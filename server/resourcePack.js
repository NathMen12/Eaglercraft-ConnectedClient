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
// Vanilla pack loading
// ---------------------------------------------------------------------------

/**
 * Maps a block name to its vanilla texture filenames (relative to
 * assets/minecraft/). Most blocks: `<name>.png` (+ `_top` for logs/pillars).
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
  const stats = { loaded: 0, fallback: 0 }

  for (const block of mcData.blocksArray) {
    const name = block.name
    if (name === 'air' || name === 'cave_air' || name === 'void_air' || name === 'moving_piston') continue
    const files = textureFilesFor(name)
    const side = tileFor(builder, assetsDir, files.side, name, stats)
    const top = tileFor(builder, assetsDir, files.top, name, stats)
    const bottom = tileFor(builder, assetsDir, files.bottom, name, stats)
    const mapping = { top, bottom, side }
    if (CROSS_BLOCKS.has(name)) mapping.cross = true
    if (TRANSPARENT_BLOCKS.has(name)) mapping.opacity = 0.5
    builder.mappings.set(name, mapping)
  }

  console.log(`[resourcePack] atlas built: ${stats.loaded} tiles from pack, ${stats.fallback} procedural, ${builder.nextTile} total`)
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

module.exports = {
  buildResourcePack,
  buildProceduralAtlas,
  PROCEDURAL_COLORS,
  CROSS_BLOCKS,
  TRANSPARENT_BLOCKS
}
