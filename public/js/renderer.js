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
    this.fps = 0
  }

  async init (loginMsg) {
    this.minY = loginMsg.minY || 0
    this.worldHeight = loginMsg.worldHeight || 256
    this.renderDistance = loginMsg.renderDistance || 4
    this.entityMappings = loginMsg.entityMappings || {}

    // --- Scene basics --------------------------------------------------
    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x87ceeb)
    this.scene.fog = new THREE.Fog(0x87ceeb, this.renderDistance * 16 * 0.7, this.renderDistance * 16)

    this.camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.1, 1000)

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
   * Builds a single BufferGeometry mesh for a chunk from visible blocks.
   * faceMask bits: 1=+X, 2=-X, 4=+Y, 8=-Y, 16=+Z, 32=-Z
   */
  buildChunkMesh (decoded) {
    const { chunkX, chunkZ, minY, entries } = decoded
    const positions = []
    const normals = []
    const uvs = []
    const indices = []

    for (const e of entries) {
      const info = this.blockInfo(e.blockId)
      if (!info) continue
      const wx = chunkX * 16 + e.x
      const wy = minY + e.y
      const wz = chunkZ * 16 + e.z

      if (info.cross) {
        this.pushCross(positions, normals, uvs, indices, wx, wy, wz, info)
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
        }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
      }
    }

    if (positions.length === 0) return null

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3))
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
    geometry.setIndex(indices)

    const material = this.chunkMaterial()
    const mesh = new THREE.Mesh(geometry, material)
    mesh.frustumCulled = true
    return mesh
  }

  /** X-shaped plant geometry (grass, flowers...). */
  pushCross (positions, normals, uvs, indices, wx, wy, wz, info) {
    const tile = info.side !== undefined ? info.side : info.all
    if (tile === undefined) return
    const rect = this.uvRectCached(tile)
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

  chunkMaterial () {
    if (!this._material) {
      this._material = new THREE.MeshLambertMaterial({
        map: this.atlasTexture,
        vertexColors: false,
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
      if (!data.index) {
        data.index = new Map()
        for (const e of data.entries) data.index.set(e.x * 65536 + e.y * 16 + e.z, e)
      }
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
   *  arrive ~10 times per second now — without smoothing mobs teleport). */
  interpolateEntities () {
    for (const group of this.entities.values()) {
      const t = group.userData.target
      if (!t) continue
      group.position.x += (t.x - group.position.x) * 0.25
      group.position.y += (t.y - group.position.y) * 0.25
      group.position.z += (t.z - group.position.z) * 0.25
      const ty = group.userData.targetYaw
      if (ty !== undefined) {
        let d = ty - group.rotation.y
        while (d > Math.PI) d -= 2 * Math.PI
        while (d < -Math.PI) d += 2 * Math.PI
        group.rotation.y += d * 0.25
      }
    }
  }

  buildEntityMesh (msg) {
    const dims = this.entityDims(msg.name)
    const group = new THREE.Group()

    const bodyColor = entityColor(msg)
    const geometry = new THREE.BoxGeometry(dims.width, dims.height, dims.width)
    const material = new THREE.MeshLambertMaterial({ color: bodyColor })
    const cube = new THREE.Mesh(geometry, material)
    cube.position.y = dims.height / 2
    group.add(cube)

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
    // Mineflayer conventions (see prismarine-physics getLookingVector):
    //   forward = (-sin(yaw)·cos(pitch), sin(pitch), -cos(yaw)·cos(pitch))
    //   yaw 0 = north (-Z), positive yaw = turning left (CCW); pitch + = down.
    // Three.js camera with rotation order YXZ:
    //   forward = (-sin(ry)·cos(rx), sin(rx), -cos(ry)·cos(rx))
    // The two match exactly with ry = yaw, rx = -pitch.
    this.camera.rotation.order = 'YXZ'
    this.camera.rotation.y = yaw
    this.camera.rotation.x = -pitch
    this.camera.position.set(x, y + 1.62, z) // eye height 1.62
  }

  animate () {
    if (!this.ready) return
    this.frames++
    const now = performance.now()
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
    if (this.entities.size > 0) this.interpolateEntities()
    this.renderer.render(this.scene, this.camera)
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


