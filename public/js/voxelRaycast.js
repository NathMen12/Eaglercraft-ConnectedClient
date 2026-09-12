'use strict'

/**
 * voxelRaycast.js — DDA grid traversal (Amanatides & Woo).
 *
 * Walks a ray voxel by voxel and stops at the first block the callback
 * reports as "solid" (targetable). Pure math — no THREE.js, no DOM: the same
 * file runs in the browser (window.VoxelRaycast) and in Node unit tests
 * (module.exports), exactly like chunkCodec.js.
 *
 * Coordinate system: Minecraft world blocks (X east, Y up, Z south). The
 * returned `face` is the index (0-5) of the face the ray CROSSED to enter
 * the hit block, in the server's FACE_VECS order:
 *   0:+X  1:-X  2:+Y  3:-Y  4:+Z  5:-Z
 * (i.e. the face vector the caller must pass to bot.placeBlock to put the
 *  new block on the side the ray came from.)
 */

const VoxelRaycast = (() => {
  /**
   * @param {{x,y,z}} origin ray start (world coords, typically the camera eye)
   * @param {{x,y,z}} dir    UNIT-LENGTH look direction
   * @param {number}  maxDistance reach in blocks (vanilla survival: 4.5)
   * @param {(x:number,y:number,z:number)=>boolean} isSolid stop test
   * @returns {{x,y,z,face}|null}
   */
  function raycast (origin, dir, maxDistance, isSolid) {
    let px = Math.floor(origin.x)
    let py = Math.floor(origin.y)
    let pz = Math.floor(origin.z)
    const stepX = dir.x > 0 ? 1 : -1
    const stepY = dir.y > 0 ? 1 : -1
    const stepZ = dir.z > 0 ? 1 : -1
    // t needed to cross one whole voxel on each axis (Infinity = axis unused)
    const invX = dir.x !== 0 ? Math.abs(1 / dir.x) : Infinity
    const invY = dir.y !== 0 ? Math.abs(1 / dir.y) : Infinity
    const invZ = dir.z !== 0 ? Math.abs(1 / dir.z) : Infinity
    // t at which the first X/Y/Z voxel boundary is crossed
    let tMaxX = dir.x !== 0
      ? (stepX > 0 ? px + 1 - origin.x : origin.x - px) * invX
      : Infinity
    let tMaxY = dir.y !== 0
      ? (stepY > 0 ? py + 1 - origin.y : origin.y - py) * invY
      : Infinity
    let tMaxZ = dir.z !== 0
      ? (stepZ > 0 ? pz + 1 - origin.z : origin.z - pz) * invZ
      : Infinity
    let face = -1 // the face crossed to ENTER the current voxel
    let t = 0
    while (t <= maxDistance) {
      // face === -1 on the first iteration: the camera's own voxel is never
      // a target (vanilla behaves the same — you can't aim at what you're in)
      if (face >= 0 && isSolid(px, py, pz)) {
        return { x: px, y: py, z: pz, face }
      }
      // Step to the neighbour with the closest boundary crossing
      if (tMaxX < tMaxY) {
        if (tMaxX < tMaxZ) {
          px += stepX; t = tMaxX; tMaxX += invX
          face = stepX > 0 ? 1 : 0 // entered through the -X / +X face
        } else {
          pz += stepZ; t = tMaxZ; tMaxZ += invZ
          face = stepZ > 0 ? 5 : 4
        }
      } else {
        if (tMaxY < tMaxZ) {
          py += stepY; t = tMaxY; tMaxY += invY
          face = stepY > 0 ? 3 : 2
        } else {
          pz += stepZ; t = tMaxZ; tMaxZ += invZ
          face = stepZ > 0 ? 5 : 4
        }
      }
    }
    return null
  }

  return { raycast }
})()

// Browser (classic script) + Node (unit tests) — same pattern as chunkCodec.js
if (typeof module !== 'undefined' && module.exports) module.exports = VoxelRaycast
if (typeof window !== 'undefined') window.VoxelRaycast = VoxelRaycast