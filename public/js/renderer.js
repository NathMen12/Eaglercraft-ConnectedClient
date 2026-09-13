'use strict'

/**
 * renderer.js (ES module) — Three.js world renderer.
 *
 * Builds one THREE.Mesh per chunk column from the streamed visible-face
 * masks. Loads /atlas.png as a texture atlas, uses per-face UVs from the
 * server-provided blockMappings (block NAME -> tile indices).
 *
 * Coordinate systems:
 *   Minecraft: X east, Y up, Z south; yaw 0 = +Z (south), pitch positive down.
 *   Three.js:  X east, Y up, Z south (same), camera yaw 0 = -Z.
 *   We convert: threeYaw = yaw - PI (so MC yaw 0 faces +Z in three).
 */

import * as THREE from '/node_modules/three/build/three.module.js'

// ---------------------------------------------------------------------------
// Constants & helpers (module level — never reallocated per chunk build)
// ---------------------------------------------------------------------------

/**
 * Face definitions: for each visible bit — normal, tile kind, and the 4
 * corners with their UV assignment (matching vertex order).
 * Corner order is chosen so triangles (0,1,2)(0,2,3) face outward.
 * (Module-level constant: the old code rebuilt this array on EVERY chunk
 * build — 6 objects + 24 corner objects per chunk.)
 */
const FACE_DEFS = [
  { // +X (east)
    bit: 1, dir: [1, 0, 0], tile: 'side',
    corners: [
      { p: [1, 0, 1], uv: [0, 0] }, { p: [1, 0, 0], uv: [1, 0] },
      { p: [1, 1, 0], uv: [1, 1] }, { p: [1, 1, 1], uv: [0, 1] }
    ]
  },
  { // -X (west)
    bit: 2, dir: [-1, 0, 0], tile: 'side',
    corners: [
      { p: [0, 0, 0], uv: [0, 0] }, { p: [0, 0, 1], uv: [1, 0] },
      { p: [0, 1, 1], uv: [1, 1] }, { p: [0, 1, 0], uv: [0, 1] }
    ]
  },
  { // +Y (top)
    bit: 4, dir: [0, 1, 0], tile: 'top',
    corners: [
      { p: [0, 1, 1], uv: [0, 0] }, { p: [1, 1, 1], uv: [1, 0] },
      { p: [1, 1, 0], uv: [1, 1] }, { p: [0, 1, 0], uv: [0, 1] }
    ]
  },
  { // -Y (bottom)
    bit: 8, dir: [0, -1, 0], tile: 'bottom',
    corners: [
      { p: [0, 0, 0], uv: [0, 0] }, { p: [1, 0, 0], uv: [1, 0] },
      { p: [1, 0, 1], uv: [1, 1] }, { p: [0, 0, 1], uv: [0, 1] }
    ]
  },
  { // +Z (south)
    bit: 16, dir: [0, 0, 1], tile: 'side',
    corners: [
      { p: [0, 0, 1], uv: [0, 0] }, { p: [1, 0, 1], uv: [1, 0] },
      { p: [1, 1, 1], uv: [1, 1] }, { p: [0, 1, 1], uv: [0, 1] }
    ]
  },
  { // -Z (north)
    bit: 32, dir: [0, 0, -1], tile: 'side',
    corners: [
      { p: [1, 0, 0], uv: [0, 0] }, { p: [0, 0, 0], uv: [1, 0] },
      { p: [0, 1, 0], uv: [1, 1] }, { p: [1, 1, 0], uv: [0, 1] }
    ]
  }
]

// Untinted vertex color (white — the texture shows through untouched)
const WHITE_TINT = [1, 1, 1]

class Renderer {
  constructor () {
    this.scene = null
    this.camera = null
    this.renderer = null
    this.chunks = new Map()     // 'cx,cz' -> THREE.Mesh
    this.chunkBlocks = new Map() // 'cx,cz' -> decoded chunk (for rebuilds)
    this.dirtyChunks = new Set()
    this.entities = new Map()   // id -> THREE.Group
    this.entityMappings = null
    this.blockMappings = null   // name -> { top, bottom, side, cross?, opacity? }
    this.blockIdToName = null
    this._blockInfoCache = new Map() // blockId -> mapping info (null incl.)
    this._uvRectCache = new Map()   // tileIndex -> uv rect
    this.atlasTexture = null
    this._material = null
    this.minY = 0
    this.worldHeight = 256
    this.ready = false
    this.frames = 0
    this.lastFpsTime = performance.now()
    this.lastFrameTime = performance.now() // per-frame dt (smoothing)
    this.fps = 0
    // Camera prediction state (see updateCamera/applyCameraEachFrame)
    this.camTarget = null   // last server position {x,y,z}
    this.camPos = null      // smoothed current camera position
    this.camSnapped = false // true after the first server position snaps
    this.localYaw = null    // local (mouse) look — null until first mouse move
    this.localPitch = null
    this.serverYaw = undefined   // last server look echo (used when not locked)
    this.serverPitch = undefined
    this.sneaking = false   // eye height dips to 1.27 while sneaking
    this.sprinting = false  // FOV widens to 77° while sprinting
    this.eyeHeight = 1.62   // smoothed current eye height
    // V1.1.0 — block targeting: last raycast hit + its wireframe box
    this.highlight = null      // { x, y, z, face, name } | null
    this.highlightMesh = null  // THREE.LineSegments (black wireframe)
    // V1.1.1 — first-person hand, swing animation, mining crack overlay
    this.handScene = null
    this.handCamera = null
    this.handRoot = null
    this.handMesh = null
    this.heldName = undefined // undefined = never built; null = bare arm
    this.swingT = 1           // 1 = idle (swing runs 0 -> 1)
    this.destroyTexture = null
    this.destroyMesh = null
    this.digState = null      // { x, y, z, start, duration }
  }

  async init (loginMsg) {
    this.minY = loginMsg.minY || 0
    this.worldHeight = loginMsg.worldHeight || 256
    this.renderDistance = loginMsg.renderDistance || 4
    this.entityMappings = loginMsg.entityMappings || {}
    // V1.1.2 — vanilla-style 3D mob models (shape + parts + texture data URL)
    this.entityModels = loginMsg.entityModels || {}

    // --- Scene basics --------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)
    this.scene.fog = new THREE.Fog(0x87ceeb, this.renderDistance * 16 * 0.7, this.renderDistance * 16)

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000)
    // Mineflayer yaw/pitch conventions map exactly to three.js with the
    // YXZ rotation order: ry = yaw, rx = -pitch (see applyCameraEachFrame).
    this.camera.rotation.order = 'YXZ'

    // Perf: antialias is the single most expensive WebGL option for a voxel
    // renderer (MSAA on thousands of quads); the pixel-blob textures hide
    // most aliasing anyway. PixelRatio capped at 1.5 instead of 2 — on a
    // hidpi screen that's ~44% fewer pixels shaded, visually near-identical
    // for 16x16 block textures.
    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: false, powerPreference: 'high-performance' })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))

    const ambient = new THREE.AmbientLight(0xffffff, 0.75)
    const sun = new THREE.DirectionalLight(0xffffff, 0.7)
    sun.position.set(0.5, 1, 0.3)
    this.scene.add(ambient)
    this.scene.add(sun)

    // --- Texture atlas ---------------------------------------------------
    this.blockMappings = loginMsg.blockMappings || {}
    const tex = await this.loadTexture('/atlas.png')
    this.atlasTexture = tex

    // Atlas layout info sent by the server? We use a fixed 64x64 grid of
    // 16px tiles (see server/resourcePack.js).
    this.atlasGrid = 64
    this.tileSize = 16
    this.atlasPixelSize = this.atlasGrid * this.tileSize

    window.addEventListener('resize', () => this.onResize())
    // V1.2.0 — pre-load the item atlas (dropped items + hand fallbacks use
    // it synchronously) + first-person hand + mining crack overlay
    this.ensureItemAtlas().then((atlas) => { this.itemAtlasInfoSync = atlas })
    this.initHandScene()
    this.initLocalPlayerModel() // V1.2.0 — F5 third person
    this.loadOverlays() // async; the overlay just stays absent on 404
    this.ready = true
    this.startLoop()
  }

  async loadTexture (url) {
    const img = await new Promise((resolve, reject) => {
      const image = new Image()
      image.onload = () => resolve(image)
      image.onerror = reject
      image.src = url
    })
    const tex = new THREE.Texture(img)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    return tex
  }

  onResize () {
    if (!this.renderer) return
    this.camera.aspect = window.innerWidth / window.innerHeight
    this.camera.updateProjectionMatrix()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    // The hand scene must keep the same aspect or the arm stretches on resize
    if (this.handCamera) {
      this.handCamera.aspect = window.innerWidth / window.innerHeight
      this.handCamera.updateProjectionMatrix()
    }
  }

  // ------------------------------------------------------------------
  // Chunks
  // ------------------------------------------------------------------

  /** UV rect for a tile index, cached per tile (the atlas is static).
   *  Three.js flips textures vertically by default (flipY=true), so a tile
   *  at pixel row y (from the top) spans V = [1-(y+T)/S, 1-y/S]. */
  uvRectCached (tileIndex) {
    let rect = this._uvRectCache.get(tileIndex)
    if (rect) return rect
    const tx = (tileIndex % this.atlasGrid) * this.tileSize
    const ty = Math.floor(tileIndex / this.atlasGrid) * this.tileSize
    const inset = 0.02 // avoid atlas bleeding
    const S = this.atlasPixelSize
    rect = {
      u0: (tx + inset) / S,
      u1: (tx + this.tileSize - inset) / S,
      v1: 1 - (ty + inset) / S, // top edge of the tile
      v0: 1 - (ty + this.tileSize - inset) / S // bottom edge
    }
    this._uvRectCache.set(tileIndex, rect)
    return rect
  }

  handleChunk (decoded) {
    if (!this.ready) return
    const key = `${decoded.chunkX},${decoded.chunkZ}`
    // Cache the decoded chunk for later block-update rebuilds
    this.chunkBlocks.set(key, decoded)
    const old = this.chunks.get(key)
    if (old) {
      this.scene.remove(old)
      old.geometry.dispose()
    }
    const mesh = this.buildChunkMesh(decoded)
    if (mesh) {
      this.chunks.set(key, mesh)
      this.scene.add(mesh)
    } else {
      this.chunks.delete(key)
    }
  }

  /** Removes a chunk's meshes (server sent chunk_unload). */
  handleChunkUnload (cx, cz) {
    const key = `${cx},${cz}`
    const old = this.chunks.get(key)
    if (old) {
      this.scene.remove(old)
      old.geometry.dispose()
      this.chunks.delete(key)
    }
    this.chunkBlocks.delete(key)
  }

  /**
   * R key / server reset: wipes EVERYTHING (meshes + decoded chunk data +
   * dirty set) so the full re-stream rebuilds the world from zero — the fix
   * for client-side phantom blocks.
   */
  clearAllChunks () {
    for (const mesh of this.chunks.values()) {
      this.scene.remove(mesh)
      mesh.geometry.dispose()
    }
    this.chunks.clear()
    this.chunkBlocks.clear() // drops the per-chunk entry indexes too
    this.dirtyChunks.clear()
    this.highlight = null
    if (this.highlightMesh) {
      this.scene.remove(this.highlightMesh)
      this.highlightMesh.geometry.dispose()
      this.highlightMesh.material.dispose()
      this.highlightMesh = null
    }
  }

  /** Decodes an RGB565 tint into 0-1 floats (undefined when untinted). */
  static decodeTint (tint) {
    if (!tint) return null
    const r = (tint >> 11) & 0x1f
    const g = (tint >> 5) & 0x3f
    const b = tint & 0x1f
    return [(r << 3) / 255, (g << 2) / 255, (b << 3) / 255]
  }

  /**
   * Builds a single BufferGeometry mesh for a chunk from visible blocks.
   * faceMask bits: 1=+X, 2=-X, 4=+Y, 8=-Y, 16=+Z, 32=-Z
   * Each entry may carry a biome tint (RGB565, 0 = none): it becomes the
   * per-vertex color, multiplied with the map by the Lambert shader.
   */
  buildChunkMesh (decoded) {
    const { chunkX, chunkZ, minY, entries } = decoded
    const positions = []
    const normals = []
    const uvs = []
    const colors = []
    const indices = []

    for (const e of entries) {
      const info = this.blockInfo(e.blockId)
      if (!info) continue
      const wx = chunkX * 16 + e.x
      const wy = minY + e.y
      const wz = chunkZ * 16 + e.z
      // Biome tint (grass/leaves/water) — default white = untinted
      const tint = Renderer.decodeTint(e.tint) || WHITE_TINT

      if (info.cross) {
        this.pushCross(positions, normals, uvs, indices, wx, wy, wz, info, colors, tint)
        continue
      }

      for (const f of FACE_DEFS) {
        if (!(e.faceMask & f.bit)) continue
        const tile = info[f.tile] !== undefined ? info[f.tile] : info.side
        const rect = this.uvRectCached(tile)
        const base = positions.length / 3
        const cs = f.corners
        for (let ci = 0; ci < 4; ci++) {
          const c = cs[ci]
          positions.push(wx + c.p[0], wy + c.p[1], wz + c.p[2])
          normals.push(f.dir[0], f.dir[1], f.dir[2])
          uvs.push(
            c.uv[0] === 0 ? rect.u0 : rect.u1,
            c.uv[1] === 0 ? rect.v0 : rect.v1
          )
          colors.push(tint[0], tint[1], tint[2])
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
    }

    if (positions.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3))
    geometry.setIndex(indices)

    const material = this.chunkMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = true
    return mesh
  }

  /** X-shaped plant geometry (grass, flowers...). */
  pushCross (positions, normals, uvs, indices, wx, wy, wz, info, colors, tint) {
    const tile = info.side !== undefined ? info.side : info.all
    if (tile === undefined) return
    const rect = this.uvRectCached(tile)
    const tintArr = tint || WHITE_TINT
    // Two quads crossing diagonally; each rendered double-sided
    const quads = [
      { p: [[0, 0, 0], [1, 0, 1], [1, 1, 1], [0, 1, 0]], n: [1, 0, -1] },
      { p: [[1, 0, 0], [0, 0, 1], [0, 1, 1], [1, 1, 0]], n: [-1, 0, -1] }
    ]
    const uvCorners = [[0, 0], [1, 0], [1, 1], [0, 1]]
    for (const q of quads) {
      const base = positions.length / 3
      for (let i = 0; i < 4; i++) {
        const c = q.p[i]
        positions.push(wx + c[0], wy + c[1], wz + c[2])
        normals.push(q.n[0], q.n[1], q.n[2])
        const uv = uvCorners[i]
        uvs.push(uv[0] === 0 ? rect.u0 : rect.u1, uv[1] === 0 ? rect.v0 : rect.v1)
        colors.push(tintArr[0], tintArr[1], tintArr[2])
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      // Double-sided: add the reversed quad
      const base2 = positions.length / 3
      for (let i = 3; i >= 0; i--) {
        const c = q.p[i]
        positions.push(wx + c[0], wy + c[1], wz + c[2])
        normals.push(q.n[0], q.n[1], q.n[2])
        const uv = uvCorners[i]
        uvs.push(uv[0] === 0 ? rect.u0 : rect.u1, uv[1] === 0 ? rect.v0 : rect.v1)
        colors.push(tintArr[0], tintArr[1], tintArr[2])
      }
      indices.push(base2, base2 + 1, base2 + 2, base2, base2 + 2, base2 + 3)
    }
  }

  blockInfo (blockId) {
    if (this._blockInfoCache.has(blockId)) return this._blockInfoCache.get(blockId)
    let info = null
    if (this.blockIdToName) {
      const name = this.blockIdToName[blockId]
      if (name) info = this.blockMappings[name] || null
    }
    this._blockInfoCache.set(blockId, info)
    return info
  }


  /** Sets the id->name table sent by the server at login. */
  setBlockNames (namesById) {
    this.blockIdToName = namesById
  }

  // ------------------------------------------------------------------
  // Block targeting (V1.1.0) — DDA voxel raycast from the camera
  // ------------------------------------------------------------------

  /**
   * Raycast through the loaded chunk data (NOT the GPU meshes — invisible
   * faces are missing from them). The traversal itself lives in
   * voxelRaycast.js (shared with the unit tests); this wrapper feeds it
   * the camera ray and the chunk-data block lookup.
   *
   * Returns { x, y, z, face, name } or null. Blocks the ray passes THROUGH:
   * cross-shaped plants & (semi-)transparent blocks (glass, water...) —
   * exactly like vanilla's "passable" targets.
   */
  raycastBlocks (maxDistance = 4.5) {
    if (!this.camera || !this.blockIdToName || !window.VoxelRaycast) return null
    const origin = this.camera.position
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
    const hit = window.VoxelRaycast.raycast(origin, dir, maxDistance, (x, y, z) => {
      const block = this.blockAtVoxel(x, y, z)
      return !!(block && this.isTargetable(block.name))
    })
    if (!hit) return null
    const block = this.blockAtVoxel(hit.x, hit.y, hit.z)
    return { x: hit.x, y: hit.y, z: hit.z, face: hit.face, name: block.name }
  }

  /** Decoded-entry lookup for the world voxel (x,y,z), or null. */
  blockAtVoxel (x, y, z) {
    const key = `${x >> 4},${z >> 4}`
    const data = this.chunkBlocks.get(key)
    if (!data) return null
    if (!data.index) this.ensureChunkIndex(data)
    const localY = y - data.minY
    if (localY < 0 || localY > 4095) return null // index key packing limit
    const entry = data.index.get((x & 15) * 65536 + localY * 16 + (z & 15))
    if (!entry) return null
    const name = this.blockIdToName[entry.blockId]
    return name ? { name, blockId: entry.blockId } : null
  }

  /** Lazily builds the local (x,y,z) -> entry index of a decoded chunk. */
  ensureChunkIndex (data) {
    if (data.index) return data.index
    data.index = new Map()
    for (const e of data.entries) {
      if (e.y < 4096) data.index.set(e.x * 65536 + e.y * 16 + e.z, e)
    }
    return data.index
  }

  /**
   * Can the player interact with this block? Cross plants & transparent
   * blocks are see-through in vanilla (ray continues past them).
   */
  isTargetable (name) {
    const info = this.blockMappings[name]
    if (info) {
      if (info.cross) return false
      if (info.opacity !== undefined && info.opacity < 1) return false
    }
    return true
  }

  /**
   * Is this HELD item name a placeable block? (Vanilla block items share the
   * block's name — 'dirt' places dirt, 'stone' places stone. Tools/food have
   * no block counterpart and are "used" instead of placed.)
   */
  isPlaceableItem (name) {
    return !!(this.blockMappings && this.blockMappings[name])
  }

  // ------------------------------------------------------------------
  // V1.2.0 — Entity targeting (attack) + third-person camera (F5)
  // ------------------------------------------------------------------

  /**
   * Raycasts the visible entities along the camera look, closest first.
   * The check is a segment/sphere test against each entity's rendering
   * bounds (its interpolated position + its height/width). Returns
   * { id, name, dist } or null. Range: vanilla survival attack reach.
   */
  raycastEntities (maxDistance = 3.5) {
    if (!this.camera || this.entities.size === 0) return null
    const origin = this.camera.position
    const dir = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
    let best = null
    for (const [id, group] of this.entities) {
      const d = group.userData.dims || { height: 1.8, width: 0.6 }
      // Sphere centre at mid-height of the entity's current (interpolated) pos
      const cx = group.position.x
      const cy = group.position.y + d.height / 2
      const cz = group.position.z
      const ox = cx - origin.x; const oy = cy - origin.y; const oz = cz - origin.z
      const radius = Math.max(d.width, d.height * 0.45) / 2 + 0.15 // hitbox + leeway
      // Project the centre on the ray; reject entities behind the camera
      const t = ox * dir.x + oy * dir.y + oz * dir.z
      if (t < 0 || t > maxDistance) continue
      const px = origin.x + dir.x * t; const py = origin.y + dir.y * t; const pz = origin.z + dir.z * t
      const distSq = (px - cx) * (px - cx) + (py - cy) * (py - cy) + (pz - cz) * (pz - cz)
      if (distSq <= radius * radius) {
        if (!best || t < best.dist) best = { id, name: group.userData.name || null, dist: t }
      }
    }
    return best
  }

  /** Black wireframe box on the targeted block (vanilla-style feedback). */
  updateHighlight (target) {
    if (!this.highlightMesh) {
      const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002)
      const mat = new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.6 })
      this.highlightMesh = new THREE.LineSegments(new THREE.EdgesGeometry(geo), mat)
      this.highlightMesh.renderOrder = 999
      this.scene.add(this.highlightMesh)
      geo.dispose() // EdgesGeometry holds its own copy
    }
    if (target) {
      this.highlightMesh.visible = true
      this.highlightMesh.position.set(target.x + 0.5, target.y + 0.5, target.z + 0.5)
    } else {
      this.highlightMesh.visible = false
    }
  }

  // ------------------------------------------------------------------
  // First-person hand / held item (V1.1.1)
  // ------------------------------------------------------------------

  /**
   * The hand lives in its OWN scene rendered with a STATIC camera after the
   * world pass (depth buffer cleared): it can never clip into world blocks
   * and never moves with the world camera — exactly like vanilla's hand.
   */
  initHandScene () {
    this.handScene = new THREE.Scene()
    this.handCamera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 10)
    this.handScene.add(new THREE.AmbientLight(0xffffff, 1.0))
    const sun = new THREE.DirectionalLight(0xffffff, 0.6)
    sun.position.set(0.5, 1, 0.3)
    this.handScene.add(sun)
    this.handRoot = new THREE.Group()
    this.handScene.add(this.handRoot)
    this.swingT = 1 // 1 = idle (swing runs 0 -> 1)
    this.rebuildHand()
  }

  /** Loads the destroy-stage crack sheet (may 404 — no overlay then). */
  async loadOverlays () {
    try {
      this.destroyTexture = await this.loadTexture('/destroy.png')
      if (this.destroyTexture) this.destroyTexture.repeat.set(0.1, 1)
    } catch (e) {
      this.destroyTexture = null
    }
  }

  /** Item icon atlas (for held items) — loaded once, cached, null on failure. */
  async ensureItemAtlas () {
    if (this.itemAtlasInfo !== undefined) return this.itemAtlasInfo
    try {
      const res = await fetch('/items.json')
      if (!res.ok) throw new Error('no item atlas')
      const meta = await res.json()
      const tex = await this.loadTexture('/items.png')
      this.itemAtlasInfo = { tex, items: meta.items || {}, grid: meta.atlasGrid || 64 }
    } catch (e) {
      this.itemAtlasInfo = null
    }
    return this.itemAtlasInfo
  }

  /** Rebuilds the hand mesh when the held item changes (null = bare arm). */
  setHeldItem (name) {
    if (name === this.heldName) return
    this.heldName = name
    this.rebuildHand()
  }

  async rebuildHand () {
    const name = this.heldName
    // Drop the current mesh (dispose GPU resources — repeated swaps leak)
    if (this.handMesh) {
      this.handRoot.remove(this.handMesh)
      this.handMesh.geometry.dispose()
      const mats = Array.isArray(this.handMesh.material) ? this.handMesh.material : [this.handMesh.material]
      for (const m of mats) m.dispose()
      this.handMesh = null
    }
    if (!this.handScene) return
    if (!name) {
      this.handMesh = this.buildArmMesh()
    } else if (this.blockMappings && this.blockMappings[name]) {
      this.handMesh = this.buildBlockHandMesh(name)
    } else {
      // Not a block: icon quad from the item atlas (async — one fetch ever)
      const atlas = await this.ensureItemAtlas()
      if (name !== this.heldName) return // selection changed while loading
      if (atlas && atlas.items[name] !== undefined) {
        this.handMesh = this.buildItemHandMesh(name, atlas)
      } else {
        this.handMesh = this.buildArmMesh() // unknown item -> arm fallback
      }
    }
    if (this.handMesh) this.handRoot.add(this.handMesh)
  }

  /** Bare Steve-style arm (nothing held). */
  buildArmMesh () {
    const geo = new THREE.BoxGeometry(0.24, 0.24, 0.7)
    const mat = new THREE.MeshLambertMaterial({ color: 0xc98d6d })
    const mesh = new THREE.Mesh(geo, mat)
    mesh.position.set(0.55, -0.6, -0.72)
    mesh.rotation.set(0.5, -0.15, 0)
    return mesh
  }

  /** Held BLOCK: a cube textured with the block's atlas tiles (iso view). */
  buildBlockHandMesh (name) {
    const info = this.blockMappings[name]
    if (info.cross) return this.buildCrossHandMesh(info)
    const positions = []
    const normals = []
    const uvs = []
    const indices = []
    for (const f of FACE_DEFS) {
      const tile = info[f.tile] !== undefined ? info[f.tile] : info.side
      const rect = this.uvRectCached(tile)
      const base = positions.length / 3
      for (let ci = 0; ci < 4; ci++) {
        const c = f.corners[ci]
        positions.push(c.p[0] - 0.5, c.p[1] - 0.5, c.p[2] - 0.5)
        normals.push(f.dir[0], f.dir[1], f.dir[2])
        uvs.push(c.uv[0] === 0 ? rect.u0 : rect.u1, c.uv[1] === 0 ? rect.v0 : rect.v1)
      }
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }
    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)
    const material = new THREE.MeshLambertMaterial({ map: this.atlasTexture })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.scale.setScalar(0.4)
    mesh.position.set(0.52, -0.42, -0.75)
    mesh.rotation.y = -Math.PI / 4 // vanilla's isometric block angle
    return mesh
  }

  /** Held CROSS block (torch, flowers...): flat quad with the side tile. */
  buildCrossHandMesh (info) {
    const tile = info.side !== undefined ? info.side : info.all
    if (tile === undefined) return this.buildArmMesh()
    const rect = this.uvRectCached(tile)
    const geometry = new THREE.PlaneGeometry(0.55, 0.55)
    const uv = geometry.attributes.uv
    uv.setXY(0, rect.u0, rect.v1)
    uv.setXY(1, rect.u1, rect.v1)
    uv.setXY(2, rect.u0, rect.v0)
    uv.setXY(3, rect.u1, rect.v0)
    const material = new THREE.MeshLambertMaterial({
      map: this.atlasTexture, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(0.6, -0.48, -0.78)
    mesh.rotation.set(0, -0.4, 0.3)
    return mesh
  }

  /** Held ITEM (tool/food/...): flat quad with its icon from the item atlas. */
  buildItemHandMesh (name, atlas) {
    const rect = this.uvRectOnAtlas(atlas.items[name], atlas.grid)
    const geometry = new THREE.PlaneGeometry(0.55, 0.55)
    const uv = geometry.attributes.uv
    uv.setXY(0, rect.u0, rect.v1)
    uv.setXY(1, rect.u1, rect.v1)
    uv.setXY(2, rect.u0, rect.v0)
    uv.setXY(3, rect.u1, rect.v0)
    const material = new THREE.MeshLambertMaterial({
      map: atlas.tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.position.set(0.62, -0.5, -0.8)
    mesh.rotation.set(0, -0.45, 0.35)
    return mesh
  }

  /** UV rect of a tile on ANY square grid atlas (items use 64 like blocks). */
  uvRectOnAtlas (tileIndex, grid) {
    const S = grid * 16
    const tx = (tileIndex % grid) * 16
    const ty = Math.floor(tileIndex / grid) * 16
    const inset = 0.02
    return {
      u0: (tx + inset) / S,
      u1: (tx + 16 - inset) / S,
      v1: 1 - (ty + inset) / S,
      v0: 1 - (ty + 16 - inset) / S
    }
  }

  /** Punch animation trigger (dig / place / activate). */
  swingHand () {
    if (this.handRoot) this.swingT = 0
  }

  /** Hand transform per frame: idle + the swing arc (sin, 250 ms). */
  animateHand (dtMs) {
    if (!this.handRoot) return
    if (this.swingT < 1) this.swingT = Math.min(1, this.swingT + dtMs / 250)
    const s = this.swingT >= 1 ? 0 : Math.sin(this.swingT * Math.PI)
    this.handRoot.position.set(-s * 0.22, -s * 0.12, s * 0.15)
    this.handRoot.rotation.set(-s * 0.8, -s * 0.3, 0)
  }

  // ------------------------------------------------------------------
  // V1.2.0 — Third-person camera (F5) + the local player's model
  // ------------------------------------------------------------------

  /**
   * Builds the LOCAL player's model (steve skin from the pack). Hidden in
   * first person — shown when the camera toggles to third person (F5).
   */
  initLocalPlayerModel () {
    const model = this.entityModels && this.entityModels.player
    if (!model) return
    const group = new THREE.Group()
    this.buildModeledEntity(group, model, { height: 1.8, width: 0.6 })
    // The model is built with pivot at feet: place it at the camera target.
    group.visible = false
    this.localPlayer = group
    this.scene.add(group)
  }

  /** F5 toggle: 0 = first person (hand shown), 1 = third person (model shown). */
  setThirdPerson (enabled) {
    this.thirdPerson = !!enabled
    if (this.localPlayer) this.localPlayer.visible = this.thirdPerson
    // The first-person hand makes no sense in third person
    if (this.handScene) this.handScene.visible = !this.thirdPerson
  }

  /**
   * Per-frame third-person camera: positioned back+up from the eye along
   * the REVERSE look, with a simple block-clip so walls push it forward.
   * The local player model is moved to the smoothed camera target.
   */
  applyThirdPersonCamera (yaw, pitch, dtMs) {
    const cam = this.camera
    // Direction the player looks (yaw/pitch conventions as elsewhere)
    const dirX = -Math.sin(yaw) * Math.cos(pitch)
    const dirZ = -Math.cos(yaw) * Math.cos(pitch)
    const dirY = Math.sin(-pitch)
    const eye = this.camPos
    if (!eye) return
    const DIST = 4
    let dist = DIST
    // Short raycast from the eye backwards: stop at the first solid block
    const back = { x: -dirX, y: -dirY, z: -dirZ }
    const hit = window.VoxelRaycast
      ? window.VoxelRaycast.raycast(
        { x: eye.x, y: eye.y + this.eyeHeight, z: eye.z },
        back, DIST,
        (x, y, z) => {
          const b = this.blockAtVoxel(x, y, z)
          return !!(b && this.isTargetable(b.name))
        })
      : null
    if (hit) {
      // Pull in just in front of the block that blocks the view
      dist = Math.max(0.5, Math.min(DIST, hit.dist !== undefined ? hit.dist - 0.2 : 1.5))
    }
    if (this.localPlayer) {
      this.localPlayer.position.set(eye.x, eye.y, eye.z)
      this.localPlayer.rotation.y = yaw
      // Walk animation driven by the same swing parts mechanism
      const swing = this.localPlayer.userData.swingParts
      if (swing) {
        const moved = Math.hypot(eye.x - (this._lastEyeX || eye.x), eye.z - (this._lastEyeZ || eye.z))
        this._lastEyeX = eye.x
        this._lastEyeZ = eye.z
        this.localPlayer.userData.walkPhase = (this.localPlayer.userData.walkPhase || 0) + moved * 9
        const a = Math.sin(this.localPlayer.userData.walkPhase) * 0.7 * Math.min(1, moved * 40)
        for (const m of swing) m.rotation.x = a * m.userData.swingPhase
      }
    }
    cam.position.set(
      eye.x + back.x * dist,
      eye.y + this.eyeHeight + back.y * dist,
      eye.z + back.z * dist
    )
  }

  /** dig_start from the server: shows the crack overlay on (x,y,z). */
  handleDigStart (x, y, z, duration) {
    if (!this.destroyTexture) return
    if (!Number.isFinite(duration) || duration <= 0) return // instant dig
    this.digState = { x, y, z, start: performance.now(), duration }
    if (!this.destroyMesh) {
      const geo = new THREE.BoxGeometry(1.002, 1.002, 1.002)
      const mat = new THREE.MeshBasicMaterial({
        map: this.destroyTexture,
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2
      })
      this.destroyMesh = new THREE.Mesh(geo, mat)
      this.destroyMesh.renderOrder = 998
      this.destroyMesh.visible = false
      this.destroyMesh.stage = -1
      this.scene.add(this.destroyMesh)
    }
  }

  /** dig_ok / dig_error / block replaced: hide the overlay. */
  handleDigEnd () {
    this.digState = null
    if (this.destroyMesh) this.destroyMesh.visible = false
  }

  /** Per-frame crack stage from the dig progress (10 vanilla stages). */
  updateDigOverlay (now) {
    if (!this.digState || !this.destroyMesh) return
    const progress = (now - this.digState.start) / this.digState.duration
    if (progress > 3) { // safety: the server never confirmed the end
      this.handleDigEnd()
      return
    }
    const stage = Math.max(0, Math.min(9, Math.floor(progress * 10)))
    if (this.destroyMesh.stage !== stage) {
      this.destroyMesh.stage = stage
      // The sheet is 10 tiles side by side: offset.x selects the stage
      this.destroyTexture.offset.x = stage / 10
    }
    this.destroyMesh.position.set(this.digState.x + 0.5, this.digState.y + 0.5, this.digState.z + 0.5)
    this.destroyMesh.visible = true
  }

  chunkMaterial () {
    if (!this._material) {
      this._material = new THREE.MeshLambertMaterial({
        map: this.atlasTexture,
        vertexColors: true, // V1.1.1 — biome tint (RGB565 -> per-vertex color)
        alphaTest: 0.1,
        side: THREE.FrontSide,
        transparent: false
      })
    }
    return this._material
  }

  // ------------------------------------------------------------------
  // Block updates (patch existing chunk meshes)
  // ------------------------------------------------------------------

  handleBlockUpdate (blocks) {
    if (!this.ready) return
    const list = Array.isArray(blocks) ? blocks : [blocks]
    for (const block of list) {
      if (!block) continue
      const key = `${block.x >> 4},${block.z >> 4}`
      const data = this.chunkBlocks.get(key)
      if (!data) continue
      // Lazily built & maintained index: local (x,y,z) -> entry (the old
      // code ran a findIndex over ALL chunk entries for EVERY block — with
      // 30k entries per chunk that froze the frame on world edits).
      if (!data.index) this.ensureChunkIndex(data)
      const localX = block.x & 15
      const localZ = block.z & 15
      const localY = block.y - data.minY
      const idxKey = localX * 65536 + localY * 16 + localZ
      const info = block.blockId !== 0 ? {
        x: localX, y: localY, z: localZ,
        blockId: block.blockId, faceMask: block.faceMask
      } : null
      const existing = data.index.get(idxKey)
      if (existing && info) {
        // In-place update keeps array positions stable (no splice churn)
        existing.blockId = info.blockId
        existing.faceMask = info.faceMask
      } else if (existing) {
        data.index.delete(idxKey)
        const i = data.entries.indexOf(existing)
        if (i >= 0) data.entries.splice(i, 1)
      } else if (info) {
        data.entries.push(info)
        data.index.set(idxKey, info)
      }
      // Rebuild lazily: mark dirty, rebuild on next frame (budgeted)
      this.dirtyChunks.add(key)
    }
  }

  // ------------------------------------------------------------------
  // Entities
  // ------------------------------------------------------------------

  handleEntity (msg) {
    if (!this.ready) return
    if (msg.updates) {
      // Batched movement updates (server sends one 'entities' message with
      // up to N entity positions every 100 ms instead of N messages)
      for (const u of msg.updates) {
        const group = this.entities.get(u.id)
        if (!group) continue
        // Store the target: interpolation happens per frame in animate()
        group.userData.target = { x: u.x, y: u.y, z: u.z }
        group.userData.targetYaw = u.yaw || 0
      }
      return
    }
    if (msg.isNew) {
      const group = this.buildEntityMesh(msg)
      if (group) {
        // V1.2.0 — keep dims/name for the entity raycast (attack targeting)
        group.userData.dims = this.entityDims(msg.name)
        group.userData.name = msg.name
        this.entities.set(msg.id, group)
        this.scene.add(group)
      }
    } else {
      const group = this.entities.get(msg.id)
      if (group) {
        group.position.set(msg.x, msg.y, msg.z)
        // Mineflayer yaw convention: 0 = north (-Z), positive = CCW.
        // A three.js rotation.y of yaw gives exactly that orientation.
        group.rotation.y = msg.yaw || 0
      }
    }
  }

  /** Per-frame interpolation of entity positions (movement updates only
   *  arrive ~10 times per second now — without smoothing mobs teleport).
   *  Time-based smoothing: identical feel at any fps.
   *  V1.2.0 — also animates the walk cycle (arms/legs swing) from the
   *  entity's actual travel speed. */
  interpolateEntities (dtMs) {
    const alpha = 1 - Math.exp(-dtMs / 80) // τ = 80 ms for mobs
    for (const group of this.entities.values()) {
      const t = group.userData.target
      if (!t) continue
      const prevX = group.position.x
      const prevZ = group.position.z
      group.position.x += (t.x - group.position.x) * alpha
      group.position.y += (t.y - group.position.y) * alpha
      group.position.z += (t.z - group.position.z) * alpha
      const ty = group.userData.targetYaw
      if (ty !== undefined) {
        let d = ty - group.rotation.y
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        group.rotation.y += d * alpha
      }
      // V1.2.0 — walk cycle: phase advances with the distance travelled
      const speed = Math.hypot(group.position.x - prevX, group.position.z - prevZ) / Math.max(dtMs, 1) // blocks/ms
      const swing = group.userData.swingParts
      if (swing && swing.length > 0) {
        group.userData.walkPhase = (group.userData.walkPhase || 0) + speed * dtMs * 9
        const a = Math.sin(group.userData.walkPhase) * 0.7
        for (const m of swing) {
          m.rotation.x = a * m.userData.swingPhase
        }
      }
      // V1.2.0 — dropped items: slow spin + gentle floating (vanilla)
      const itemSpin = group.userData.itemSpin
      if (itemSpin) {
        itemSpin.rotation.y += dtMs * 0.003
        itemSpin.position.y = 0.18 + Math.sin(performance.now() * 0.003) * 0.05
      }
    }
  }

  buildEntityMesh (msg) {
    const dims = this.entityDims(msg.name)
    const group = new THREE.Group()

    // V1.2.0 — dropped ITEM entities render as a textured mini-cube (the
    // block's own tiles) or a floating sprite for non-block items.
    if (msg.kind === 'item' || (msg.name && msg.name.startsWith('item_'))) {
      const itemName = msg.metadata && msg.metadata.itemName ? msg.metadata.itemName : null
      this.buildItemDropMesh(group, itemName || 'dirt', dims)
    } else {
      // V1.1.2 — vanilla-style 3D model (shape + parts + texture data URL)
      const model = this.entityModels && this.entityModels[msg.name]
      if (model) {
        this.buildModeledEntity(group, model, dims)
      } else {
        // Fallback: the old colored box
        const bodyColor = entityColor(msg)
        const geometry = new THREE.BoxGeometry(dims.width, dims.height, dims.width)
        const material = new THREE.MeshLambertMaterial({ color: bodyColor })
        const cube = new THREE.Mesh(geometry, material)
        cube.position.y = dims.height / 2
        group.add(cube)
      }
    }

    // Nametag for players & mobs
    if (msg.kind === 'player' || msg.name) {
      const tag = this.makeNametag(msg.kind === 'player' ? (msg.name || 'Player') : msg.name)
      if (tag) {
        tag.position.y = dims.height + 0.4
        group.add(tag)
      }
    }
    return group
  }

  /**
   * V1.2.0 — dropped item: a 0.25-block spinning cube with the block's real
   * atlas tiles (or a flat sprite quad for tools/food). Floats sin(t).
   */
  buildItemDropMesh (group, itemName, dims) {
    const info = this.blockMappings && this.blockMappings[itemName]
    let mesh = null
    if (info && !info.cross) {
      // Real block: mini cube with the block's top/side tiles
      const positions = []
      const normals = []
      const uvs = []
      const indices = []
      for (const f of FACE_DEFS) {
        const tile = info[f.tile] !== undefined ? info[f.tile] : info.side
        const rect = this.uvRectCached(tile)
        const base = positions.length / 3
        for (let ci = 0; ci < 4; ci++) {
          const c = f.corners[ci]
          positions.push(c.p[0] - 0.5, c.p[1] - 0.5, c.p[2] - 0.5)
          normals.push(f.dir[0], f.dir[1], f.dir[2])
          uvs.push(c.uv[0] === 0 ? rect.u0 : rect.u1, c.uv[1] === 0 ? rect.v0 : rect.v1)
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
      const geometry = new THREE.BufferGeometry()
      geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
      geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
      geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
      geometry.setIndex(indices)
      const material = new THREE.MeshLambertMaterial({ map: this.atlasTexture })
      mesh = new THREE.Mesh(geometry, material)
      mesh.scale.setScalar(0.25)
    } else {
      // Non-block item: flat sprite quad from the item atlas (or plain box)
      const atlas = this.itemAtlasInfoSync
      const tile = atlas && atlas.items[itemName] !== undefined ? atlas.items[itemName] : null
      if (tile !== null && atlas) {
        const rect = this.uvRectOnAtlas(tile, atlas.grid)
        const geometry = new THREE.PlaneGeometry(0.35, 0.35)
        const uv = geometry.attributes.uv
        uv.setXY(0, rect.u0, rect.v1)
        uv.setXY(1, rect.u1, rect.v1)
        uv.setXY(2, rect.u0, rect.v0)
        uv.setXY(3, rect.u1, rect.v0)
        const material = new THREE.MeshLambertMaterial({
          map: atlas.tex, transparent: true, alphaTest: 0.1, side: THREE.DoubleSide
        })
        mesh = new THREE.Mesh(geometry, material)
        mesh.rotation.x = -0.2
      } else {
        const material = new THREE.MeshLambertMaterial({ color: 0xffd54a })
        mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), material)
      }
    }
    mesh.position.y = 0.18
    // Spin + float handled per frame (see interpolateEntities)
    group.userData.itemSpin = mesh
    group.add(mesh)
  }

  /**
   * V1.1.2 — builds a composite vanilla-style mob: one THREE.Group of
   * BoxGeometry parts (head/body/arms/legs...), each UV-mapped onto the
   * mob's texture using the vanilla 64x64 box-UV layout, then scaled so
   * the model matches the entity's real hitbox dims (height/width).
   * V1.2.0 — parts tagged `swing` are stored for the walk animation
   * (rotate.x = sin(walkPhase) * 0.6, arms/legs in opposite phases).
   */
  buildModeledEntity (group, model, dims) {
    const img = new Image()
    img.src = model.texture
    const tex = new THREE.Texture(img)
    tex.magFilter = THREE.NearestFilter
    tex.minFilter = THREE.NearestFilter
    tex.colorSpace = THREE.SRGBColorSpace
    img.onload = () => { tex.needsUpdate = true }
    const material = new THREE.MeshLambertMaterial({ map: tex, alphaTest: 0.1 })

    // Texture layout size: sent by the server (64x64 humanoid, 64x32 creeper/
    // spider/skeleton/chicken/sheep/enderman...)
    const TW = model.texW || 64
    const TH = model.texH || 64

    for (const part of Object.values(model.parts)) {
      const [w, h, d] = part.size
      const geo = new THREE.BoxGeometry(w / 16, h / 16, d / 16)
      // Vanilla box UV: each face gets its own rectangle on the texture.
      // THREE BoxGeometry face order: +X, -X, +Y, -Y, +Z, -Z (4 uv each).
      const uv = geo.attributes.uv
      const U = part.uv[0]
      const V = part.uv[1]
      // Vanilla box-UV layout (u,v = top-left of the part's UV area):
      //   top:   [u+d,     v]       .. [u+d+w,     v+d]
      //   bottom:[u+d+w,   v]       .. [u+d+w+w,  v+d]
      //   west(-X): [u,       v+d]   .. [u+d,       v+d+h]
      //   north(-Z): [u+d,     v+d]   .. [u+d+w,     v+d+h]
      //   east(+X):  [u+d+w,  v+d]   .. [u+d+w+d,   v+d+h]
      //   south(+Z): [u+d+w+d,v+d]   .. [u+d+w+d+w, v+d+h]
      const px = (x) => x / TW
      const py = (y) => 1 - y / TH
      const rects = [
        [U + d + w, V + d, U + d + w + d, V + d + h], // +X = east
        [U, V + d, U + d, V + d + h], // -X = west
        [U + d, V, U + d + w, V + d], // +Y = top
        [U + d + w, V, U + d + w + w, V + d], // -Y = bottom
        [U + d + w + d, V + d, U + d + w + d + w, V + d + h], // +Z = south
        [U + d, V + d, U + d + w, V + d + h] // -Z = north
      ]
      for (let f = 0; f < 6; f++) {
        const [u0, v0, u1, v1] = rects[f]
        // Bottom row of the face = bottom of the texture rect (v1)
        uv.setXY(f * 4 + 0, px(u0), py(v1)) // bottom-left
        uv.setXY(f * 4 + 1, px(u1), py(v1)) // bottom-right
        uv.setXY(f * 4 + 2, px(u0), py(v0)) // top-left
        uv.setXY(f * 4 + 3, px(u1), py(v0)) // top-right
      }
      const mesh = new THREE.Mesh(geo, material)
      // Pivot = the CENTER of the box (see entityModels.js) — direct mapping
      mesh.position.set(part.pivot[0] / 16, part.pivot[1] / 16, part.pivot[2] / 16)
      if (part.swing) {
        // V1.2.0 — walk animation: rotate around the part's TOP (pivot of a
        // hanging limb). Store base Y + phase sign for the per-frame update.
        mesh.userData.baseY = mesh.position.y
        mesh.userData.swingPhase = part.swing
        if (!group.userData.swingParts) group.userData.swingParts = []
        group.userData.swingParts.push(mesh)
      }
      group.add(mesh)
    }

    // Scale the model to the entity's real hitbox: our humanoid is 32px tall
    // (2 blocks); quadruped 24px (1.5); enderman 42px... compute from the
    // highest part pivot+size so every shape auto-fits its hitbox height.
    let maxTop = 0
    for (const part of Object.values(model.parts)) {
      maxTop = Math.max(maxTop, part.pivot[1] + part.size[1])
    }
    // The model's top in blocks; scale = hitbox height / model height
    const modelHeightBlocks = maxTop / 16
    const scale = dims.height / modelHeightBlocks
    group.scale.setScalar(scale)
    // Parts pivot from the FEET (y=0) — the group is placed at the entity's
    // position (feet), exactly how the server reports it.
  }

  makeNametag (text) {
    const canvas = document.createElement('canvas')
    canvas.width = 256
    canvas.height = 64
    const ctx = canvas.getContext('2d')
    ctx.fillStyle = 'rgba(0,0,0,0.4)'
    ctx.fillRect(0, 0, 256, 64)
    ctx.font = '28px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(text.slice(0, 20), 128, 34)
    const texture = new THREE.CanvasTexture(canvas)
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false })
    const sprite = new THREE.Sprite(material)
    sprite.scale.set(1.6, 0.4, 1)
    return sprite
  }

  entityDims (name) {
    const d = (this.entityMappings && this.entityMappings[name]) || null
    return d ? { height: d.height, width: d.width } : { height: 1.8, width: 0.6 }
  }

  handleEntityGone (id) {
    const group = this.entities.get(id)
    if (group) {
      this.scene.remove(group)
      // Free GPU resources (old code leaked one geometry+material+texture
      // per removed entity — a slow memory leak over a long session)
      group.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose()
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
          for (const m of mats) {
            if (m.map && m.map.dispose) m.map.dispose()
            m.dispose()
          }
        }
      })
      this.entities.delete(id)
    }
  }

  // ------------------------------------------------------------------
  // Camera & animation
  // ------------------------------------------------------------------

  updateCamera (x, y, z, yaw, pitch) {
    if (!this.camera) return
    // Server position update (20 Hz): store as the smoothing TARGET only.
    // The actual camera transform is applied every frame in animate() using
    // the local (predicted) look — applying it here made the camera update
    // at 20 Hz and the game FEEL like 20 fps even at 300 fps.
    this.camTarget = { x, y, z }
    this.serverYaw = yaw
    this.serverPitch = pitch
    // Instantly snap the first update (spawn/teleport) so the camera
    // doesn't glide across the world on login.
    if (!this.camSnapped) {
      this.camSnapped = true
      this.camPos = { x, y, z }
      this.camera.position.set(x, y + 1.62, z)
    }
  }

  /** Local look from the mouse (prediction, zero latency). */
  setLocalLook (yaw, pitch) {
    this.localYaw = yaw
    this.localPitch = pitch
  }

  /** Sneak state toggles the eye height (1.62 standing, 1.27 sneaking,
   *  like vanilla) — smoothed per frame so the camera dips instead of
   *  teleporting when the key is pressed/released. Sprint widens the FOV. */
  setSneakSprint (sneaking, sprinting) {
    this.sneaking = !!sneaking
    this.sprinting = !!sprinting
  }

  /**
   * Applies the camera transform EVERY FRAME:
   *  - rotation from the LOCAL mouse look (instant, no network round-trip)
   *  - position smoothed toward the last server position with a time
   *    constant of 50 ms (matches the server's 20 Hz update rate, so the
   *    movement looks fluid at any fps without adding latency)
   *  - when the pointer is NOT locked, the server's yaw/pitch echo is used
   *    (spectating/knockback corrections)
   * The smoothing factor is TIME-based (dt in ms) so the feel is identical
   * at 30, 60 or 300 fps.
   */
  applyCameraEachFrame (serverYaw, serverPitch, dtMs) {
    const cam = this.camera
    if (!cam) return
    // Rotation: local look takes priority while the mouse drives the camera
    if (this.localYaw !== null && document.pointerLockElement) {
      cam.rotation.y = this.localYaw
      cam.rotation.x = -this.localPitch
    } else if (serverYaw !== undefined) {
      cam.rotation.y = serverYaw
      cam.rotation.x = -serverPitch
    }
    // Position: exponential smoothing toward the server target.
    // alpha = 1 - exp(-dt/τ) with τ = 50 ms — framerate-independent.
    if (this.camPos && this.camTarget) {
      const alpha = 1 - Math.exp(-dtMs / 50)
      this.camPos.x += (this.camTarget.x - this.camPos.x) * alpha
      this.camPos.y += (this.camTarget.y - this.camPos.y) * alpha
      this.camPos.z += (this.camTarget.z - this.camPos.z) * alpha
      // Eye height: 1.62 standing / 1.27 sneaking (vanilla), smoothed with
      // the same time constant so the camera DIPS when sneaking instead of
      // teleporting. When sprinting, the FOV widens slightly like vanilla.
      const targetEye = this.sneaking ? 1.27 : 1.62
      this.eyeHeight += (targetEye - this.eyeHeight) * alpha
      cam.position.set(this.camPos.x, this.camPos.y + this.eyeHeight, this.camPos.z)
      // V1.2.0 — third person (F5): camera moves back over the shoulder and
      // the local model is shown; first person keeps the standard eye.
      if (this.thirdPerson) {
        this.applyThirdPersonCamera(
          document.pointerLockElement ? this.localYaw : (this.serverYaw ?? 0),
          document.pointerLockElement ? this.localPitch : (this.serverPitch ?? 0),
          dtMs)
      }
      // Sprint FOV effect (vanilla: +10% while sprinting)
      const targetFov = this.sprinting ? 77 : 70
      if (Math.abs(cam.fov - targetFov) > 0.05) {
        cam.fov += (targetFov - cam.fov) * alpha
        cam.updateProjectionMatrix()
      }
    }
  }

  animate () {
    if (!this.ready) return
    this.frames++
    const now = performance.now()
    const dtMs = now - this.lastFrameTime
    this.lastFrameTime = now
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frames
      this.frames = 0
      this.lastFpsTime = now
    }
    // Rebuild dirty chunks within a time budget: rebuilding them ALL in one
    // frame caused multi-hundred-ms spikes (frozen camera) on world edits.
    if (this.dirtyChunks.size > 0) {
      const budgetEnd = now + 6 // ms
      for (const key of this.dirtyChunks) {
        const data = this.chunkBlocks.get(key)
        if (data) this.handleChunk(data)
        this.dirtyChunks.delete(key)
        if (performance.now() >= budgetEnd) break
      }
    }
    if (this.entities.size > 0) this.interpolateEntities(dtMs)
    // Camera: applied EVERY frame with the local (predicted) look and a
    // smoothed position — never at the 20 Hz network rate.
    this.applyCameraEachFrame(this.serverYaw, this.serverPitch, dtMs)
    // V1.1.0 — block targeting: raycast from the (just-updated) camera and
    // refresh the wireframe box. Only while the mouse drives the camera:
    // without the pointer lock the crosshair is not on screen.
    if (document.pointerLockElement) {
      this.highlight = this.raycastBlocks()
    } else {
      this.highlight = null
    }
    this.updateHighlight(this.highlight)
    // V1.1.1 — mining crack overlay stage + hand swing, then the two render
    // passes: world first, then the hand with a CLEARED depth buffer so it
    // never clips into world geometry (vanilla renders it the same way).
    this.updateDigOverlay(now)
    this.animateHand(dtMs)
    this.renderer.render(this.scene, this.camera)
    if (this.handScene) {
      this.renderer.autoClear = false
      this.renderer.clearDepth()
      this.renderer.render(this.handScene, this.handCamera)
      this.renderer.autoClear = true
    }
  }

  /** Starts the render loop (bound once — the old code allocated a new
   *  bound function on EVERY frame). */
  startLoop () {
    const loop = () => {
      requestAnimationFrame(loop)
      this.animate()
    }
    requestAnimationFrame(loop)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Deterministic color for an entity kind (fallback when no texture). */
function entityColor (msg) {
  const palette = {
    player: 0x3d9bff,
    zombie: 0x3fa34d,
    skeleton: 0xc9c9c9,
    creeper: 0x4d9e4d,
    spider: 0x2e2229,
    enderman: 0x161616,
    pig: 0xe79c9c,
    cow: 0x4a3728,
    sheep: 0xe8e8e8,
    chicken: 0xe8e8e8,
    item: 0xffd54a,
    arrow: 0xd8d8d8,
    minecart: 0x8a8a8a
  }
  const key = String(msg.name || '').toLowerCase()
  for (const [k, v] of Object.entries(palette)) {
    if (key.includes(k)) return v
  }
  let h = 0
  const s = String(msg.name || msg.kind || '?')
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return (h & 0xffffff) | 0x404040
}

// ---------------------------------------------------------------------------
// Module exports (window bridge for classic scripts)
// ---------------------------------------------------------------------------

window.Renderer = Renderer
export { Renderer }


