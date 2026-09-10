'use strict'

/**
 * Unit test of the connection queue (BotManager) — no real bots are spawned:
 * we stub `spawnBot` and verify queue ordering, limits, and promotion.
 *
 * Run: node test/queue.test.js
 */

const assert = require('assert')
const { BotManager } = require('../server/botManager')

const config = {
  maxConcurrentBots: 2,
  maxQueueSize: 3,
  queueTimeoutMs: 10 * 60 * 1000
}

const manager = new BotManager(config)
const events = []
manager.on('queued', (socket, position, total) => events.push(['queued', socket, position, total]))
manager.on('queueFull', (socket) => events.push(['queueFull', socket]))
manager.on('queuePromoted', (socket) => events.push(['queuePromoted', socket]))

// Stub spawnBot so no real connection happens
let spawnCount = 0
manager.spawnBot = (socket, request) => {
  spawnCount++
  manager.sessions.set(socket.id, { bot: { quit () {} }, socket, cleanup: [] })
  events.push(['spawned', socket, request.username])
}

// Fake sockets
const sockets = []
for (let i = 0; i < 6; i++) sockets.push({ id: `s${i}` })

// --- 3 requests: 2 spawn immediately, 1 queued ----------------------------
manager.requestConnect(sockets[0], { host: 'a', port: 1, username: 'A' })
manager.requestConnect(sockets[1], { host: 'a', port: 1, username: 'B' })
manager.requestConnect(sockets[2], { host: 'a', port: 1, username: 'C' })
assert.strictEqual(spawnCount, 2, 'first two bots spawned immediately')
assert.strictEqual(manager.queue.length, 1, 'third request queued')
assert.deepStrictEqual(events.find((e) => e[0] === 'queued' && e[1] === sockets[2]).slice(2), [1, 1], 'queue position 1/1')
console.log('✓ 2 immediate spawns + 1 queued')

// --- 4th request queues too, 5th... --------------------------------------
manager.requestConnect(sockets[3], { host: 'a', port: 1, username: 'D' })
assert.strictEqual(manager.queue.length, 2)
assert.strictEqual(manager.queuePositionOf(sockets[3].id), 2)
console.log('✓ 4th request queued at position 2')

// --- 5th request: queue full (maxQueueSize=3 counts s2, s3, s4) -----------
manager.requestConnect(sockets[4], { host: 'a', port: 1, username: 'E' })
manager.requestConnect(sockets[5], { host: 'a', port: 1, username: 'F' })
// queue now: s2, s3, s4 → s5 rejected? Let's trace: after s4 queued (len 2),
// s5 fills to 3, s6 must be rejected.
const fullEvent = events.find((e) => e[0] === 'queueFull')
assert(fullEvent, 'queue_full emitted')
assert.strictEqual(manager.queue.length, config.maxQueueSize, 'queue at capacity')
assert.strictEqual(manager.stats.queueRejections, 1, 'one rejection counted')
console.log('✓ 6th request rejected when queue full')

// --- Free a slot: promotion happens --------------------------------------
events.length = 0
manager.teardown(sockets[0].id, 'test')
assert.strictEqual(spawnCount, 3, 'queued client promoted after a slot freed')
const promoted = events.find((e) => e[0] === 'queuePromoted')
assert(promoted, 'queue_promoted emitted')
console.log('✓ queue promotion on slot release')

// --- Client page close removes it from queue -------------------------------
manager.requestConnect(sockets[0], { host: 'a', port: 1, username: 'A2' }) // re-queue s0 (s1 still active)
assert(manager.queue.length >= 1)
const lenBefore = manager.queue.length
manager.handleSocketClose(sockets[0].id)
assert.strictEqual(manager.queue.length, lenBefore - 1, 'queued client removed on page close')
console.log('✓ queued client removed when its page closes')

// Clean up remaining queue timers so the process can exit
for (const entry of manager.queue) clearTimeout(entry.timer)
manager.queue.length = 0
for (const [id] of manager.sessions) manager.teardown(id, 'test cleanup')

console.log('\nAll queue unit tests passed ✓')
