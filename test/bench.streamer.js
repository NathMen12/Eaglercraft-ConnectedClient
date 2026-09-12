'use strict'

/**
 * Benchmark of the chunk serialization pipeline (no Minecraft server):
 * builds a REALISTIC 1.21 column (surface at y=70, mostly empty sections
 * above — like a real world) and times WorldStreamer.serializeChunk.
 *
 * Run: node test/bench.streamer.js
 */

const mcDataLoader = require('minecraft-data')
const { WorldStreamer } = require('../server/worldStreamer')

const mcData = mcDataLoader('1.21.9')
const ChunkColumn = require('prismarine-chunk')('1.21.9')

const stone = mcData.blocksByName.stone
const grass = mcData.blocksByName.grass_block
const dirt = mcData.blocksByName.dirt
const bedrock = mcData.blocksByName.bedrock

function buildRealisticColumn () {
  const column = new ChunkColumn()
  const minY = column.minY
  for (let x = 0; x < 16; x++) {
    for (let z = 0; z < 16; z++) {
      // bedrock floor, stone up to 68, dirt, grass at 70 — air everywhere else
      column.setBlock({ x, y: minY, z }, { stateId: bedrock.defaultState, biome: 1 })
      for (let y = minY + 1; y <= 68; y++) {
        column.setBlock({ x, y, z }, { stateId: stone.defaultState, biome: 1 })
      }
      column.setBlock({ x, y: 69, z }, { stateId: dirt.defaultState, biome: 1 })
      column.setBlock({ x, y: 70, z }, { stateId: grass.defaultState, biome: 1 })
    }
  }
  return column
}

const column = buildRealisticColumn()
const fakeBot = {
  world: {
    getColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null),
    getLoadedColumn: (cx, cz) => (cx === 0 && cz === 0 ? column : null)
  }
}
const streamer = new WorldStreamer({ bot: fakeBot, mcData, renderDistance: 4 })

// Warmup + correctness
const payload = streamer.serializeChunk(0, 0)
if (!payload) { console.error('✗ no payload'); process.exit(1) }

// --- Timing: 200 chunks ----------------------------------------------------
const N = 200
const t0 = process.hrtime.bigint()
let bytes = 0
for (let i = 0; i < N; i++) {
  const p = streamer.serializeChunk(0, 0)
  bytes += p.length
}
const t1 = process.hrtime.bigint()
const msPerChunk = Number(t1 - t0) / 1e6 / N

// Block update timing (the old path allocated 7 Block objects + Vec3s)
const t2 = process.hrtime.bigint()
const M = 2000
for (let i = 0; i < M; i++) {
  streamer.serializeBlockUpdate(5, 70, 5)
}
const t3 = process.hrtime.bigint()
const usPerUpdate = Number(t3 - t2) / 1e6 / M

console.log(`✓ serializeChunk:        ${msPerChunk.toFixed(2)} ms/chunk  (${(1000 / msPerChunk).toFixed(0)} chunks/s per core)`)
console.log(`  payload: ${(bytes / N).toFixed(0)} bytes/chunk compressed`)
console.log(`✓ serializeBlockUpdate: ${usPerUpdate.toFixed(1)} µs/update  (${(1e3 / usPerUpdate / 1000).toFixed(0)}k updates/s)`)
console.log('\nBenchmark passed ✓')
