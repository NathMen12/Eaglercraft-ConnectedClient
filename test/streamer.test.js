'use strict'

/**
 * Unit test of the chunk streaming pipeline (no Minecraft server involved):
 *
 *   fake column (prismarine-chunk) -> WorldStreamer.serializeChunk
 *   -> zlib inflate -> ChunkCodec-equivalent decode -> assertions
 *
 * Run: node test/streamer.test.js
 */

const assert = require('assert')
const zlib = require('zlib')
const mcDataLoader = require('minecraft-data')
const { WorldStreamer } = require('../server/worldStreamer')
// Load the REAL client codec (public/js/chunkCodec.js) so this test exercises
// the exact browser decode path, not a re-implementation.
const codecSrc = require('fs').readFileSync(require('path').join(__dirname, '..', 'public', 'js', 'chunkCodec.js'), 'utf8')
const sandboxWindow = {}
new Function('window', 'module', codecSrc)(sandboxWindow, undefined)
const ChunkCodec = sandboxWindow.ChunkCodec
assert(ChunkCodec && typeof ChunkCodec.decodeChunk === 'function', 'client ChunkCodec loaded')

const mcData = mcDataLoader('1.21.9')
const ChunkColumn = require('prismarine-chunk')('1.21.9')

// --- Build a fake world column -------------------------------------------
// A flat 1.21 world: bedrock at y=-64, stone layers, grass at y=20, air above
const column = new ChunkColumn()
const minY = column.minY
const worldHeight = column.worldHeight

const bedrock = mcData.blocksByName.bedrock
const stone = mcData.blocksByName.stone
const grass = mcData.blocksByName.grass_block
const dirt = mcData.blocksByName.dirt
const air = mcData.blocksByName.air
// plains: a real biome with temperature/downfall for the colormap sampling
const plains = mcData.biomesArray.find((b) => b.name === 'plains')

for (let x = 0; x < 16; x++) {
  for (let z = 0; z < 16; z++) {
    column.setBlock({ x, y: minY, z }, { stateId: bedrock.defaultState })
    for (let y = minY + 1; y < 20; y++) {
      column.setBlock({ x, y, z }, { stateId: stone.defaultState })
    }
    column.setBlock({ x, y: 20, z }, { stateId: dirt.defaultState })
    column.setBlock({ x, y: 21, z }, { stateId: grass.defaultState })
    // setBlock's biome option takes an OBJECT ({id}) — a raw number was
    // silently ignored, leaving biome undefined and the tint at 0 (gray
    // grass bug). setBiome is the explicit path.
    column.setBiome({ x, y: 21, z }, plains.id)
    // air above stays implicit
  }
}
// Non-grass layers get a biome too (the streamer samples the biome at every
// block position; without one the section defaults to 0 = badlands).
for (let x = 0; x < 16; x++) {
  for (let z = 0; z < 16; z++) {
    for (let y = minY; y <= 20; y++) column.setBiome({ x, y, z }, plains.id)
  }
}

// Fake bot exposing the column (mimics bot.world's sync wrapper API)
const fakeBot = {
  world: {
    getColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null),
    getLoadedColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null)
  }
}

// Vanilla-like grass colormap: every pixel plain green (80,190,70).
// _colormapSample reads it at the biome's (temperature, downfall).
const { PNG } = require('pngjs')
const grassColormap = new PNG({ width: 256, height: 256 })
for (let i = 0; i < grassColormap.data.length; i += 4) {
  grassColormap.data[i] = 80; grassColormap.data[i + 1] = 190
  grassColormap.data[i + 2] = 70; grassColormap.data[i + 3] = 255
}
const streamer = new WorldStreamer({ bot: fakeBot, mcData, renderDistance: 4 })
streamer.colormaps = { grass: grassColormap, foliage: grassColormap }

// --- Serialize ------------------------------------------------------------
const payload = streamer.serializeChunk(0, 0)
assert(payload, 'serializeChunk returned a payload')
assert(Buffer.isBuffer(payload), 'payload is a Buffer')

const raw = zlib.inflateSync(payload)
assert.strictEqual(raw.readUInt8(0), 2, 'format version is 2 (biome tint)')

// Decode through the REAL client codec — this is the browser pipeline.
const decoded = ChunkCodec.decodeChunk(new Uint8Array(raw))
console.log('✓ client codec decodes the v2 payload:', JSON.stringify({
  chunkX: decoded.chunkX, chunkZ: decoded.chunkZ, minY: decoded.minY, count: decoded.count
}))
assert(decoded.entries.length === decoded.count, 'decoded count matches header')
assert(decoded.entries.every((e) => typeof e.tint === 'number'), 'entries carry the tint field')

const chunkX = raw.readInt32LE(1)
const chunkZ = raw.readInt32LE(5)
const payloadMinY = raw.readInt32LE(9)
const count = raw.readUInt16LE(13)
assert.strictEqual(chunkX, 0)
assert.strictEqual(chunkZ, 0)
assert.strictEqual(payloadMinY, minY)
assert(count > 0, 'chunk has visible blocks')
console.log(`✓ chunk serialized: ${count} visible blocks, ${payload.length} bytes compressed (vs ${raw.length} raw, ${16 * 16 * 84} total blocks in column)`)

// --- Decode entries (raw manual read, cross-checks the client codec) ------
let o = 15
const blocks = []
for (let i = 0; i < count; i++) {
  const x = raw.readUInt8(o); o += 1
  const y = raw.readUInt16LE(o); o += 2
  const z = raw.readUInt8(o); o += 1
  const blockId = raw.readUInt16LE(o); o += 2
  const faceMask = raw.readUInt8(o); o += 1
  o += 2 // v2 tint (RGB565)
  blocks.push({ x, y, z, blockId, faceMask })
}

// Every entry must be decodable and consistent
assert.strictEqual(o, raw.length, 'payload fully consumed')
// Cross-check: the manual raw read and the REAL client codec must agree
assert.strictEqual(blocks.length, decoded.entries.length, 'manual decode === client codec count')
for (let i = 0; i < blocks.length; i++) {
  const a = blocks[i]
  const b = decoded.entries[i]
  assert.strictEqual(a.x, b.x); assert.strictEqual(a.y, b.y); assert.strictEqual(a.z, b.z)
  assert.strictEqual(a.blockId, b.blockId); assert.strictEqual(a.faceMask, b.faceMask)
}
console.log('✓ client codec output === manual raw decode (every field, every entry)')

// --- Biome tint (V1.1.2 gray-grass regression test) -------------------------
// The grass layer must carry a NON-ZERO tint sampled from the (green) grass
// colormap. A zero tint = gray grass — the exact V1.1.0/V1.1.1 bug, caused by
// _buildStateLookup rejecting minecraft-data's OBJECT-shaped blocksByStateId
// (only arrays were accepted, so the tint table stayed empty).
{
  const grassEntries = decoded.entries.filter((e) => e.blockId === grass.id)
  assert(grassEntries.length > 0, 'grass entries present')
  const tinted = grassEntries.filter((e) => e.tint !== 0 && e.tint !== undefined)
  assert.strictEqual(tinted.length, grassEntries.length, 'every grass entry carries a biome tint')
  // Decode one tint: RGB565 -> RGB, expect the colormap's green (~80,188,64)
  const t = tinted[0].tint
  const r = ((t >> 11) & 0x1f) << 3
  const g = ((t >> 5) & 0x3f) << 2
  const b = (t & 0x1f) << 3
  assert(r >= 60 && r <= 100, `tint red channel in range (got ${r})`)
  assert(g >= 150 && g <= 210, `tint green channel dominant (got ${g})`)
  assert(b <= 100, `tint blue channel low (got ${b})`)
  console.log(`✓ grass biome tint: RGB(${r},${g},${b}) — green, not gray`)
}

// The grass block layer (y=21 local y=21-minY) must be visible with the top
// face (+Y bit 4) set; blocks below it hidden (faceMask without top bit)
const grassLocalY = 21 - minY
const grassBlocks = blocks.filter((b) => b.y === grassLocalY && b.blockId === grass.id)
assert.strictEqual(grassBlocks.length, 256, 'all 256 grass blocks are visible')
for (const g of grassBlocks) {
  assert(g.faceMask & 4, 'grass top face visible')
  assert(!(g.faceMask & 8), 'grass bottom face hidden (dirt below)')
}
console.log('✓ grass layer: 256 blocks, top faces visible, bottom faces culled')

// Interior stone must NOT be present (fully enclosed)
const stoneBlocks = blocks.filter((b) => b.blockId === stone.id)
const interior = stoneBlocks.filter((b) => {
  // interior blocks: not on the x/z borders, not adjacent to air
  return b.x > 0 && b.x < 15 && b.z > 0 && b.z < 15 && b.y < grassLocalY - 1 && b.y > 1
})
assert.strictEqual(interior.length, 0, 'no interior stone blocks were sent')
console.log('✓ interior stone blocks culled (network saving works)')

// Bedrock at the bottom: bottom faces visible (out of world)
const bedrockBlocks = blocks.filter((b) => b.blockId === bedrock.id)
assert.strictEqual(bedrockBlocks.length, 256, 'all 256 bedrock blocks visible')
for (const b of bedrockBlocks) {
  assert(b.faceMask & 8, 'bedrock bottom face exposed (world bottom)')
}
console.log('✓ bedrock layer bottom faces exposed')

// Compression ratio
const totalBlocks = 16 * 16 * (worldHeight - 2) // rough
const ratio = (1 - payload.length / raw.length) * 100
console.log(`✓ deflate compression: ${raw.length} -> ${payload.length} bytes (${ratio.toFixed(0)}% saved)`)

// Parity test: fast (flattened) scan vs slow (getBlockStateId) scan must
// produce IDENTICAL entries on a mixed-content 1.21 column.
const column2 = new ChunkColumn()
{
  const minY2 = column2.minY
  const glass = mcData.blocksByName.glass
  const torch = mcData.blocksByName.torch
  const water = mcData.blocksByName.water
  const log = mcData.blocksByName.oak_log
  // Messy column: layers + scattered blocks + transparency mix
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      column2.setBlock({ x, y: minY2, z }, { stateId: bedrock.defaultState, biome: 1 })
      column2.setBlock({ x, y: minY2 + 1, z }, { stateId: stone.defaultState, biome: 1 })
    }
  }
  for (let i = 0; i < 64; i++) {
    column2.setBlock({ x: i & 15, y: minY2 + 2 + (i % 8), z: (i * 7) & 15 }, {
      stateId: [glass.defaultState, torch.defaultState, water.defaultState, log.defaultState][i % 4], biome: 1
    })
  }
}
const fakeBot2 = {
  world: {
    getColumn: (cx, cz) => (cx === 0 && cz === 0 ? column2 : null),
    getLoadedColumn: (cx, cz) => (cx === 0 && cz === 0 ? column2 : null)
  }
}
const streamer2 = new WorldStreamer({ bot: fakeBot2, mcData, renderDistance: 4 })

const fast = streamer2.serializeChunk(0, 0)
// Force the slow path: wrap the column so only the getBlockStateId-based
// interface is exposed (no sections array -> generic scan branch)
const wrappedColumn = {
  get minY () { return column2.minY },
  get worldHeight () { return column2.worldHeight },
  getBlockStateId: (pos) => column2.getBlockStateId(pos)
}
const fakeBotSlow = {
  world: {
    getColumn: (cx, cz) => (cx === 0 && cz === 0 ? wrappedColumn : null),
    getLoadedColumn: (cx, cz) => (cx === 0 && cz === 0 ? wrappedColumn : null)
  }
}
const streamerSlow = new WorldStreamer({ bot: fakeBotSlow, mcData, renderDistance: 4 })
const slow = streamerSlow.serializeChunk(0, 0)

assert(fast && slow, 'both paths produced a payload')
const inflate = (buf) => zlib.inflateSync(buf).toString('base64')
assert.strictEqual(inflate(fast), inflate(slow), 'fast scan (flattened sections) === slow scan (getBlockStateId)')
console.log('✓ fast/slow scan parity on mixed-content column (glass/torch/water/log)')
console.log(`  payload: ${fast.length} bytes`)

console.log('\nAll streamer unit tests passed ✓')
