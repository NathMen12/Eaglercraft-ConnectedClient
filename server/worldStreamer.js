'use strict'

/**
 * worldStreamer.js
 *
 * Streams the bot's world to the browser client as compact binary chunks.
 *
 * Key optimization (user request): only blocks touching air (or a
 * transparent block) are sent. Each block entry carries a 6-bit mask of its
 * visible faces so the client only builds the geometry it needs.
 *
 * Binary chunk format (little-endian, then zlib-deflated):
 *   u8  version = 1
 *   i32 chunkX, i32 chunkZ, i32 minY
 *   u16 blockCount
 *   blockCount * entry:
 *     u8 localX, u16 localY (block index in column), u8 localZ
 *     u16 blockId
 *     u8  faceMask (bit0..5 = +X,-X,+Y,-Y,+Z,-Z)
 *   One entry costs 7 bytes before compression.
 */

const zlib = require('zlib')
const { Vec3 } = require('vec3')

// Chunk geometry constants
const CHUNK_WIDTH = 16

// Face order (bit index): +X, -X, +Y, -Y, +Z, -Z
const FACES = [
  { dx: 1, dy: 0, dz: 0, bit: 1 },
  { dx: -1, dy: 0, dz: 0, bit: 2 },
  { dy: 1, dx: 0, dz: 0, bit: 4 },
  { dy: -1, dx: 0, dz: 0, bit: 8 },
  { dx: 0, dy: 0, dz: 1, bit: 16 },
  { dx: 0, dy: 0, dz: -1, bit: 32 }
]

class WorldStreamer {
  /**
   * @param {object} opts
   * @param {object} opts.bot           mineflayer bot
   * @param {object} opts.mcData        minecraft-data registry for the version
   * @param {number} opts.renderDistance chunks streamed around the bot
   */
  constructor (opts) {
    this.bot = opts.bot
    this.mcData = opts.mcData
    this.renderDistance = opts.renderDistance

    // id -> block info
    this.blocksById = []
    for (const block of this.mcData.blocksArray) {
      this.blocksById[block.id] = block
    }
    // Blocks the camera can see through — a face touching them is visible
    this.transparentBlockIds = new Set()
    for (const block of this.mcData.blocksArray) {
      if (block.transparent || block.boundingBox === 'empty') {
        this.transparentBlockIds.add(block.id)
      }
    }
    // Blocks never streamed (air variants & technical blocks)
    this.skippedBlocks = new Set()
    for (const name of ['air', 'cave_air', 'void_air', 'structure_void', 'moving_piston']) {
      const b = this.mcData.blocksByName[name]
      if (b) this.skippedBlocks.add(b.id)
    }
    // stateId -> block info cache (populated lazily)
    this._stateCache = new Map()
  }

  /** Maps a state id to the block info object (cached), or null. */
  stateIdToBlock (stateId) {
    const cached = this._stateCache.get(stateId)
    if (cached !== undefined) return cached
    const info = this.mcData.blocksByStateId ? this.mcData.blocksByStateId[stateId] : undefined
    const result = info || null
    this._stateCache.set(stateId, result)
    return result
  }

  /**
   * Computes which of the 6 faces of the block at local (x,y,z) in a column
   * are visible. At chunk borders the face is exposed (safe default) until
   * the neighbor chunk loads; block updates correct it afterwards.
   */
  computeFaceMask (column, x, y, z, minY, maxY) {
    let mask = 0
    for (const f of FACES) {
      const nx = x + f.dx
      const ny = y + f.dy
      const nz = z + f.dz
      if (ny < minY || ny >= maxY) {
        mask |= f.bit // outside the world vertically
        continue
      }
      if (nx < 0 || nx >= CHUNK_WIDTH || nz < 0 || nz >= CHUNK_WIDTH) {
        mask |= f.bit // chunk border — expose, corrected on neighbor load
        continue
      }
      const nStateId = column.getBlockStateId({ x: nx, y: ny, z: nz })
      if (nStateId === 0) {
        mask |= f.bit // air neighbor
        continue
      }
      const nBlock = this.stateIdToBlock(nStateId)
      if (!nBlock || this.transparentBlockIds.has(nBlock.id)) {
        mask |= f.bit // transparent neighbor
      }
    }
    return mask
  }

  /**
   * Serializes one chunk column into the compact binary format.
   * Returns a deflated Buffer, or null when the column has nothing visible.
   */
  serializeChunk (chunkX, chunkZ) {
    // bot.world is prismarine-world's *sync* wrapper: getColumn() there is
    // the loaded-column getter.
    const column = this.bot.world.getColumn(chunkX, chunkZ)
    if (!column) return null

    const minY = column.minY ?? 0
    const worldHeight = column.worldHeight ?? 256
    const maxY = minY + worldHeight

    const entries = []
    for (let y = minY; y < maxY; y++) {
      for (let z = 0; z < CHUNK_WIDTH; z++) {
        for (let x = 0; x < CHUNK_WIDTH; x++) {
          const stateId = column.getBlockStateId({ x, y, z })
          if (stateId === 0) continue
          const block = this.stateIdToBlock(stateId)
          if (!block || this.skippedBlocks.has(block.id)) continue
          const faceMask = this.computeFaceMask(column, x, y, z, minY, maxY)
          if (faceMask === 0) continue
          entries.push({ x, y: y - minY, z, blockId: block.id, faceMask })
        }
      }
    }

    if (entries.length === 0) return null
    return this.encodeChunk(chunkX, chunkZ, minY, entries)
  }

  /**
   * Encodes entries and deflates the buffer.
   */
  encodeChunk (chunkX, chunkZ, minY, entries) {
    const count = entries.length
    const headerSize = 15 // v(1) + chunkX(4) + chunkZ(4) + minY(4) + count(2)
    const buf = Buffer.alloc(headerSize + count * 7)
    let o = 0
    buf.writeUInt8(1, o); o += 1
    buf.writeInt32LE(chunkX, o); o += 4
    buf.writeInt32LE(chunkZ, o); o += 4
    buf.writeInt32LE(minY, o); o += 4
    buf.writeUInt16LE(count, o); o += 2
    for (const e of entries) {
      buf.writeUInt8(e.x, o); o += 1
      buf.writeUInt16LE(e.y, o); o += 2
      buf.writeUInt8(e.z, o); o += 1
      buf.writeUInt16LE(e.blockId, o); o += 2
      buf.writeUInt8(e.faceMask, o); o += 1
    }
    return zlib.deflateSync(buf)
  }

  /**
   * Serializes a single block update (after chunk edits) so the client can
   * patch its meshes. Takes WORLD coordinates.
   */
  serializeBlockUpdate (worldX, worldY, worldZ) {
    const chunkX = worldX >> 4
    const chunkZ = worldZ >> 4
    const localX = worldX & 15
    const localZ = worldZ & 15
    const column = this.bot.world.getColumn(chunkX, chunkZ)
    const stateId = column
      ? column.getBlockStateId({ x: localX, y: worldY, z: localZ })
      : 0
    const block = this.stateIdToBlock(stateId)
    const blockId = block && !this.skippedBlocks.has(block.id) ? block.id : 0
    const faceMask = this.computeGlobalFaceMask(worldX, worldY, worldZ)
    return {
      x: worldX, y: worldY, z: worldZ,
      blockId, faceMask
    }
  }

  /**
   * Face mask computed across chunk borders. Uses the sync wrapper's
   * getBlock() (slower path, used only for individual block updates).
   */
  computeGlobalFaceMask (worldX, worldY, worldZ) {
    let mask = 0
    const world = this.bot.world
    for (const f of FACES) {
      const nx = worldX + f.dx
      const ny = worldY + f.dy
      const nz = worldZ + f.dz
      let nBlock = null
      try {
        nBlock = world.getBlock(new Vec3(nx, ny, nz))
      } catch (e) { nBlock = null }
      if (!nBlock) {
        mask |= f.bit // unloaded neighbor chunk: expose the face (safe default)
        continue
      }
      if (nBlock.name === 'air' || this.transparentBlockIds.has(nBlock.id)) {
        mask |= f.bit
      }
    }
    return mask
  }
}

module.exports = { WorldStreamer, FACES }

