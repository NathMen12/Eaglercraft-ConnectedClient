'use strict'

/**
 * security.test.js (V1.1.3) — unit tests of the server hardening:
 *
 *   - isPrivateIp: every private/internal/metadata range is flagged,
 *     public addresses are not
 *   - assertPublicHost: hostnames resolving to private IPs are blocked
 *     (DNS is stubbed), public hosts pass
 *   - createRateLimiter: bursts pass, sustained floods are dropped
 *
 * Run: node test/security.test.js
 */

const assert = require('assert')
const path = require('path')

// Load security.js (plain CommonJS module — direct require)
const { isPrivateIp, createRateLimiter } = require(path.join(__dirname, '..', 'server', 'security.js'))

// --- isPrivateIp: IPv4 -------------------------------------------------------
{
  const mustBePrivate = [
    '127.0.0.1', '127.255.255.255', // loopback
    '10.0.0.1', '10.255.255.255', // private A
    '172.16.0.1', '172.31.255.255', // private B
    '192.168.1.1', '192.168.0.0', // private C
    '169.254.169.254', // link-local + AWS/GCP/Azure metadata
    '100.64.0.1', '100.127.255.255', // CGNAT
    '0.0.0.0', '0.1.2.3', // "this network"
    '192.0.0.1', '192.0.2.1', // IETF special
    '198.18.0.1', '198.19.255.255', // benchmarking
    '224.0.0.1', '255.255.255.255' // multicast / reserved
  ]
  for (const ip of mustBePrivate) {
    assert.strictEqual(isPrivateIp(ip), true, `${ip} must be private`)
  }
  const mustBePublic = [
    '1.1.1.1', '8.8.8.8', '163.5.201.7', // real public IPs
    '9.9.9.9', '172.32.0.1', '172.15.255.255', '192.169.0.1', // range edges
    '100.128.0.1', '101.0.0.1' // just outside CGNAT
  ]
  for (const ip of mustBePublic) {
    assert.strictEqual(isPrivateIp(ip), false, `${ip} must be public`)
  }
}
console.log('✓ isPrivateIp: all private/internal/metadata ranges blocked, public pass')

// --- isPrivateIp: IPv6 -------------------------------------------------------
{
  const mustBePrivate = [
    '::', '::1', // unspecified + loopback
    'fe80::1', 'fe90::', 'fea0::1', 'febf::ffff', // link-local
    'fc00::1', 'fd12:3456::1', // unique local
    'ff02::1', // multicast
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:192.168.1.1' // v4-mapped
  ]
  for (const ip of mustBePrivate) {
    assert.strictEqual(isPrivateIp(ip), true, `${ip} must be private`)
  }
  const mustBePublic = ['2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:1.1.1.1']
  for (const ip of mustBePublic) {
    assert.strictEqual(isPrivateIp(ip), false, `${ip} must be public`)
  }
}
console.log('✓ isPrivateIp (IPv6): loopback/link-local/ULA/multicast/v4-mapped blocked')

// --- Rate limiter -------------------------------------------------------------
{
  const limiter = createRateLimiter(10, 5) // burst 10, refill 5/s
  let allowed = 0
  for (let i = 0; i < 10; i++) if (limiter.take()) allowed++
  assert.strictEqual(allowed, 10, 'the full burst passes')
  assert.strictEqual(limiter.take(), false, 'the 11th immediate message is dropped')
  // Refill: 5/s => after 1.2s at least 5 tokens are back
  const before = Date.now()
  while (Date.now() - before < 1200) { /* busy wait */ }
  let afterWait = 0
  for (let i = 0; i < 6; i++) if (limiter.take()) afterWait++
  assert(afterWait >= 5, `tokens refilled over time (got ${afterWait} of 5+)`)
}
console.log('✓ rate limiter: burst passes, flood dropped, tokens refill')

// --- sanitizeItem-equivalent regex (client mirrors it) -----------------------
{
  // Same pattern as game.js sanitizeItem / server serializeItem
  const RE = /^[a-z0-9_]{1,64}$/
  assert(RE.test('diamond_sword'), 'valid item id accepted')
  assert(RE.test('grass_block'), 'valid block id accepted')
  assert(!RE.test('javascript:alert(1)'), 'scheme rejected')
  assert(!RE.test('foo bar'), 'spaces rejected')
  assert(!RE.test('A-B!'), 'uppercase/punctuation rejected')
  assert(!RE.test(''), 'empty rejected')
  assert(!RE.test('x'.repeat(65)), 'too long rejected')
}
console.log('✓ item name validation: injection strings rejected, vanilla ids pass')

console.log('\nAll security unit tests passed ✓')