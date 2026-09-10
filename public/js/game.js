'use strict'

/**
 * game.js — in-game controls & HUD.
 *
 * Keyboard layout (auto-detects AZERTY/QWERTY using physical key codes):
 *   Z/W forward, S back, Q/A left, D right, Space jump, Shift sneak,
 *   Ctrl sprint, T chat, Escape release mouse.
 * Mouse: look (pointer lock).
 */

const Game = (() => {
  const state = {
    active: false,
    controls: { forward: false, back: false, left: false, right: false, jump: false, sneak: false, sprint: false },
    yaw: 0, pitch: 0,
    health: 20, food: 20,
    position: { x: 0, y: 0, z: 0 },
    chatOpen: false
  }

  // Send control states at ~10 Hz
  let lastSent = 0
  const SEND_INTERVAL = 100

  function isActive () { return state.active }

  function start () {
    state.active = true
    bindEvents()
    requestAnimationFrame(tick)
  }

  function stop () {
    state.active = false
    unbindEvents()
    if (document.pointerLockElement) document.exitPointerLock()
    // Release every pressed control on the server, otherwise the bot keeps
    // walking after the client left the game screen.
    resetControls()
    if (typeof Net !== 'undefined' && Net.isOpen()) {
      Net.send({ t: 'control', states: state.controls })
    }
  }

  // ------------------------------------------------------------------
  // Input events
  // ------------------------------------------------------------------

  // --- Movement keys: e.key (character) so AZERTY ZQSD and QWERTY WASD
  // both map to the same controls without layout detection.
  const keyMap = {
    z: 'forward', w: 'forward', Z: 'forward', W: 'forward',
    s: 'back', S: 'back',
    q: 'left', a: 'left', Q: 'left', A: 'left',
    d: 'right', D: 'right'
  }

  function onKeyDown (e) {
    if (!state.active) return
    if (state.chatOpen) return // typed keys go to the input field
    if (e.code === 'KeyT' || e.code === 'Slash') {
      e.preventDefault()
      openChat(e.code === 'Slash' ? '/' : '')
      return
    }
    if (e.code === 'Escape') {
      if (document.pointerLockElement) document.exitPointerLock()
      return
    }
    if (e.code === 'Space') {
      e.preventDefault()
      state.controls.jump = true
      return
    }
    if (e.key === 'Shift') {
      state.controls.sneak = true
      return
    }
    if (e.key === 'Control') {
      state.controls.sprint = true
      return
    }
    const control = keyMap[e.key]
    if (control) {
      e.preventDefault()
      state.controls[control] = true
    }
  }

  function onKeyUp (e) {
    if (!state.active) return
    if (e.code === 'Space') { state.controls.jump = false; return }
    if (e.key === 'Shift') { state.controls.sneak = false; return }
    if (e.key === 'Control') { state.controls.sprint = false; return }
    const control = keyMap[e.key]
    if (control) state.controls[control] = false
  }

  function onMouseMove (e) {
    if (!state.active || !document.pointerLockElement) return
    const sensitivity = 0.0022
    // Mineflayer yaw convention (from prismarine-physics):
    //   yaw 0 = north (-Z), positive yaw turns LEFT (toward west).
    // Mouse right (positive movementX) must turn right => DECREASE yaw.
    state.yaw -= e.movementX * sensitivity
    // Pitch: positive = looking down. Mouse up (negative movementY) looks up.
    state.pitch += e.movementY * sensitivity
    const halfPi = Math.PI / 2
    if (state.pitch > halfPi) state.pitch = halfPi
    if (state.pitch < -halfPi) state.pitch = -halfPi
    // Normalize yaw to [-π, π]
    if (state.yaw > Math.PI) state.yaw -= 2 * Math.PI
    if (state.yaw < -Math.PI) state.yaw += 2 * Math.PI
  }

  function onCanvasClick () {
    if (!state.active || state.chatOpen) return
    if (!document.pointerLockElement) {
      document.getElementById('game-canvas').requestPointerLock()
    }
  }

  function onPointerLockChange () {
    // When lock is lost we stop moving so the bot doesn't run away
    if (!document.pointerLockElement) resetControls()
  }

  function resetControls () {
    for (const k of Object.keys(state.controls)) state.controls[k] = false
  }

  // ------------------------------------------------------------------
  // Chat
  // ------------------------------------------------------------------

  function openChat (prefix) {
    state.chatOpen = true
    const row = document.getElementById('chat-input-row')
    const input = document.getElementById('chat-input')
    row.classList.remove('hidden')
    input.value = prefix
    input.focus()
    if (document.pointerLockElement) document.exitPointerLock()
  }

  function closeChat (send) {
    const input = document.getElementById('chat-input')
    const text = input.value.trim()
    state.chatOpen = false
    document.getElementById('chat-input-row').classList.add('hidden')
    input.value = ''
    if (send && text && typeof Net !== 'undefined') {
      Net.send({ t: 'chat', text: text.slice(0, 256) })
    }
  }

  function onChatInputKey (e) {
    if (e.code === 'Enter') closeChat(true)
    else if (e.code === 'Escape') closeChat(false)
    e.stopPropagation()
  }

  // ------------------------------------------------------------------
  // Network tick: send controls + look
  // ------------------------------------------------------------------

  function tick () {
    if (!state.active) return
    const now = performance.now()
    if (now - lastSent >= SEND_INTERVAL) {
      lastSent = now
      if (typeof Net !== 'undefined' && Net.isOpen()) {
        Net.send({ t: 'control', states: state.controls })
        Net.send({ t: 'look', yaw: state.yaw, pitch: state.pitch })
      }
    }
    requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  function updateHud (data) {
    if (data.health !== undefined) state.health = data.health
    if (data.food !== undefined) state.food = data.food
    renderHearts()
  }
  function renderHearts () {
    const el = document.getElementById('hearts')
    if (!el) return
    el.innerHTML = ''
    const full = Math.max(0, Math.min(10, Math.round(state.health / 2)))
    for (let i = 0; i < 10; i++) {
      const h = document.createElement('div')
      h.className = 'heart' + (i >= full ? ' empty' : '')
      el.appendChild(h)
    }
  }

  function addChatLine (from, text) {
    const box = document.getElementById('chat-messages')
    if (!box) return
    const line = document.createElement('div')
    line.className = 'chat-line' + (from ? '' : ' system')
    if (from) {
      const f = document.createElement('span')
      f.className = 'from'
      f.textContent = `<${from}> `
      line.appendChild(f)
    }
    line.appendChild(document.createTextNode(text))
    box.appendChild(line)
    while (box.children.length > 60) box.removeChild(box.firstChild)
    box.scrollTop = box.scrollHeight
  }

  function updateDebug (fps, extra) {
    const el = document.getElementById('debug-info')
    if (!el) return
    const p = state.position
    el.textContent =
      `Eaglercraft: Connected Client  |  ${fps} fps\n` +
      `XYZ: ${p.x.toFixed(1)} / ${p.y.toFixed(1)} / ${p.z.toFixed(1)}\n` +
      (extra || '')
  }

  function setPosition (x, y, z) {
    state.position.x = x; state.position.y = y; state.position.z = z
  }

  function setLook (yaw, pitch) {
    // While the player controls the camera (pointer lock), the local look
    // is authoritative — server echoes must not fight the mouse.
    if (document.pointerLockElement) return
    state.yaw = yaw
    state.pitch = pitch
  }

  // ------------------------------------------------------------------
  // Binding
  // ------------------------------------------------------------------

  let bound = false

  function bindEvents () {
    if (bound) return
    bound = true
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('keyup', onKeyUp)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    document.getElementById('game-canvas').addEventListener('click', onCanvasClick)
    document.getElementById('chat-input').addEventListener('keydown', onChatInputKey)
  }

  function unbindEvents () {
    if (!bound) return
    bound = false
    document.removeEventListener('keydown', onKeyDown)
    document.removeEventListener('keyup', onKeyUp)
    document.removeEventListener('mousemove', onMouseMove)
    document.removeEventListener('pointerlockchange', onPointerLockChange)
  }

  return {
    start, stop, isActive, state,
    updateHud, addChatLine, updateDebug, setPosition, setLook
  }
})()

window.Game = Game

