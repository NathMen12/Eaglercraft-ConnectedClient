'use strict';

/**
 * main.js — application orchestration.
 *
 * Wires the Menu UI, the WebSocket layer (Net) and the game components
 * (Game controls/HUD, Renderer). Classic script, loaded last.
 */

(() => {
  const $ = (id) => document.getElementById(id)

  const screens = {
    menu: $('menu-screen'),
    loading: $('loading-screen'),
    game: $('game-screen'),
    error: $('error-screen')
  }

  let renderer = null // Renderer instance (class from renderer.js module)
  let currentServer = null

  function showScreen (name) {
    for (const [k, el] of Object.entries(screens)) {
      el.classList.toggle('active', k === name)
    }
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------

  document.addEventListener('DOMContentLoaded', () => {
    Menu.init()
    wireMenu()
    wireNet()
    Net.connect()
  })

  function wireMenu () {
    Menu.onConnect = (server) => {
      const username = Menu.getUsername()
      if (!/^[a-zA-Z0-9_]{1,16}$/.test(username)) {
        $('username-input').focus()
        $('username-input').style.borderColor = 'var(--danger)'
        setTimeout(() => { $('username-input').style.borderColor = '' }, 1500)
        return
      }
      currentServer = server
      showScreen('loading')
      $('loading-title').textContent = 'Connexion…'
      $('loading-detail').textContent = `Connexion à ${server.host}:${server.port} en tant que ${username}…`
      Net.send({ t: 'connect', host: server.host, port: server.port, username })
    }

    $('loading-cancel').addEventListener('click', () => {
      Net.send({ t: 'disconnect_bot' })
      showScreen('menu')
    })

    $('error-back').addEventListener('click', () => {
      showScreen('menu')
    })
  }


  // ------------------------------------------------------------------
  // Net wiring
  // ------------------------------------------------------------------

  function wireNet () {
    Net.on('close', (wasOpen) => {
      if (Game.isActive()) {
        showError('Connexion perdue', 'La connexion WebSocket au serveur web a été fermée.')
      }
    })

    Net.on('error', () => {
      if (screens.loading.classList.contains('active')) {
        showError('Erreur de connexion', 'Impossible de joindre le serveur web.')
      }
    })

    Net.on('queue', (msg) => {
      $('loading-title').textContent = 'En file d\u2019attente…'
      $('loading-detail').textContent = `Position ${msg.position} sur ${msg.total} — ${msg.max} bots max en simultané`
    })

    Net.on('queue_full', () => {
      showError('File d\u2019attente pleine', 'Trop de clients attendent déjà. Réessaie plus tard.')
    })

    Net.on('queue_timeout', () => {
      showError('Délai dépassé', 'Tu as attendu trop longtemps dans la file d\u2019attente.')
    })

    Net.on('queue_promoted', () => {
      $('loading-title').textContent = 'Connexion…'
      $('loading-detail').textContent = 'Un slot s\u2019est libéré — connexion du bot…'
    })

    Net.on('connect_error', (msg) => {
      showError('Connexion impossible', msg.error || 'Erreur inconnue')
    })

    Net.on('kicked', (msg) => {
      showError('Expulsé du serveur', msg.reason || '')
    })

    Net.on('login', async (msg) => {
      showScreen('game')
      $('hud').classList.remove('hidden')
      Game.start()
      Game.addChatLine(null, `Connecté à ${msg.host}:${msg.port} — MC ${msg.version}`)
      Game.addChatLine(null, `Connecté en tant que ${msg.username}`)
      // Init the renderer (module class) with login data.
      // renderer.js is an ES module: make sure it has been evaluated.
      const RendererClass = await waitForRenderer()
      renderer = new RendererClass()
      const idToName = await buildIdToName(msg.version)
      renderer.setBlockNames(idToName)
      await renderer.init(msg)
    })

    /** Resolves as soon as the renderer module has set window.Renderer. */
    function waitForRenderer () {
      return new Promise((resolve, reject) => {
        if (window.Renderer) { resolve(window.Renderer); return }
        let tries = 0
        const timer = setInterval(() => {
          if (window.Renderer) { clearInterval(timer); resolve(window.Renderer) }
          else if (++tries > 100) { clearInterval(timer); reject(new Error('renderer module failed to load')) }
        }, 100)
      })
    }

    Net.on('position', (msg) => {
      Game.setPosition(msg.x, msg.y, msg.z)
      Game.setLook(msg.yaw, msg.pitch)
      Game.updateHud(msg)
      if (renderer && renderer.ready) {
        renderer.updateCamera(msg.x, msg.y, msg.z, msg.yaw, msg.pitch)
      }
      // Debug HUD at 4 Hz: building the debug string on every position
      // message (20 Hz) forced a layout thrash 20 times per second.
      const now = performance.now()
      if (now - lastDebugUpdate > 250) {
        lastDebugUpdate = now
        Game.updateDebug(renderer ? renderer.fps : 0,
          `Serveur: ${currentServer ? currentServer.host + ':' + currentServer.port : '?'}\n` +
          `Santé: ${msg.health ?? '?'}  Nourriture: ${msg.food ?? '?'}`)
      }
    })
    let lastDebugUpdate = 0

    Net.on('health', (msg) => Game.updateHud(msg))

    Net.on('chat', (msg) => Game.addChatLine(msg.from, msg.text))

    Net.on('entity', (msg) => {
      if (renderer && renderer.ready) renderer.handleEntity(msg)
    })

    // Batched entity movement updates (one message every ~100 ms instead of
    // one message per entity per physics tick)
    Net.on('entities', (msg) => {
      if (renderer && renderer.ready) renderer.handleEntity(msg)
    })

    Net.on('entity_gone', (msg) => {
      if (renderer) renderer.handleEntityGone(msg.id)
    })

    Net.on('bot_end', () => {
      showError('Déconnecté', 'Le bot a été déconnecté du serveur Minecraft.')
    })

    Net.on('closed', (msg) => {
      if (Game.isActive()) {
        showError('Session fermée', msg.reason || '')
      }
    })

    Net.on('chunk_empty', (msg) => {
      if (renderer && renderer.ready) renderer.handleChunkUnload(msg.cx, msg.cz)
    })

    Net.on('chunk_unload', (msg) => {
      if (renderer && renderer.ready) renderer.handleChunkUnload(msg.cx, msg.cz)
    })

    Net.on('block_update', (msg) => {
      // Server sends a batched array ({ blocks: [...] }); the renderer also
      // accepts a single block object for compatibility.
      if (renderer && renderer.ready) renderer.handleBlockUpdate(msg.blocks || msg.block)
    })

    // Binary chunks
    Net.onBinaryChunk((decoded) => {
      if (renderer && renderer.ready) renderer.handleChunk(decoded)
    })
  }

  /** Fetches blockId -> blockName from the server (/blocks.json?v=<mc version>). */
  async function buildIdToName (version) {
    try {
      const res = await fetch(`/blocks.json?v=${encodeURIComponent(version || '1.21.9')}`)
      if (res.ok) return await res.json()
    } catch (e) {}
    return {}
  }

  function showError (title, detail) {
    Game.stop()
    $('error-title').textContent = title
    $('error-detail').textContent = detail || ''
    showScreen('error')
  }
})()
