'use strict'

const { safeStorage } = require('electron')
const crypto = require('crypto')
const os = require('os')
const Store = require('electron-store')
const { machineIdSync } = require('node-machine-id')
const nativeSecure = require('./native-secure')

const LEGACY_STORE_NAME = 'zenith-data'
const SECURE_STORE_NAME = 'zenith-data-v2'
const SETTINGS_SEED = 'zenith-settings-key-v2'
const MIGRATION_MARKER = '__migrated_to_v2'

function _sha256Hex(input) {
  const txt = String(input || '')
  if (nativeSecure.available) {
    try {
      const out = String(nativeSecure.sha256Hex(txt) || '').toLowerCase()
      if (/^[a-f0-9]{64}$/.test(out)) return out
    } catch (_) {}
  }
  return crypto.createHash('sha256').update(txt, 'utf8').digest('hex')
}

function _deriveSettingsKey() {
  if (nativeSecure.available) {
    try {
      const out = String(nativeSecure.deriveDeviceKey(SETTINGS_SEED) || '').toLowerCase()
      if (/^[a-f0-9]{32}$/.test(out)) return out
    } catch (_) {}
  }
  try {
    return _sha256Hex(`${machineIdSync({ original: true })}:${SETTINGS_SEED}`).slice(0, 32)
  } catch (_) {
    return _sha256Hex(`${os.hostname()}:${SETTINGS_SEED}`).slice(0, 32)
  }
}

const _legacyStore = new Store({ name: LEGACY_STORE_NAME })
const _store = new Store({ name: SECURE_STORE_NAME, encryptionKey: _deriveSettingsKey() })

function _migrateLegacyStore() {
  try {
    if (_store.get(MIGRATION_MARKER)) return
    const existing = _store.store || {}
    if (Object.keys(existing).length > 0) {
      _store.set(MIGRATION_MARKER, true)
      return
    }
    const legacy = _legacyStore.store || {}
    if (Object.keys(legacy).length > 0) {
      _store.store = { ...legacy, [MIGRATION_MARKER]: true }
    } else {
      _store.set(MIGRATION_MARKER, true)
    }
  } catch (_) {}
}

_migrateLegacyStore()
const QS_ENC_PREFIX = 'enc:v1:'

function _canEncryptSettings() {
  try {
    return safeStorage && safeStorage.isEncryptionAvailable()
  } catch (_) {
    return false
  }
}

function _encryptText(raw) {
  const txt = String(raw || '')
  if (!txt || !_canEncryptSettings()) return ''
  try {
    const enc = safeStorage.encryptString(txt).toString('base64')
    return enc ? `${QS_ENC_PREFIX}${enc}` : ''
  } catch (_) {
    return ''
  }
}

function _decryptText(raw) {
  const txt = String(raw || '')
  if (!txt.startsWith(QS_ENC_PREFIX) || !_canEncryptSettings()) return ''
  try {
    const payload = txt.slice(QS_ENC_PREFIX.length)
    return safeStorage.decryptString(Buffer.from(payload, 'base64')) || ''
  } catch (_) {
    return ''
  }
}

function _decodeQueueSniper(queue) {
  if (!queue || typeof queue !== 'object') return queue

  const out = { ...queue }
  const targets = Array.isArray(queue.targets) ? queue.targets : []
  out.targets = targets.map((target) => {
    const plainUrl = String(target?.url || '').trim()
    const decryptedUrl = _decryptText(target?.urlEnc)
    const next = {
      ...target,
      url: decryptedUrl || plainUrl
    }
    delete next.urlEnc
    return next
  })
  return out
}

function _encodeQueueSniper(queue) {
  if (!queue || typeof queue !== 'object') return queue

  const out = { ...queue }
  const targets = Array.isArray(queue.targets) ? queue.targets : []
  const canEncrypt = _canEncryptSettings()

  out.targets = targets.map((target) => {
    const normalizedUrl = String(target?.url || '').trim()
    const next = { ...target, url: normalizedUrl }
    if (!normalizedUrl || !canEncrypt) {
      delete next.urlEnc
      return next
    }

    const encryptedUrl = _encryptText(normalizedUrl)
    if (!encryptedUrl) {
      delete next.urlEnc
      return next
    }

    next.url = ''
    next.urlEnc = encryptedUrl
    return next
  })
  return out
}

function _decodeAppSettings(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const out = { ...source }
  if (out.queueSniper) out.queueSniper = _decodeQueueSniper(out.queueSniper)
  return out
}

function _encodeAppSettings(next) {
  const source = next && typeof next === 'object' ? next : {}
  const out = { ...source }
  if (out.queueSniper) out.queueSniper = _encodeQueueSniper(out.queueSniper)
  return out
}

function getMacroConfig() {
  return _store.get('macroConfig') || null
}

function saveMacroConfig(config) {
  _store.set('macroConfig', config)
}

function getSettings() {
  const raw = _store.get('appSettings') || {}
  return _decodeAppSettings(raw)
}

function saveSettings(partial) {
  const patch = partial || {}
  const currentRaw = _store.get('appSettings') || {}
  const currentDecoded = _decodeAppSettings(currentRaw)
  const merged = { ...currentDecoded, ...patch }
  const encoded = _encodeAppSettings(merged)

  // Preserve existing encrypted queue-sniper payload unless this call
  // explicitly updates queueSniper settings.
  if (!Object.prototype.hasOwnProperty.call(patch, 'queueSniper') && currentRaw?.queueSniper) {
    encoded.queueSniper = currentRaw.queueSniper
  }

  _store.set('appSettings', encoded)
}

function getSecurityInfo() {
  const raw = _store.get('appSettings') || {}
  const queueTargets = Array.isArray(raw?.queueSniper?.targets) ? raw.queueSniper.targets : []
  let encryptedTargets = 0
  let plaintextTargets = 0

  for (const target of queueTargets) {
    const hasEncrypted = String(target?.urlEnc || '').startsWith(QS_ENC_PREFIX)
    const hasPlain = String(target?.url || '').trim().length > 0
    if (hasEncrypted) encryptedTargets += 1
    if (hasPlain) plaintextTargets += 1
  }

  return {
    safeStorageAvailable: _canEncryptSettings(),
    queueSniper: {
      totalTargets: queueTargets.length,
      encryptedTargets,
      plaintextTargets
    }
  }
}

function _defaultProfile() {
  return {
    id: 'default',
    name: 'Default',
    config: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  }
}

function getProfiles() {
  const saved = _store.get('profiles')
  if (!saved || saved.length === 0) {
    const dflt = [_defaultProfile()]
    _store.set('profiles', dflt)
    return dflt
  }

  if (!saved.find((p) => p.id === 'default')) {
    saved.unshift(_defaultProfile())
    _store.set('profiles', saved)
  }
  return saved
}

function saveProfile(id, name, config) {
  const profiles = getProfiles()
  const idx = profiles.findIndex((p) => p.id === id)
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], name, config, updatedAt: Date.now() }
  } else {
    profiles.push({ id, name, config, createdAt: Date.now(), updatedAt: Date.now() })
  }
  _store.set('profiles', profiles)
}

function renameProfile(id, name) {
  if (!name || !name.trim()) return
  const profiles = getProfiles()
  const idx = profiles.findIndex((p) => p.id === id)
  if (idx >= 0) {
    profiles[idx] = { ...profiles[idx], name: name.trim(), updatedAt: Date.now() }
    _store.set('profiles', profiles)
  }
}

function deleteProfile(id) {
  if (id === 'default') return
  const profiles = getProfiles().filter((p) => p.id !== id)
  _store.set('profiles', profiles)
  if (getActiveProfile() === id) {
    _store.set('activeProfile', 'default')
  }
}

function getActiveProfile() {
  return _store.get('activeProfile') || 'default'
}

function setActiveProfile(id) {
  _store.set('activeProfile', id)
}

module.exports = {
  getMacroConfig,
  saveMacroConfig,
  getSettings,
  saveSettings,
  getSecurityInfo,
  getProfiles,
  saveProfile,
  renameProfile,
  deleteProfile,
  getActiveProfile,
  setActiveProfile
}
