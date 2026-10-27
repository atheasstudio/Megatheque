// Service worker de Mégathèque.
// 1. Sert l'interface depuis le cache (l'appli s'ouvre même hors ligne).
// 2. Intercepte les URL "stream/..." : récupère le fichier chiffré chez MEGA,
//    le déchiffre à la volée (AES-128-CTR) et le renvoie au lecteur vidéo,
//    avec prise en charge des requêtes Range pour l'avance rapide.
//    Rien n'est écrit sur le téléphone.

const VERSION = 'v1'
const SHELL_CACHE = `megatheque-shell-${VERSION}`
const SHELL = [
  './',
  'index.html',
  'app.js',
  'style.css',
  'manifest.webmanifest',
  'vendor/megajs-1.3.10.mjs',
  'icons/icon-192.png',
  'icons/icon-512.png'
]

const API_URL = 'https://g.api.mega.co.nz/cs'
// Taille maximale servie par réponse : le lecteur redemande la suite tout seul.
// Évite de consommer du quota MEGA pour des morceaux que l'on saute.
const MAX_CHUNK = 8 * 1024 * 1024
const URL_TTL = 30 * 60 * 1000

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('megatheque-shell-') && key !== SHELL_CACHE) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  const scope = new URL(self.registration.scope)
  if (url.origin !== scope.origin || event.request.method !== 'GET') return

  const rel = url.pathname.slice(scope.pathname.length)
  if (rel.startsWith('stream/')) {
    event.respondWith(handleStream(event.request, rel.slice('stream/'.length)))
    return
  }

  // Interface : réseau d'abord (pour les mises à jour), cache si hors ligne.
  event.respondWith((async () => {
    try {
      const res = await fetch(event.request)
      if (res.ok) {
        const cache = await caches.open(SHELL_CACHE)
        cache.put(event.request, res.clone())
      }
      return res
    } catch (err) {
      const cached = await caches.match(event.request, { ignoreSearch: true })
      if (cached) return cached
      throw err
    }
  })())
})

// ---------- Streaming ----------

async function handleStream (request, path) {
  try {
    const parts = path.split('/')
    const [root, node, keyB64, sizeStr] = parts
    const name = decodeURIComponent(parts.slice(4).join('/'))
    const size = Number(sizeStr)
    const key = b64urlDecode(keyB64)
    if (!root || !node || key.length !== 32 || !Number.isFinite(size)) {
      return new Response('Lien de lecture invalide', { status: 400 })
    }

    const range = parseRange(request.headers.get('range'), size)
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
    }
    const start = range ? range.start : 0
    const end = range ? Math.min(range.end, start + MAX_CHUNK - 1) : size - 1

    const upstream = await fetchEncrypted(root, node, start - (start % 16), end)
    const body = decryptStream(upstream, key, start - (start % 16), start % 16)

    const headers = {
      'Content-Type': mimeFor(name),
      'Accept-Ranges': 'bytes',
      'Content-Length': String(end - start + 1),
      'Cache-Control': 'no-store'
    }
    if (!range) return new Response(body, { status: 200, headers })
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
    return new Response(body, { status: 206, headers })
  } catch (err) {
    notifyClients(err)
    return new Response(err.message || 'Erreur', { status: err.status || 502 })
  }
}

function parseRange (header, size) {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid'
  let start, end
  if (m[1] === '') { // suffixe : les N derniers octets
    start = Math.max(0, size - Number(m[2]))
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  }
  if (start >= size || start > end) return 'invalid'
  return { start, end }
}

const urlCache = new Map()
let apiSeq = Math.floor(Math.random() * 1e9)

async function getDownloadUrl (root, node, fresh = false) {
  const cacheKey = `${root}/${node}`
  const hit = urlCache.get(cacheKey)
  if (!fresh && hit && Date.now() - hit.time < URL_TTL) return hit.url

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API_URL}?id=${apiSeq++}&n=${encodeURIComponent(root)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ a: 'g', g: 1, ssl: 2, n: node }])
    })
    const json = await res.json()
    const result = Array.isArray(json) ? json[0] : json
    if (typeof result === 'number') {
      // -3 = serveur occupé : on réessaie avec un délai croissant
      if (result === -3 && attempt < 5) { await sleep(500 * 2 ** attempt); continue }
      throw apiError(result)
    }
    if (!result || typeof result.g !== 'string' || !result.g.startsWith('http')) {
      if (result && result.efq) throw quotaError(null)
      throw new Error('Réponse MEGA inattendue (limite atteinte ?)')
    }
    urlCache.set(cacheKey, { url: result.g, time: Date.now() })
    return result.g
  }
}

async function fetchEncrypted (root, node, from, to) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const g = await getDownloadUrl(root, node, attempt > 0)
    const res = await fetch(`${g}/${from}-${to}`)
    if (res.ok) return res
    if (res.status === 509) throw quotaError(res.headers.get('x-mega-time-left'))
    // URL expirée : on en redemande une
  }
  throw new Error('Impossible de récupérer la vidéo chez MEGA')
}

// Déchiffre le flux. `offset` est la position (multiple de 16) du premier octet reçu,
// `skip` le nombre d'octets à ignorer au début pour retomber sur la position demandée.
function decryptStream (response, key, offset, skip) {
  const reader = response.body.getReader()
  const aesKey = new Uint8Array(16)
  for (let i = 0; i < 16; i++) aesKey[i] = key[i] ^ key[16 + i]
  const nonce = key.slice(16, 24)
  const cryptoKey = crypto.subtle.importKey('raw', aesKey, 'AES-CTR', false, ['decrypt'])
  let pending = new Uint8Array(0)
  let position = offset

  async function decrypt (data) {
    const counter = new Uint8Array(16)
    counter.set(nonce, 0)
    new DataView(counter.buffer).setBigUint64(8, BigInt(position / 16))
    const plain = new Uint8Array(await crypto.subtle.decrypt(
      { name: 'AES-CTR', counter, length: 64 }, await cryptoKey, data))
    position += data.length
    if (skip > 0) {
      const cut = Math.min(skip, plain.length)
      skip -= cut
      return plain.subarray(cut)
    }
    return plain
  }

  return new ReadableStream({
    async pull (controller) {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) {
          if (pending.length) {
            const out = await decrypt(pending)
            pending = new Uint8Array(0)
            if (out.length) controller.enqueue(out)
          }
          controller.close()
          return
        }
        const buf = new Uint8Array(pending.length + value.length)
        buf.set(pending, 0)
        buf.set(value, pending.length)
        const usable = buf.length - (buf.length % 16)
        pending = buf.slice(usable)
        if (usable === 0) continue
        const out = await decrypt(buf.subarray(0, usable))
        if (out.length) { controller.enqueue(out); return }
      }
    },
    cancel (reason) { return reader.cancel(reason) }
  })
}

// ---------- Utilitaires ----------

const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/mp4', webm: 'video/webm',
  mkv: 'video/x-matroska', ogv: 'video/ogg', avi: 'video/x-msvideo', '3gp': 'video/3gpp',
  ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', wmv: 'video/x-ms-wmv'
}
function mimeFor (name) {
  const ext = name.split('.').pop().toLowerCase()
  return MIME[ext] || 'application/octet-stream'
}

function b64urlDecode (s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4) s += '='
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function sleep (ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function quotaError (secondsLeft) {
  const s = Number(secondsLeft)
  const wait = Number.isFinite(s) && s > 0 ? ` Réessaie dans ${Math.ceil(s / 60)} min.` : ''
  const err = new Error(`Quota de transfert MEGA atteint.${wait}`)
  err.status = 509
  err.quota = true
  return err
}

function apiError (code) {
  const messages = {
    '-2': 'Requête refusée par MEGA',
    '-9': 'Fichier introuvable (lien supprimé ?)',
    '-11': 'Accès refusé',
    '-16': 'Fichier bloqué par MEGA',
    '-17': 'Quota de transfert MEGA atteint',
    '-18': 'MEGA est temporairement indisponible'
  }
  const err = new Error(messages[code] || `Erreur MEGA ${code}`)
  if (code === -17) { err.status = 509; err.quota = true }
  return err
}

async function notifyClients (err) {
  const clients = await self.clients.matchAll({ type: 'window' })
  for (const client of clients) {
    client.postMessage({ type: 'stream-error', message: err.message, quota: !!err.quota })
  }
}
