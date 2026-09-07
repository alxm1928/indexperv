'use strict'

const http = require('http')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const HOST = process.env.PERVENT_HOST || '0.0.0.0'
const PORT = Number(process.env.PERVENT_PORT || 38473)
const ADMIN_SECRET = String(process.env.PERVENT_ADMIN_SECRET || 'CHANGE_ME_NOW')
const DATA_DIR = path.join(__dirname, 'license-data')
const DB_FILE = path.join(DATA_DIR, 'database.json')

fs.mkdirSync(DATA_DIR, { recursive: true })
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ keys: {}, sessions: {}, resetRequests: {}, events: [] }, null, 2))

function db() { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) }
function save(x) { fs.writeFileSync(DB_FILE, JSON.stringify(x, null, 2)) }
function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''; req.on('data', c => { raw += c; if (raw.length > 1e6) req.destroy() })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch (e) { reject(e) } })
    req.on('error', reject)
  })
}
function hash(v) { return crypto.createHash('sha256').update(String(v)).digest('hex') }
function token() { return crypto.randomBytes(32).toString('hex') }
function key() {
  const group = () => crypto.randomBytes(2).toString('hex').toUpperCase().padStart(4, '0')
  return `PRVT-${group()}-${group()}-${group()}`
}
function expiry(duration) {
  const d = String(duration || '30d').toLowerCase()
  if (d === 'lifetime') return null
  const m = d.match(/^(\d+)\s*(m|h|d|w|mo|y)$/)
  if (!m) throw new Error('Duration must look like 30d, 12h, 7d, 1mo, 1y, or lifetime')
  const n = Number(m[1]); const u = m[2]
  const ms = u === 'm' ? 60000 : u === 'h' ? 3600000 : u === 'd' ? 86400000 : u === 'w' ? 604800000 : u === 'mo' ? 2592000000 : 31536000000
  return new Date(Date.now() + n * ms).toISOString()
}
function keyRecord(k) { return db().keys[k] }
function validRecord(r) { return r && !r.revoked && !r.banned && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()) }
function admin(req) { return String(req.headers['x-admin-secret'] || '') === ADMIN_SECRET }
function logEvent(d, type, detail) { d.events.unshift({ id: token().slice(0, 12), type, detail, at: new Date().toISOString() }); d.events = d.events.slice(0, 500) }

async function handler(req, res) {
  if (req.method === 'OPTIONS') return json(res, 204, {})
  try {
    if (req.method === 'GET' && req.url === '/health') return json(res, 200, { ok: true, service: 'Pervent License API', time: new Date().toISOString() })
    if (req.method === 'POST' && req.url === '/v1/activate') {
      const b = await readBody(req); const k = String(b.key || '').trim().toUpperCase(); const hwid = String(b.hwid || '').trim()
      const d = db(); const r = d.keys[k]
      if (!validRecord(r)) return json(res, 403, { valid: false, reason: r?.banned ? 'LICENSE_BANNED' : r?.revoked ? 'LICENSE_REVOKED' : r ? 'LICENSE_EXPIRED' : 'KEY_NOT_FOUND' })
      const h = hash(hwid)
      if (r.hwidHash && r.hwidHash !== h) return json(res, 403, { valid: false, reason: 'HWID_MISMATCH' })
      if (!r.hwidHash) { r.hwidHash = h; r.activatedAt = new Date().toISOString() }
      const sessionToken = token(); d.sessions[sessionToken] = { key: k, hwidHash: h, createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString() }
      r.lastSeenAt = new Date().toISOString(); logEvent(d, 'activate', { key: k }); save(d)
      return json(res, 200, { valid: true, tier: r.tier, key: k, expiresAt: r.expiresAt, sessionToken, hwid: h.slice(0, 12) + '…' })
    }
    if (req.method === 'POST' && req.url === '/v1/session') {
      const b = await readBody(req); const d = db(); const s = d.sessions[String(b.sessionToken || '')]
      const r = s && d.keys[s.key]
      if (!s || !validRecord(r)) return json(res, 403, { valid: false, reason: r?.banned ? 'LICENSE_BANNED' : r?.revoked ? 'LICENSE_REVOKED' : 'INVALID_SESSION' })
      const h = hash(b.hwid || '')
      if (h !== s.hwidHash || (r.hwidHash && h !== r.hwidHash)) return json(res, 403, { valid: false, reason: 'HWID_MISMATCH' })
      s.lastSeenAt = new Date().toISOString(); r.lastSeenAt = s.lastSeenAt; save(d)
      return json(res, 200, { valid: true, tier: r.tier, key: s.key, expiresAt: r.expiresAt, hwid: h.slice(0, 12) + '…' })
    }
    if (req.method === 'POST' && req.url === '/v1/hwid-reset') {
      const b = await readBody(req); const d = db(); const s = d.sessions[String(b.sessionToken || '')]; const r = s && d.keys[s.key]
      if (!s || !validRecord(r)) return json(res, 403, { ok: false, reason: 'INVALID_SESSION' })
      const reason = String(b.reason || '').trim(); if (reason.length < 5) return json(res, 400, { ok: false, reason: 'REASON_REQUIRED' })
      const id = `RST-${crypto.randomBytes(4).toString('hex').toUpperCase()}`
      d.resetRequests[id] = { id, key: s.key, oldHwidHash: s.hwidHash, reason, status: 'pending', createdAt: new Date().toISOString() }
      logEvent(d, 'hwid_reset_requested', { id, key: s.key }); save(d)
      return json(res, 200, { ok: true, requestId: id, status: 'pending' })
    }
    if (req.method === 'POST' && req.url === '/admin/key/create') {
      if (!admin(req)) return json(res, 401, { message: 'Unauthorized' }); const b = await readBody(req); const d = db(); let k = key(); while (d.keys[k]) k = key()
      d.keys[k] = { key: k, tier: String(b.tier || 'pervent'), expiresAt: expiry(b.duration || '30d'), hwidHash: null, revoked: false, banned: false, createdAt: new Date().toISOString() }; logEvent(d, 'key_created', { key: k, duration: b.duration }); save(d); return json(res, 200, d.keys[k])
    }
    if (req.method === 'POST' && req.url === '/admin/key/action') {
      if (!admin(req)) return json(res, 401, { message: 'Unauthorized' }); const b = await readBody(req); const d = db(); const r = d.keys[String(b.key || '').toUpperCase()]; if (!r) return json(res, 404, { message: 'Key not found' })
      const action = String(b.action || ''); if (action === 'revoke') r.revoked = true; else if (action === 'unrevoke') r.revoked = false; else if (action === 'ban') r.banned = true; else if (action === 'unban') r.banned = false; else if (action === 'reset-hwid') r.hwidHash = null; else return json(res, 400, { message: 'Unknown action' })
      logEvent(d, `key_${action}`, { key: r.key }); save(d); return json(res, 200, { ok: true, key: r })
    }
    if (req.method === 'GET' && req.url === '/admin/licenses') {
      if (!admin(req)) return json(res, 401, { message: 'Unauthorized' }); const d = db(); return json(res, 200, { keys: Object.values(d.keys), resetRequests: Object.values(d.resetRequests).sort((a,b) => b.createdAt.localeCompare(a.createdAt)), events: d.events.slice(0, 100) })
    }
    if (req.method === 'POST' && req.url === '/admin/hwid-reset') {
      if (!admin(req)) return json(res, 401, { message: 'Unauthorized' }); const b = await readBody(req); const d = db(); const q = d.resetRequests[String(b.id || '')]; if (!q) return json(res, 404, { message: 'Request not found' })
      if (String(b.action) === 'approve') { const r = d.keys[q.key]; if (!r) return json(res, 404, { message: 'Key not found' }); r.hwidHash = null; q.status = 'approved'; q.resolvedAt = new Date().toISOString() } else if (String(b.action) === 'reject') { q.status = 'rejected'; q.rejectionReason = String(b.reason || 'Rejected by administrator'); q.resolvedAt = new Date().toISOString() } else return json(res, 400, { message: 'Unknown action' })
      logEvent(d, `hwid_reset_${q.status}`, { id: q.id, key: q.key }); save(d); return json(res, 200, q)
    }
    return json(res, 404, { message: 'Not found' })
  } catch (e) { return json(res, 500, { message: e.message || 'Server error' }) }
}

http.createServer(handler).listen(PORT, HOST, () => console.log(`Pervent License API listening on ${HOST}:${PORT}`))
