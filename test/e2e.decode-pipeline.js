// Simulates the BROWSER decode pipeline (net.js + chunkCodec.js)
// against the real server + real Minecraft server.
const WebSocket = require('ws')
const zlib = require('zlib')

// Load the client chunkCodec.js (it sets window.ChunkCodec in browser; here we require it)
const codecSrc = require('fs').readFileSync('public/js/chunkCodec.js', 'utf8')
// Evaluate in a sandbox with a fake window (module pattern uses window + module)
const sandboxWindow = {}
new Function('window', 'module', codecSrc)(sandboxWindow, undefined)
const ChunkCodec = sandboxWindow.ChunkCodec
if (!ChunkCodec) { console.error('FAIL: ChunkCodec not exported'); process.exit(1) }
console.log('✓ chunkCodec.js chargé, decodeChunk:', typeof ChunkCodec.decodeChunk)

const ws = new WebSocket('ws://127.0.0.1:3000/ws')
ws.binaryType = 'nodebuffer'
let decodedCount = 0
let errCount = 0

ws.on('open', () => {
  ws.send(JSON.stringify({ t: 'connect', host: '163.5.201.7', port: 14636, username: 'CodecTest' + Math.floor(Math.random()*999) }))
})

ws.on('message', (data, isBinary) => {
  if (!isBinary) return
  try {
    // === EXACT pipeline from net.js: inflate then decode ===
    const raw = zlib.inflateSync(data)
    const decoded = ChunkCodec.decodeChunk(raw)
    if (!Array.isArray(decoded.entries)) throw new Error('entries is not an array!')
    if (decoded.entries.length !== decoded.count) throw new Error('count mismatch')
    decodedCount++
    if (decodedCount === 1) {
      const e = decoded.entries[0]
      console.log('✓ 1er chunk décodé:', JSON.stringify({ chunkX: decoded.chunkX, chunkZ: decoded.chunkZ, minY: decoded.minY, count: decoded.count }))
      console.log('  1re entrée:', JSON.stringify(e))
    }
    if (decodedCount >= 5) {
      console.log(`✓ SUCCÈS: ${decodedCount} chunks décodés avec le pipeline navigateur, ${errCount} erreurs`)
      ws.close(); process.exit(0)
    }
  } catch (e) {
    errCount++
    if (errCount === 1) console.error('✗ decode error:', e.message)
  }
})

setTimeout(() => { console.log(`timeout: decoded=${decodedCount} err=${errCount}`); process.exit(decodedCount > 0 ? 0 : 1) }, 40000)
