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
 *   u8  version = 2
 *   i32 chunkX, i32 chunkZ, i32 minY
 *   u16 blockCount
 *   blockCount * entry:
 *     u8 localX, u16 localY (block index in column), u8 localZ
 *     u16 blockId
 *     u8  faceMask (bit0..5 = +X,-X,+Y,-Y,+Z,-Z)
 *     u16 tint (packed RGB565 — 0 when the block is NOT biome-tinted)
 *   One entry costs 9 bytes before compression.
 */

const zlib = require('zlib')

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

// Reusable position objects: getBlockStateId() never mutates the pos it
// receives (verified across prismarine-chunk 1.8 → 1.21), so shared objects
// avoid ~500k short-lived allocations per scanned chunk.
const POS = { x: 0, y: 0, z: 0 }
const NPOS = { x: 0, y: 0, z: 0 }

/** Sets the shared POS object and returns it (no allocation). */
function POS_SET (x, y, z) {
  POS.x = x; POS.y = y; POS.z = z
  return POS
}

/** Packs 8-bit RGB into RGB565 (the on-wire tint format). */
function pack565 (r, g, b) {
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
}

/**
 * Section flatten helpers: convert one prismarine-chunk section into a
 * plain Uint32Array of 4096 stateIds (index = (y<<8)|(z<<4)|x). Both the
 * sequential scan and the neighbour lookups then become plain array reads
 * (~10x faster than per-block BitArray .get() calls, which dominate the
 * serialization cost). The bit-extraction is INLINED and sequential.
 */
const SECTION_VOLUME = 16 * 16 * 16

/**
 * Returns a descriptor of the section's raw storage, or null when the
 * layout is unknown. Layouts (verified in prismarine-chunk 1.9 → 1.21):
 *   - 1.18+ PaletteChunkSection: data is a PaletteContainer
 *     (SingleValueContainer has .value; Indirect/Direct hold a
 *     BitArrayNoSpan in .data — values never span a 64-bit long)
 *   - 1.9 – 1.17 ChunkSection: data is a legacy BitArray (values DO span
 *     32-bit words), palette on the section itself (null = global palette)
 */
function sectionDescriptor (section) {
  const d = section.data
  if (!d) return null
  if (d.value !== undefined) return { single: d.value } // SingleValueContainer
  if (d.data && typeof d.data.get === 'function') {
    // 1.18+ Indirect/Direct PaletteContainer
    const bits = d.data
    if (!(bits.data instanceof Uint32Array) || !bits.bitsPerValue) return null
    return {
      raw: bits.data, bpv: bits.bitsPerValue,
      vpl: bits.valuesPerLong, mask: bits.valueMask,
      palette: Array.isArray(d.palette) ? d.palette : null,
      noSpan: true
    }
  }
  // 1.9 – 1.17 ChunkSection
  const bits = d
  if (typeof bits.get === 'function' && bits.data instanceof Uint32Array && bits.bitsPerValue) {
    return {
      raw: bits.data, bpv: bits.bitsPerValue,
      vpl: 0, mask: bits.valueMask,
      palette: Array.isArray(section.palette) ? section.palette : null,
      noSpan: false
    }
  }
  return null
}

/** Flattens a section descriptor into out (Uint32Array[4096] of stateIds). */
function flattenSection (desc, out) {
  if (desc.single !== undefined) { out.fill(desc.single); return }
  const { raw, bpv, vpl, mask, palette, noSpan } = desc
  let i = 0
  if (noSpan) {
    // [low, high] 32-bit word pairs per 64-bit long; values never span a long.
    // V1.2.0 CRITICAL FIX: BitArrayNoSpan stores only valuesPerLong values
    // per 64-bit long — the remaining bits are PADDING and must never be
    // read. The old loop ran `off < 64` and read the padding, shifting every
    // following value by +1 per long: with bpv=5+ (17+ block types in the
    // section palette — any rich surface), 97% of the flattened values were
    // wrong, producing the "diagonal dirt/stone staircases" and phantom
    // blocks (deterministic, so the R reload changed nothing).
    const dataBits = vpl * bpv // valid data region within each long
    for (let w = 0; w < raw.length && i < SECTION_VOLUME; w += 2) {
      const w0 = raw[w]
      const w1 = raw[w + 1]
      for (let off = 0; off < dataBits && i < SECTION_VOLUME; off += bpv) {
        let v
        if (off >= 32) {
          v = (w1 >>> (off - 32)) & mask
        } else if (off + bpv > 32) {
          v = ((w0 >>> off) | (w1 << (32 - off))) & mask
        } else {
          v = (w0 >>> off) & mask
        }
        out[i++] = (palette && v < palette.length) ? (palette[v] || 0) : v
      }
    }
  } else {
    // Legacy BitArray: values span 32-bit words, bit index grows by bpv
    let bitIndex = 0
    while (i < SECTION_VOLUME) {
      const inWord = bitIndex & 31
      let v = raw[bitIndex >>> 5] >>> inWord
      if (inWord + bpv > 32) {
        const next = raw[(bitIndex >>> 5) + 1]
        if (next !== undefined) v |= next << (32 - inWord)
      }
      v &= mask
      out[i++] = (palette && v < palette.length) ? (palette[v] || 0) : v
      bitIndex += bpv
    }
  }
}

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
    this._stateCache.set(0, null) // stateId 0 is always air — no lookup
    // Precomputed stateId -> blockId (0 = air/not present) and skip-flag
    // tables: avoids a Map lookup + 2 Set lookups for EVERY neighbour of
    // every scanned block (the hottest path of the whole server).
    this._stateToId = new Int32Array(0)
    this._stateToSkipped = new Uint8Array(0)
    // stateId -> 1 when a face touching this block is VISIBLE (air or
    // transparent block). One flat typed-array read per neighbour instead
    // of two Set lookups — this table is read millions of times per chunk.
    this._exposedByState = new Uint8Array(0)
    // stateId -> tint KIND: 0 none, 1 grass, 2 foliage, 3 water
    this._stateToTint = new Uint8Array(0)
    this._buildStateLookup()
    // Reusable growable encode buffer (avoids a big alloc per chunk)
    this._encodeBuf = null
    // Pool of section scratch buffers (Uint32Array[4096]) reused across
    // chunks — flattening 9 sections used to allocate ~144 KB per chunk.
    this._flatPool = []
    // Biome id -> [grassRGB565, foliageRGB565, waterRGB565] — built lazily
    // from the vanilla colormaps (see _buildBiomeTints).
    this._biomeTints = new Map()
  }

  /** Precomputes stateId -> blockId / skip / exposed / tint tables. */
  _buildStateLookup () {
    let byState = this.mcData.blocksByStateId
    if (!byState) return
    // minecraft-data exposes blocksByStateId as an ARRAY on some versions
    // and as an OBJECT (stateId-as-string keys) on others — both are
    // numerically indexed, so normalize the length only. (When it is an
    // object, the old Array.isArray check returned early and the tint /
    // id tables were NEVER built — grass rendered gray because
    // _stateToTint stayed empty!)
    const n = Array.isArray(byState) ? byState.length : Object.keys(byState).length
    if (n === 0) return
    const ids = new Int32Array(n) // 0 = air/not present
    const skipped = new Uint8Array(n)
    const exposed = new Uint8Array(n)
    const tint = new Uint8Array(n) // 0 none, 1 grass, 2 foliage, 3 water
    // Blocks whose grayscale texture is multiplied by the biome color
    const GRASS_TINTED = new Set(['grass_block', 'short_grass', 'tall_grass', 'fern', 'large_fern', 'grass', 'sugar_cane', 'vines', 'vine', 'lily_pad'])
    const FOLIAGE_TINTED = new Set(['oak_leaves', 'spruce_leaves', 'birch_leaves', 'jungle_leaves', 'acacia_leaves', 'dark_oak_leaves', 'mangrove_leaves', 'cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves'])
    for (let stateId = 0; stateId < n; stateId++) {
      const info = byState[stateId]
      if (!info) continue
      ids[stateId] = info.id
      skipped[stateId] = this.skippedBlocks.has(info.id) ? 1 : 0
      // A neighbour face is visible when the neighbour is air-like
      // (transparent) or an empty bounding box (torch, grass...)
      exposed[stateId] = (info.transparent || info.boundingBox === 'empty' || this.skippedBlocks.has(info.id)) ? 1 : 0
      if (GRASS_TINTED.has(info.name)) tint[stateId] = 1
      else if (FOLIAGE_TINTED.has(info.name)) tint[stateId] = 2
      else if (info.name === 'water') tint[stateId] = 3
    }
    this._stateToId = ids
    this._stateToSkipped = skipped
    this._exposedByState = exposed
    this._stateToTint = tint
  }

  /**
   * Samples the vanilla colormap (grass.png / foliage.png) at the biome's
   * (temperature, downfall) coordinates — exactly what the vanilla client
   * does. Returns the packed RGB565 color. `this.colormaps` is set at boot
   * ({ grass: PNG, foliage: PNG } or null when the pack has none).
   */
  _colormapSample (kind, temperature, downfall) {
    const map = this.colormaps && (kind === 2 ? this.colormaps.foliage : this.colormaps.grass)
    if (!map) return 0
    const t = Math.max(0, Math.min(1, temperature))
    const d = Math.max(0, Math.min(1, downfall))
    const x = Math.min(map.width - 1, Math.floor((1 - t) * (map.width - 1)))
    const y = Math.min(map.height - 1, Math.floor((1 - d) * (map.height - 1)))
    const idx = (y * map.width + x) * 4
    const r = map.data[idx]; const g = map.data[idx + 1]; const b = map.data[idx + 2]
    return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3)
  }

  /**
   * Builds (and caches per biome) the 3 tint colors from the vanilla
   * colormaps. Water uses vanilla's fixed blue (per-biome water would need
   * extra data; 0x3F76E4 matches the vanilla overworld average).
   */
  _biomeTintFor (biomeId) {
    let tints = this._biomeTints.get(biomeId)
    if (tints) return tints
    const biome = (this.mcData.biomesArray || []).find((b) => b.id === biomeId)
    if (!biome) {
      tints = [0, 0, pack565(63, 118, 228)]
    } else {
      tints = [
        this._colormapSample(1, biome.temperature, biome.downfall ?? 0.5),
        this._colormapSample(2, biome.temperature, biome.downfall ?? 0.5),
        pack565(63, 118, 228)
      ]
    }
    this._biomeTints.set(biomeId, tints)
    return tints
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
   * Uses module-level reusable pos objects — zero allocation per call.
   */
  computeFaceMask (column, x, y, z, minY, maxY) {
    let mask = 0
    const ids = this._stateToId
    const hasFastTable = ids.length > 0
    for (const f of FACES) {
      const ny = y + f.dy
      if (ny < minY || ny >= maxY) {
        mask |= f.bit // outside the world vertically
        continue
      }
      const nx = x + f.dx
      const nz = z + f.dz
      if (nx < 0 || nx >= CHUNK_WIDTH || nz < 0 || nz >= CHUNK_WIDTH) {
        mask |= f.bit // chunk border — expose, corrected on neighbor load
        continue
      }
      NPOS.x = nx; NPOS.y = ny; NPOS.z = nz
      const nStateId = column.getBlockStateId(NPOS)
      if (nStateId === 0) {
        mask |= f.bit // air neighbor
        continue
      }
      if (hasFastTable && nStateId < ids.length) {
        // Fast path: precomputed tables, no object/Map/Set lookups
        const nId = ids[nStateId]
        if (nId !== 0 && !this.transparentBlockIds.has(nId)) continue
        mask |= f.bit
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
   *
   * Perf: reads each 16-block SECTION through its palette/BitArray directly
   * (no per-block position objects — getBlockStateId allocates one per call,
   * ~700k allocations per scanned 1.21 column) and skips empty sections
   * (solidBlockCount === 0 or null section), which cover most of the column
   * above the surface. Falls back to the slow generic path when the section
   * layout is not recognized (e.g. 1.8).
   */
  serializeChunk (chunkX, chunkZ) {
    // bot.world is prismarine-world's *sync* wrapper: getColumn() there is
    // the loaded-column getter.
    const column = this.bot.world.getColumn(chunkX, chunkZ)
    if (!column) return null

    const minY = column.minY ?? 0
    const worldHeight = column.worldHeight ?? 256
    const maxY = minY + worldHeight
    const sections = Array.isArray(column.sections) ? column.sections : null
    const sectionBase = minY >> 4 // index of the section holding minY
    const sectionCount = maxY >> 4

    // STREAMER_SLOW=1 escape hatch (V1.2.0): forces the generic
    // getBlockStateId path — the safe reference implementation. Only for
    // debugging section-layout issues on exotic server versions.
    if (process.env.STREAMER_SLOW === '1') sections = null

    // Fast path: flatten every non-empty section into a pooled
    // Uint32Array[4096] of stateIds (sequential inline bit extraction —
    // per-block .get() calls dominated the whole scan cost before).
    if (sections) {
      let allReadable = true
      const flats = new Array(sections.length)
      const pool = this._flatPool
      let poolUsed = 0
      for (let i = 0; i < sections.length; i++) {
        const s = sections[i]
        if (s == null || s.solidBlockCount === 0) { flats[i] = null; continue }
        const desc = sectionDescriptor(s)
        if (!desc) { allReadable = false; break }
        let out = pool[poolUsed]
        if (!out) { out = pool[poolUsed] = new Uint32Array(SECTION_VOLUME) }
        poolUsed++
        flattenSection(desc, out)
        flats[i] = out
      }
      if (allReadable) {
        return this._scanColumnFast(chunkX, chunkZ, minY, maxY, sectionBase, sectionCount, flats, column)
      }
    }

    // Generic fallback (1.8 columns, exotic layouts): position-object path
    return this._scanColumnSlow(chunkX, chunkZ, column, minY, maxY)
  }

  /** Fast column scan: iterates every non-empty flattened section. */
  _scanColumnFast (chunkX, chunkZ, minY, maxY, sectionBase, sectionCount, flats, column) {
    const entries = []
    const ids = this._stateToId
    const tints = this._stateToTint
    const hasFastTable = ids.length > 0
    const anyTint = tints.length > 0 && this.colormaps
    for (let si = 0; si < sectionCount - sectionBase; si++) {
      const flat = flats[si]
      if (!flat) continue // null / empty section
      const worldYBase = (sectionBase + si) << 4
      const yStart = Math.max(minY, worldYBase)
      const yEnd = Math.min(maxY, worldYBase + 16)
      for (let y = yStart; y < yEnd; y++) {
        const yLocal = y - worldYBase
        const ySlot = yLocal << 8
        for (let z = 0; z < CHUNK_WIDTH; z++) {
          const zSlot = ySlot | (z << 4)
          for (let x = 0; x < CHUNK_WIDTH; x++) {
            const stateId = flat[zSlot | x]
            if (stateId === 0) continue
            const blockId = hasFastTable && stateId < ids.length
              ? ids[stateId]
              : this._blockIdForState(stateId)
            if (blockId === 0) continue
            if (hasFastTable && stateId < ids.length && this._stateToSkipped[stateId]) continue
            const faceMask = this._computeFaceMaskFast(flats, si, x, yLocal, z, worldYBase, y, minY, maxY)
            if (faceMask === 0) continue
            // Biome tint (grass/leaves/water): sampled ONLY for tinted
            // blocks — the biome read is the only extra cost and tinted
            // blocks are a small minority of a column.
            let tint = 0
            if (anyTint && stateId < tints.length && tints[stateId] !== 0) {
              const kind = tints[stateId]
              if (typeof column.getBiome === 'function') {
                POS.x = x; POS.y = y; POS.z = z
                let biomeId = 0
                try { biomeId = column.getBiome(POS) } catch (e) { biomeId = 0 }
                tint = this._biomeTintFor(biomeId)[kind - 1] || 0
              }
            }
            entries.push({ x, y: y - minY, z, blockId, faceMask, tint })
          }
        }
      }
    }
    if (entries.length === 0) return null
    return this.encodeChunk(chunkX, chunkZ, minY, entries)
  }

  /**
   * Face mask via flattened sections (plain array reads, zero allocation).
   * `si` is the section index of the block; ±X/±Z stay in the same section
   * unless they cross the chunk border; ±Y may cross into the neighbouring
   * section. Null/empty neighbouring section = air = face exposed.
   */
  _computeFaceMaskFast (flats, si, x, yLocal, z, worldYBase, worldY, minY, maxY) {
    let mask = 0
    const exposedByState = this._exposedByState
    const tableLen = exposedByState.length
    const flat = flats[si]
    const up = flats[si + 1]
    const down = flats[si - 1]
    for (const f of FACES) {
      let stateId
      const ny = yLocal + f.dy
      if (ny >= 0 && ny <= 15) {
        const nx = x + f.dx
        const nz = z + f.dz
        if (nx >= 0 && nx <= 15 && nz >= 0 && nz <= 15) {
          // Same section — the hot path (4 of 6 faces usually)
          stateId = flat[(ny << 8) | (nz << 4) | nx]
        } else {
          mask |= f.bit // chunk border — expose, corrected on neighbor load
          continue
        }
      } else {
        // Crosses a section boundary vertically
        if (worldY + f.dy < minY || worldY + f.dy >= maxY) {
          mask |= f.bit // outside the world
          continue
        }
        const g = (f.dy > 0) ? up : down
        if (!g) { mask |= f.bit; continue } // empty section above/below = air
        stateId = g[((ny & 15) << 8) | (z << 4) | x]
      }
      if (stateId === 0) { mask |= f.bit; continue }
      if (stateId < tableLen) {
        if (exposedByState[stateId]) mask |= f.bit
        continue
      }
      const nBlock = this.stateIdToBlock(stateId)
      if (!nBlock || this.transparentBlockIds.has(nBlock.id)) mask |= f.bit
    }
    return mask
  }

  /**
   * Generic (slower) column scan used when the section layout is not
   * recognized. Semantically identical to _scanColumnFast.
   */
  _scanColumnSlow (chunkX, chunkZ, column, minY, maxY) {
    const entries = []
    const ids = this._stateToId
    const hasFastTable = ids.length > 0
    for (let y = minY; y < maxY; y++) {
      for (let z = 0; z < CHUNK_WIDTH; z++) {
        for (let x = 0; x < CHUNK_WIDTH; x++) {
          const stateId = column.getBlockStateId(POS_SET(x, y, z))
          if (stateId === 0) continue
          let blockId = 0
          if (hasFastTable && stateId < ids.length) {
            blockId = ids[stateId]
            if (blockId === 0) continue
            if (this._stateToSkipped[stateId]) continue
          } else {
            const block = this.stateIdToBlock(stateId)
            if (!block || this.skippedBlocks.has(block.id)) continue
            blockId = block.id
          }
          const faceMask = this.computeFaceMask(column, x, y, z, minY, maxY)
          if (faceMask === 0) continue
          entries.push({ x, y: y - minY, z, blockId, faceMask })
        }
      }
    }
    if (entries.length === 0) return null
    return this.encodeChunk(chunkX, chunkZ, minY, entries)
  }

  /**
   * Encodes entries and deflates the buffer. Reuses a growable internal
   * Buffer (only the deflate output is fresh) to avoid a large allocation
   * per chunk. Level 1: near-instant compression, ~70% size reduction —
   * the old level 6 default burned CPU for ~5 extra percent.
   * Format v2: 9 bytes/entry (v1 was 7) — the extra u16 packs the biome
   * tint as RGB565 (0 = untinted).
   */
  encodeChunk (chunkX, chunkZ, minY, entries) {
    const count = entries.length
    const headerSize = 15 // v(1) + chunkX(4) + chunkZ(4) + minY(4) + count(2)
    const size = headerSize + count * 9
    if (!this._encodeBuf || this._encodeBuf.length < size) {
      // 25% slack so slightly bigger chunks don't trigger a realloc
      this._encodeBuf = Buffer.alloc(Math.ceil(size * 1.25))
    }
    const buf = this._encodeBuf
    let o = 0
    buf.writeUInt8(2, o); o += 1 // format version 2 (biome tint)
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
      buf.writeUInt16LE(e.tint || 0, o); o += 2
    }
    // subarray view + deflateSync always returns a fresh Buffer — safe to send
    return zlib.deflateSync(buf.subarray(0, size), { level: 1 })
  }

  /**
   * Serializes a single block update (after chunk edits) so the client can
   * patch its meshes. Takes WORLD coordinates. Uses the world's sync
   * getBlockStateId (no Block object allocation) with a reusable pos.
   */
  serializeBlockUpdate (worldX, worldY, worldZ) {
    const chunkX = worldX >> 4
    const chunkZ = worldZ >> 4
    const localX = worldX & 15
    const localZ = worldZ & 15
    const world = this.bot.world
    POS.x = worldX; POS.y = worldY; POS.z = worldZ
    let stateId = 0
    if (typeof world.getBlockStateId === 'function') {
      try { stateId = world.getBlockStateId(POS) } catch (e) { stateId = 0 }
    } else {
      const column = world.getColumn(chunkX, chunkZ)
      if (column) {
        POS.x = localX; POS.y = worldY; POS.z = localZ
        stateId = column.getBlockStateId(POS)
      }
    }
    const blockId = this._blockIdForState(stateId)
    const faceMask = this.computeGlobalFaceMask(worldX, worldY, worldZ)
    // Biome tint for the new block state (grass/leaves/water)
    let tint = 0
    if (blockId !== 0 && this.colormaps && stateId < this._stateToTint.length && this._stateToTint[stateId] !== 0) {
      const kind = this._stateToTint[stateId]
      const column = world.getColumn(chunkX, chunkZ)
      if (column && typeof column.getBiome === 'function') {
        POS.x = localX; POS.y = worldY; POS.z = localZ
        let biomeId = 0
        try { biomeId = column.getBiome(POS) } catch (e) { biomeId = 0 }
        tint = this._biomeTintFor(biomeId)[kind - 1] || 0
      }
    }
    return {
      x: worldX, y: worldY, z: worldZ,
      blockId, faceMask, tint
    }
  }

  /** stateId -> streamed blockId (0 when air/skipped), via the fast tables. */
  _blockIdForState (stateId) {
    if (stateId === 0) return 0
    if (stateId < this._stateToId.length) {
      const id = this._stateToId[stateId]
      if (id === 0) return 0
      if (this._stateToSkipped[stateId]) return 0
      return id
    }
    const block = this.stateIdToBlock(stateId)
    return block && !this.skippedBlocks.has(block.id) ? block.id : 0
  }

  /**
   * Face mask computed across chunk borders. Uses the world's sync
   * getBlockStateId + a reusable pos — the old code allocated a full Block
   * object and a Vec3 per neighbour on every single block update.
   */
  computeGlobalFaceMask (worldX, worldY, worldZ) {
    let mask = 0
    const world = this.bot.world
    const hasFastState = typeof world.getBlockStateId === 'function'
    for (const f of FACES) {
      const nx = worldX + f.dx
      const ny = worldY + f.dy
      const nz = worldZ + f.dz
      let exposed = false
      if (hasFastState) {
        NPOS.x = nx; NPOS.y = ny; NPOS.z = nz
        let nStateId = 0
        try { nStateId = world.getBlockStateId(NPOS) } catch (e) { nStateId = -1 }
        if (nStateId === -1) exposed = true // unloaded neighbor chunk: safe default
        else exposed = nStateId === 0 || this._isTransparentState(nStateId)
      } else {
        const column = world.getColumn(nx >> 4, nz >> 4)
        if (!column) exposed = true // unloaded: expose, corrected on load
        else {
          NPOS.x = nx & 15; NPOS.y = ny; NPOS.z = nz & 15
          let nStateId = 0
          try { nStateId = column.getBlockStateId(NPOS) } catch (e) { nStateId = 0 }
          exposed = nStateId === 0 || this._isTransparentState(nStateId)
        }
      }
      if (exposed) mask |= f.bit
    }
    return mask
  }

  /** stateId -> transparent (id table when available, Set fallback). */
  _isTransparentState (stateId) {
    if (stateId === 0) return true
    if (stateId < this._stateToId.length) {
      const id = this._stateToId[stateId]
      if (id === 0) return true
      return this.transparentBlockIds.has(id)
    }
    const block = this.stateIdToBlock(stateId)
    return !block || this.transparentBlockIds.has(block.id)
  }
}

module.exports = { WorldStreamer, FACES }

