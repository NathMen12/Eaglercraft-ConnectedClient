'use strict'

/**
 * menu.js — server list UI backed by localStorage.
 *
 * A "server entry" is { id, name, host, port }.
 */

const Menu = (() => {
  const STORAGE_KEY = 'eaglercraft-servers'
  const USERNAME_KEY = 'eaglercraft-username'

  let servers = []
  let editingId = null // null = form hidden; 'new' = creating; otherwise id

  function loadServers () {
    try {
      servers = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    } catch (e) { servers = [] }
  }

  function saveServers () {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(servers))
  }

  function loadUsername () {
    return localStorage.getItem(USERNAME_KEY) || ''
  }

  function saveUsername (name) {
    localStorage.setItem(USERNAME_KEY, name)
  }

  // ------------------------------------------------------------------
  // DOM helpers
  // ------------------------------------------------------------------

  const $ = (id) => document.getElementById(id)

  function render () {
    const list = $('server-list')
    const empty = $('no-servers')
    list.innerHTML = ''
    empty.classList.toggle('hidden', servers.length > 0)

    // V1.1.3 — XSS-safe render: server entries come from localStorage but
    // could be tampered with by ANY script on the page (or an old bug), so
    // every field goes through textContent / attribute-safe construction.
    // (The old template interpolated s.port & data-id UNESCAPED and crashed
    // on empty names with s.name[0].)
    servers.forEach((s) => {
      if (!s || typeof s.host !== 'string' || !s.host) return

      const li = document.createElement('li')
      li.className = 'server-item'

      const icon = document.createElement('div')
      icon.className = 'server-icon'
      const initial = (typeof s.name === 'string' && s.name) ? s.name[0].toUpperCase() : '?'
      icon.textContent = initial

      const info = document.createElement('div')
      info.className = 'server-info'
      const nameEl = document.createElement('div')
      nameEl.className = 'server-name'
      nameEl.textContent = s.name || s.host
      const addrEl = document.createElement('div')
      addrEl.className = 'server-addr'
      addrEl.textContent = `${s.host}:${Number(s.port) || 25565}`
      info.appendChild(nameEl)
      info.appendChild(addrEl)

      const connect = document.createElement('button')
      connect.className = 'btn small primary connect'
      connect.textContent = 'Rejoindre'
      connect.dataset.id = String(s.id || '')

      const del = document.createElement('button')
      del.className = 'btn small danger delete'
      del.textContent = '✕'
      del.dataset.id = String(s.id || '')

      li.appendChild(icon)
      li.appendChild(info)
      li.appendChild(connect)
      li.appendChild(del)
      list.appendChild(li)
    })
  }

  // ------------------------------------------------------------------
  // Form
  // ------------------------------------------------------------------

  function openForm (server) {
    editingId = server ? server.id : 'new'
    const form = $('server-form')
    form.classList.remove('hidden')
    if (server) {
      $('server-name').value = server.name || ''
      $('server-host').value = server.host || ''
      $('server-port').value = server.port || 25565
    } else {
      $('server-name').value = ''
      $('server-host').value = ''
      $('server-port').value = 25565
    }
    $('server-host').focus()
  }

  function closeForm () {
    editingId = null
    $('server-form').classList.add('hidden')
  }

  function saveForm () {
    const name = $('server-name').value.trim()
    const host = $('server-host').value.trim()
    const port = parseInt($('server-port').value, 10) || 25565
    if (!host) {
      $('server-host').focus()
      return
    }
    if (editingId === 'new') {
      servers.push({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, host, port })
    } else {
      const s = servers.find((x) => x.id === editingId)
      if (s) { s.name = name; s.host = host; s.port = port }
    }
    saveServers()
    closeForm()
    render()
  }

  // ------------------------------------------------------------------
  // Public API
  // ------------------------------------------------------------------

  function init () {
    loadServers()
    render()

    $('username-input').value = loadUsername()
    $('username-input').addEventListener('input', () => saveUsername($('username-input').value))

    $('add-server-btn').addEventListener('click', () => openForm(null))
    $('server-form-cancel').addEventListener('click', closeForm)
    $('server-form-save').addEventListener('click', saveForm)

    // Delegate clicks inside the server list
    $('server-list').addEventListener('click', (ev) => {
      const target = ev.target.closest('button')
      if (!target) return
      const id = target.dataset.id
      if (target.classList.contains('connect')) {
        const server = servers.find((s) => s.id === id)
        if (server) Menu.onConnect(server)
      } else if (target.classList.contains('delete')) {
        servers = servers.filter((s) => s.id !== id)
        saveServers()
        render()
      }
    })
  }

  function getUsername () {
    const v = $('username-input').value.trim()
    return v
  }

  /** Overridden by main.js: (server) => void */
  function onConnect (server) {
    console.warn('Menu.onConnect not wired yet', server)
  }

  return { init, render, getUsername, onConnect, openForm }
})()

window.Menu = Menu
