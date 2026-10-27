import { File } from './vendor/megajs-1.3.10.mjs'

// megajs ne conserve pas les "file attributes" (miniatures) des nœuds : on les garde au passage.
const originalLoadMetadata = File.prototype.loadMetadata
File.prototype.loadMetadata = function (aes, opt) {
  originalLoadMetadata.call(this, aes, opt)
  this.fa = opt.fa
}

// ---------- Stockage local (uniquement sur le téléphone) ----------

const STORE_KEY = 'megatheque.folders'
const PREFS_KEY = 'megatheque.prefs'

function readJSON (key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback } catch { return fallback }
}
function writeJSON (key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
}

let folders = readJSON(STORE_KEY, [])
const prefs = Object.assign({ filter: 'all', sort: 'name', dir: 1, layout: 'grid' }, readJSON(PREFS_KEY, {}))
const saveFolders = () => writeJSON(STORE_KEY, folders)
const savePrefs = () => writeJSON(PREFS_KEY, prefs)

// ---------- Utilitaires ----------

const $ = (sel) => document.querySelector(sel)
const view = $('#view')

const VIDEO_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', 'avi', '3gp', 'ts', 'mpg', 'mpeg', 'wmv'])
const isVideo = (node) => !node.directory && VIDEO_EXT.has((node.name || '').split('.').pop().toLowerCase())

const MEGA_LINK = /https?:\/\/(?:www\.)?mega\.(?:nz|co\.nz|io)\/(?:folder\/[\w-]+#[\w-]+(?:\/(?:folder|file)\/[\w-]+)?|#F![\w-]+![\w-]+(?:![\w-]+)?)/

function formatSize (bytes) {
  if (!bytes) return '0 o'
  const units = ['o', 'Ko', 'Mo', 'Go', 'To']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** i
  return `${value.toLocaleString('fr-FR', { maximumFractionDigits: value < 10 && i > 0 ? 1 : 0 })} ${units[i]}`
}
const formatDate = (ts) => ts ? new Date(ts * 1000).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }) : ''
const plural = (n, one, many) => `${n.toLocaleString('fr-FR')} ${n > 1 ? many : one}`

function b64url (bytes) {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function el (tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('on')) node.addEventListener(k.slice(2), v)
    else if (k === 'class') node.className = v
    else if (v !== false && v != null) node.setAttribute(k, v === true ? '' : v)
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) node.append(child)
  }
  return node
}

const ICONS = {
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>',
  video: '<svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M10 9l5 3-5 3z"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
  dots: '<svg viewBox="0 0 24 24" style="stroke:currentColor"><circle cx="12" cy="5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="19" r="1"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  muted: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M22 9l-6 6M16 9l6 6"/></svg>',
  sound: '<svg viewBox="0 0 24 24"><path d="M11 5L6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7M18.5 5.5a9 9 0 0 1 0 13"/></svg>'
}
function icon (kind) {
  const span = el('span', { class: `ico ${kind}` })
  span.innerHTML = ICONS[kind]
  return span
}

let toastTimer
function toast (message, ms = 4000) {
  const t = $('#toast')
  t.textContent = message
  t.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { t.hidden = true }, ms)
}

function sheet (title, actions) {
  const bg = el('div', { class: 'sheet-bg', onclick: (e) => { if (e.target === bg) bg.remove() } },
    el('div', { class: 'sheet' },
      el('div', { class: 'sheet-title' }, title),
      actions.map(({ label, danger, run }) =>
        el('button', { class: danger ? 'danger' : '', onclick: () => { bg.remove(); run() } }, label))
    ))
  document.body.append(bg)
}

// ---------- Chargement des dossiers MEGA ----------

const loaded = new Map() // id -> Promise<File>

function loadFolder (entry, fresh = false) {
  if (fresh || !loaded.has(entry.id)) {
    const promise = File.fromURL(entry.url).loadAttributes()
    promise.catch(() => loaded.delete(entry.id))
    loaded.set(entry.id, promise)
  }
  return loaded.get(entry.id)
}

const handleOf = (node) => Array.isArray(node.downloadId) ? node.downloadId[1] : node.downloadId

const videoCounts = new WeakMap()
function countVideos (node) {
  if (!node.directory) return isVideo(node) ? 1 : 0
  if (videoCounts.has(node)) return videoCounts.get(node)
  const n = (node.children || []).reduce((sum, c) => sum + countVideos(c), 0)
  videoCounts.set(node, n)
  return n
}

// ---------- Miniatures MEGA ----------
// Chaque fichier peut porter des attributs "fa" du type "924:0*HANDLE/924:1*HANDLE" :
// 0 = miniature (120 px), 1 = aperçu (jusqu'à 1000 px). L'image est chiffrée en AES-CBC
// avec la clé du fichier. On garde les images déchiffrées dans le cache du navigateur
// (quelques Ko chacune) pour ne pas les redemander à chaque ouverture.

const THUMB_CACHE = 'megatheque-thumbs-v1'
const thumbUrls = new Map() // handle -> Promise<objectURL|null>

function thumbHandle (node) {
  if (!node.fa || !node.key) return null
  const attrs = Object.fromEntries(node.fa.split('/').map((part) => {
    const m = /:(\d+)\*([\w-]+)/.exec(part)
    return m ? [m[1], m[2]] : [null, null]
  }))
  return attrs[1] || attrs[0] || null
}

function thumbnailFor (node, rootHandle) {
  const fah = thumbHandle(node)
  if (!fah) return Promise.resolve(null)
  if (!thumbUrls.has(fah)) {
    const p = fetchThumbnail(node, fah, rootHandle).catch((err) => {
      console.warn('Miniature indisponible', err)
      return null
    })
    thumbUrls.set(fah, p)
  }
  return thumbUrls.get(fah)
}

async function fetchThumbnail (node, fah, rootHandle) {
  const cacheKey = new URL(`thumb/${fah}`, location.href).href
  let cache = null
  try { cache = await caches.open(THUMB_CACHE) } catch {}
  const cached = cache && await cache.match(cacheKey)
  if (cached) return URL.createObjectURL(await cached.blob())

  const res = await node.api.request({ a: 'ufa', fah, ssl: 2, r: 1, _querystring: { n: rootHandle } })
  if (!res || typeof res.p !== 'string') throw new Error('pas d\'URL de miniature')
  const body = b64urlDecode(fah)
  let data = null
  for (const url of [res.p, `${res.p}/0`]) {
    const r = await fetch(url, { method: 'POST', body })
    if (!r.ok) continue
    data = parseFaResponse(new Uint8Array(await r.arrayBuffer()), body)
    if (data) break
  }
  if (!data) throw new Error('réponse de miniature illisible')
  const jpeg = await aesCbcDecryptNoPad(fileAesKey(node.key), data)
  const blob = new Blob([jpeg], { type: 'image/jpeg' })
  if (cache) cache.put(cacheKey, new Response(blob)).catch(() => {})
  return URL.createObjectURL(blob)
}

// Réponse : [8 octets handle][4 octets longueur, little-endian][données], répété.
function parseFaResponse (buf, handle) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  let pos = 0
  while (pos + 12 <= buf.length) {
    const h = buf.subarray(pos, pos + 8)
    const len = view.getUint32(pos + 8, true)
    const start = pos + 12
    if (len === 0 || start + len > buf.length) return null
    if (h.every((b, i) => b === handle[i]) && len % 16 === 0) return buf.slice(start, start + len)
    pos = start + len
  }
  return null
}

function fileAesKey (key) {
  const k = new Uint8Array(16)
  for (let i = 0; i < 16; i++) k[i] = key.length === 32 ? key[i] ^ key[16 + i] : key[i]
  return k
}

// AES-CBC sans padding (IV nul). WebCrypto exige un padding PKCS#7 :
// on ajoute un bloc chiffré qui se déchiffre en padding valide.
async function aesCbcDecryptNoPad (rawKey, data) {
  const key = await crypto.subtle.importKey('raw', rawKey, 'AES-CBC', false, ['encrypt', 'decrypt'])
  const last = data.slice(data.length - 16)
  const padBlock = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: last }, key, new Uint8Array(16).fill(16))).slice(0, 16)
  const full = new Uint8Array(data.length + 16)
  full.set(data, 0)
  full.set(padBlock, data.length)
  return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv: new Uint8Array(16) }, key, full))
}

function b64urlDecode (s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0))
}

const rootOf = (node) => Array.isArray(node.downloadId) ? node.downloadId[0] : node.downloadId

function firstVideo (node) {
  for (const c of node.children || []) if (isVideo(c) && thumbHandle(c)) return c
  for (const c of node.children || []) if (c.directory) { const v = firstVideo(c); if (v) return v }
  return null
}

const lazyThumbs = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    lazyThumbs.unobserve(entry.target)
    const { node } = entry.target._thumb
    thumbnailFor(node, rootOf(node)).then((url) => {
      if (!url) return
      const img = el('img', { alt: '', decoding: 'async', src: url })
      img.onload = () => entry.target.classList.add('has-thumb')
      entry.target.prepend(img)
    })
  }
}, { rootMargin: '300px' })

function megaError (err) {
  const msg = String(err && err.message || err)
  if (/ENOENT|-9\b|not found/i.test(msg)) return 'Dossier introuvable : le lien a peut-être été supprimé.'
  if (/decrypt|key/i.test(msg)) return 'Clé de déchiffrement invalide : vérifie le lien complet (avec la partie après #).'
  if (/fetch|network/i.test(msg)) return 'Pas de connexion à MEGA. Vérifie ton réseau.'
  return `Erreur MEGA : ${msg}`
}

// ---------- Ajout d'un lien ----------

async function addFolder (raw) {
  const match = MEGA_LINK.exec(raw.trim())
  if (!match) {
    toast('Ce n\'est pas un lien de dossier MEGA. Il doit ressembler à mega.nz/folder/…#…')
    return false
  }
  const url = match[0]
  if (folders.some((f) => f.url === url)) {
    toast('Ce dossier est déjà enregistré.')
    return false
  }
  const entry = { id: crypto.randomUUID(), url, name: 'Dossier MEGA', addedAt: Date.now() }
  try {
    const top = await loadFolder(entry)
    entry.name = top.name || entry.name
  } catch (err) {
    loaded.delete(entry.id)
    toast(megaError(err), 6000)
    return false
  }
  folders.unshift(entry)
  saveFolders()
  toast(`« ${entry.name} » ajouté.`)
  return true
}

// ---------- Vues ----------

function setHeader ({ title, back, refresh, crumbs = [] }) {
  $('#title').textContent = title
  $('#back').hidden = !back
  $('#refresh').hidden = !refresh
  const c = $('#crumbs')
  c.replaceChildren()
  crumbs.forEach((crumb, i) => {
    if (i) c.append(' / ')
    c.append(crumb.href ? el('button', { onclick: () => { location.hash = crumb.href } }, crumb.label) : crumb.label)
  })
}

function renderHome () {
  setHeader({ title: 'Mégathèque' })
  const input = el('input', {
    type: 'text', inputmode: 'url', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', enterkeyhint: 'done',
    placeholder: 'Colle un lien de dossier MEGA'
  })
  const button = el('button', { class: 'btn', type: 'submit' }, 'Ajouter')
  const form = el('form', {
    class: 'add',
    onsubmit: async (e) => {
      e.preventDefault()
      if (!input.value.trim()) return
      button.disabled = true
      button.textContent = '…'
      const ok = await addFolder(input.value)
      button.disabled = false
      button.textContent = 'Ajouter'
      if (ok) renderHome()
    }
  }, input, button)

  const list = folders.length
    ? el('ul', { class: 'list' }, folders.map((f) =>
      el('li', { class: 'item', onclick: () => { location.hash = `#/f/${f.id}` } },
        icon('folder'),
        el('div', { class: 'body' },
          el('div', { class: 'name' }, f.name),
          el('div', { class: 'meta' }, `Ajouté le ${new Date(f.addedAt).toLocaleDateString('fr-FR')}`)),
        el('button', {
          class: 'icon-btn more', 'aria-label': 'Options',
          onclick: (e) => { e.stopPropagation(); folderMenu(f) }
        }, icon('dots').firstChild)
      )))
    : el('p', { class: 'empty' }, 'Aucun dossier pour l\'instant. Colle un lien MEGA ci-dessus pour commencer.')

  view.replaceChildren(
    form,
    el('p', { class: 'hint' }, 'Les vidéos sont lues en streaming depuis MEGA : rien n\'est téléchargé sur ton téléphone. Astuce : depuis l\'appli MEGA, « Partager » un lien vers Mégathèque l\'ajoute directement.'),
    list
  )
}

function folderMenu (entry) {
  sheet(entry.name, [
    {
      label: 'Renommer',
      run: () => {
        const name = prompt('Nouveau nom', entry.name)
        if (name && name.trim()) { entry.name = name.trim(); saveFolders(); render() }
      }
    },
    {
      label: 'Copier le lien MEGA',
      run: async () => {
        try { await navigator.clipboard.writeText(entry.url); toast('Lien copié.') } catch { toast(entry.url, 8000) }
      }
    },
    {
      label: 'Retirer de la liste',
      danger: true,
      run: () => {
        if (!confirm(`Retirer « ${entry.name} » ? Le dossier reste intact sur MEGA.`)) return
        folders = folders.filter((f) => f !== entry)
        loaded.delete(entry.id)
        saveFolders()
        render()
      }
    }
  ])
}

let searchText = ''

async function renderFolder (id, path, fresh = false) {
  const entry = folders.find((f) => f.id === id)
  if (!entry) { location.hash = '#/'; return }
  setHeader({ title: entry.name, back: true, refresh: true })
  view.replaceChildren(el('div', { class: 'spinner' }))

  let top
  try {
    top = await loadFolder(entry, fresh)
  } catch (err) {
    view.replaceChildren(
      el('p', { class: 'empty' }, megaError(err)),
      el('div', { style: 'text-align:center' },
        el('button', { class: 'btn secondary', onclick: () => renderFolder(id, path, true) }, 'Réessayer')))
    return
  }
  if (currentRoute() !== `f/${[id, ...path].join('/')}`) return // l'utilisateur est parti entre-temps

  // Retrouve le sous-dossier demandé
  const chain = [top]
  for (const h of path) {
    const next = (chain[chain.length - 1].children || []).find((c) => c.directory && handleOf(c) === h)
    if (!next) break
    chain.push(next)
  }
  const node = chain[chain.length - 1]
  const crumbs = chain.map((n, i) => ({
    label: i === 0 ? (n.name || entry.name) : n.name,
    href: i < chain.length - 1 ? `#/f/${[id, ...path.slice(0, i)].join('/')}` : null
  }))
  setHeader({ title: chain.length > 1 ? node.name : entry.name, back: true, refresh: true, crumbs: chain.length > 1 ? crumbs : [] })

  const children = node.children || []
  const listEl = el('ul', { class: 'list' })
  const countEl = el('p', { class: 'count' })

  function fill () {
    const q = searchText.trim().toLowerCase()
    let items = children.filter((c) => {
      if (prefs.filter === 'videos' && !isVideo(c)) return false
      if (prefs.filter === 'folders' && !c.directory) return false
      if (q && !(c.name || '').toLowerCase().includes(q)) return false
      return true
    })
    const key = {
      name: (a, b) => (a.name || '').localeCompare(b.name || '', 'fr', { numeric: true, sensitivity: 'base' }),
      size: (a, b) => (a.directory ? countVideos(a) : a.size) - (b.directory ? countVideos(b) : b.size),
      date: (a, b) => (a.timestamp || 0) - (b.timestamp || 0)
    }[prefs.sort]
    items = items.sort((a, b) => (b.directory - a.directory) || key(a, b) * prefs.dir)

    countEl.textContent = items.length
      ? `${plural(items.filter((c) => c.directory).length, 'dossier', 'dossiers')} · ${plural(items.filter(isVideo).length, 'vidéo', 'vidéos')}`
      : ''
    stopPreview()
    listEl.className = prefs.layout === 'grid' ? 'grid' : 'list'
    listEl.replaceChildren(...(items.length
      ? items.map((c) => prefs.layout === 'grid' ? tileFor(c, id, path) : itemFor(c, id, path))
      : [el('li', { class: 'empty' }, q ? 'Aucun résultat.' : 'Rien à afficher ici.')]))
  }

  const seg = el('div', { class: 'seg', role: 'group', 'aria-label': 'Filtrer' },
    [['all', 'Tout'], ['videos', 'Vidéos'], ['folders', 'Dossiers']].map(([value, label]) =>
      el('button', {
        'aria-pressed': String(prefs.filter === value),
        onclick: (e) => {
          prefs.filter = value; savePrefs()
          seg.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)))
          fill()
        }
      }, label)))

  const select = el('select', {
    'aria-label': 'Trier par',
    onchange: () => { prefs.sort = select.value; savePrefs(); fill() }
  }, [['name', 'Nom'], ['date', 'Date'], ['size', 'Taille']].map(([v, l]) =>
    el('option', { value: v, selected: prefs.sort === v }, l)))
  const dirBtn = el('button', {
    'aria-label': 'Inverser l\'ordre',
    onclick: () => { prefs.dir *= -1; savePrefs(); dirBtn.textContent = prefs.dir > 0 ? '↑' : '↓'; fill() }
  }, prefs.dir > 0 ? '↑' : '↓')
  const layoutBtn = el('button', {
    'aria-label': 'Changer l\'affichage',
    onclick: () => {
      prefs.layout = prefs.layout === 'grid' ? 'list' : 'grid'; savePrefs()
      layoutBtn.innerHTML = prefs.layout === 'grid' ? ICONS.list : ICONS.grid
      fill()
    }
  })
  layoutBtn.innerHTML = prefs.layout === 'grid' ? ICONS.list : ICONS.grid

  const search = el('input', {
    class: 'search', type: 'search', placeholder: 'Rechercher dans ce dossier', value: searchText,
    oninput: () => { searchText = search.value; fill() }
  })

  view.replaceChildren(
    el('div', { class: 'toolbar' }, seg, el('div', { class: 'sort' }, select, dirBtn, layoutBtn), search),
    countEl,
    listEl
  )
  fill()
}

function itemFor (node, id, path) {
  if (node.directory) {
    const videos = countVideos(node)
    return el('li', { class: 'item', onclick: () => { searchText = ''; location.hash = `#/f/${[id, ...path, handleOf(node)].join('/')}` } },
      icon('folder'),
      el('div', { class: 'body' },
        el('div', { class: 'name' }, node.name || '(sans nom)'),
        el('div', { class: 'meta' }, `${plural(videos, 'vidéo', 'vidéos')} · ${plural((node.children || []).length, 'élément', 'éléments')}`)))
  }
  const video = isVideo(node)
  return el('li', {
    class: `item${video ? '' : ' disabled'}`,
    onclick: () => video ? play(node) : toast('Seules les vidéos peuvent être lues ici.')
  },
  icon(video ? 'video' : 'file'),
  el('div', { class: 'body' },
    el('div', { class: 'name' }, node.name || '(sans nom)'),
    el('div', { class: 'meta' }, [formatSize(node.size), formatDate(node.timestamp)].filter(Boolean).join(' · '))))
}

// ---------- Lecteur ----------

const player = $('#player')
const video = $('#video')
const playerMsg = $('#player-msg')

async function streamUrl (node) {
  if (!('serviceWorker' in navigator)) {
    toast('Ton navigateur ne permet pas la lecture en streaming. Utilise Chrome.')
    return null
  }
  const reg = await navigator.serviceWorker.ready
  if (!navigator.serviceWorker.controller) {
    // Première ouverture : le service worker n'a pas encore pris la main sur la page.
    toast('Initialisation… relance la vidéo dans une seconde.')
    location.reload()
    return null
  }
  const [root, h] = node.downloadId
  return new URL(`stream/${root}/${h}/${b64url(node.key)}/${node.size}/${encodeURIComponent(node.name)}`, reg.scope).href
}

async function play (node, startAt = 0) {
  const src = await streamUrl(node)
  if (!src) return
  stopPreview()
  $('#player-title').textContent = node.name
  playerMsg.hidden = true
  player.hidden = false
  history.pushState({ player: true }, '')
  video.src = src
  if (startAt) video.currentTime = startAt
  video.play().catch(() => {})
}

// ---------- Grille et aperçu au doigt ----------

const LONG_PRESS_MS = 350
let preview = null // { tile, video }

function tileFor (node, id, path) {
  if (node.directory) {
    const videos = countVideos(node)
    const tile = el('li', {
      class: 'tile folder-tile',
      onclick: () => { searchText = ''; location.hash = `#/f/${[id, ...path, handleOf(node)].join('/')}` }
    },
    el('div', { class: 'tile-placeholder' }, icon('folder')),
    el('span', { class: 'badge' }, icon('folder')),
    el('div', { class: 'tile-caption' },
      el('div', { class: 'name' }, node.name || '(sans nom)'),
      el('div', { class: 'meta' }, plural(videos, 'vidéo', 'vidéos'))))
    const cover = firstVideo(node)
    if (cover) { tile._thumb = { node: cover }; lazyThumbs.observe(tile) }
    return tile
  }

  const video = isVideo(node)
  const soundBtn = el('button', { class: 'sound-btn', 'aria-label': 'Activer le son', hidden: true })
  soundBtn.innerHTML = ICONS.muted
  const tile = el('li', { class: `tile${video ? '' : ' disabled'}` },
    el('div', { class: 'tile-placeholder' }, icon(video ? 'video' : 'file')),
    soundBtn,
    el('div', { class: 'tile-caption' },
      el('div', { class: 'name' }, node.name || '(sans nom)'),
      el('div', { class: 'meta' }, formatSize(node.size))))
  tile._thumb = { node }
  if (thumbHandle(node)) lazyThumbs.observe(tile)
  if (!video) {
    tile.addEventListener('click', () => toast('Seules les vidéos peuvent être lues ici.'))
    return tile
  }

  // Appui court : lecture plein écran. Appui long : aperçu muet dans la vignette.
  let timer = null
  let startX = 0
  let startY = 0
  let longPressed = false
  const cancel = () => { clearTimeout(timer); timer = null }

  tile.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.sound-btn')) return
    longPressed = false
    startX = e.clientX
    startY = e.clientY
    cancel()
    timer = setTimeout(() => {
      timer = null
      longPressed = true
      if (navigator.vibrate) navigator.vibrate(15)
      startPreview(tile, node, soundBtn)
    }, LONG_PRESS_MS)
  })
  tile.addEventListener('pointermove', (e) => {
    if (timer && Math.hypot(e.clientX - startX, e.clientY - startY) > 10) cancel()
  })
  tile.addEventListener('pointercancel', cancel)
  tile.addEventListener('pointerleave', cancel)
  tile.addEventListener('contextmenu', (e) => e.preventDefault())
  tile.addEventListener('click', (e) => {
    if (e.target.closest('.sound-btn')) return
    cancel()
    if (longPressed) { longPressed = false; return }
    const at = preview && preview.tile === tile ? preview.video.currentTime : 0
    play(node, at)
  })
  soundBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!preview || preview.tile !== tile) return
    preview.video.muted = !preview.video.muted
    soundBtn.innerHTML = preview.video.muted ? ICONS.muted : ICONS.sound
    soundBtn.setAttribute('aria-label', preview.video.muted ? 'Activer le son' : 'Couper le son')
  })
  return tile
}

async function startPreview (tile, node, soundBtn) {
  if (preview && preview.tile === tile) return
  stopPreview()
  const src = await streamUrl(node)
  if (!src) return
  const v = el('video', { class: 'tile-video', muted: true, playsinline: true, loop: true, preload: 'auto' })
  v.muted = true
  v.src = src
  tile.classList.add('previewing')
  tile.append(v)
  soundBtn.hidden = false
  soundBtn.innerHTML = ICONS.muted
  preview = { tile, video: v, soundBtn }
  v.addEventListener('playing', () => tile.classList.add('playing'), { once: true })
  v.play().catch(() => {})
  previewObserver.observe(tile)
}

function stopPreview () {
  if (!preview) return
  const { tile, video: v, soundBtn } = preview
  preview = null
  previewObserver.unobserve(tile)
  v.pause()
  v.removeAttribute('src')
  v.load()
  v.remove()
  soundBtn.hidden = true
  tile.classList.remove('previewing', 'playing')
}

// L'aperçu s'arrête dès que la vignette sort de l'écran.
const previewObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting && preview && preview.tile === entry.target) stopPreview()
  }
})

function closePlayer () {
  video.pause()
  video.removeAttribute('src')
  video.load()
  player.hidden = true
}

$('#player-close').addEventListener('click', () => history.back())
video.addEventListener('error', () => {
  if (!player.hidden && video.getAttribute('src') && playerMsg.hidden) {
    playerMsg.textContent = 'Lecture impossible. Le format de cette vidéo n\'est peut-être pas pris en charge par ton téléphone (le MP4 marche partout).'
    playerMsg.hidden = false
  }
})

// ---------- Navigation ----------

const currentRoute = () => location.hash.replace(/^#\/?/, '')

function render () {
  const route = currentRoute()
  if (route.startsWith('f/')) {
    const [id, ...path] = route.slice(2).split('/').filter(Boolean)
    renderFolder(id, path)
  } else {
    renderHome()
  }
}

window.addEventListener('hashchange', () => { stopPreview(); if (!player.hidden) closePlayer(); render() })
document.addEventListener('visibilitychange', () => { if (document.hidden) stopPreview() })
window.addEventListener('popstate', () => { if (!player.hidden) closePlayer() })
$('#back').addEventListener('click', () => {
  const route = currentRoute()
  const parts = route.split('/')
  location.hash = parts.length > 2 ? `#/${parts.slice(0, -1).join('/')}` : '#/'
})
$('#refresh').addEventListener('click', () => {
  const [id, ...path] = currentRoute().slice(2).split('/').filter(Boolean)
  renderFolder(id, path, true)
})

// ---------- Service worker & partage ----------

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((err) => console.error(err))
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'stream-error') {
      if (!player.hidden) {
        playerMsg.textContent = event.data.message
        playerMsg.hidden = false
      } else {
        toast(event.data.message, 8000)
      }
    }
  })
}

// Lien partagé depuis une autre appli (menu « Partager » d'Android)
async function handleShare () {
  const params = new URLSearchParams(location.search)
  const shared = ['url', 'text', 'title'].map((k) => params.get(k) || '').join(' ')
  if (!shared.trim()) return
  history.replaceState(null, '', location.pathname + location.hash)
  if (MEGA_LINK.test(shared)) {
    toast('Ajout du dossier partagé…')
    if (await addFolder(shared)) render()
  } else {
    toast('Le contenu partagé ne contient pas de lien de dossier MEGA.')
  }
}

render()
handleShare()
