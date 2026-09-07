'use strict'

const path = require('path')

let _native = null
let _errorMessage = ''

const _candidates = [
  process.env.ZENITH_SECURE_NODE_PATH ? path.resolve(process.env.ZENITH_SECURE_NODE_PATH) : '',
  path.join(__dirname, 'build', 'Release', 'zenith_secure.node')
].filter(Boolean)

if (process.resourcesPath) {
  _candidates.push(
    path.join(process.resourcesPath, 'app.asar.unpacked', 'native', 'secure-auth', 'build', 'Release', 'zenith_secure.node'),
    path.join(process.resourcesPath, 'native', 'secure-auth', 'build', 'Release', 'zenith_secure.node')
  )
}

for (const candidate of _candidates) {
  try {
    _native = require(candidate)
    if (_native) break
  } catch (err) {
    if (!_errorMessage) {
      _errorMessage = String(err?.message || err || 'native secure load failed')
    }
  }
}

function _safeCall(fnName, args, fallback) {
  try {
    if (_native && typeof _native[fnName] === 'function') {
      const out = _native[fnName](...args)
      if (out !== undefined && out !== null) return out
    }
  } catch (_) {}
  return fallback
}

module.exports = {
  available: Boolean(_native),
  errorMessage: _errorMessage,
  sha256Hex: (input) => _safeCall('sha256Hex', [String(input || '')], ''),
  hmacSha256Hex: (key, input) => _safeCall('hmacSha256Hex', [String(key || ''), String(input || '')], ''),
  getHardwareId: () => _safeCall('getHardwareId', [], ''),
  deriveDeviceKey: (seed) => _safeCall('deriveDeviceKey', [String(seed || '')], ''),
  isValidKeyFormat: (key) => Boolean(_safeCall('isValidKeyFormat', [String(key || '')], false)),
  normalizeLicenseKey: (key) => _safeCall('normalizeLicenseKey', [String(key || '')], ''),
  timingSafeEqual: (left, right) => Boolean(_safeCall('timingSafeEqual', [String(left || ''), String(right || '')], false)),
  randomHex: (bytes = 48) => {
    const n = Number(bytes)
    const safe = Number.isFinite(n) ? Math.max(1, Math.min(256, Math.trunc(n))) : 48
    return _safeCall('randomHex', [safe], '')
  },
  generateLicenseKey: () => _safeCall('generateLicenseKey', [], ''),
}
