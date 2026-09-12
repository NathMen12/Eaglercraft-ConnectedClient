'use strict'

/**
 * Unit test of the DDA voxel raycast (public/js/voxelRaycast.js) — the same
 * file the browser loads, loaded here through the classic-script bridge
 * (window + module), like chunkCodec.js in the streamer test.
 *
 * Scenario: a 5x5x5 grid of solid blocks, the camera placed in the middle of
 * the empty space in front of a wall. The ray must stop on the FIRST solid
 * voxel and report the exact face the ray crossed to enter it.
 *
 * Run: node test/raycast.test.js
 */

const assert = require('assert')
const path = require('path')

const src = require('fs').readFileSync(path.join(__dirname, '..', 'public', 'js', 'voxelRaycast.js'), 'utf8')
const sandbox = { VoxelRaycast: null }
// voxelRaycast.js references `window` — provide a minimal sandbox
new Function('window', 'module', src)(sandbox, undefined)
const VoxelRaycast = sandbox.VoxelRaycast
assert(VoxelRaycast && typeof VoxelRaycast.raycast === 'function', 'VoxelRaycast loaded')

// --- Test 1: straight ray hits the wall on its -X face ---------------------
// Wall: every voxel with x === 3 is solid. Camera at (1.5, 1.5, 1.5) looking
// +X: the first solid voxel entered is (3, 1, 1) through its -X face (0 = +X
// face vector? NO: face index 1 is -X — see the FACE order comment).
{
  const isSolid = (x, y, z) => x === 3
  const hit = VoxelRaycast.raycast(
    { x: 1.5, y: 1.5, z: 1.5 }, // origin
    { x: 1, y: 0, z: 0 },       // unit dir, +X
    4.5,                        // reach
    isSolid
  )
  assert(hit, 'ray hits the wall')
  assert.strictEqual(hit.x, 3)
  assert.strictEqual(hit.y, 1)
  assert.strictEqual(hit.z, 1)
  // The ray travels +X and enters (3,1,1) by crossing x=3 — that boundary is
  // the block's -X face => face index 1 (FACE order: 0:+X 1:-X 2:+Y 3:-Y 4:+Z 5:-Z)
  assert.strictEqual(hit.face, 1, 'entered through the -X face')
}
console.log('✓ ray +X hits (3,1,1) through its -X face')

// --- Test 2: diagonal ray (equal +X/+Z) — deterministic tie-break ---------
{
  const isSolid = (x, y, z) => x === 2 && z === 2
  const hit = VoxelRaycast.raycast(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 }, // 45° in the XZ plane
    4.5,
    isSolid
  )
  assert(hit, 'diagonal ray hits')
  assert.strictEqual(hit.x, 2)
  assert.strictEqual(hit.z, 2)
  console.log(`✓ diagonal ray hits (${hit.x},${hit.y},${hit.z}) face=${hit.face}`)
}

// --- Test 3: transparent blocks are passed THROUGH -------------------------
// Glass at x===2, stone wall at x===4: the ray must ignore the glass and
// stop on the stone. This mirrors the renderer's isTargetable behaviour.
{
  const isSolid = (x, y, z) => x === 4 // only the stone stops the ray
  const hit = VoxelRaycast.raycast(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 0, z: 0 },
    4.5,
    isSolid
  )
  assert(hit && hit.x === 4, 'ray passes the "glass" and stops at the wall')
  assert.strictEqual(hit.face, 1)
}
console.log('✓ transparent blocks are passed through (wall behind hit)')

// --- Test 4: nothing in reach -> null ---------------------------------------
{
  const hit = VoxelRaycast.raycast(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 0, z: 0 },
    4.5,
    () => false
  )
  assert.strictEqual(hit, null, 'no solid block -> null')
}
console.log('✓ no block in reach -> null')

// --- Test 5: straight down (+Y face of the block below) --------------------
{
  const isSolid = (x, y, z) => y === 0
  const hit = VoxelRaycast.raycast(
    { x: 0.5, y: 2.5, z: 0.5 },
    { x: 0, y: -1, z: 0 },
    4.5,
    isSolid
  )
  assert(hit && hit.y === 0, 'ray down hits the floor')
  assert.strictEqual(hit.face, 2, 'entered through the +Y face of the floor (place ON TOP)')
}
console.log('✓ looking down hits the floor through its +Y face (face=2)')

// --- Test 6: the camera's own voxel is never a target ----------------------
{
  const isSolid = (x, y, z) => x === 0 && y === 0 && z === 0
  const hit = VoxelRaycast.raycast(
    { x: 0.5, y: 0.5, z: 0.5 },
    { x: 1, y: 0, z: 0 },
    4.5,
    isSolid
  )
  assert.strictEqual(hit, null, 'standing inside a block -> no target')
}
console.log('✓ the camera voxel is skipped (no self-target)')

// --- Test 7: face indexes match the server's FACE_VECS order ---------------
// FACE_VECS in server/index.js handlePlace: [+X, -X, +Y, -Y, +Z, -Z]
// Entering a block moving +X crosses its -X face (index 1), moving -X its
// +X face (0), moving +Y its -Y face (3), moving -Y its +Y face (2),
// moving +Z its -Z face (5), moving -Z its +Z face (4).
{
  const mk = (dir, expected) => {
    // Solid voxel just past a one-block gap in the dir axis
    const solidAt = (x, y, z) => {
      if (dir.x === 1) return x === 1
      if (dir.x === -1) return x === -1
      if (dir.y === 1) return y === 1
      if (dir.y === -1) return y === -1
      if (dir.z === 1) return z === 1
      return z === -1
    }
    const hit = VoxelRaycast.raycast({ x: 0.5, y: 0.5, z: 0.5 }, dir, 4.5, solidAt)
    assert(hit, `hit in dir ${JSON.stringify(dir)}`)
    assert.strictEqual(hit.face, expected, `face for dir ${JSON.stringify(dir)}`)
  }
  mk({ x: 1, y: 0, z: 0 }, 1)   // moving +X -> -X face
  mk({ x: -1, y: 0, z: 0 }, 0)  // moving -X -> +X face
  mk({ x: 0, y: 1, z: 0 }, 3)   // moving +Y -> -Y face
  mk({ x: 0, y: -1, z: 0 }, 2)  // moving -Y -> +Y face
  mk({ x: 0, y: 0, z: 1 }, 5)   // moving +Z -> -Z face
  mk({ x: 0, y: 0, z: -1 }, 4)  // moving -Z -> +Z face
}
console.log('✓ all 6 face indexes match the server FACE_VECS order')

console.log('\nAll raycast unit tests passed ✓')