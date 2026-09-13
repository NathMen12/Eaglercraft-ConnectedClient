'use strict'

/**
 * entityModels.js (V1.1.2) — vanilla-style 3D mob models from the pack's
 * entity textures.
 *
 * Instead of parsing Minecraft's .json model files (ModelBox UV maps are
 * complex and version-specific), this builds COMPOSITE models out of boxes
 * with hand-mapped UVs matching the vanilla 64x64 mob texture layout:
 * the classic humanoid (zombie/skeleton/villager/piglin...), creeper,
 * quadruped (cow/pig/sheep...), spider, enderman, and chicken shapes.
 *
 * Every part is described once as { size, pivot, uv } in PIXEL units of
 * the vanilla layout (identical to Blockbench's display), then one
 * generic builder on the CLIENT maps each onto a THREE BoxGeometry.
 */

// ---------------------------------------------------------------------------
// Vanilla part descriptions (px units, 64x64 texture layout)
// Convention: `pivot` = the CENTER of the part's box (matches THREE's
// BoxGeometry directly — the client does mesh.position = pivot / 16).
// ---------------------------------------------------------------------------

/** Head+body+arms+legs, the zombie/skeleton/villager layout.
 *  UVs use the CLASSIC 64x32 layout — zombies (64x64) duplicate the same
 *  areas in their lower half, so these coordinates work for both. */
function humanoidParts () {
  return {
    head: { size: [8, 8, 8], pivot: [0, 28, 0], uv: [0, 0] },
    body: { size: [8, 12, 4], pivot: [0, 18, 0], uv: [16, 16] },
    leftArm: { size: [4, 12, 4], pivot: [-6, 16, 0], uv: [32, 48] },
    rightArm: { size: [4, 12, 4], pivot: [6, 16, 0], uv: [40, 16] },
    leftLeg: { size: [4, 12, 4], pivot: [-2, 6, 0], uv: [16, 48] },
    rightLeg: { size: [4, 12, 4], pivot: [2, 6, 0], uv: [0, 16] }
  }
}

/** Creeper: head + body + 4 short legs (64x64 layout). */
function creeperParts () {
  return {
    head: { size: [8, 8, 8], pivot: [0, 22, 0], uv: [0, 0] },
    body: { size: [4, 12, 8], pivot: [0, 12, 0], uv: [16, 16] },
    legFL: { size: [4, 6, 4], pivot: [-2, 3, -4], uv: [0, 16] },
    legFR: { size: [4, 6, 4], pivot: [2, 3, -4], uv: [0, 16] },
    legBL: { size: [4, 6, 4], pivot: [-2, 3, 4], uv: [0, 16] },
    legBR: { size: [4, 6, 4], pivot: [2, 3, 4], uv: [0, 16] }
  }
}

/** Quadruped (cow/pig/sheep...): head + body + 4 legs (64x64 layout). */
function quadrupedParts () {
  const legLen = 8
  const bodyH = 10
  return {
    head: { size: [8, 8, 8], pivot: [0, legLen + bodyH - 3, -8], uv: [0, 0] },
    body: { size: [6, bodyH, 10], pivot: [0, legLen + bodyH / 2, 0], uv: [18, 4] },
    legFL: { size: [4, legLen, 4], pivot: [-2, legLen / 2, -3], uv: [0, 16] },
    legFR: { size: [4, legLen, 4], pivot: [2, legLen / 2, -3], uv: [0, 16] },
    legBL: { size: [4, legLen, 4], pivot: [-2, legLen / 2, 3], uv: [0, 16] },
    legBR: { size: [4, legLen, 4], pivot: [2, legLen / 2, 3], uv: [0, 16] }
  }
}

/** Spider: head + body + 8 legs (64x64 layout). */
function spiderParts () {
  const leg = (px, pz, uv) => ({ size: [14, 2, 2], pivot: [px, 7, pz], uv })
  return {
    head: { size: [8, 8, 8], pivot: [0, 8, -8], uv: [0, 0] },
    body: { size: [10, 8, 10], pivot: [0, 8, 2], uv: [16, 16] },
    leg1: leg(-8, -5, [0, 32]), leg2: leg(-8, -2, [18, 32]),
    leg3: leg(-8, 1, [36, 32]), leg4: leg(-8, 4, [54, 32]),
    leg5: leg(8, -5, [0, 40]), leg6: leg(8, -2, [18, 40]),
    leg7: leg(8, 1, [36, 40]), leg8: leg(8, 4, [54, 40])
  }
}

/** Enderman: tall thin humanoid (64x64 layout). */
function endermanParts () {
  return {
    head: { size: [8, 8, 8], pivot: [0, 44, 0], uv: [0, 0] },
    body: { size: [8, 12, 4], pivot: [0, 34, 0], uv: [32, 16] },
    leftArm: { size: [2, 28, 2], pivot: [-5, 28, 0], uv: [56, 0] },
    rightArm: { size: [2, 28, 2], pivot: [5, 28, 0], uv: [56, 0] },
    leftLeg: { size: [2, 28, 2], pivot: [-2, 14, 0], uv: [0, 16] },
    rightLeg: { size: [2, 28, 2], pivot: [2, 14, 0], uv: [8, 16] }
  }
}

/** Chicken: head + body + wings + legs + beak (64x32 layout). */
function chickenParts () {
  return {
    head: { size: [4, 6, 3], pivot: [0, 18, -2], uv: [0, 0] },
    body: { size: [6, 8, 6], pivot: [0, 9, 0], uv: [0, 9] },
    leftWing: { size: [1, 4, 6], pivot: [-3.5, 9, 0], uv: [24, 13] },
    rightWing: { size: [1, 4, 6], pivot: [3.5, 9, 0], uv: [24, 13] },
    leftLeg: { size: [1, 5, 3], pivot: [-1, 2.5, 1], uv: [26, 0] },
    rightLeg: { size: [1, 5, 3], pivot: [1, 2.5, 1], uv: [26, 0] },
    beak: { size: [4, 2, 2], pivot: [0, 15, -4], uv: [14, 0] }
  }
}

// ---------------------------------------------------------------------------
// Entity name -> shape + texture path
// ---------------------------------------------------------------------------

/** Texture path candidates per entity (first existing on disk wins). */
const TEXTURE_CANDIDATES = {
  zombie: ['zombie/zombie.png'],
  husk: ['zombie/husk.png'],
  drowned: ['zombie/drowned.png'],
  zombie_villager: ['zombie/zombie_villager.png', 'zombie/zombie.png'],
  skeleton: ['skeleton/skeleton.png'],
  stray: ['skeleton/stray.png'],
  wither_skeleton: ['skeleton/wither_skeleton.png'],
  bogged: ['skeleton/bogged.png'],
  creeper: ['creeper/creeper.png'],
  spider: ['spider/spider.png'],
  cave_spider: ['spider/cave_spider.png'],
  enderman: ['enderman/enderman.png'],
  pig: ['pig/pig.png', 'pig/pig_temperate.png'],
  cow: ['cow/cow.png', 'cow/cow_temperate.png'],
  mooshroom: ['cow/mooshroom_red.png'],
  sheep: ['sheep/sheep.png'],
  chicken: ['chicken/chicken.png', 'chicken/chicken_temperate.png'],
  villager: ['villager/villager.png'],
  blaze: ['blaze/blaze.png']
}

/** Model shape per entity name (missing names stay colored boxes). */
const SHAPE_FOR = {
  zombie: 'humanoid', husk: 'humanoid', drowned: 'humanoid',
  zombie_villager: 'humanoid', skeleton: 'humanoid', stray: 'humanoid',
  wither_skeleton: 'humanoid', bogged: 'humanoid', villager: 'humanoid',
  piglin: 'humanoid', piglin_brute: 'humanoid',
  zombified_piglin: 'humanoid', zombie_pigman: 'humanoid',
  creeper: 'creeper',
  spider: 'spider', cave_spider: 'spider',
  enderman: 'enderman',
  pig: 'quadruped', cow: 'quadruped', mooshroom: 'quadruped',
  sheep: 'quadruped',
  chicken: 'chicken'
}

const PARTS_FOR = {
  humanoid: () => humanoidParts(),
  creeper: () => creeperParts(),
  quadruped: () => quadrupedParts(),
  spider: () => spiderParts(),
  enderman: () => endermanParts(),
  chicken: () => chickenParts()
}

/**
 * Builds the entity model registry: entityName -> { shape, texture, parts }
 * (texture = data URL). Only entities whose texture exists are included;
 * anything else keeps the client's colored-box fallback.
 *
 * UV nuance: 64x64 humanoid skins (zombie) give the left arm/leg their own
 * areas at (32,48)/(16,48); 64x32 skins (skeleton) MIRROR the right ones.
 * The left arm/leg UVs are fixed up below according to the texture height.
 */
function buildEntityModels (assetsDir) {
  const fs = require('fs')
  const path = require('path')
  const models = {}
  if (!assetsDir) return models
  for (const [name, candidates] of Object.entries(TEXTURE_CANDIDATES)) {
    for (const rel of candidates) {
      const p = path.join(assetsDir, 'minecraft', 'textures', 'entity', rel)
      if (!fs.existsSync(p)) continue
      const shape = SHAPE_FOR[name] || 'humanoid'
      // Texture sizes vary (64x64 humanoid, 64x32 creeper/spider/skeleton...):
      // the client's UV mapper needs the actual dimensions.
      let texW = 64
      let texH = 64
      try {
        const { PNG } = require('pngjs')
        const png = PNG.sync.read(fs.readFileSync(p))
        texW = png.width
        texH = png.height
      } catch (e) { /* keep 64x64 defaults */ }
      const parts = PARTS_FOR[shape]()
      // 64x32 humanoids mirror their right limbs for the left side
      if (shape === 'humanoid' && texH < 64) {
        parts.leftArm.uv = parts.rightArm.uv.slice()
        parts.leftLeg.uv = parts.rightLeg.uv.slice()
      }
      models[name] = {
        shape,
        texW,
        texH,
        texture: 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'),
        parts
      }
      break
    }
  }
  return models
}

module.exports = {
  buildEntityModels, SHAPE_FOR, TEXTURE_CANDIDATES,
  humanoidParts, creeperParts, quadrupedParts, spiderParts,
  endermanParts, chickenParts
}
