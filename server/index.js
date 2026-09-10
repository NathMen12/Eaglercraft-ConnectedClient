'use strict'

/**
 * Eaglercraft: Connected Client — main server.
 *
 * Serves the web client (public/) over Express and speaks WebSocket (ws)
 * with browsers. For each connected web client it can spawn one Mineflayer
 * bot on a target Minecraft server and stream the world to the renderer.
 */

const http = require('http')
const path = require('path')
const express = require('express')
const { WebSocketServer, WebSocket } = require('ws')

const config = require('./config')
const { BotManager } = require('./botManager')
const resourcePack = require('./resourcePack')

// ---------------------------------------------------------------------------
// HTTP server (static files + texture atlas)
// ---------------------------------------------------------------------------

const app = express()
app.disable('x-powered-by')
// Serve the web client
app.use(express.static(path.join(__dirname, '..', 'public')))
// Serve three.js from node_modules (imported by renderer.js as an ES module).
// three.module.js imports its sibling ./three.core.js — the whole build
// directory must be reachable with a JS MIME type.
const THREE_BUILD = path.join(__dirname, '..', 'node_modules', 'three', 'build')
app.get('/node_modules/three/build/:file', (req, res) => {
  const file = path.basename(req.params.file)
  if (!/^(three|three.core|three.tsl|three.webgpu|three.webgpu.nodes)\.(module\.js|js|cjs)$/.test(file)) {
    return res.status(404).end()
  }
  res.set('Content-Type', 'text/javascript')
  res.set('Cache-Control', 'public, max-age=86400')
  res.sendFile(path.join(THREE_BUILD, file))
})

// Build the texture atlas once at startup (pack if present, procedural else)
const atlasResult = resourcePack.buildResourcePack(config.resourcePackPath, '1.21.9') ||
  resourcePack.buildProceduralAtlas('1.21.9')
app.get('/atlas.png', (req, res) => {
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(atlasResult.atlasPng)
})

// blockId -> blockName table for the client renderer. Built lazily per
// Minecraft version (block ids differ across versions); the client requests
// it after login when it knows the negotiated version.
const blocksJsonCache = new Map() // version -> JSON string
app.get('/blocks.json', (req, res) => {
  const version = String(req.query.v || '1.21.9')
  let payload = blocksJsonCache.get(version)
  if (!payload) {
    const mcData = require('minecraft-data')(version)
    const table = {}
    if (mcData) {
      for (const b of mcData.blocksArray) table[b.id] = b.name
    }
    payload = JSON.stringify(table)
    blocksJsonCache.set(version, payload)
  }
  res.set('Content-Type', 'application/json')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(payload)
})

const server = http.createServer(app)

// ---------------------------------------------------------------------------
// WebSocket server
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ server, path: '/ws' })

const manager = new BotManager(config)
manager.on('log', (msg) => console.log(`[botManager] ${msg}`))

// Text frame helper
function sendJson (ws, obj) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
}
function sendBinary (ws, buf) {
  if (ws.readyState === WebSocket.OPEN) ws.send(buf, { binary: true })
}

// Keep track of socket ids
let nextSocketId = 1

wss.on('connection', (ws) => {
  ws.id = `sock-${nextSocketId++}`
  ws.isAlive = true
  ws.on('pong', () => { ws.isAlive = true })

  sendJson(ws, { t: 'hello', maxConcurrentBots: config.maxConcurrentBots, queueSize: 0 })

  ws.on('message', (data, isBinary) => {
    if (isBinary) return // clients only send text
    let msg
    try { msg = JSON.parse(data.toString()) } catch (e) { return }

    switch (msg.t) {
      case 'connect':
        handleConnect(ws, msg)
        break
      case 'control':
        handleControl(ws, msg)
        break
      case 'look':
        handleLook(ws, msg)
        break
      case 'chat':
        handleChat(ws, msg)
        break
      case 'disconnect_bot':
        manager.handleSocketClose(ws.id)
        sendJson(ws, { t: 'bot_closed' })
        break
      default:
        break
    }
  })

  ws.on('close', () => {
    manager.handleSocketClose(ws.id)
  })
})

// Heartbeat: drop dead sockets every 30s
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { ws.terminate(); continue }
    ws.isAlive = false
    try { ws.ping() } catch (e) {}
  }
}, 30000)

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

function validateConnectRequest (msg) {
  const host = String(msg.host || '').trim()
  const port = parseInt(msg.port, 10) || 25565
  const username = String(msg.username || '').trim()
  if (!host || host.length > 255) return { error: 'Invalid host' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: 'Invalid port' }
  if (!/^[a-zA-Z0-9_]{1,16}$/.test(username)) return { error: 'Invalid username (1-16 alphanumeric/underscore)' }
  return { host, port, username }
}

function handleConnect (ws, msg) {
  const valid = validateConnectRequest(msg)
  if (valid.error) {
    sendJson(ws, { t: 'connect_error', error: valid.error })
    return
  }
  // Reject when a bot already exists for this socket
  if (manager.sessions.has(ws.id)) {
    sendJson(ws, { t: 'connect_error', error: 'Already connected — disconnect first' })
    return
  }
  manager.requestConnect(ws, valid)
}

// ---------------------------------------------------------------------------
// Control relays (client -> bot)
// ---------------------------------------------------------------------------

// Control state keys accepted from the client
const CONTROL_KEYS = ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']

function handleControl (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const bot = session.bot
  const states = msg.states || {}
  for (const key of CONTROL_KEYS) {
    if (key in states) {
      try { bot.setControlState(key, !!states[key]) } catch (e) {}
    }
  }
}

function handleLook (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const yaw = Number(msg.yaw)
  const pitch = Number(msg.pitch)
  if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
  // Keep the client-side look in range (mirrors the client clamping)
  const clampedYaw = ((yaw + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  const clampedPitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, pitch))
  const now = Date.now()
  if (session.lastLookAt && now - session.lastLookAt < config.controlThrottleMs) return
  session.lastLookAt = now
  // force=true applies the look immediately (skips the smooth transition
  // task) — the client is the only one driving the camera, so no smoothing
  // is needed and small mouse deltas are never lost.
  try { session.bot.look(clampedYaw, clampedPitch, true) } catch (e) {}
}

function handleChat (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const text = String(msg.text || '').slice(0, 256)
  if (!text) return
  try { session.bot.chat(text) } catch (e) {}
}

// ---------------------------------------------------------------------------
// Bot events -> client streaming
// ---------------------------------------------------------------------------

const { WorldStreamer } = require('./worldStreamer')

manager.on('queued', (socket, position, total) => {
  sendJson(socket, { t: 'queue', position, total, max: config.maxQueueSize })
})

manager.on('queueFull', (socket) => {
  sendJson(socket, { t: 'queue_full' })
})

manager.on('queueTimeout', (socket) => {
  sendJson(socket, { t: 'queue_timeout' })
})

manager.on('queuePromoted', (socket) => {
  sendJson(socket, { t: 'queue_promoted' })
})

manager.on('botReady', (socket, session, mcData) => {
  const bot = session.bot
  session.streamer = new WorldStreamer({
    bot,
    mcData,
    renderDistance: config.renderDistance
  })

  sendJson(socket, {
    t: 'login',
    username: bot.username,
    version: bot.version,
    host: session.request.host,
    port: session.request.port,
    // Texture mappings for the client renderer (block name -> atlas tiles)
    blockMappings: atlasBlockMappings,
    minY: bot.game ? bot.game.minY : 0,
    worldHeight: bot.game ? (bot.game.height || 256) : 256,
    renderDistance: config.renderDistance,
    entityMappings: buildEntityMappings(mcData)
  })

  attachWorldStreaming(socket, session, mcData)
  attachBotEvents(socket, session)
})

/** blockName -> { top, bottom, side, cross?, opacity? } as a plain object.
 *  Built once at startup (the atlas is static for the server's lifetime). */
const atlasBlockMappings = (() => {
  const out = {}
  for (const [name, m] of atlasResult.mappings) {
    out[name] = { top: m.top, bottom: m.bottom, side: m.side }
    if (m.cross) out[name].cross = 1
    if (m.opacity !== undefined) out[name].opacity = m.opacity
  }
  return out
})()

/** Entity type name -> { height, width } for client-side box sizing. */
const entityMappingsCache = new Map() // version -> object
function buildEntityMappings (mcData) {
  const key = mcData.version && mcData.version.minecraftVersion
  if (key && entityMappingsCache.has(key)) return entityMappingsCache.get(key)
  const out = {}
  for (const e of mcData.entitiesArray) {
    out[e.name] = { height: e.height || 1.8, width: e.width || 0.6, id: e.id }
  }
  if (key) entityMappingsCache.set(key, out)
  return out
}


// ---------------------------------------------------------------------------
// World streaming (chunks, entities, position) with rate limiting
// ---------------------------------------------------------------------------

function attachWorldStreaming (socket, session, mcData) {
  const bot = session.bot
  const streamer = session.streamer

  // --- Chunk streaming with a token bucket --------------------------------
  const chunkQueue = [] // { chunkX, chunkZ }
  const sentChunks = new Set() // 'cx,cz'
  let tokens = config.chunkScanRate
  const refillTimer = setInterval(() => { tokens = config.chunkScanRate }, 1000)
  session.cleanup.push(() => clearInterval(refillTimer))

  function queueChunk (cx, cz) {
    const key = `${cx},${cz}`
    if (sentChunks.has(key)) return
    chunkQueue.push({ cx, cz })
  }

  // Queue the chunks around the bot on login (all render distance)
  let lastCenter = { cx: null, cz: null }
  const updateCenter = () => {
    if (!bot.entity) return
    const cx = Math.floor(bot.entity.position.x / 16)
    const cz = Math.floor(bot.entity.position.z / 16)
    if (cx === lastCenter.cx && cz === lastCenter.cz) return
    lastCenter = { cx, cz }
    queueAround(lastCenter)
  }

  function queueAround ({ cx, cz }) {
    const r = config.renderDistance
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dz * dz <= (r + 0.5) * (r + 0.5)) {
          queueChunk(cx + dx, cz + dz)
        }
      }
    }
  }

  updateCenter()
  // Re-scan when the bot crosses into another chunk
  const moveTimer = setInterval(updateCenter, 1000)
  session.cleanup.push(() => clearInterval(moveTimer))

  // Columns already loaded before we attached the listeners: snapshot them.
  // (The initial world load races with the login event.)
  for (const c of bot.world.getColumns()) {
    queueChunk(Number(c.chunkX), Number(c.chunkZ))
  }

  // Drain loop: send at most `chunkScanRate` chunks per second while
  // respecting the socket's backpressure.
  const drainTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > config.maxBufferedBytes) return // backpressure
    while (tokens > 0 && chunkQueue.length > 0) {
      const { cx, cz } = chunkQueue.shift()
      if (sentChunks.has(`${cx},${cz}`)) continue
      // Serialize + send is synchronous CPU work on a 1-core box:
      // limit to one chunk per tick of the drain loop.
      if (sendChunkColumn(cx, cz)) tokens--
      break
    }
  }, 50)
  session.cleanup.push(() => clearInterval(drainTimer))

  /** Sends one chunk. Returns true when a payload was actually sent. */
  function sendChunkColumn (cx, cz) {
    try {
      const payload = streamer.serializeChunk(cx, cz)
      if (payload) {
        sendBinary(socket, payload)
        sentChunks.add(`${cx},${cz}`)
        return true
      }
      // No visible blocks OR not loaded yet — decide using the column state
      const column = bot.world.getColumn(cx, cz)
      if (column) {
        // Truly empty column: tell the client so it can clear meshes
        sendJson(socket, { t: 'chunk_empty', cx, cz })
        sentChunks.add(`${cx},${cz}`)
        return true
      }
      // Not loaded yet — leave unmarked; chunkColumnLoad will re-queue it
      return false
    } catch (e) {
      console.warn(`[stream] chunk ${cx},${cz} failed: ${e.message}`)
      return false
    }
  }

  // --- World events --------------------------------------------------------
  // chunkColumnLoad/Unload emit a Vec3 corner (chunkX*16, 0, chunkZ*16)
  const onChunkLoad = (corner) => {
    const chunkX = Math.floor(corner.x / 16)
    const chunkZ = Math.floor(corner.z / 16)
    queueChunk(chunkX, chunkZ)
    // When a chunk loads, its 4 neighbors may hide faces at their borders:
    // rescan them so the client geometry stays correct.
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const key = `${chunkX + dx},${chunkZ + dz}`
      if (sentChunks.has(key)) {
        sentChunks.delete(key)
        queueChunk(chunkX + dx, chunkZ + dz)
      }
    }
  }
  bot.world.on('chunkColumnLoad', onChunkLoad)
  session.cleanup.push(() => bot.world.off('chunkColumnLoad', onChunkLoad))

  const onChunkUnload = (corner) => {
    const chunkX = Math.floor(corner.x / 16)
    const chunkZ = Math.floor(corner.z / 16)
    sendJson(socket, { t: 'chunk_unload', cx: chunkX, cz: chunkZ })
    sentChunks.delete(`${chunkX},${chunkZ}`)
  }
  bot.world.on('chunkColumnUnload', onChunkUnload)
  session.cleanup.push(() => bot.world.off('chunkColumnUnload', onChunkUnload))

  // Block updates: patch the client's meshes (single blocks)
  const onBlockUpdate = (oldBlock, newBlock) => {
    // Recompute masks around the updated position, including this block
    const pos = newBlock.position
    sendJson(socket, {
      t: 'block_update',
      block: streamer.serializeBlockUpdate(pos.x, pos.y, pos.z)
    })
    // Neighbors may gain/lose visible faces: send their new masks too
    const neighbors = [
      [pos.x + 1, pos.y, pos.z], [pos.x - 1, pos.y, pos.z],
      [pos.x, pos.y + 1, pos.z], [pos.x, pos.y - 1, pos.z],
      [pos.x, pos.y, pos.z + 1], [pos.x, pos.y, pos.z - 1]
    ]
    for (const [nx, ny, nz] of neighbors) {
      sendJson(socket, {
        t: 'block_update',
        block: streamer.serializeBlockUpdate(nx, ny, nz)
      })
    }
  }
  bot.on('blockUpdate', onBlockUpdate)
  session.cleanup.push(() => bot.off('blockUpdate', onBlockUpdate))
}


// ---------------------------------------------------------------------------
// Bot events -> client (position, entities, chat, health)
// ---------------------------------------------------------------------------

function attachBotEvents (socket, session) {
  const bot = session.bot

  // --- Position (throttled ~20 Hz) ---------------------------------------
  let lastPosSent = 0
  const onMove = () => {
    if (!bot.entity) return
    const now = Date.now()
    if (now - lastPosSent < 50) return
    lastPosSent = now
    const e = bot.entity
    const payload = {
      t: 'position',
      x: e.position.x, y: e.position.y, z: e.position.z,
      yaw: e.yaw, pitch: e.pitch,
      onGround: !!e.onGround
    }
    // health/food are only defined once the server sent update_health
    if (typeof bot.health === 'number') payload.health = bot.health
    if (typeof bot.food === 'number') payload.food = bot.food
    sendJson(socket, payload)
  }
  bot.on('move', onMove)
  session.cleanup.push(() => bot.off('move', onMove))

  // --- Health --------------------------------------------------------------
  const onHealth = () => {
    sendJson(socket, { t: 'health', health: bot.health, food: bot.food })
  }
  bot.on('health', onHealth)
  session.cleanup.push(() => bot.off('health', onHealth))

  // --- Chat ----------------------------------------------------------------
  const onChat = (username, message) => {
    sendJson(socket, { t: 'chat', from: username, text: message })
  }
  bot.on('chat', onChat)
  session.cleanup.push(() => bot.off('chat', onChat))

  const onMessage = (jsonMsg) => {
    // Full system messages (join/leave, deaths, /say...)
    const text = jsonMsg.toString()
    if (text) sendJson(socket, { t: 'chat', from: null, text })
  }
  bot.on('message', onMessage)
  session.cleanup.push(() => bot.off('message', onMessage))

  // --- Entities ------------------------------------------------------------
  const sendEntity = (entity, isNew) => {
    if (!entity) return
    sendJson(socket, {
      t: 'entity',
      isNew,
      id: entity.id,
      kind: entity.type,
      name: entity.name || entity.username || entity.type,
      x: entity.position.x, y: entity.position.y, z: entity.position.z,
      yaw: entity.yaw, pitch: entity.pitch
    })
  }
  const onEntitySpawn = (e) => sendEntity(e, true)
  const onEntityMoved = (e) => sendEntity(e, false)
  const onEntityGone = (e) => sendJson(socket, { t: 'entity_gone', id: e.id })

  bot.on('entitySpawn', onEntitySpawn)
  bot.on('entityMoved', onEntityMoved)
  bot.on('entityGone', onEntityGone)
  session.cleanup.push(() => {
    bot.off('entitySpawn', onEntitySpawn)
    bot.off('entityMoved', onEntityMoved)
    bot.off('entityGone', onEntityGone)
  })

  // Entities already present when we attach (the login happens after the
  // server has sent its entity list): snapshot them now.
  for (const id in bot.entities) {
    const e = bot.entities[id]
    if (e && e !== bot.entity) sendEntity(e, true)
  }
}


// ---------------------------------------------------------------------------
// Manager events -> client notifications
// ---------------------------------------------------------------------------

manager.on('kicked', (socket, reason) => {
  sendJson(socket, { t: 'kicked', reason: typeof reason === 'string' ? reason : JSON.stringify(reason) })
})

manager.on('botError', (socket, err) => {
  sendJson(socket, { t: 'connect_error', error: err.message || 'Connection failed' })
})

manager.on('botEnd', (socket) => {
  sendJson(socket, { t: 'bot_end' })
})

manager.on('sessionClosed', (socket, reason) => {
  sendJson(socket, { t: 'closed', reason })
})

manager.on('timeout', (socket) => {
  sendJson(socket, { t: 'connect_error', error: 'Connection timed out' })
})

manager.on('error', (err) => {
  console.error('[botManager] unhandled error:', err.message)
})

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

server.listen(config.port, config.host, () => {
  console.log('')
  console.log('=====================================================')
  console.log('  Eaglercraft: Connected Client')
  console.log('=====================================================')
  console.log(`  Web client:     http://localhost:${config.port}`)
  console.log(`  WebSocket:      ws://localhost:${config.port}/ws`)
  console.log(`  Resource pack:  ${config.resourcePackPath || '(none — procedural textures)'}`)
  console.log(`  Limits:         ${config.maxConcurrentBots} concurrent bots, queue of ${config.maxQueueSize}`)
  console.log(`  Render dist.:   ${config.renderDistance} chunks (${config.chunkScanRate} chunks/s per client)`)
  console.log('=====================================================')
  console.log('')
})

// Graceful shutdown
function shutdown () {
  console.log('\n[server] shutting down...')
  for (const [socketId] of manager.sessions) manager.teardown(socketId, 'Server shutdown')
  for (const ws of wss.clients) { try { ws.terminate() } catch (e) {} }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

