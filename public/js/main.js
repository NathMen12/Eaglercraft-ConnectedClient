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
      // Camera prediction wiring: every mouse move rotates the camera
      // locally & instantly (zero latency); the server echo is only a
      // fallback when the pointer is NOT locked.
      Game.onLookChange((yaw, pitch) => renderer.setLocalLook(yaw, pitch))
      const look = Game.getLook()
      renderer.setLocalLook(look.yaw, look.pitch)
      // Sneak (camera dips) & sprint (FOV widens) local feedback
      Game.onSneakSprintChange((sneak, sprint) => renderer.setSneakSprint(sneak, sprint))
      // V1.1.0 — R key: wipe the client cache; the server (reset_chunks)
      // wipes its own sent-set and re-streams everything from zero.
      Game.onReloadChunks(() => renderer.clearAllChunks())
      // V1.2.0 — mouse: dig (held = repeat), attack mobs, stop on release
      Game.onAttack((kind) => {
        if (renderer.swingHand) renderer.swingHand()
        if (kind === 'dig_start') {
          // Mob in front? Punch it instead of digging (vanilla behaviour)
          const mob = renderer.raycastEntities ? renderer.raycastEntities() : null
          if (mob) {
            Net.send({ t: 'attack', id: mob.id })
            return
          }
          const target = renderer.highlight
          if (target) Net.send({ t: 'dig_start', x: target.x, y: target.y, z: target.z })
          return
        }
        if (kind === 'dig_stop') {
          Net.send({ t: 'dig_stop' })
          return
        }
        // Right click — two cases:
        //   a block is targeted AND the held item can be placed -> place
        //   otherwise (no target, or a non-block item in hand) -> activate
        const target = renderer.highlight
        const held = Game.state.hotbar[Game.state.selectedSlot]
        const heldName = held ? held.name : null
        if (target && heldName && renderer.isPlaceableItem(heldName)) {
          Net.send({ t: 'place', x: target.x, y: target.y, z: target.z, face: target.face })
        } else {
          Net.send({ t: 'activate' })
        }
      })
      // V1.2.0 — F5: first <-> third person view
      Game.onViewToggle(() => {
        if (renderer.setThirdPerson) {
          renderer.setThirdPerson(!renderer.thirdPerson)
          Game.addChatLine(null, renderer.thirdPerson ? 'Vue : 3e personne' : 'Vue : 1re personne')
        }
      })
      // V1.1.1 — the hand shows the held item; re-synced on every hotbar /
      // selection change through a light poll (0.5 s, only while in game):
      // the held item depends on BOTH the selected slot and the hotbar
      // contents, both of which change via several code paths.
      const syncHeldItem = () => {
        if (renderer.setHeldItem) {
          const held = Game.state.hotbar[Game.state.selectedSlot]
          renderer.setHeldItem(held ? held.name : null)
        }
      }
      syncHeldItem()
      setInterval(() => { if (Game.isActive()) syncHeldItem() }, 500)
      // V1.1.0 — item icons (atlas built by the server from the pack)
      loadItemIcons()
      // Re-sync the predicted look when the pointer lock is (re)acquired:
      // while unlocked the look follows the server echo, so the prediction
      // must not stay stale from an earlier session.
      document.addEventListener('pointerlockchange', () => {
        if (document.pointerLockElement) {
          const l = Game.getLook()
          renderer.setLocalLook(l.yaw, l.pitch)
        }
      })
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

    // V1.1.0 — inventory / hotbar sync
    Net.on('hotbar', (msg) => Game.updateHotbar(msg))
    Net.on('inv_slot', (msg) => {
      if (typeof msg.index !== 'number' || msg.index < 0 || msg.index > 44) return
      Game.updateInventorySlot(msg.index, msg.item)
    })
    Net.on('slot_selected', (msg) => {
      if (typeof msg.slot === 'number') Game.selectHotbarSlot(msg.slot, false)
    })
    Net.on('chunks_reset', () => {
      // Server wiped its sent-set: the client wipes its cache in sync so the
      // full re-stream rebuilds the world cleanly (phantom-block fix).
      if (renderer && renderer.ready) renderer.clearAllChunks()
    })
    // V1.1.1 — dig feedback: swing the hand, show the crack overlay
    Net.on('dig_start', (msg) => {
      if (renderer && renderer.ready) renderer.handleDigStart(msg.x, msg.y, msg.z, msg.time)
    })
    Net.on('dig_ok', () => {
      if (renderer && renderer.ready) renderer.handleDigEnd()
    })
    Net.on('dig_error', (msg) => {
      if (renderer && renderer.ready) renderer.handleDigEnd()
      Game.addChatLine(null, `⛏ ${msg.error || 'Minage impossible'}`)
    })
    // V1.2.0 — dig cancelled (button released): hide the cracks
    Net.on('dig_cancelled', () => {
      if (renderer && renderer.ready) renderer.handleDigEnd()
    })
    // V1.2.0 — crafting feedback
    Net.on('recipes', (msg) => Game.updateRecipes(msg))
    Net.on('craft_ok', (msg) => {
      Game.addChatLine(null, `✓ Crafté : ${msg.result}${msg.count > 1 ? ' x' + msg.count : ''}`)
      if (Net.isOpen()) Net.send({ t: 'recipes' }) // refresh the list
    })
    Net.on('craft_error', (msg) => Game.addChatLine(null, `⚠ ${msg.error || 'Craft impossible'}`))
    Net.on('attack_error', (msg) => Game.addChatLine(null, `⚔ ${msg.error || 'Attaque impossible'}`))
    Net.on('place_error', (msg) => Game.addChatLine(null, `⚠ ${msg.error || 'Pose impossible'}`))
    Net.on('inv_swap_error', (msg) => Game.addChatLine(null, `⚠ ${msg.error || 'Échange impossible'}`))

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

  /**
   * V1.1.0 — loads the item icon atlas (/items.png + /items.json, both 404
   * when the pack has no items) and registers the icon provider used by the
   * hotbar. Without an atlas the hotbar shows plain slots (no crash).
   */
  async function loadItemIcons () {
    try {
      const [jsonRes, pngRes] = await Promise.all([
        fetch('/items.json'),
        fetch('/items.png')
      ])
      if (!jsonRes.ok || !pngRes.ok) return
      const meta = await jsonRes.json()
      if (!meta || !meta.items) return
      const blob = await pngRes.blob()
      const url = URL.createObjectURL(blob)
      const items = meta.items
      Game.setItemIconProvider((name) => {
        const tile = items[name]
        if (tile !== undefined) return { url, tile }
        // V1.2.0 — blocks that have no flat item icon get a 3D isometric
        // one rendered by the server from the block's own textures.
        return { url: `/icon3d/${encodeURIComponent(name)}.png`, tile: null, iso: true }
      })
      Game.renderHotbar() // re-render with textures if the hotbar was already drawn
    } catch (e) { /* no icons — the hotbar stays text-only */ }
  }

  function showError (title, detail) {
    Game.stop()
    $('error-title').textContent = title
    $('error-detail').textContent = detail || ''
    showScreen('error')
  }
})()
