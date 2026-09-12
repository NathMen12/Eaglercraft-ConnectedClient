'use strict'

/**
 * net.js — WebSocket client layer.
 *
 * Text frames carry JSON control messages; binary frames carry deflated
 * chunk payloads which are inflated and decoded here before being passed to
 * registered handlers.
 *
 * Exposes a tiny message-bus API:
 *   Net.connect(), Net.send(), Net.on(type, fn), Net.onBinaryChunk(fn)
 */

const Net = (() => {
  let ws = null
  let connected = false
  const handlers = {}       // message type -> [fn]
  const binaryHandlers = [] // fn(buf)
  const pendingBinary = [] // chunks received before handlers exist
  let binaryHandlersReady = false

  function on (type, fn) {
    if (!handlers[type]) handlers[type] = []
    handlers[type].push(fn)
  }

  function emit (type, payload) {
    const list = handlers[type]
    if (!list) return
    for (const fn of list) {
      try { fn(payload) } catch (e) { console.error('handler error for', type, e) }
    }
  }

  function connect () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    ws = new WebSocket(`${proto}//${location.host}/ws`)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      connected = true
      emit('open')
    }
    ws.onclose = () => {
      const was = connected
      connected = false
      emit('close', was)
    }
    ws.onerror = () => emit('error')
    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        let msg
        try { msg = JSON.parse(ev.data) } catch (e) { return }
        emit(msg.t, msg)
      } else {
        // Binary frame: deflated chunk -> inflate -> decode -> notify.
        // Buffer chunks that arrive before any handler is registered
        // (the renderer initializes asynchronously after login).
        if (!binaryHandlersReady) {
          if (pendingBinary.length < 500) pendingBinary.push(ev.data)
          return
        }
        dispatchBinary(ev.data)
      }
    }
  }

  /**
   * Full binary pipeline: inflate (deflate) -> ChunkCodec.decodeChunk ->
   * binary handlers receive a decoded chunk object
   * { chunkX, chunkZ, minY, count, entries }.
   *
   * Perf: the payload is piped through the DecompressionStream reader
   * directly — the old code wrapped it in a Response, then a Blob, then
   * copied the pieces into one buffer (3 copies + 2 allocations per chunk).
   */
  function dispatchBinary (data) {
    inflateChunk(data, (raw) => {
      let decoded
      try {
        decoded = window.ChunkCodec.decodeChunk(raw)
      } catch (e) {
        console.error('chunk decode failed', e)
        return
      }
      for (const fn of binaryHandlers) {
        try { fn(decoded) } catch (e) { console.error('binary handler error', e) }
      }
    })
  }

  /** Decompresses (zlib deflate) a chunk payload using the Compression API. */
  function inflateChunk (compressed, cb) {
    if (typeof DecompressionStream === 'undefined') {
      console.warn('DecompressionStream not supported — update your browser')
      return
    }
    const ds = new DecompressionStream('deflate')
    const stream = new Blob([compressed]).stream().pipeThrough(ds)
    streamToBuffer(stream).then(cb).catch((e) => {
      console.error('chunk decompression failed', e)
    })
  }

  async function streamToBuffer (stream) {
    const reader = stream.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.length
    }
    const out = new Uint8Array(total)
    let off = 0
    for (const c of chunks) { out.set(c, off); off += c.length }
    return out
  }

  function onBinaryChunk (fn) {
    binaryHandlers.push(fn)
    // First registration: replay chunks that were buffered while nobody
    // was listening (renderer init races with the chunk stream).
    if (!binaryHandlersReady) {
      binaryHandlersReady = true
      const queue = pendingBinary.splice(0)
      for (const data of queue) dispatchBinary(data)
    }
  }

  function send (obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj))
  }

  function isOpen () { return !!(ws && ws.readyState === WebSocket.OPEN) }
  function close () { if (ws) { try { ws.close() } catch (e) {} } }

  return { connect, send, on, onBinaryChunk, isOpen, close, emit }
})()

// Make Net available both as a module and a global (classic scripts)
if (typeof module !== 'undefined' && module.exports) module.exports = Net
window.Net = Net
