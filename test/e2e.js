'use strict'

/**
 * E2E test: connects to the web server's WebSocket, requests a bot on the
 * target Minecraft server, and verifies world streaming (login message,
 * binary chunks, position updates).
 *
 * Usage: node test/e2e.js [mcHost] [mcPort]
 *   mcHost defaults to 163.5.201.7, mcPort to 14636 (user-provided test server)
 * Env:
 *   E2E_CHUNK_TARGET  success threshold in chunks (default 10)
 *   E2E_STAY_MS       extra time to keep streaming before exiting (default 0)
 */

const WebSocket = require('ws')
const zlib = require('zlib')

const WEB_HOST = process.env.WEB_HOST || 'ws://127.0.0.1:3000/ws'
const MC_HOST = process.argv[2] || '163.5.201.7'
const MC_PORT = parseInt(process.argv[3] || '14636', 10)
const USERNAME = 'TestBot' + Math.floor(Math.random() * 1000)
const CHUNK_TARGET = parseInt(process.env.E2E_CHUNK_TARGET || '10', 10)
const STAY_MS = parseInt(process.env.E2E_STAY_MS || '0', 10)

// Timeout for the whole test
const TEST_TIMEOUT = 45000

let gotLogin = false
let gotPosition = false
let chunkCount = 0
let blockCount = 0
let chatLines = 0
let entityCount = 0

function fail (msg) {
  console.error(`✗ FAIL: ${msg}`)
  process.exit(1)
}

console.log(`[e2e] connecting to ${WEB_HOST}...`)
const ws = new WebSocket(WEB_HOST)
ws.binaryType = 'nodebuffer'

setTimeout(() => {
  if (!gotLogin) fail(`timeout: no login after ${TEST_TIMEOUT}ms (login=${gotLogin}, chunks=${chunkCount}, pos=${gotPosition})`)
}, TEST_TIMEOUT).unref()

ws.on('open', () => {
  console.log('[e2e] websocket open, requesting bot...')
  ws.send(JSON.stringify({
    t: 'connect',
    host: MC_HOST,
    port: MC_PORT,
    username: USERNAME
  }))
})

ws.on('message', (data, isBinary) => {
  if (isBinary) {
    // Binary frame: zlib-deflated chunk payload
    try {
      const inflated = zlib.inflateSync(data)
      const count = inflated.readUInt16LE(13)
      chunkCount++
      blockCount += count
      if (chunkCount === 1) {
        console.log(`[e2e] first chunk received: ${count} visible blocks (${data.length} bytes compressed, ${inflated.length} raw)`)
      }
      // After enough chunks + position, the E2E is a success
      if (chunkCount >= CHUNK_TARGET && gotPosition) {
        console.log(`[e2e] ✓ SUCCESS: login + position + ${CHUNK_TARGET}+ chunks streamed`)
        console.log(`[e2e]   chunks: ${chunkCount}, visible blocks: ${blockCount}, entities: ${entityCount}, chat: ${chatLines}`)
        if (STAY_MS > 0) {
          console.log(`[e2e] staying ${STAY_MS}ms more to watch for errors...`)
          setTimeout(() => {
            console.log(`[e2e] final: chunks=${chunkCount} blocks=${blockCount} entities=${entityCount}`)
            ws.close()
            process.exit(0)
          }, STAY_MS)
        } else {
          ws.close()
          process.exit(0)
        }
      }
    } catch (e) {
      console.error('[e2e] chunk decode error:', e.message)
    }
    return
  }
  let msg
  try { msg = JSON.parse(data.toString()) } catch (e) { return }
  switch (msg.t) {
    case 'hello':
      console.log(`[e2e] server hello: max ${msg.maxConcurrentBots} bots`)
      break
    case 'queue':
      console.log(`[e2e] queued at position ${msg.position}/${msg.total}`)
      break
    case 'login':
      gotLogin = true
      console.log(`[e2e] ✓ bot logged in as ${msg.username} on MC ${msg.version}`)
      console.log(`[e2e]   minY=${msg.minY} worldHeight=${msg.worldHeight} renderDistance=${msg.renderDistance}`)
      break
    case 'position':
      if (!gotPosition) {
        gotPosition = true
        console.log(`[e2e] ✓ position: x=${msg.x.toFixed(1)} y=${msg.y.toFixed(1)} z=${msg.z.toFixed(1)} health=${msg.health}`)
      }
      break
    case 'chat':
      chatLines++
      break
    case 'entity':
      if (msg.isNew) entityCount++
      break
    case 'connect_error':
      fail(`connect_error: ${msg.error}`)
      break
    case 'kicked':
      fail(`kicked: ${msg.reason}`)
      break
    case 'closed':
      if (!gotLogin) fail(`session closed: ${msg.reason}`)
      break
    default:
      break
  }
})

ws.on('error', (err) => {
  fail(`websocket error: ${err.message}`)
})

ws.on('close', () => {
  if (chunkCount === 0 && gotPosition) {
    // Logged in but no chunk in time — could be slow server; still report
    console.log(`[e2e] ⚠ login OK but no chunks streamed (check CHUNK_SCAN_RATE / world data)`)
    process.exit(2)
  }
})
