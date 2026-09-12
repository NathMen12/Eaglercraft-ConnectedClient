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
    chatOpen: false,
    // V1.1.0 — hotbar / inventory state (kept in sync by main.js)
    hotbar: new Array(9).fill(null), // [{ name, count }] | null
    selectedSlot: 0,
    // V1.1.1 — full inventory (36 slots: 0-8 hotbar, 9-35 main grid).
    // Server slot indexes 36-44 map to 0-8 here (quick bar first, like the
    // vanilla inventory screen layout).
    inventory: new Array(36).fill(null),
    inventoryOpen: false,
    // First clicked slot while the inventory screen is open (swap source)
    pickedSlot: null
  }

  // Hotbar DOM signature — avoids rebuilding identical slots (see renderHotbar).
  // Declared here (not near renderHotbar) so start() can reset it without TDZ.
  let lastHotbarSignature = ''

  // Inventory item icon providers — set by main.js once the item atlas is
  // loaded (name -> { url, tile } or null when the server has none).
  let itemIconProvider = null
  function setItemIconProvider (fn) { itemIconProvider = fn }
  function getItemIcon (name) { return itemIconProvider ? itemIconProvider(name) : null }

  /**
   * Hotbar selection. notifyServer=false when the change originates from a
   * server echo (slot_selected) — pushing it back would loop.
   */
  function selectHotbarSlot (slot, notifyServer = true) {
    slot = ((slot % 9) + 9) % 9
    if (slot === state.selectedSlot) return
    state.selectedSlot = slot
    renderHotbar()
    if (notifyServer && typeof Net !== 'undefined' && Net.isOpen()) {
      Net.send({ t: 'slot_select', slot })
    }
  }

  // Send control states at ~10 Hz — but only when something actually changed
  // (controls state OR camera moved). A static client used to send 20
  // messages/s forever for nothing.
  let lastSent = 0
  const SEND_INTERVAL = 100
  // Look updates are latency-sensitive (they aim the bot): sent at 20 Hz,
  // on a SEPARATE timer so they are never delayed behind controls.
  let lastLookSent = 0
  const LOOK_SEND_INTERVAL = 50
  let lastSentControls = null
  let lastSentYaw = 0
  let lastSentPitch = 0
  const LOOK_EPSILON = 0.01 // ~0.57° — below human perception

  // Called on EVERY mouse move with the new local look. The renderer uses
  // it to rotate the camera INSTANTLY (client-side prediction) instead of
  // waiting for the 20 Hz server echo — this is what removes the
  // "capped at 20 fps" feel while the render loop runs at full speed.
  let lookCallback = null
  function onLookChange (fn) { lookCallback = fn }

  // R key: the client wipes its whole chunk cache too (see onKeyDown).
  let reloadChunksCallback = null
  function onReloadChunks (fn) { reloadChunksCallback = fn }

  // Mouse buttons (V1.1.0): dig / place-use — wired to the raycast target
  // provided by the renderer (block + face) via onAttack callback.
  let attackCallback = null
  function onAttack (fn) { attackCallback = fn }

  // Sneak/sprint state callbacks: the renderer dips the camera when
  // sneaking and widens the FOV when sprinting (local feedback, no latency)
  let sneakSprintCallback = null
  function onSneakSprintChange (fn) { sneakSprintCallback = fn }
  function notifySneakSprint () {
    if (sneakSprintCallback) sneakSprintCallback(state.controls.sneak, state.controls.sprint)
  }

  function isActive () { return state.active }

  function start () {
    state.active = true
    bindEvents()
    loadHudSprites() // async, emoji fallback until loaded
    // Reset the V1.1.0 interaction state for a fresh session: a second login
    // (same tab, back from the menu) must not keep the previous hotbar.
    state.hotbar = new Array(9).fill(null)
    state.selectedSlot = 0
    state.inventory = new Array(36).fill(null)
    state.pickedSlot = null
    if (state.inventoryOpen) closeInventory()
    lastHotbarSignature = '' // force a hotbar re-render
    renderHotbar()
    requestAnimationFrame(tick)
  }

  function stop () {
    state.active = false
    unbindEvents()
    if (document.pointerLockElement) document.exitPointerLock()
    // Release every pressed control on the server, otherwise the bot keeps
    // walking after the client left the game screen.
    resetControls()
    lastSentControls = null // force a fresh state send on next start
    if (typeof Net !== 'undefined' && Net.isOpen()) {
      Net.send({ t: 'control', states: { ...state.controls } })
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
    if (e.code === 'KeyR') {
      // Full chunk reload: wipes the client cache (meshes + decoded data) and
      // the server's sent-set, then everything is re-scanned from zero — the
      // fix for client-side "phantom blocks" desyncs.
      e.preventDefault()
      if (typeof Net !== 'undefined' && Net.isOpen()) Net.send({ t: 'reset_chunks' })
      if (reloadChunksCallback) reloadChunksCallback()
      addChatLine(null, 'Rechargement des chunks…')
      return
    }
    if (e.code === 'KeyE') {
      // V1.1.1 — inventory screen toggle (vanilla binding)
      e.preventDefault()
      if (state.inventoryOpen) closeInventory()
      else openInventory()
      return
    }
    // While the inventory screen is open every other game key is captured
    // except Escape (close) — vanilla behaves the same.
    if (state.inventoryOpen) {
      if (e.code === 'Escape') closeInventory()
      return
    }
    // Hotbar slots 1-9 (vanilla binding)
    if (/^Digit[1-9]$/.test(e.code)) {
      e.preventDefault()
      selectHotbarSlot(parseInt(e.code.slice(5), 10) - 1)
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
      notifySneakSprint()
      return
    }
    if (e.key === 'Control') {
      state.controls.sprint = true
      notifySneakSprint()
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
    if (e.key === 'Shift') { state.controls.sneak = false; notifySneakSprint(); return }
    if (e.key === 'Control') { state.controls.sprint = false; notifySneakSprint(); return }
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
    // Camera prediction: notify the renderer IMMEDIATELY (same event, zero
    // latency) — do not wait for the 20 Hz network echo.
    if (lookCallback) lookCallback(state.yaw, state.pitch)
  }

  function onCanvasClick () {
    if (!state.active || state.chatOpen) return
    if (!document.pointerLockElement) {
      document.getElementById('game-canvas').requestPointerLock()
    }
  }

  /**
   * Mouse buttons (V1.1.0), only while the pointer is locked:
   *   left  (button 0) -> mine the targeted block
   *   right (button 2)  -> place the held block against the targeted face
   *                        (or "activate" when nothing is held / in hand)
   * The click itself acquires the pointer lock when it is not held yet.
   */
  function onMouseDown (e) {
    if (!state.active || state.chatOpen) return
    if (!document.pointerLockElement) return // first click only locks
    e.preventDefault()
    if (!attackCallback) return
    if (e.button === 0) {
      attackCallback('dig')
    } else if (e.button === 2) {
      attackCallback('place')
    }
  }

  // Hotbar wheel (vanilla: scroll up = previous slot, down = next)
  function onWheel (e) {
    if (!state.active || state.chatOpen) return
    if (!document.pointerLockElement) return
    e.preventDefault()
    selectHotbarSlot(state.selectedSlot + (e.deltaY > 0 ? 1 : -1))
  }

  function onContextMenu (e) { e.preventDefault() }

  function onPointerLockChange () {
    // When lock is lost we stop moving so the bot doesn't run away
    if (!document.pointerLockElement) resetControls()
  }

  function resetControls () {
    for (const k of Object.keys(state.controls)) state.controls[k] = false
    notifySneakSprint()
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
    // Look: 20 Hz, independent from controls (aiming is latency-sensitive)
    if (typeof Net !== 'undefined' && Net.isOpen() &&
        now - lastLookSent >= LOOK_SEND_INTERVAL &&
        (Math.abs(state.yaw - lastSentYaw) > LOOK_EPSILON ||
         Math.abs(state.pitch - lastSentPitch) > LOOK_EPSILON)) {
      lastLookSent = now
      lastSentYaw = state.yaw
      lastSentPitch = state.pitch
      Net.send({ t: 'look', yaw: state.yaw, pitch: state.pitch })
    }
    if (now - lastSent >= SEND_INTERVAL) {
      lastSent = now
      if (typeof Net !== 'undefined' && Net.isOpen()) {
        // Controls: send only when the state actually changed
        const c = state.controls
        const changed = !lastSentControls ||
          c.forward !== lastSentControls.forward || c.back !== lastSentControls.back ||
          c.left !== lastSentControls.left || c.right !== lastSentControls.right ||
          c.jump !== lastSentControls.jump || c.sneak !== lastSentControls.sneak ||
          c.sprint !== lastSentControls.sprint
        if (changed) {
          lastSentControls = { ...c }
          Net.send({ t: 'control', states: { ...c } })
        }
      }
    }
    requestAnimationFrame(tick)
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  // HUD updates are throttled: updateHud/renderHearts used to run at up to
  // 20 Hz (every position message), rebuilding the hearts DOM 20 times per
  // second. Now: values cached, DOM touched only on actual change.
  let lastHealthRendered = -1
  let lastFoodRendered = -1
  // Vanilla HUD sprites (loaded once from the server's resource pack).
  // Null while loading / when the server has no pack -> emoji fallback.
  let hudSprites = null
  let hudSheetUrl = null
  let hudSheetSize = { w: 9, h: 54 }

  async function loadHudSprites () {
    try {
      const [jsonRes, pngRes] = await Promise.all([
        fetch('/hud.json'),
        fetch('/hud.png')
      ])
      if (!jsonRes.ok || !pngRes.ok) return
      const sprites = await jsonRes.json()
      if (!sprites || !sprites.sprites || !sprites.sprites.heart_full) return
      const blob = await pngRes.blob()
      hudSheetUrl = URL.createObjectURL(blob)
      hudSprites = sprites.sprites
      hudSheetSize = { w: sprites.sheetWidth || 9, h: sprites.sheetHeight || 54 }
      lastHealthRendered = -1 // force a re-render with textures
      lastFoodRendered = -1
      renderHealthHud()
    } catch (e) { /* emoji fallback stays active */ }
  }

  function spriteStyle (el, name) {
    const s = hudSprites && hudSprites[name]
    if (!s || !hudSheetUrl) return false
    el.classList.add('textured')
    // Icons are displayed at 2x their 9x9 native size (18px, pixelated).
    el.style.backgroundImage = `url(${hudSheetUrl})`
    el.style.backgroundPosition = `-${s.x * 2}px -${s.y * 2}px`
    el.style.backgroundSize = `${hudSheetSize.w * 2}px ${hudSheetSize.h * 2}px`
    return true
  }

  function updateHud (data) {
    if (data.health !== undefined) state.health = data.health
    if (data.food !== undefined) state.food = data.food
    renderHealthHud()
  }

  // ------------------------------------------------------------------
  // Hotbar (V1.1.0)
  // ------------------------------------------------------------------

  /** Rebuilds the 9 hotbar slot elements (idempotent, throttled by signature). */
  function renderHotbar () {
    const bar = document.getElementById('hotbar')
    if (!bar) return
    // Signature = slots content + selection: skip identical DOM rebuilds
    const sig = state.selectedSlot + '|' + state.hotbar.map((s) => s ? `${s.name}:${s.count}` : '-').join(',')
    if (sig === lastHotbarSignature) return
    lastHotbarSignature = sig
    bar.innerHTML = ''
    for (let i = 0; i < 9; i++) {
      const slot = document.createElement('div')
      slot.className = 'hotbar-slot' + (i === state.selectedSlot ? ' selected' : '')
      const item = state.hotbar[i]
      if (item) {
        const icon = getItemIcon(item.name)
        if (icon) {
          const img = document.createElement('div')
          img.className = 'hotbar-icon'
          img.style.backgroundImage = `url(${icon.url})`
          // Icon tile position in the 64x64 atlas (16px tiles, 2x upscale)
          const tx = (icon.tile % 64) * 32
          const ty = Math.floor(icon.tile / 64) * 32
          img.style.backgroundPosition = `-${tx}px -${ty}px`
          img.style.backgroundSize = '2048px 2048px'
          slot.appendChild(img)
        } else {
          const fallback = document.createElement('div')
          fallback.className = 'hotbar-icon hotbar-icon-fallback'
          slot.appendChild(fallback)
        }
        if (item.count > 1) {
          const count = document.createElement('span')
          count.className = 'hotbar-count'
          count.textContent = item.count > 99 ? '99+' : String(item.count)
          slot.appendChild(count)
        }
      }
      // Slot number (vanilla-like, only on the selected one for now)
      if (i === state.selectedSlot) slot.title = `Slot ${i + 1}`
      bar.appendChild(slot)
    }
  }

  /** Full hotbar update from a server {t:'hotbar'} snapshot. */
  function updateHotbar (msg) {
    if (!Array.isArray(msg.slots) || msg.slots.length !== 9) return
    state.hotbar = msg.slots.map((s) => s ? { name: s.name, count: s.count } : null)
    if (typeof msg.selected === 'number' && msg.selected >= 0 && msg.selected <= 8) {
      state.selectedSlot = msg.selected
    }
    // The hotbar snapshot IS the inventory's quick-bar row (client 0-8)
    for (let i = 0; i < 9; i++) state.inventory[i] = state.hotbar[i]
    renderHotbar()
    if (state.inventoryOpen) renderInventory()
  }

  /** Single quick-bar item change (server 'inv_slot' with index 36-44, or a
   *  full hotbar push — main.js translates and calls this). */
  function updateHotbarSlot (index, item) {
    if (index < 0 || index > 8) return
    state.hotbar[index] = item ? { name: item.name, count: item.count } : null
    state.inventory[index] = state.hotbar[index]
    renderHotbar()
    if (state.inventoryOpen) renderInventory()
  }

  // ------------------------------------------------------------------
  // Inventory screen (V1.1.1 — E key)
  // ------------------------------------------------------------------

  /** Server slot index -> client inventory index (hotbar 36-44 -> 0-8). */
  function serverSlotToClient (index) {
    if (index >= 36 && index <= 44) return index - 36
    return index // 0-35 unchanged
  }

  function openInventory () {
    state.inventoryOpen = true
    state.pickedSlot = null
    document.getElementById('inventory-screen').classList.remove('hidden')
    if (document.pointerLockElement) document.exitPointerLock()
    renderInventory()
  }

  function closeInventory () {
    state.inventoryOpen = false
    state.pickedSlot = null
    document.getElementById('inventory-screen').classList.add('hidden')
  }

  /** Builds the DOM slots once, then only refreshes icons/counts. */
  let invDomBuilt = false
  function ensureInvDom () {
    if (invDomBuilt) return
    invDomBuilt = true
    const grid = document.getElementById('inventory-grid')
    const hot = document.getElementById('inventory-hotbar')
    for (let i = 9; i < 36; i++) grid.appendChild(buildInvSlotEl(i))
    for (let i = 0; i < 9; i++) hot.appendChild(buildInvSlotEl(i))
  }

  function buildInvSlotEl (clientIndex) {
    const el = document.createElement('div')
    el.className = 'inv-slot'
    el.dataset.slot = String(clientIndex)
    el.addEventListener('click', onInventorySlotClick)
    return el
  }

  function renderInventory () {
    ensureInvDom()
    const slots = document.querySelectorAll('#inventory-screen .inv-slot')
    for (const el of slots) {
      const i = parseInt(el.dataset.slot, 10)
      const item = state.inventory[i]
      // Selected (source of an in-progress swap) is outlined
      const picked = state.pickedSlot === i
      el.classList.toggle('picked', picked)
      el.classList.toggle('in-hotbar', i < 9)
      fillItemEl(el, item)
    }
  }

  /** Writes icon + count into a slot element (shared by hotbar & inventory). */
  function fillItemEl (el, item) {
    // Keep the click listener on the parent: rebuild children only
    const icon = el.querySelector('.hotbar-icon, .inv-icon')
    if (icon) icon.remove()
    const count = el.querySelector('.hotbar-count')
    if (count) count.remove()
    if (!item) return
    const img = document.createElement('div')
    img.className = 'inv-icon'
    const iconInfo = getItemIcon(item.name)
    if (iconInfo) {
      img.style.backgroundImage = `url(${iconInfo.url})`
      const tx = (iconInfo.tile % 64) * 32
      const ty = Math.floor(iconInfo.tile / 64) * 32
      img.style.backgroundPosition = `-${tx}px -${ty}px`
      img.style.backgroundSize = '2048px 2048px'
    } else {
      img.classList.add('hotbar-icon-fallback')
    }
    el.appendChild(img)
    if (item.count > 1) {
      const c = document.createElement('span')
      c.className = 'hotbar-count'
      c.textContent = item.count > 99 ? '99+' : String(item.count)
      el.appendChild(c)
    }
  }

  /**
   * Two clicks = one swap: pick the source slot, then the destination. The
   * server does the real clickWindow pair (see handleInvSwap) and the result
   * comes back through inv_slot pushes — the client never invents state.
   */
  function onInventorySlotClick (e) {
    const el = e.currentTarget
    const to = parseInt(el.dataset.slot, 10)
    if (state.pickedSlot === null) {
      if (!state.inventory[to]) return // can't pick up an empty slot
      state.pickedSlot = to
    } else {
      const from = state.pickedSlot
      state.pickedSlot = null
      if (from !== to) {
        // Server slot index: client 0-8 (hotbar) -> 36-44
        const fromServer = from < 9 ? from + 36 : from
        const toServer = to < 9 ? to + 36 : to
        if (typeof Net !== 'undefined' && Net.isOpen()) {
          Net.send({ t: 'inv_swap', from: fromServer, to: toServer })
        }
        // Optimistic display swap (inv_slot echoes will correct any drift)
        const tmp = state.inventory[from]
        state.inventory[from] = state.inventory[to]
        state.inventory[to] = tmp
      }
    }
    renderInventory()
    syncHotbarFromInventory()
  }

  /** Mirrors inventory hotbar slots (0-8) into the HUD hotbar state. */
  function syncHotbarFromInventory () {
    let changed = false
    for (let i = 0; i < 9; i++) {
      if (state.hotbar[i] !== state.inventory[i]) {
        state.hotbar[i] = state.inventory[i]
        changed = true
      }
    }
    if (changed) renderHotbar()
  }

  /** Server 'inv_slot' push (index 0-44) — main.js routes 36-44 here too. */
  function updateInventorySlot (serverIndex, item) {
    const i = serverSlotToClient(serverIndex)
    if (i < 0 || i > 35) return
    state.inventory[i] = item ? { name: item.name, count: item.count } : null
    if (i < 9) {
      state.hotbar[i] = state.inventory[i]
      renderHotbar()
    }
    if (state.inventoryOpen) renderInventory()
  }

  function renderHealthHud () {
    // Hearts (health / 2, half hearts supported)
    const heartsEl = document.getElementById('hearts')
    if (heartsEl) {
      const hp = Math.max(0, Math.min(20, state.health))
      const fullHearts = Math.floor(hp / 2)
      const halfHeart = hp % 2 === 1
      const signature = `${fullHearts}.${halfHeart ? 5 : 0}`
      if (signature !== lastHealthRendered) {
        lastHealthRendered = signature
        heartsEl.innerHTML = ''
        for (let i = 0; i < 10; i++) {
          const h = document.createElement('div')
          const isFull = i < fullHearts
          const isHalf = i === fullHearts && halfHeart
          h.className = 'heart' + (!isFull && !isHalf ? ' empty' : '')
          const sprite = isFull ? 'heart_full' : isHalf ? 'heart_half' : 'heart_container'
          if (!spriteStyle(h, sprite)) {
            // Emoji fallback (no class change keeps the ::before heart)
            if (!isFull) h.classList.add('empty')
          }
          heartsEl.appendChild(h)
        }
      }
    }
    // Food (food / 2, half icons supported)
    const foodEl = document.getElementById('food')
    if (foodEl) {
      const f = Math.max(0, Math.min(20, state.food))
      const fullFood = Math.floor(f / 2)
      const halfFood = f % 2 === 1
      const signature = `${fullFood}.${halfFood ? 5 : 0}`
      if (signature !== lastFoodRendered) {
        lastFoodRendered = signature
        foodEl.innerHTML = ''
        for (let i = 0; i < 10; i++) {
          const d = document.createElement('div')
          const isFull = i < fullFood
          const isHalf = i === fullFood && halfFood
          d.className = 'food-icon'
          const sprite = isFull ? 'food_full' : isHalf ? 'food_half' : 'food_empty'
          spriteStyle(d, sprite)
          foodEl.appendChild(d)
        }
      }
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

  /** Current local look (used by the renderer for camera prediction). */
  function getLook () { return { yaw: state.yaw, pitch: state.pitch } }

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
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('wheel', onWheel, { passive: false })
    document.addEventListener('contextmenu', onContextMenu)
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
    document.removeEventListener('mousedown', onMouseDown)
    document.removeEventListener('wheel', onWheel)
    document.removeEventListener('contextmenu', onContextMenu)
  }

  return {
    start, stop, isActive, state,
    updateHud, addChatLine, updateDebug, setPosition, setLook, getLook,
    onLookChange, onSneakSprintChange,
    // V1.1.0 — chunk reload, mouse attacks, hotbar
    onReloadChunks, onAttack,
    updateHotbar, updateHotbarSlot, selectHotbarSlot, renderHotbar,
    setItemIconProvider,
    // V1.1.1 — inventory screen (E)
    updateInventorySlot
  }
})()

window.Game = Game

