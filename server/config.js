'use strict'

/**
 * Eaglercraft: Connected Client — server configuration.
 *
 * The server is designed to run on a small box (1 core / 2.5 GB RAM),
 * so every tunable is conservative by default and can be overridden
 * through environment variables.
 */

const path = require('path')
const fs = require('fs')

// ---------------------------------------------------------------------------
// Files & folders
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..')
const PUBLIC_DIR = path.join(ROOT, 'public')

// A vanilla resource pack (an *extracted* folder containing
// assets/minecraft/textures/block/...). Optional: when missing, the server
// falls back to procedurally generated textures.
let RESOURCE_PACK_PATH = process.env.RESOURCE_PACK_PATH || ''
if (!RESOURCE_PACK_PATH) {
  const candidate = path.join(ROOT, 'resourcepack')
  if (fs.existsSync(candidate)) RESOURCE_PACK_PATH = candidate
}

// ---------------------------------------------------------------------------
// HTTP / WebSocket
// ---------------------------------------------------------------------------

const config = {
  port: intFromEnv('PORT', 3000),
  host: process.env.HOST || '0.0.0.0',

  // Max size (bytes) of the outbound binary queue for one client before the
  // chunk stream pauses itself (backpressure).
  maxBufferedBytes: intFromEnv('MAX_BUFFERED_BYTES', 4 * 1024 * 1024),

  // How often (ms) the client is allowed to send control/look updates.
  controlThrottleMs: intFromEnv('CONTROL_THROTTLE_MS', 50),

  // How many chunk messages may be sent per second to a single client.
  chunkSendRate: intFromEnv('CHUNK_SEND_RATE', 40),

  // ---- Queue / load control (small server: 1 core, 2.5 GB RAM) ----
  // Maximum bots (Mineflayer connections) running at the same time.
  maxConcurrentBots: intFromEnv('MAX_CONCURRENT_BOTS', 2),
  // Maximum clients waiting in the connection queue. Extra requests are rejected.
  maxQueueSize: intFromEnv('MAX_QUEUE_SIZE', 8),
  // How long (ms) a queued client waits before giving up.
  queueTimeoutMs: intFromEnv('QUEUE_TIMEOUT_MS', 10 * 60 * 1000),

  // ---- World streaming ----
  // Number of chunks around the bot that are streamed to the client.
  renderDistance: intFromEnv('RENDER_DISTANCE', 4),
  // Max chunks streamed per second (protects the CPU on a 1-core box).
  chunkScanRate: intFromEnv('CHUNK_SCAN_RATE', 8),
  // Compact binary chunks are deflated before being sent.
  chunkCompression: process.env.CHUNK_COMPRESSION !== '0'
}

function intFromEnv (name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = parseInt(raw, 10)
  return Number.isNaN(value) ? fallback : value
}

// Path to a vanilla resource pack (already extracted on disk), or '' if none.
config.resourcePackPath = RESOURCE_PACK_PATH

module.exports = config
