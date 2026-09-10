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

for (let x = 0; x < 16; x++) {
  for (let z = 0; z < 16; z++) {
    column.setBlock({ x, y: minY, z }, { stateId: bedrock.defaultState, biome: 1 })
    for (let y = minY + 1; y < 20; y++) {
      column.setBlock({ x, y, z }, { stateId: stone.defaultState, biome: 1 })
    }
    column.setBlock({ x, y: 20, z }, { stateId: dirt.defaultState, biome: 1 })
    column.setBlock({ x, y: 21, z }, { stateId: grass.defaultState, biome: 1 })
    // air above stays implicit
  }
}

// Fake bot exposing the column (mimics bot.world's sync wrapper API)
const fakeBot = {
  world: {
    getColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null),
    getLoadedColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null)
  }
}

const streamer = new WorldStreamer({ bot: fakeBot, mcData, renderDistance: 4 })

// --- Serialize ------------------------------------------------------------
const payload = streamer.serializeChunk(0, 0)
assert(payload, 'serializeChunk returned a payload')
assert(Buffer.isBuffer(payload), 'payload is a Buffer')

const raw = zlib.inflateSync(payload)
assert.strictEqual(raw.readUInt8(0), 1, 'format version is 1')

const chunkX = raw.readInt32LE(1)
const chunkZ = raw.readInt32LE(5)
const payloadMinY = raw.readInt32LE(9)
const count = raw.readUInt16LE(13)
assert.strictEqual(chunkX, 0)
assert.strictEqual(chunkZ, 0)
assert.strictEqual(payloadMinY, minY)
assert(count > 0, 'chunk has visible blocks')
console.log(`✓ chunk serialized: ${count} visible blocks, ${payload.length} bytes compressed (vs ${raw.length} raw, ${16 * 16 * 84} total blocks in column)`)

// --- Decode entries ------------------------------------------------------
let o = 15
const blocks = []
for (let i = 0; i < count; i++) {
  const x = raw.readUInt8(o); o += 1
  const y = raw.readUInt16LE(o); o += 2
  const z = raw.readUInt8(o); o += 1
  const blockId = raw.readUInt16LE(o); o += 2
  const faceMask = raw.readUInt8(o); o += 1
  blocks.push({ x, y, z, blockId, faceMask })
}

// Every entry must be decodable and consistent
assert.strictEqual(o, raw.length, 'payload fully consumed')

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

console.log('\nAll streamer unit tests passed ✓')
