'use strict'

const Store = require('electron-store')
const crypto = require('crypto')
const os = require('os')
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const store = new Store({ name: 'pervent-license' })
const config = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'license-config.json'), 'utf8')) } catch (_) { return {} }
})()
const API_BASE = String(process.env.PERVENT_LICENSE_URL || config.apiBase || '').replace(/\/$/, '')

function getClientVersion() {
  try { return app?.getVersion?.() || require('../package.json').version || '0.0.0' } catch { return '0.0.0' }
}

function getHardwareId() {
  try {
    const { machineIdSync } = require('node-machine-id')
    const raw = machineIdSync({ original: true })
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32)
  } catch {
    return crypto.createHash('sha256').update(os.hostname()).digest('hex').slice(0, 32)
  }
}

function normalizeUserKeyInput(key) {
  return String(key || '').trim().toUpperCase().replace(/[\u2010-\u2015]/g, '-').replace(/[^A-Z0-9-]/g, '')
}

async function api(pathname, options = {}) {
  if (!API_BASE) throw new Error('License API is not configured')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), Number(options.timeout || 8000))
  try {
    const res = await fetch(`${API_BASE}${pathname}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      signal: controller.signal
    })
    const text = await res.text()
    let data = {}
    try { data = text ? JSON.parse(text) : {} } catch (_) { data = { message: text } }
    if (!res.ok) {
      const err = new Error(data.message || data.reason || `License server returned ${res.status}`)
      err.status = res.status
      err.code = data.code
      throw err
    }
    return data
  } finally { clearTimeout(timer) }
}

async function activateKey(key) {
  const clean = normalizeUserKeyInput(key)
  if (!clean) return { valid: false, reason: 'INVALID_LICENSE_KEY', message: 'Enter a license key.' }
  try {
    const data = await api('/v1/activate', {
      method: 'POST',
      body: JSON.stringify({ key: clean, hwid: getHardwareId(), clientVersion: getClientVersion() })
    })
    if (data.valid) store.set('license', data)
    return data
  } catch (err) {
    return { valid: false, reason: err.code || 'LICENSE_SERVER_ERROR', message: err.message }
  }
}

async function validateLicense() {
  const saved = store.get('license')
  if (!saved?.sessionToken) return { valid: false, reason: 'NO_SESSION' }
  try {
    const data = await api('/v1/session', {
      method: 'POST',
      body: JSON.stringify({ sessionToken: saved.sessionToken, hwid: getHardwareId(), clientVersion: getClientVersion() })
    })
    if (data.valid) store.set('license', { ...saved, ...data, lastValidated: Date.now() })
    else store.delete('license')
    return data
  } catch (err) {
    return { valid: false, reason: err.code || 'LICENSE_SERVER_ERROR', message: err.message }
  }
}

function getStoredLicense() { return store.get('license', null) }
function updateStoredLicense(partial) {
  const updated = { ...(store.get('license', {}) || {}), ...(partial || {}) }
  store.set('license', updated)
  return updated
}
function clearLicense() { store.delete('license') }

async function requestHwidReset(reason) {
  const saved = store.get('license')
  if (!saved?.sessionToken) return { ok: false, reason: 'NO_SESSION' }
  try {
    return await api('/v1/hwid-reset', {
      method: 'POST',
      body: JSON.stringify({ sessionToken: saved.sessionToken, hwid: getHardwareId(), reason: String(reason || '').trim() })
    })
  } catch (err) { return { ok: false, reason: err.code || 'REQUEST_FAILED', message: err.message } }
}

function buildSignedPayload(route, payload) {
  return { ...(payload || {}), route, clientVersion: getClientVersion() }
}

module.exports = { activateKey, validateLicense, getStoredLicense, updateStoredLicense, clearLicense, getHardwareId, requestHwidReset, buildSignedPayload }
