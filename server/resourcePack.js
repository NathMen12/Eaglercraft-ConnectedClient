'use strict'

/**
 * resourcePack.js
 *
 * Loads an (extracted) vanilla resource pack and builds a single texture
 * atlas PNG that the browser renderer samples. When no pack is present the
 * module falls back to procedurally generated textures so the client always
 * renders something.
 *
 * The atlas is a grid of 16x16 tiles. `mappings` maps a block NAME to the
 * tiles used for its faces: { top, bottom, side, cross, opacity }.
 *
 * Public API:
 *   buildResourcePack(packPath, version)  -> { atlasPng, mappings, tileCount } | null
 *   buildProceduralAtlas(version)         -> { atlasPng, mappings, tileCount }
 */

const fs = require('fs')
const path = require('path')
const { PNG } = require('pngjs')
const minecraftData = require('minecraft-data')

// Atlas geometry: 64x64 tiles of 16px => 1024x1024 px (4096 tiles max).
const TILE = 16
const GRID = 64
const ATLAS_SIZE = TILE * GRID

// Blocks rendered as X-shaped plants instead of cubes
const CROSS_BLOCKS = new Set([
  'grass', 'tall_grass', 'fern', 'large_fern', 'dead_bush', 'dandelion',
  'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torch',
  'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'sunflower',
  'lilac', 'rose_bush', 'peony', 'sugar_cane', 'wheat', 'carrots',
  'potatoes', 'beetroots', 'nether_wart', 'sweet_berry_bush',
  'oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling',
  'acacia_sapling', 'dark_oak_sapling', 'bamboo_sapling', 'short_grass'
])

// Blocks that should be rendered semi-transparent
const TRANSPARENT_BLOCKS = new Set([
  'glass', 'glass_pane', 'white_stained_glass', 'orange_stained_glass',
  'magenta_stained_glass', 'light_blue_stained_glass',
  'yellow_stained_glass', 'lime_stained_glass', 'pink_stained_glass',
  'gray_stained_glass', 'light_gray_stained_glass', 'cyan_stained_glass',
  'purple_stained_glass', 'blue_stained_glass', 'brown_stained_glass',
  'green_stained_glass', 'red_stained_glass', 'black_stained_glass',
  'white_stained_glass_pane', 'orange_stained_glass_pane',
  'magenta_stained_glass_pane', 'light_blue_stained_glass_pane',
  'yellow_stained_glass_pane', 'lime_stained_glass_pane',
  'pink_stained_glass_pane', 'gray_stained_glass_pane',
  'light_gray_stained_glass_pane', 'cyan_stained_glass_pane',
  'purple_stained_glass_pane', 'blue_stained_glass_pane',
  'brown_stained_glass_pane', 'green_stained_glass_pane',
  'red_stained_glass_pane', 'black_stained_glass_pane',
  'ice', 'packed_ice', 'blue_ice', 'slime_block', 'honey_block',
  'barrier', 'water'
])

// Procedural fallback palette (block name -> base color)
const PROCEDURAL_COLORS = {
  stone: [125, 125, 125],
  granite: [149, 103, 85],
  diorite: [189, 190, 189],
  andesite: [136, 136, 136],
  deepslate: [80, 80, 82],
  cobblestone: [120, 120, 120],
  mossy_cobblestone: [110, 118, 97],
  dirt: [134, 96, 67],
  coarse_dirt: [119, 85, 59],
  rooted_dirt: [150, 110, 85],
  grass_block: [127, 178, 86],
  clay: [162, 162, 173],
  gravel: [127, 124, 123],
  sand: [219, 207, 163],
  red_sand: [190, 102, 34],
  sandstone: [216, 203, 155],
  snow_block: [240, 246, 246],
  ice: [145, 205, 221],
  packed_ice: [140, 188, 210],
  obsidian: [20, 18, 30],
  bedrock: [85, 85, 85],
  netherrack: [97, 38, 38],
  soul_sand: [84, 64, 51],
  end_stone: [221, 223, 165],
  oak_log: [109, 86, 53],
  oak_planks: [162, 130, 78],
  spruce_log: [58, 37, 16],
  spruce_planks: [115, 90, 60],
  birch_log: [215, 205, 193],
  birch_planks: [192, 175, 123],
  jungle_log: [87, 68, 26],
  jungle_planks: [160, 115, 77],
  acacia_log: [103, 96, 86],
  acacia_planks: [168, 90, 50],
  dark_oak_log: [59, 38, 24],
  dark_oak_planks: [66, 43, 26],
  crimson_stem: [133, 34, 47],
  crimson_planks: [101, 38, 50],
  warped_stem: [56, 75, 84],
  warped_planks: [50, 67, 71],
  oak_leaves: [60, 143, 35],
  spruce_leaves: [45, 95, 45],
  birch_leaves: [100, 168, 60],
  jungle_leaves: [48, 130, 26],
  acacia_leaves: [110, 138, 35],
  dark_oak_leaves: [55, 90, 32],
  glass: [255, 255, 255],
  bricks: [150, 97, 83],
  bookshelf: [155, 111, 74],
  crafting_table: [140, 111, 72],
  furnace: [111, 111, 111],
  pumpkin: [196, 118, 21],
  melon: [107, 144, 34],
  white_wool: [233, 236, 236],
  orange_wool: [240, 118, 19],
  magenta_wool: [189, 68, 179],
  light_blue_wool: [58, 175, 217],
  yellow_wool: [248, 197, 39],
  lime_wool: [112, 185, 25],
  pink_wool: [237, 141, 172],
  gray_wool: [62, 68, 71],
  light_gray_wool: [142, 142, 135],
  cyan_wool: [21, 137, 145],
  purple_wool: [121, 42, 172],
  blue_wool: [53, 57, 157],
  brown_wool: [114, 71, 40],
  green_wool: [84, 109, 27],
  red_wool: [161, 39, 34],
  black_wool: [20, 21, 25],
  coal_ore: [115, 115, 115],
  iron_ore: [135, 136, 135],
  copper_ore: [140, 100, 82],
  gold_ore: [145, 141, 133],
  diamond_ore: [115, 115, 115],
  emerald_ore: [115, 115, 115],
  lapis_ore: [115, 115, 115],
  gold_block: [247, 233, 163],
  iron_block: [216, 211, 207],
  diamond_block: [98, 219, 214],
  emerald_block: [52, 180, 118],
  lapis_block: [35, 115, 201],
  redstone_block: [196, 40, 40],
  coal_block: [20, 20, 20],
  netherite_block: [62, 59, 63],
  copper_block: [197, 108, 66],
  quartz_block: [236, 230, 224],
  amethyst_block: [133, 88, 211],
  purpur_block: [169, 125, 176],
  water: [63, 118, 228],
  lava: [207, 92, 20],
  stone_bricks: [122, 122, 122],
  mossy_stone_bricks: [115, 115, 101],
  smooth_stone: [158, 158, 158],
  prismarine: [99, 156, 152],
  sponge: [193, 192, 56],
  dead_bush: [141, 94, 30],
  grass: [127, 178, 86],
  tall_grass: [127, 178, 86],
  short_grass: [127, 178, 86],
  poppy: [220, 0, 0],
  dandelion: [255, 255, 85]
}


// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function clamp8 (v) {
  return Math.max(0, Math.min(255, Math.round(v)))
}

function hash32 (name) {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h
}

function hashColor (name) {
  const h = hash32(name)
  return [h & 0xFF, (h >> 8) & 0xFF, (h >> 16) & 0xFF]
}

// ---------------------------------------------------------------------------
// Atlas builder
// ---------------------------------------------------------------------------

class AtlasBuilder {
  constructor () {
    this.png = new PNG({ width: ATLAS_SIZE, height: ATLAS_SIZE })
    // Fill the whole atlas with opaque magenta so missing tiles are obvious
    for (let i = 0; i < this.png.data.length; i += 4) {
      this.png.data[i] = 255
      this.png.data[i + 1] = 0
      this.png.data[i + 2] = 255
      this.png.data[i + 3] = 255
    }
    this.nextTile = 0
    // blockName -> { top, bottom, side, cross?, opacity }
    this.mappings = new Map()
    // Cache: texture file path -> tileIndex (many blocks share textures)
    this.fileCache = new Map()
  }

  tilePosition (index) {
    return { x: index % GRID, y: Math.floor(index / GRID) }
  }

  ensureCapacity () {
    if (this.nextTile >= GRID * GRID) {
      throw new Error(`Texture atlas overflow (max ${GRID * GRID} tiles)`)
    }
  }

  /** Blits a 16x16 (or smaller, wrapped) PNG buffer into a new atlas tile. */
  addTileFromBuffer (buffer) {
    this.ensureCapacity()
    const index = this.nextTile++
    const pos = this.tilePosition(index)
    const img = PNG.sync.read(buffer)
    for (let y = 0; y < TILE; y++) {
      const sy = img.height ? y % img.height : 0
      for (let x = 0; x < TILE; x++) {
        const sx = img.width ? x % img.width : 0
        const sIdx = (sy * img.width + sx) * 4
        const dIdx = (this.png.width * (pos.y * TILE + y) + pos.x * TILE + x) * 4
        this.png.data[dIdx] = img.data[sIdx]
        this.png.data[dIdx + 1] = img.data[sIdx + 1]
        this.png.data[dIdx + 2] = img.data[sIdx + 2]
        this.png.data[dIdx + 3] = img.data[sIdx + 3]
      }
    }
    return index
  }

  /** Draws a noisy color tile (fallback when a texture is missing). */
  addTileProcedural (name) {
    this.ensureCapacity()
    const index = this.nextTile++
    const pos = this.tilePosition(index)
    const color = PROCEDURAL_COLORS[name] || hashColor(name)
    const h = hash32(name)
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        const noise = (((x * 7 + y * 13 + (h % 97) * 31) % 7) / 7) - 0.5
        const dIdx = (this.png.width * (pos.y * TILE + y) + pos.x * TILE + x) * 4
        this.png.data[dIdx] = clamp8(color[0] + noise * 40)
        this.png.data[dIdx + 1] = clamp8(color[1] + noise * 40)
        this.png.data[dIdx + 2] = clamp8(color[2] + noise * 40)
        this.png.data[dIdx + 3] = 255
      }
    }
    return index
  }

  result () {
    return {
      atlasPng: PNG.sync.write(this.png),
      mappings: this.mappings,
      tileCount: this.nextTile
    }
  }
}

// ---------------------------------------------------------------------------
// Vanilla texture resolution (blockstate -> model -> texture)
// ---------------------------------------------------------------------------

/**
 * Vanilla texture resolver: reads the pack's blockstates/<block>.json to
 * find the model, then the model's JSON to find the texture references
 * (`all`, `top`, `side`, `bottom`, `end`, `cross`, `plant`, `pane`, ...).
 * This replaces the old filename heuristics — the pack defines 1200+ block
 * models and guessing file names left 618/1199 tiles procedural (the
 * "noisy blocks" bug).
 *
 * Returns { top, bottom, side } RELATIVE texture paths (no leading
 * 'textures/', no '.png'), or null when the pack has no data for the block.
 */
class VanillaTextureResolver {
  constructor (assetsDir) {
    this.assetsDir = assetsDir
    this.blockstates = new Map() // block name -> parsed blockstate JSON
    this.models = new Map()      // model path -> parsed model JSON
    this.textureCache = new Map() // block name -> { top, bottom, side } | null
  }

  /** blockName -> { top, bottom, side } (RELATIVE paths), or null. */
  resolve (blockName) {
    if (this.textureCache.has(blockName)) return this.textureCache.get(blockName)
    const result = this._resolve(blockName)
    this.textureCache.set(blockName, result)
    return result
  }

  _resolve (blockName) {
    try {
      const stateJson = this._loadBlockstate(blockName)
      if (!stateJson) return null
      // Pick the first variant/first multipart entry — good enough for a
      // renderer that only shows one texture per face kind.
      let modelPath = null
      if (stateJson.variants) {
        const firstKey = Object.keys(stateJson.variants)[0]
        const variant = stateJson.variants[firstKey]
        modelPath = Array.isArray(variant) ? variant[0]?.model : variant?.model
      } else if (stateJson.multipart) {
        const apply = stateJson.multipart[0]?.apply
        modelPath = Array.isArray(apply) ? apply[0]?.model : apply?.model
      }
      if (!modelPath) return null
      const modelJson = this._loadModel(modelPath)
      if (!modelJson) return null
      return this._texturesFromModel(modelJson)
    } catch (e) {
      return null
    }
  }

  /** Loads blockstates/<name>.json (cached). */
  _loadBlockstate (blockName) {
    if (this.blockstates.has(blockName)) return this.blockstates.get(blockName)
    let json = null
    try {
      const p = path.join(this.assetsDir, 'minecraft', 'blockstates', `${blockName}.json`)
      if (fs.existsSync(p)) json = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) { json = null }
    this.blockstates.set(blockName, json)
    return json
  }

  /** Loads models/block/<path>.json (cached, handles nested parents). */
  _loadModel (modelPath) {
    if (this.models.has(modelPath)) return this.models.get(modelPath)
    let json = null
    try {
      const rel = String(modelPath).replace(/^minecraft:/, '').replace(/^block\//, '')
      const p = path.join(this.assetsDir, 'minecraft', 'models', 'block', rel + (rel.endsWith('.json') ? '' : '.json'))
      if (fs.existsSync(p)) json = JSON.parse(fs.readFileSync(p, 'utf8'))
    } catch (e) { json = null }
    this.models.set(modelPath, json)
    return json
  }

  /**
   * Extracts { top, bottom, side } from a model JSON, walking the parent
   * chain (cube_bottom_top, cube_column, cross, fence_post...) and MERGING
   * the textures maps (child overrides parent — vanilla semantics).
   * Handles '#' references (e.g. fence models use "texture": "#texture").
   */
  _texturesFromModel (modelJson, depth = 0, inheritedTextures = null) {
    if (!modelJson || depth > 10) return null
    // Vanilla semantics: the child's textures override the parent's on the
    // same keys; parents contribute the rest (e.g. fence_post + planks).
    const textures = Object.assign({}, inheritedTextures, modelJson.textures)
    // Handles BOTH texture formats:
    //   - classic:  "side": "minecraft:block/oak_planks"
    //   - 1.21.2+:  "side": { "sprite": "minecraft:block/oak_planks", "force_translucent": true }
    const deref = (v, seen = 0) => {
      if (v == null || seen > 4) return null
      if (typeof v === 'object') v = v.sprite // modern format
      if (typeof v !== 'string' || !v) return null
      if (v.startsWith('#')) return deref(textures[v.slice(1)], seen + 1)
      return this._strip(v)
    }
    const pick = (...keys) => {
      for (const k of keys) {
        const v = deref(textures[k])
        if (v) return v
      }
      return null
    }
    // Cross models (plants/fences/panes): everything uses one texture
    if (textures.cross || textures.plant || textures.all || textures.texture) {
      const s = pick('cross', 'plant', 'all', 'texture')
      if (s) return { top: s, bottom: s, side: s }
    }
    const top = pick('top', 'up', 'end')
    const bottom = pick('bottom', 'down', 'end')
    const side = pick('side', 'north', 'all', 'texture', 'pane')
    if (top || bottom || side) {
      return { top: top || side, bottom: bottom || side, side: side || top }
    }
    // Element-based models (torch, rails, redstone wire...): the textures
    // only appear as "#refs" inside elements[].faces[].texture. Collect them
    // in face order (down/up/north/south/east/west) and deref.
    if (Array.isArray(modelJson.elements)) {
      const faceKeys = ['up', 'down', 'north', 'south', 'east', 'west']
      const found = { top: null, bottom: null, side: null }
      for (const el of modelJson.elements) {
        if (!el || typeof el !== 'object' || !el.faces) continue
        for (const fk of faceKeys) {
          const face = el.faces[fk]
          if (!face || !face.texture) continue
          const resolved = deref(face.texture)
          if (!resolved) continue
          if (fk === 'up' && !found.top) found.top = resolved
          else if (fk === 'down' && !found.bottom) found.bottom = resolved
          else if (!found.side) found.side = resolved
        }
      }
      if (found.top || found.bottom || found.side) {
        return {
          top: found.top || found.side,
          bottom: found.bottom || found.side,
          side: found.side || found.top || found.bottom
        }
      }
    }
    // Walk the parent model (cube_bottom_top etc.) with merged textures
    if (modelJson.parent) {
      return this._texturesFromModel(this._loadModel(modelJson.parent), depth + 1, textures)
    }
    return null
  }

  /** 'minecraft:block/dirt' -> 'block/dirt' (relative to textures/). */
  _strip (ref) {
    return String(ref).replace(/^minecraft:/, '').replace(/^textures\//, '')
  }
}

/**
 * Maps a block name to its vanilla texture filenames (relative to
 * assets/minecraft/). Fallback heuristic when the pack has no
 * blockstate/model JSON for the block — the primary resolution now goes
 * through the pack's own blockstates and models (see VanillaTextureResolver).
 */
function textureFilesFor (blockName) {
  const t = (n) => `textures/block/${n}.png`
  // Logs & stems have distinct top/bottom textures
  if (/_log$/.test(blockName) || /_stem$/.test(blockName) || /_pillar$/.test(blockName)) {
    return { side: t(blockName), top: t(`${blockName}_top`), bottom: t(`${blockName}_top`) }
  }
  if (blockName === 'grass_block') {
    return { side: t('grass_block_side'), top: t('grass_block_top'), bottom: t('dirt') }
  }
  if (blockName === 'mycelium') {
    return { side: t('mycelium_side'), top: t('mycelium_top'), bottom: t('dirt') }
  }
  if (blockName === 'podzol') {
    return { side: t('podzol_side'), top: t('podzol_top'), bottom: t('dirt') }
  }
  if (blockName === 'snowy_grass') {
    return { side: t('grass_block_snow'), top: t('snow'), bottom: t('dirt') }
  }
  if (blockName === 'crafting_table') {
    return { side: t('crafting_table_side'), top: t('crafting_table_top'), bottom: t('oak_planks') }
  }
  if (blockName === 'furnace') {
    return { side: t('furnace_side'), top: t('furnace_top'), bottom: t('furnace_top') }
  }
  if (blockName === 'pumpkin' || blockName === 'carved_pumpkin' || blockName === 'jack_o_lantern') {
    return { side: t('pumpkin_side'), top: t('pumpkin_top'), bottom: t('pumpkin_top') }
  }
  if (blockName === 'melon') {
    return { side: t('melon_side'), top: t('melon_top'), bottom: t('melon_top') }
  }
  if (blockName === 'bookshelf') {
    return { side: t('bookshelf'), top: t('oak_planks'), bottom: t('oak_planks') }
  }
  if (blockName === 'hay_block') {
    return { side: t('hay_block_side'), top: t('hay_block_top'), bottom: t('hay_block_top') }
  }
  if (blockName === 'vine' || blockName === 'vines') {
    return { side: t('vine'), top: t('vine'), bottom: t('vine') }
  }
  if (blockName === 'farmland') {
    return { side: t('dirt'), top: t('farmland'), bottom: t('dirt') }
  }
  if (blockName === 'dirt_path') {
    return { side: t('grass_path_side' ), top: t('grass_path_top'), bottom: t('dirt') }
  }
  return { side: t(blockName), top: t(blockName), bottom: t(blockName) }
}



/**
 * Vanilla packs store assets under <pack>/assets/minecraft/textures/block or
 * (for some extracted jars) directly at the root. Returns the directory that
 * contains `minecraft/textures/block` (or null).
 */
function findAssetsDir (packPath) {
  const candidates = [
    path.join(packPath, 'assets'),
    path.join(packPath, 'resourcepack', 'assets'),
    packPath
  ]
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'minecraft', 'textures', 'block'))) return c
  }
  return null
}

/** Builds a tile from the pack if possible, else a procedural fallback tile. */
function tileFor (builder, assetsDir, relPath, blockName, stats) {
  const abs = path.join(assetsDir, 'minecraft', relPath)
  const cached = builder.fileCache.get(abs)
  if (cached !== undefined) return cached
  let tile
  if (fs.existsSync(abs)) {
    try {
      tile = builder.addTileFromBuffer(fs.readFileSync(abs))
      stats.loaded++
    } catch (e) {
      tile = builder.addTileProcedural(blockName)
      stats.fallback++
    }
  } else {
    tile = builder.addTileProcedural(blockName)
    stats.fallback++
  }
  builder.fileCache.set(abs, tile)
  return tile
}

/**
 * Builds the atlas from a vanilla resource pack directory (extracted).
 * Returns null when the pack path is missing or has no block textures.
 */
function buildResourcePack (packPath, version) {
  if (!packPath || !fs.existsSync(packPath)) return null
  const mcData = minecraftData(version === undefined ? '1.21.9' : version)
  if (!mcData) return null
  const assetsDir = findAssetsDir(packPath)
  if (!assetsDir) return null

  const builder = new AtlasBuilder()
  const stats = { loaded: 0, fallback: 0, resolved: 0 }
  const resolver = new VanillaTextureResolver(assetsDir)

  for (const block of mcData.blocksArray) {
    const name = block.name
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'moving_piston') continue
    // 1) Vanilla pipeline: blockstate -> model -> texture paths
    const resolved = resolver.resolve(name)
    const files = resolved
      ? {
          side: `textures/${resolved.side}.png`,
          top: `textures/${resolved.top}.png`,
          bottom: `textures/${resolved.bottom}.png`
        }
      : textureFilesFor(name) // 2) heuristic fallback (no blockstate/model)
    const side = tileFor(builder, assetsDir, files.side, name, stats)
    const top = tileFor(builder, assetsDir, files.top, name, stats)
    const bottom = tileFor(builder, assetsDir, files.bottom, name, stats)
    if (resolved) stats.resolved++
    const mapping = { top, bottom, side }
    if (CROSS_BLOCKS.has(name)) mapping.cross = true
    if (TRANSPARENT_BLOCKS.has(name)) mapping.opacity = 0.5
    builder.mappings.set(name, mapping)
  }

  console.log(`[resourcePack] atlas built: ${stats.loaded} tiles from pack (${stats.resolved} resolved via blockstates/models), ${stats.fallback} procedural, ${builder.nextTile} total`)
  return builder.result()
}

/** Builds a fully procedural atlas (no resource pack needed). */
function buildProceduralAtlas (version) {
  const mcData = minecraftData(version === undefined ? '1.21.9' : version)
  const builder = new AtlasBuilder()
  for (const block of mcData.blocksArray) {
    const name = block.name
    if (name === 'air' || name === 'cave_air' || name === 'void_air') continue
    const tile = builder.addTileProcedural(name)
    const mapping = { top: tile, bottom: tile, side: tile }
    if (CROSS_BLOCKS.has(name)) mapping.cross = true
    if (TRANSPARENT_BLOCKS.has(name)) mapping.opacity = 0.5
    builder.mappings.set(name, mapping)
  }
  console.log(`[resourcePack] procedural atlas built: ${builder.nextTile} tiles`)
  return builder.result()
}

/**
 * Builds the HUD spritesheet from the pack's GUI sprites (hearts, food):
 * a vertical strip of 9x9 tiles. Returns { png, sprites } or null when the
 * pack has no HUD sprites.
 *
 * Sprite order (fixed): heartContainer, heartFull, heartHalf,
 * foodEmpty, foodFull, foodHalf — indices in `sprites` are tile numbers
 * (top-to-bottom, one per 9px row band).
 */
const HUD_SPRITES = [
  ['heart_container', 'textures/gui/sprites/hud/heart/container.png'],
  ['heart_full', 'textures/gui/sprites/hud/heart/full.png'],
  ['heart_half', 'textures/gui/sprites/hud/heart/half.png'],
  ['food_empty', 'textures/gui/sprites/hud/food_empty.png'],
  ['food_full', 'textures/gui/sprites/hud/food_full.png'],
  ['food_half', 'textures/gui/sprites/hud/food_half.png'],
  // V1.1.2 — vanilla hotbar chrome (182x22) + selection box (24x23)
  ['hotbar', 'textures/gui/sprites/hud/hotbar.png'],
  ['hotbar_selection', 'textures/gui/sprites/hud/hotbar_selection.png']
]

function buildHudSheet (assetsDir) {
  const tiles = []
  let width = 0
  let height = 0
  for (const [key, rel] of HUD_SPRITES) {
    const p = path.join(assetsDir, 'minecraft', rel)
    if (!fs.existsSync(p)) { tiles.push(null); continue }
    try {
      const img = PNG.sync.read(fs.readFileSync(p))
      tiles.push(img)
      width = Math.max(width, img.width)
      height += img.height
    } catch (e) {
      tiles.push(null)
    }
  }
  if (tiles.every((t) => t === null)) return null
  // Compose the sheet (nulls are skipped rows but keep their index)
  const sheet = new PNG({ width: Math.max(width, 9), height: Math.max(height, 9) })
  const sprites = {}
  let y = 0
  let i = 0
  for (const img of tiles) {
    const key = HUD_SPRITES[i][0]
    if (img) {
      PNG.bitblt(img, sheet, 0, 0, img.width, img.height, 0, y)
      sprites[key] = { x: 0, y, w: img.width, h: img.height }
      y += img.height
    } else {
      sprites[key] = null
    }
    i++
  }
  return { png: PNG.sync.write(sheet), sprites, sheetWidth: sheet.width, sheetHeight: sheet.height }
}

// ---------------------------------------------------------------------------
// Resource pack auto-download
// ---------------------------------------------------------------------------

/**
 * Downloads a resource pack ZIP from `url` and extracts the parts we need
 * (blockstates, models, block textures, HUD sprites) into `destDir`.
 * Skips the download when `destDir` already contains assets. Returns the
 * pack directory path, or null on failure (the caller falls back to the
 * procedural atlas).
 *
 * Node 18+ only (global fetch + stream/promises pipeline).
 */
const DEFAULT_PACK_URL = process.env.RESOURCE_PACK_URL || 'https://www.dropbox.com/scl/fi/awz1u7z2oorsp15j30bnw/26.2.x-Template.zip?rlkey=a3tz81fe4uij1wjtj2imco8hs&st=6xg261xt&dl=1'

async function ensureResourcePack (destDir, url = DEFAULT_PACK_URL) {
  const marker = path.join(destDir, 'assets', 'minecraft')
  if (fs.existsSync(marker)) return destDir // already installed
  try {
    fs.mkdirSync(destDir, { recursive: true })
    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const zipPath = path.join(destDir, '_pack.zip')
    const buf = Buffer.from(await res.arrayBuffer())
    fs.writeFileSync(zipPath, buf)
    // Extract only what the atlas/HUD builder reads
    const entries = [
      'assets/minecraft/blockstates/*',
      'assets/minecraft/models/block/*',
      'assets/minecraft/textures/block/*',
      'assets/minecraft/textures/gui/sprites/hud/*'
    ]
    const { execFile } = require('child_process')
    await new Promise((resolve, reject) => {
      execFile('unzip', ['-q', '-o', zipPath, ...entries, '-d', destDir], (err) => err ? reject(err) : resolve())
    })
    fs.rmSync(zipPath, { force: true })
    if (!fs.existsSync(marker)) throw new Error('pack layout not recognized (missing assets/minecraft)')
    console.log(`[resourcePack] downloaded & extracted (${(buf.length / 1e6).toFixed(1)} MB) -> ${destDir}`)
    return destDir
  } catch (e) {
    console.warn(`[resourcePack] auto-download failed: ${e.message} — falling back to procedural textures`)
    return null
  }
}

/**
 * Loads the vanilla biome colormaps (grass.png / foliage.png) from the
 * pack. Returns { grass: PNG, foliage: PNG } or null when absent.
 */
function buildColormaps (assetsDir) {
  try {
    const grassPath = path.join(assetsDir, 'minecraft', 'textures', 'colormap', 'grass.png')
    const foliagePath = path.join(assetsDir, 'minecraft', 'textures', 'colormap', 'foliage.png')
    if (!fs.existsSync(grassPath) || !fs.existsSync(foliagePath)) return null
    return {
      grass: PNG.sync.read(fs.readFileSync(grassPath)),
      foliage: PNG.sync.read(fs.readFileSync(foliagePath))
    }
  } catch (e) {
    return null
  }
}

/**
 * Builds the ITEM texture atlas (16x16 tiles) from the pack's
 * textures/item/*.png, for every item in the registry. Returns
 * { atlasPng, mappings } (item name -> tile index) or null without a pack.
 * Reuses AtlasBuilder (same 64x64 grid as the block atlas).
 */
function buildItemAtlas (assetsDir, version) {
  try {
    const mcData = minecraftData(version === undefined ? '1.21.9' : version)
    if (!mcData || !fs.existsSync(path.join(assetsDir, 'minecraft', 'textures', 'item'))) return null
    const builder = new AtlasBuilder()
    let loaded = 0
    for (const item of mcData.itemsArray) {
      const p = path.join(assetsDir, 'minecraft', 'textures', 'item', `${item.name}.png`)
      if (!fs.existsSync(p)) continue
      try {
        const tile = builder.addTileFromBuffer(fs.readFileSync(p))
        builder.mappings.set(item.name, { tile })
        loaded++
      } catch (e) { /* skip broken item png */ }
    }
    if (loaded === 0) return null
    console.log(`[resourcePack] item atlas built: ${loaded} items`)
    return builder.result()
  } catch (e) {
    console.warn('[resourcePack] item atlas failed:', e.message)
    return null
  }
}

/**
 * Destroy-stage overlay sheet (V1.1.1): the 10 vanilla crack textures
 * (destroy_stage_0..9.png) laid side by side in ONE 160x16 PNG served as
 * /destroy.png. The client selects the stage by UV offset (tile = stage).
 * Returns null when the pack has none (the client then skips the overlay).
 */
function buildDestroySheet (assetsDir) {
  try {
    const tiles = []
    for (let i = 0; i < 10; i++) {
      const p = path.join(assetsDir, 'minecraft', 'textures', 'block', `destroy_stage_${i}.png`)
      if (!fs.existsSync(p)) return null
      tiles.push(PNG.sync.read(fs.readFileSync(p)))
    }
    const sheet = new PNG({ width: 16 * 10, height: 16 })
    for (let i = 0; i < 10; i++) {
      const img = tiles[i]
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const sIdx = (y * img.width + x) * 4
          const dIdx = (sheet.width * y + i * 16 + x) * 4
          sheet.data[dIdx] = img.data[sIdx]
          sheet.data[dIdx + 1] = img.data[sIdx + 1]
          sheet.data[dIdx + 2] = img.data[sIdx + 2]
          sheet.data[dIdx + 3] = img.data[sIdx + 3]
        }
      }
    }
    return { png: PNG.sync.write(sheet), tiles: 10 }
  } catch (e) {
    console.warn('[resourcePack] destroy sheet build failed:', e.message)
    return null
  }
}

/**
 * V1.1.2 — inventory screen background. Modern packs (1.21+) ship GUI as
 * separate sprites with no container/inventory.png, so we DRAW a vanilla-
 * style panel: the classic #c6c6c6 grey, 3D bevel borders and 36 slot
 * cells at the vanilla coordinates (player inventory layout).
 * Served as /gui/inventory.png; the client overlays its item icons.
 */
function buildInventoryBackground (assetsDir) {
  try {
    // Vanilla player inventory: 176x166, 27-grid at (7,17), hotbar at (7,75)
    const W = 176
    const H = 166
    const CELL = 18 // 16px sprite + 2px of panel padding around each cell
    const img = new PNG({ width: W, height: H, colorType: 6 })
    const put = (x, y, r, g, b, a = 255) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return
      const i = (y * W + x) * 4
      img.data[i] = r; img.data[i + 1] = g; img.data[i + 2] = b; img.data[i + 3] = a
    }
    // Panel body — vanilla grey
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        put(x, y, 198, 198, 198)
      }
    }
    // Outer bevel: light top/left, dark bottom/right (vanilla GUI style)
    for (let x = 0; x < W; x++) { put(x, 0, 255, 255, 255); put(x, H - 1, 85, 85, 85) }
    for (let y = 0; y < H; y++) { put(0, y, 255, 255, 255); put(W - 1, y, 85, 85, 85) }
    // Inner shadow line of the bevel
    for (let x = 1; x < W - 1; x++) { put(x, 1, 160, 160, 160); put(x, H - 2, 232, 232, 232) }
    for (let y = 1; y < H - 1; y++) { put(1, y, 160, 160, 160); put(W - 2, y, 232, 232, 232) }
    // Slot cell: dark top/left inner border, light bottom/right (inset look)
    const drawCell = (cx, cy) => {
      for (let y = 0; y < CELL; y++) {
        for (let x = 0; x < CELL; x++) {
          const px = cx + x
          const py = cy + y
          const edge = x === 0 || y === 0
          const edge2 = x === CELL - 1 || y === CELL - 1
          if (edge) put(px, py, 55, 55, 55) // dark bevel
          else if (edge2) put(px, py, 255, 255, 255) // light bevel
          else put(px, py, 139, 139, 139) // cell interior (vanilla #8b8b8b)
        }
      }
    }
    // 27 main-grid cells (9x3) then the 9 hotbar cells — vanilla coords
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 9; col++) drawCell(7 + col * CELL, 17 + row * CELL)
    }
    for (let col = 0; col < 9; col++) drawCell(7 + col * CELL, 75 + 0 * CELL)
    return { png: PNG.sync.write(img), width: W, height: H }
  } catch (e) {
    console.warn('[resourcePack] inventory background build failed:', e.message)
    return null
  }
}

module.exports = {
  buildResourcePack,
  buildProceduralAtlas,
  buildHudSheet,
  buildColormaps,
  buildItemAtlas,
  buildDestroySheet,
  buildInventoryBackground,
  ensureResourcePack,
  findAssetsDir,
  VanillaTextureResolver,
  PROCEDURAL_COLORS,
  CROSS_BLOCKS,
  TRANSPARENT_BLOCKS
}
