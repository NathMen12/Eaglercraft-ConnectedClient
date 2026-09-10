'use strict'

/**
 * botManager.js
 *
 * Owns every Mineflayer bot spawned by web clients and a connection queue
 * sized for a small server (1 core / 2.5 GB RAM):
 *
 *   - at most `maxConcurrentBots` bots run at the same time
 *   - extra connect requests wait in a FIFO queue (position is pushed to
 *     the client); requests beyond `maxQueueSize` are rejected
 *   - queued requests time out after `queueTimeoutMs`
 *
 * One WebSocket client == at most one bot. Closing the socket disconnects
 * the bot (or removes it from the queue).
 */

const EventEmitter = require('events')
const mineflayer = require('mineflayer')
const minecraftData = require('minecraft-data')

class BotManager extends EventEmitter {
  constructor (config) {
    super()
    this.config = config
    /** @type {Map<string, {bot, streamer, socket, state}>} socketId -> session */
    this.sessions = new Map()
    /** @type {Array<{socketId, socket, request, enqueuedAt, timer}>} */
    this.queue = []
    this.stats = {
      botsCreated: 0,
      queueRejections: 0,
      queueTimeouts: 0
    }
  }

  get activeBotCount () {
    let n = 0
    for (const s of this.sessions.values()) if (s.bot) n++
    return n
  }

  /**
   * Entry point: called when a web client asks to connect to a server.
   * Either spawns the bot immediately or queues the request.
   */
  requestConnect (socket, request) {
    if (this.sessions.has(socket.id) || this.queue.some(q => q.socketId === socket.id)) {
      this.emit('error', new Error('Already connecting/connected'))
      return
    }
    if (this.activeBotCount >= this.config.maxConcurrentBots) {
      if (this.queue.length >= this.config.maxQueueSize) {
        this.stats.queueRejections++
        this.emit('queueFull', socket)
        return
      }
      const entry = {
        socketId: socket.id,
        socket,
        request,
        enqueuedAt: Date.now()
      }
      entry.timer = setTimeout(() => {
        this.stats.queueTimeouts++
        this.removeFromQueue(socket.id)
        this.emit('queueTimeout', socket)
      }, this.config.queueTimeoutMs)
      this.queue.push(entry)
      this.emit('queued', socket, this.queuePositionOf(socket.id), this.queue.length)
      return
    }
    this.spawnBot(socket, request)
  }

  queuePositionOf (socketId) {
    return this.queue.findIndex(q => q.socketId === socketId) + 1
  }

  removeFromQueue (socketId) {
    const idx = this.queue.findIndex(q => q.socketId === socketId)
    if (idx === -1) return
    const entry = this.queue[idx]
    clearTimeout(entry.timer)
    this.queue.splice(idx, 1)
    // Re-notify remaining queued clients of their new position
    this.queue.forEach((q, i) => this.emit('queued', q.socket, i + 1, this.queue.length))
  }

  /** Spawns a Mineflayer bot for the given web client. */
  spawnBot (socket, request) {
    const { host, port, username } = request
    this.emit('log', `Creating bot for ${socket.id} -> ${username}@${host}:${port}`)
    const bot = mineflayer.createBot({
      host,
      port,
      username,
      version: false, // auto-negotiate
      auth: 'offline' // no Mojang auth — works on offline/cracked servers
    })
    const session = {
      bot,
      streamer: null,
      socket,
      state: 'connecting',
      request,
      cleanup: []
    }
    this.sessions.set(socket.id, session)
    this.stats.botsCreated++
    this.emit('botCreating', socket, request)

    // --- Bot lifecycle -----------------------------------------------------
    bot.once('login', () => {
      session.state = 'connected'
      const version = bot.version
      // bot.registry is already resolved by mineflayer for the negotiated
      // version — safer than re-loading minecraft-data ourselves.
      const mcData = bot.registry || minecraftData(version)
      if (!mcData) {
        this.emit('botError', socket, new Error(`Unsupported Minecraft version: ${version}`))
        this.teardown(socket.id, `Unsupported version ${version}`)
        return
      }
      this.emit('log', `Bot ${username} logged in ${host}:${port} (MC ${version})`)
      this.emit('botReady', socket, session, mcData)
    })

    bot.once('kicked', (reason) => {
      this.emit('kicked', socket, reason)
      this.teardown(socket.id, `Kicked: ${JSON.stringify(reason)}`)
    })

    bot.once('error', (err) => {
      this.emit('botError', socket, err)
      this.teardown(socket.id, `Connection error: ${err.message}`)
    })

    bot.once('end', () => {
      if (session.state !== 'disconnected') {
        this.emit('botEnd', socket)
        this.teardown(socket.id, 'Disconnected from server')
      }
    })

    // Safety net: never leak a connecting bot
    session.connectTimeout = setTimeout(() => {
      if (session.state === 'connecting') {
        this.emit('timeout', socket)
        this.teardown(socket.id, 'Connection timed out (30s)')
      }
    }, 30000)
  }

  /**
   * Tears down a session: disconnects the bot, removes listeners and frees
   * the slot (which may promote queued clients).
   */
  teardown (socketId, reason) {
    const session = this.sessions.get(socketId)
    this.sessions.delete(socketId)
    if (!session) return
    if (session.connectTimeout) clearTimeout(session.connectTimeout)
    for (const off of session.cleanup) { try { off() } catch (e) {} }
    if (session.bot) {
      try { session.bot.quit() } catch (e) {}
      // Remove all listeners so a late event cannot resurrect the session
      try { session.bot.removeAllListeners() } catch (e) {}
    }
    this.emit('sessionClosed', session.socket, reason)
    // A slot is free: promote the next queued client
    this.promoteFromQueue()
  }

  /** Queued-client promotion with queue position re-notifications. */
  promoteFromQueue () {
    while (this.queue.length > 0 && this.activeBotCount < this.config.maxConcurrentBots) {
      const entry = this.queue.shift()
      clearTimeout(entry.timer)
      this.emit('queuePromoted', entry.socket)
      this.spawnBot(entry.socket, entry.request)
      // spawnBot is synchronous setup; the actual connection is async
    }
    this.queue.forEach((q, i) => this.emit('queued', q.socket, i + 1, this.queue.length))
  }

  /** Called when a web client socket closes: clean everything it owns. */
  handleSocketClose (socketId) {
    this.removeFromQueue(socketId)
    this.teardown(socketId, 'Client closed the page')
  }
}

module.exports = { BotManager }

