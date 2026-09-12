'use strict'

/**
 * chunkCodec.js (client side)
 *
 * Decodes the compact binary chunk format produced by
 * server/worldStreamer.js:
 *
 *   u8  version = 1 (7 B/entry) or 2 (9 B/entry)
 *   i32 chunkX, i32 chunkZ, i32 minY
 *   u16 blockCount
 *   blockCount * entry:
 *     v1: u8 localX, u16 localY, u8 localZ, u16 blockId, u8 faceMask
 *     v2: same + u16 tint (packed RGB565, 0 = untinted)
 *
 * All integers are little-endian.
 */

const ChunkCodec = (() => {
  // Fast little-endian readers (function-scope, monomorphic)
  function readInt32 (b, o) {
    return (b[o]) | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)
  }

  function readUint16 (b, o) {
    return b[o] | (b[o + 1] << 8)
  }

  function decodeChunk (buf) {
    // buf: Uint8Array (already decompressed)
    if (buf.length < 15) throw new Error('chunk payload too short')
    let o = 0
    const version = buf[o]; o += 1
    // v1 = 7 B/entry (no tint), v2 = 9 B/entry (biome tint RGB565)
    const entrySize = version === 2 ? 9 : version === 1 ? 7 : null
    if (entrySize === null) throw new Error(`unsupported chunk format version ${version}`)
    const chunkX = readInt32(buf, o); o += 4
    const chunkZ = readInt32(buf, o); o += 4
    const minY = readInt32(buf, o); o += 4
    const count = readUint16(buf, o); o += 2
    if (buf.length < o + count * entrySize) throw new Error('chunk payload truncated')
    const entries = new Array(count)
    for (let i = 0; i < count; i++) {
      const x = buf[o]; o += 1
      const y = readUint16(buf, o); o += 2
      const z = buf[o]; o += 1
      const blockId = readUint16(buf, o); o += 2
      const faceMask = buf[o]; o += 1
      const tint = version === 2 ? readUint16(buf, o) : 0
      o += entrySize - 7 // 0 for v1, 2 (tint) for v2
      entries[i] = { x, y, z, blockId, faceMask, tint }
    }
    return { chunkX, chunkZ, minY, count, entries }
  }

  return { decodeChunk }
})()

if (typeof module !== 'undefined' && module.exports) module.exports = ChunkCodec
window.ChunkCodec = ChunkCodec
