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

    this.renderer = new THREE.WebGLRenderer({ canvas: document.getElementById('game-canvas'), antialias: true })
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

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
    this.animate()
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

  /** UV rect for a tile index: [u0, v0, u1, v1] with a small inset.
   *  Three.js flips textures vertically by default (flipY=true), so a tile
   *  at pixel row y (from the top) spans V = [1-(y+T)/S, 1-y/S]. */
  uvRect (tileIndex) {
    const tx = (tileIndex % this.atlasGrid) * this.tileSize
    const ty = Math.floor(tileIndex / this.atlasGrid) * this.tileSize
    const inset = 0.02 // avoid atlas bleeding
    const S = this.atlasPixelSize
    const u0 = (tx + inset) / S
    const u1 = (tx + this.tileSize - inset) / S
    const v1 = 1 - (ty + inset) / S // top edge of the tile
    const v0 = 1 - (ty + this.tileSize - inset) / S // bottom edge
    return { u0, v0, u1, v1 }
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

    // Face definitions: for each visible bit — normal, tile kind, and the 4
    // corners with their UV assignment (matching vertex order).
    // Corner order is chosen so triangles (0,1,2)(0,2,3) face outward.
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
        const rect = this.uvRect(tile)
        const base = positions.length / 3
        for (const c of f.corners) {
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
    const rect = this.uvRect(tile)
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
    if (!this.blockIdToName) return null
    const name = this.blockIdToName[blockId]
    if (!name) return null
    return this.blockMappings[name] || null
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

  handleBlockUpdate (block) {
    if (!this.ready) return
    const key = `${block.x >> 4},${block.z >> 4}`
    // For simplicity we rebuild the whole chunk column when a block changes.
    // The chunk data is cached client-side in this.chunkBlocks.
    const data = this.chunkBlocks.get(key)
    if (!data) return
    // Update the stored entry (or remove when blockId = 0)
    const localX = block.x & 15
    const localZ = block.z & 15
    const idx = data.entries.findIndex((e) => e.x === localX && e.z === localZ && (data.minY + e.y) === block.y)
    const info = block.blockId !== 0 ? {
      x: localX, y: block.y - data.minY, z: localZ,
      blockId: block.blockId, faceMask: block.faceMask
    } : null
    if (idx >= 0 && info) data.entries[idx] = info
    else if (idx >= 0) data.entries.splice(idx, 1)
    else if (info) data.entries.push(info)
    // Rebuild lazily: mark dirty, rebuild on next frame
    this.dirtyChunks.add(key)
  }

  // ------------------------------------------------------------------
  // Entities
  // ------------------------------------------------------------------

  handleEntity (msg) {
    if (!this.ready) return
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
    requestAnimationFrame(this.animate.bind(this))
    if (!this.ready) return
    this.frames++
    const now = performance.now()
    if (now - this.lastFpsTime >= 1000) {
      this.fps = this.frames
      this.frames = 0
      this.lastFpsTime = now
    }
    // Rebuild dirty chunks
    if (this.dirtyChunks.size > 0) {
      for (const key of this.dirtyChunks) {
        const data = this.chunkBlocks.get(key)
        if (data) this.handleChunk(data)
      }
      this.dirtyChunks.clear()
    }
    this.renderer.render(this.scene, this.camera)
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


