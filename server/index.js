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

// Build the texture atlas once at startup (pack if present, procedural else).
// When no pack exists on disk, try to auto-download it first (V1.0.2) so a
// fresh clone gets the real Minecraft textures on first boot.
let atlasResult = null
const bootPromise = (async () => {
  if (!config.resourcePackPath) {
    const downloaded = await resourcePack.ensureResourcePack(path.join(__dirname, '..', 'resourcepack'))
    if (downloaded) config.resourcePackPath = downloaded
  }
  atlasResult = resourcePack.buildResourcePack(config.resourcePackPath, '1.21.9') ||
    resourcePack.buildProceduralAtlas('1.21.9')
  return atlasResult
})()

app.get('/atlas.png', async (req, res) => {
  await bootPromise
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(atlasResult.atlasPng)
})

// HUD spritesheet (hearts/food from the pack's GUI sprites, drawn-emoji
// fallback in CSS when absent). Built during the async boot with the atlas.
let hudSheet = null
// Biome colormaps (grass/foliage) + item atlas — built during boot too.
let colormaps = null
let itemAtlas = null
bootPromise.then(() => {
  if (!config.resourcePackPath) return
  try {
    const assetsDir = resourcePack.findAssetsDir(config.resourcePackPath)
    if (!assetsDir) return
    hudSheet = resourcePack.buildHudSheet(assetsDir)
    if (hudSheet) console.log(`[resourcePack] HUD sheet built (${Object.keys(hudSheet.sprites).filter(k => hudSheet.sprites[k]).length}/6 sprites)`)
    colormaps = resourcePack.buildColormaps(assetsDir)
    if (colormaps) console.log('[resourcePack] biome colormaps loaded (grass + foliage)')
    itemAtlas = resourcePack.buildItemAtlas(assetsDir, '1.21.9')
  } catch (e) {
    console.warn('[resourcePack] HUD sheet build failed:', e.message)
  }
})

app.get('/hud.png', (req, res) => {
  if (!hudSheet) { res.status(404).end(); return }
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(hudSheet.png)
})
app.get('/hud.json', (req, res) => {
  res.set('Content-Type', 'application/json')
  res.set('Cache-Control', 'public, max-age=86400')
  if (!hudSheet) { res.json({}); return }
  res.json({
    sheetWidth: hudSheet.sheetWidth,
    sheetHeight: hudSheet.sheetHeight,
    sprites: hudSheet.sprites
  })
})

// Item atlas (hotbar/inventory icons) — 404 when the pack has no items.
app.get('/items.png', (req, res) => {
  if (!itemAtlas) { res.status(404).end(); return }
  res.set('Content-Type', 'image/png')
  res.set('Cache-Control', 'public, max-age=86400')
  res.send(itemAtlas.atlasPng)
})
app.get('/items.json', (req, res) => {
  res.set('Content-Type', 'application/json')
  res.set('Cache-Control', 'public, max-age=86400')
  if (!itemAtlas) { res.json({}); return }
  const out = {}
  for (const [name, m] of itemAtlas.mappings) out[name] = m.tile
  res.json({ atlasGrid: 64, tileSize: 16, items: out })
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
      case 'reset_chunks':
        // Client asked for a full chunk reload (R key): the streaming state
        // (sent set + queue) is wiped and everything re-scanned from zero —
        // fixes client-side phantom blocks after desyncs.
        handleResetChunks(ws)
        break
      case 'dig':
        handleDig(ws, msg)
        break
      case 'place':
        handlePlace(ws, msg)
        break
      case 'activate':
        handleActivate(ws, msg)
        break
      case 'slot_select': // hotbar selection (wheel / 1-9 keys)
        handleSlotSelect(ws, msg)
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
  // Pitch INVERSION: the web client uses "positive = down" but mineflayer
  // uses "positive = up" (conversions.js: toNotchianPitch = -pitch) —
  // without the negation the bot looked UP when the player looked down.
  try { session.bot.look(clampedYaw, -clampedPitch, true) } catch (e) {}
}

function handleChat (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const text = String(msg.text || '').slice(0, 256)
  if (!text) return
  try { session.bot.chat(text) } catch (e) {}
}

// ---------------------------------------------------------------------------
// World interaction (dig / place / activate) + chunk reset — V1.1.0
// ---------------------------------------------------------------------------

/** Validates block coordinates coming from the client. */
function validBlockCoords (msg) {
  const x = Math.floor(Number(msg.x))
  const y = Math.floor(Number(msg.y))
  const z = Math.floor(Number(msg.z))
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return null
  return { x, y, z }
}

/** R key: full chunk reload on both sides (fixes phantom blocks). */
function handleResetChunks (ws) {
  const session = manager.sessions.get(ws.id)
  if (!session) return
  if (session.stream && typeof session.stream.reset === 'function') {
    session.stream.reset()
    sendJson(ws, { t: 'chunks_reset' })
  }
}

/** Left click: mine the block at (x,y,z). One dig at a time per client —
 *  spamming the click while a dig is running would queue dozens of
 *  lookAt/dig chains and jerk the bot's camera around. */
function handleDig (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  if (session.digInFlight) return
  const bot = session.bot
  const pos = validBlockCoords(msg)
  if (!pos) return
  const { Vec3 } = require('vec3')
  const block = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!block || block.name === 'air') {
    sendJson(ws, { t: 'dig_error', error: 'Block not found / out of reach' })
    return
  }
  session.digInFlight = true
  bot.lookAt(new Vec3(pos.x + 0.5, pos.y + 0.5, pos.z + 0.5), true).then(() => {
    return bot.dig(block, true)
  }).then(() => {
    sendJson(ws, { t: 'dig_ok' })
    // The world listener streams the block_update (the bot's own view is
    // authoritative — no client-side ghost prediction on failure).
  }).catch((e) => {
    sendJson(ws, { t: 'dig_error', error: e.message || 'dig failed' })
  }).finally(() => {
    session.digInFlight = false
  })
}

/** Right click: place the held block against the (x,y,z)+face. */
function handlePlace (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const bot = session.bot
  const pos = validBlockCoords(msg)
  if (!pos) return
  const face = Math.floor(Number(msg.face))
  if (!(face >= 0 && face <= 5)) return
  const held = bot.heldItem
  if (!held) {
    sendJson(ws, { t: 'place_error', error: 'Nothing in hand' })
    return
  }
  const { Vec3 } = require('vec3')
  const FACE_VECS = [
    new Vec3(1, 0, 0), new Vec3(-1, 0, 0),
    new Vec3(0, 1, 0), new Vec3(0, -1, 0),
    new Vec3(0, 0, 1), new Vec3(0, 0, -1)
  ]
  const referenceBlock = bot.blockAt(new Vec3(pos.x, pos.y, pos.z))
  if (!referenceBlock || referenceBlock.name === 'air') {
    sendJson(ws, { t: 'place_error', error: 'Reference block missing' })
    return
  }
  const faceVec = FACE_VECS[face]
  bot.lookAt(new Vec3(pos.x + 0.5 + faceVec.x * 0.5, pos.y + 0.5 + faceVec.y * 0.5, pos.z + 0.5 + faceVec.z * 0.5), true)
    .then(() => bot.placeBlock(referenceBlock, faceVec))
    .then(() => sendJson(ws, { t: 'place_ok' }))
    .catch((e) => sendJson(ws, { t: 'place_error', error: e.message || 'place failed' }))
}

/** Activate the held item (right click on air / use: eat, shoot, etc.). */
function handleActivate (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const bot = session.bot
  try {
    bot.activateItem()
    sendJson(ws, { t: 'activate_ok' })
  } catch (e) {
    sendJson(ws, { t: 'activate_error', error: e.message || 'activate failed' })
  }
}

// ---------------------------------------------------------------------------
// Inventory (hotbar) relays — V1.1.0
// ---------------------------------------------------------------------------

/** Serializes an inventory item (null when the slot is empty). */
function serializeItem (item) {
  if (!item) return null
  return { name: item.name, count: item.count }
}

/** Hotbar snapshot: the 9 quick-bar slots + the selected one. */
function hotbarPayload (bot) {
  const slots = []
  for (let i = 0; i < 9; i++) {
    slots.push(serializeItem(bot.inventory.slots[bot.QUICK_BAR_START + i]))
  }
  return { t: 'hotbar', slots, selected: bot.quickBarSlot ?? 0 }
}

/** Selects a hotbar slot (0-8) — the wheel / 1-9 keys on the client. */
function handleSlotSelect (ws, msg) {
  const session = manager.sessions.get(ws.id)
  if (!session || !session.bot) return
  const bot = session.bot
  const slot = Math.floor(Number(msg.slot))
  if (!(Number.isFinite(slot) && slot >= 0 && slot <= 8)) return
  try {
    bot.setQuickBarSlot(slot)
    sendJson(ws, { t: 'slot_selected', slot })
  } catch (e) {}
}

/**
 * Inventory slots 0-35 (crafting/armor slots excluded): every item change
 * (pick up, place, drop, server /give...) pushes {t:'inv_slot'}.
 */
function sendInvSlot (ws, bot, index) {
  const slot = serializeItem(bot.inventory.slots[index])
  sendJson(ws, { t: 'inv_slot', index, item: slot })
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

manager.on('botReady', async (socket, session, mcData) => {
  // A bot login can theoretically race with the first-boot atlas build
  // (pack auto-download): wait for it before sending the mappings.
  await bootPromise
  const bot = session.bot
  session.streamer = new WorldStreamer({
    bot,
    mcData,
    renderDistance: config.renderDistance
  })
  // Vanilla biome colormaps -> the streamer tints grass/leaves/water
  session.streamer.colormaps = colormaps

  sendJson(socket, {
    t: 'login',
    username: bot.username,
    version: bot.version,
    host: session.request.host,
    port: session.request.port,
    // Texture mappings for the client renderer (block name -> atlas tiles)
    blockMappings: atlasBlockMappings(),
    minY: bot.game ? bot.game.minY : 0,
    worldHeight: bot.game ? (bot.game.height || 256) : 256,
    renderDistance: config.renderDistance,
    entityMappings: buildEntityMappings(mcData)
  })

  attachWorldStreaming(socket, session, mcData)
  attachBotEvents(socket, session)
})

/** blockName -> { top, bottom, side, cross?, opacity? } as a plain object.
 *  Built lazily AFTER the async boot (pack download + atlas build) — the
 *  login handler can't race with it because a bot login takes seconds. */
let _atlasBlockMappingsCache = null
function atlasBlockMappings () {
  if (_atlasBlockMappingsCache) return _atlasBlockMappingsCache
  const out = {}
  for (const [name, m] of atlasResult.mappings) {
    out[name] = { top: m.top, bottom: m.bottom, side: m.side }
    if (m.cross) out[name].cross = 1
    if (m.opacity !== undefined) out[name].opacity = m.opacity
  }
  _atlasBlockMappingsCache = out
  return out
}

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
  const chunkQueue = [] // { chunkX, chunkZ } — no duplicates (queuedChunks set)
  const queuedChunks = new Set() // 'cx,cz' currently in the queue
  const sentChunks = new Set() // 'cx,cz'
  let tokens = config.chunkScanRate
  const refillTimer = setInterval(() => { tokens = config.chunkScanRate }, 1000)
  session.cleanup.push(() => clearInterval(refillTimer))

  function queueChunk (cx, cz) {
    const key = `${cx},${cz}`
    if (sentChunks.has(key) || queuedChunks.has(key)) return
    queuedChunks.add(key)
    chunkQueue.push({ cx, cz, key })
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

  // Full reset (R key on the client): forget every sent/queued chunk and
  // re-queue the whole render distance from zero. The client wipes its
  // meshes at the same time, so the world is rebuilt consistently on both
  // sides — this is the fix for client-side "phantom blocks" desyncs.
  session.stream = {
    reset () {
      sentChunks.clear()
      queuedChunks.clear()
      chunkQueue.length = 0
      lastCenter = { cx: null, cz: null }
      updateCenter()
    },
    queueChunk
  }

  // Drain loop: respects the socket's backpressure and a per-tick CPU budget.
  // The old version sent AT MOST ONE chunk per 50 ms tick (~20 chunks/s max
  // whatever the token bucket allowed) — with a 8ms time budget we now send
  // as many chunks as the event loop can afford without starving the bot.
  const drainTimer = setInterval(() => {
    if (socket.readyState !== WebSocket.OPEN) return
    if (socket.bufferedAmount > config.maxBufferedBytes) return // backpressure
    const budgetEnd = performance.now() + config.drainBudgetMs
    while (tokens > 0 && chunkQueue.length > 0) {
      const { cx, cz, key } = chunkQueue.shift()
      queuedChunks.delete(key)
      if (sentChunks.has(key)) continue
      if (sendChunkColumn(cx, cz)) tokens--
      // Serialize + send is synchronous CPU work on a 1-core box: stop when
      // the time budget is spent so the bot's packets are still processed.
      if (performance.now() >= budgetEnd) break
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

  // Block updates: patch the client's meshes (single blocks). All seven
  // positions (the block + its 6 neighbours) are batched into ONE message —
  // sending 7 JSON frames per update was flooding the socket (any fast
  // world edit = hundreds of messages per second).
  const onBlockUpdate = (oldBlock, newBlock) => {
    // Recompute masks around the updated position, including this block
    const pos = newBlock.position
    const blocks = [streamer.serializeBlockUpdate(pos.x, pos.y, pos.z)]
    // Neighbors may gain/lose visible faces: send their new masks too
    blocks.push(
      streamer.serializeBlockUpdate(pos.x + 1, pos.y, pos.z),
      streamer.serializeBlockUpdate(pos.x - 1, pos.y, pos.z),
      streamer.serializeBlockUpdate(pos.x, pos.y + 1, pos.z),
      streamer.serializeBlockUpdate(pos.x, pos.y - 1, pos.z),
      streamer.serializeBlockUpdate(pos.x, pos.y, pos.z + 1),
      streamer.serializeBlockUpdate(pos.x, pos.y, pos.z - 1)
    )
    sendJson(socket, { t: 'block_update', blocks })
  }
  bot.on('blockUpdate', onBlockUpdate)
  session.cleanup.push(() => bot.off('blockUpdate', onBlockUpdate))
}


// ---------------------------------------------------------------------------
// Bot events -> client (position, entities, chat, health)
// ---------------------------------------------------------------------------

function attachBotEvents (socket, session) {
  const bot = session.bot

  // --- Inventory / hotbar (V1.1.0) ------------------------------------------
  // Initial snapshot then incremental pushes: heldItemChanged covers quick-bar
  // slot switches; updateSlot covers every inventory slot change (picked-up
  // loot, /give, container moves, the initial window_items packet...).
  // Slot layout (server-side indexes): 0-35 main inventory, 36-44 quick bar.
  const QUICK_BAR_START = bot.QUICK_BAR_START
  const pushHotbar = () => sendJson(socket, hotbarPayload(bot))
  const onHeldItemChanged = () => pushHotbar()
  const onInvUpdateSlot = (index) => {
    if (index >= 0 && index <= QUICK_BAR_START + 8) sendInvSlot(socket, bot, index)
  }
  bot.on('heldItemChanged', onHeldItemChanged)
  bot.inventory.on('updateSlot', onInvUpdateSlot)
  session.cleanup.push(() => {
    bot.off('heldItemChanged', onHeldItemChanged)
    bot.inventory.off('updateSlot', onInvUpdateSlot)
  })
  pushHotbar()
  for (let i = 0; i <= QUICK_BAR_START + 8; i++) sendInvSlot(socket, bot, i)

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
      yaw: e.yaw,
      // Convert mineflayer's pitch convention (positive = UP) to the web
      // client's (positive = down) — see handleLook for the mirror inversion.
      pitch: -e.pitch,
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
  // entityMoved fires for EVERY entity on EVERY physics tick (20 Hz): with
  // 50 mobs around that was 1000 JSON messages per second. Updates are now
  // batched into one message every 100 ms.
  const pendingEntityUpdates = new Map() // id -> { entity, isNew: false }
  const entityFlushTimer = setInterval(() => {
    if (pendingEntityUpdates.size === 0) return
    if (socket.readyState !== WebSocket.OPEN) { pendingEntityUpdates.clear(); return }
    const updates = []
    for (const [, u] of pendingEntityUpdates) updates.push(u)
    pendingEntityUpdates.clear()
    sendJson(socket, { t: 'entities', updates })
  }, 100)
  session.cleanup.push(() => clearInterval(entityFlushTimer))

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
  const onEntityMoved = (e) => {
    if (!e || e === bot.entity) return
    pendingEntityUpdates.set(e.id, {
      id: e.id,
      name: e.name || e.username || e.type,
      x: e.position.x, y: e.position.y, z: e.position.z,
      yaw: e.yaw
    })
  }
  const onEntityGone = (e) => {
    // A gone entity no longer needs its pending movement update
    pendingEntityUpdates.delete(e.id)
    sendJson(socket, { t: 'entity_gone', id: e.id })
  }

  bot.on('entitySpawn', onEntitySpawn)
  bot.on('entityMoved', onEntityMoved)
  bot.on('entityGone', onEntityGone)
  session.cleanup.push(() => {
    clearInterval(entityFlushTimer)
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

