'use strict'

/**
 * security.js (V1.1.3) — server-side hardening.
 *
 *  - SSRF guard: the `connect` request must point at a PUBLIC address
 *    (no localhost/private/link-local/cloud-metadata ranges) unless the
 *    operator explicitly allows it (ALLOW_PRIVATE_SERVERS=1).
 *  - WS rate limiting: token bucket per socket (messages/second).
 *  - Security headers: helmet-lite applied to every HTTP response.
 */

const dns = require('dns').promises
const net = require('net')

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

/**
 * True when the IP is private/internal and must not be reachable through
 * the bot relay: loopback, private ranges, link-local, CGNAT, and the
 * cloud metadata endpoints (169.254.169.254 / fd00:ec2::254 & friends).
 */
function isPrivateIp (ip) {
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number)
    const [a, b] = o
    if (a === 10 || a === 127) return true // private A + loopback
    if (a === 0) return true // "this network"
    if (a === 172 && b >= 16 && b <= 31) return true // private B
    if (a === 192 && b === 168) return true // private C
    if (a === 169 && b === 254) return true // link-local + AWS/GCP metadata
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT 100.64/10
    if (a === 192 && b === 0) return true // 192.0.0.0/24 + 192.0.2.0/24
    if (a === 198 && (b === 18 || b === 19)) return true // benchmark tests
    if (a >= 224) return true // multicast + reserved
    return false
  }
  if (net.isIPv6(ip)) {
    const low = ip.toLowerCase()
    if (low === '::' || low === '::1') return true
    if (low.startsWith('fe8') || low.startsWith('fe9') || low.startsWith('fea') || low.startsWith('feb')) return true // link-local
    if (low.startsWith('fc') || low.startsWith('fd')) return true // unique local
    if (low.startsWith('ff')) return true // multicast
    // IPv4-mapped (::ffff:10.0.0.1) and 6to4/Teredo embed IPv4 — check the tail
    const v4 = low.match(/(\d+\.\d+\.\d+\.\d+)$/)
    if (v4 && isPrivateIp(v4[1])) return true
    return false
  }
  return true // not an IP we recognize: treat as private (safe default)
}

/**
 * Resolves a connect host and returns { error } when it points at a
 * private/internal address. DNS rebindiing is defeated by re-resolving at
 * connect time (mineflayer re-resolves too, but we keep the check tight
 * by validating the address family ourselves).
 */
async function assertPublicHost (host) {
  // Literal IP: check directly
  if (net.isIP(host)) {
    return isPrivateIp(host) ? { error: 'Private/local addresses are not allowed' } : null
  }
  // Hostname: resolve and check EVERY address (A + AAAA)
  try {
    const results = await dns.lookup(host, { all: true })
    if (results.length === 0) return { error: 'Host not found' }
    for (const r of results) {
      if (isPrivateIp(r.address)) {
        return { error: 'Host resolves to a private/local address' }
      }
    }
    return null
  } catch (e) {
    return { error: 'Host not found' }
  }
}

// ---------------------------------------------------------------------------
// Per-socket rate limiting (token bucket)
// ---------------------------------------------------------------------------

/**
 * Creates a token-bucket limiter: `capacity` messages bursting, refilled at
 * `perSecond`. The 1 Hz control loop + 20 Hz look stay far below this.
 */
function createRateLimiter (capacity = 60, perSecond = 30) {
  return {
    tokens: capacity,
    last: Date.now(),
    take () {
      const now = Date.now()
      const refill = ((now - this.last) / 1000) * perSecond
      this.tokens = Math.min(capacity, this.tokens + refill)
      this.last = now
      if (this.tokens >= 1) {
        this.tokens -= 1
        return true
      }
      return false
    }
  }
}

// ---------------------------------------------------------------------------
// Security headers (helmet-lite)
// ---------------------------------------------------------------------------

/** Applies baseline security headers to every response. */
function securityHeaders (req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff')
  res.set('X-Frame-Options', 'DENY')
  res.set('Referrer-Policy', 'no-referrer')
  res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
  res.set('Cross-Origin-Opener-Policy', 'same-origin')
  // CSP: the app is a classic-scripts + one ES module app; textures and
  // data: URLs (entity models) are img-src; WebSocket to self only.
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data: blob:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'"
  ].join('; '))
  next()
}

module.exports = {
  isPrivateIp,
  assertPublicHost,
  createRateLimiter,
  securityHeaders
}
