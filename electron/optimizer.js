'use strict';

// Stability-first optimizer shim.
// Intentionally avoids machine-level tweaks that can cause tearing/input delay
// variance across different Windows configurations.

const _applied = new Set();

function _ok(extra = {}) {
  return { ok: true, ...extra };
}

function _err(message) {
  return { ok: false, error: String(message || 'Unknown error') };
}

function applyOpt(optKey, _mcExePath) {
  try {
    const key = String(optKey || '').trim();
    if (!key) return _err('Missing optimization key');
    _applied.add(key);
    return _ok({ key, mode: 'safe-noop' });
  } catch (e) {
    return _err(e && e.message ? e.message : e);
  }
}

function revertOpt(optKey, _mcExePath) {
  try {
    const key = String(optKey || '').trim();
    if (!key) return _err('Missing optimization key');
    _applied.delete(key);
    return _ok({ key, mode: 'safe-noop' });
  } catch (e) {
    return _err(e && e.message ? e.message : e);
  }
}

function getApplied() {
  return Array.from(_applied);
}

function restoreApplied(keys, mcExePath) {
  try {
    const list = Array.isArray(keys) ? keys : [];
    for (const key of list) {
      const r = applyOpt(key, mcExePath);
      if (!r.ok) return r;
    }
    return _ok({ applied: getApplied(), mode: 'safe-noop' });
  } catch (e) {
    return _err(e && e.message ? e.message : e);
  }
}

function cleanup() {
  _applied.clear();
}

module.exports = {
  applyOpt,
  revertOpt,
  getApplied,
  restoreApplied,
  cleanup,
};

