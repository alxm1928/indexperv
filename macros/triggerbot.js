const { Hardware } = require('../electron/keysender-safe')
const { screen } = require('electron')
const focusLock = require('../electron/focus-lock')
const { getClickBinds, resolveMouseButton } = require('./click-binds')

let _hwInstance = null
const _hw = new Proxy({}, {
  get(_target, prop) {
    if (!_hwInstance) _hwInstance = new Hardware()
    const value = _hwInstance[prop]
    return typeof value === 'function' ? value.bind(_hwInstance) : value
  }
})

const CLICK_HOLD_MS = 15
let _hitCooldownMs = 600
const SEQUENCE_TIMEOUT = 3000
const CRIT_WAIT_MS = 60
const DEFAULT_POLL_MS = 42
const IDLE_POLL_EXTRA_MS = 22
const MAX_POLL_MS = 100
const MIN_POLL_MS = 26
const CENTER_REFRESH_MS = 2500
const UNFOCUSED_POLL_MS = 90
const IDLE_SAMPLE_EVERY = 1
const ACTIVE_SAMPLE_EVERY = 1
const CENTER_FALLBACK = { cx: 960, cy: 540 }

function isRed(r, g, b) {
  if (r < 165) return false
  const maxOther = Math.max(g, b)
  if (r - maxOther < 45) return false
  if (r - Math.min(r, g, b) < 55) return false
  return r >= g * 1.28 && r >= b * 1.28
}

function isBlue(r, g, b) {
  if (b < 150) return false
  const maxOther = Math.max(r, g)
  if (b - maxOther < 38) return false
  if (b - Math.min(r, g, b) < 50) return false
  return b >= r * 1.24 && b >= g * 1.12
}

function classifyPoint(x, y) {
  const [r, g, b] = _hw.workwindow.colorAt(x, y, 'array')
  return {
    red: isRed(r, g, b),
    blue: isBlue(r, g, b),
  }
}

function toPoint(x, y) {
  return {
    cx: Math.floor(Number(x) || 0),
    cy: Math.floor(Number(y) || 0),
  }
}

function getFocusedCenterPoint() {
  try {
    const view = typeof focusLock.getFocusedGameView === 'function'
      ? focusLock.getFocusedGameView()
      : null
    if (!view) return null
    const cx = Number(view.x) + Number(view.width) / 2
    const cy = Number(view.y) + Number(view.height) / 2
    if (Number.isFinite(cx) && Number.isFinite(cy)) {
      return toPoint(cx, cy)
    }
  } catch (_) {}
  return null
}

function getDisplayCenterPoint() {
  try {
    const cursor = screen.getCursorScreenPoint()
    const d = screen.getDisplayNearestPoint(cursor) || screen.getPrimaryDisplay()
    if (!d) return null
    const bounds = d.bounds || { x: 0, y: 0, width: d.size.width, height: d.size.height }
    const dipX = Number(bounds.x) + Number(bounds.width) / 2
    const dipY = Number(bounds.y) + Number(bounds.height) / 2
    if (Number.isFinite(dipX) && Number.isFinite(dipY)) {
      if (typeof screen.dipToScreenPoint === 'function') {
        const p = screen.dipToScreenPoint({ x: dipX, y: dipY })
        if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
          return toPoint(p.x, p.y)
        }
      }
      const sf = Number(d.scaleFactor) || 1
      return toPoint(dipX * sf, dipY * sf)
    }
  } catch (_) {}
  return null
}

function resolveCenterPoint() {
  const focused = getFocusedCenterPoint()
  if (focused) return focused
  const display = getDisplayCenterPoint()
  if (display) return display
  return { ...CENTER_FALLBACK }
}

function sampleCrosshairSignal(cx, cy) {
  // Primary gate: center pixel itself.
  const center = classifyPoint(cx, cy)
  if (center.red || center.blue) {
    return {
      inRange: true,
      blue: center.blue,
    }
  }

  // Fallback gate: plus-shape around center.
  // This catches anti-aliased/offset center pixels while rejecting broad
  // world colors that are not crosshair-like.
  const up = classifyPoint(cx, cy - 1)
  const down = classifyPoint(cx, cy + 1)
  const left = classifyPoint(cx - 1, cy)
  const right = classifyPoint(cx + 1, cy)

  let red = Number(up.red) + Number(down.red) + Number(left.red) + Number(right.red) >= 2
  let blue = Number(up.blue) + Number(down.blue) + Number(left.blue) + Number(right.blue) >= 2

  if (red || blue) {
    const d1 = classifyPoint(cx - 1, cy - 1)
    const d2 = classifyPoint(cx + 1, cy - 1)
    const d3 = classifyPoint(cx - 1, cy + 1)
    const d4 = classifyPoint(cx + 1, cy + 1)

    const redDiag = Number(d1.red) + Number(d2.red) + Number(d3.red) + Number(d4.red)
    const blueDiag = Number(d1.blue) + Number(d2.blue) + Number(d3.blue) + Number(d4.blue)

    if (red && redDiag >= 3) red = false
    if (blue && blueDiag >= 3) blue = false
  }

  return {
    inRange: red || blue,
    blue,
  }
}

let _tbActive = false
let _tbTimer = null
let _pollInFlight = false
let _state = 'idle'
let _lastHitMs = 0
let _lastSignalMs = 0
let _clicking = false
let _statusCb = null
let _center = null
let _focusLocked = true
let _lastCenterRefreshMs = 0

let _mode = 'normal'
let _sTapMs = 150
let _pollMs = DEFAULT_POLL_MS
let _sampleCounter = 0

let _waitingForCrit = false
let _critWaitStart = 0

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function doClick() {
  if (_clicking) return
  _clicking = true
  try {
    const { left } = getClickBinds()
    const bind = left || 'Mouse1'
    const mouseBtn = resolveMouseButton(bind)
    if (mouseBtn) {
      await _hw.mouse.toggle(mouseBtn, true)
      await sleep(CLICK_HOLD_MS)
      await _hw.mouse.toggle(mouseBtn, false)
    } else {
      await _hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0)
    }
    if (_mode === 's-tap') {
      await sleep(10)
      await _hw.keyboard.sendKey('s', _sTapMs, 0)
    }
  } catch (_) {
  } finally {
    _clicking = false
  }
}

function refreshCenter(force = false) {
  const now = Date.now()
  if (!force && _center && now - _lastCenterRefreshMs < CENTER_REFRESH_MS) return
  _center = resolveCenterPoint()
  _lastCenterRefreshMs = now
}

function poll() {
  if (!_tbActive) return
  if (_focusLocked && !focusLock.isMcFocused()) return
  if (_clicking) return

  const sampleEvery = _state === 'idle' ? IDLE_SAMPLE_EVERY : ACTIVE_SAMPLE_EVERY
  _sampleCounter = (_sampleCounter + 1) % sampleEvery
  if (_sampleCounter !== 0) return

  const now = Date.now()
  refreshCenter(false)
  if (!_center) return

  let signal
  try {
    signal = sampleCrosshairSignal(_center.cx, _center.cy)
  } catch (_) {
    return
  }

  const inRange = !!signal.inRange
  const blue = !!signal.blue
  const cooldownReady = now - _lastHitMs >= _hitCooldownMs

  if (_state === 'idle') {
    if (!inRange || _clicking) return
    _lastSignalMs = now
    _state = 'sequence'

    if (_mode === 'smart-crit' && !blue) {
      _waitingForCrit = true
      _critWaitStart = now
      return
    }

    doClick()
    _lastHitMs = now
    return
  }

  if (inRange) _lastSignalMs = now

  if (now - _lastSignalMs >= SEQUENCE_TIMEOUT) {
    _state = 'idle'
    _waitingForCrit = false
    return
  }

  if (!cooldownReady || _clicking) return

  if (_mode === 'smart-crit') {
    if (!_waitingForCrit && inRange) {
      _waitingForCrit = true
      _critWaitStart = now
    }
    if (_waitingForCrit) {
      if (blue) {
        doClick()
        _lastHitMs = now
        _waitingForCrit = false
      } else if (now - _critWaitStart >= CRIT_WAIT_MS) {
        if (inRange) {
          doClick()
          _lastHitMs = now
        }
        _waitingForCrit = false
      }
    }
  } else if (inRange) {
    doClick()
    _lastHitMs = now
  }
}

function setTBConfig(cfg) {
  if (!cfg) return
  if (cfg.tbMode) {
    _mode = ['normal', 'smart-crit', 's-tap'].includes(cfg.tbMode)
      ? cfg.tbMode
      : 'normal'
  }
  if (cfg.sTapMs != null) _sTapMs = Math.max(10, Number(cfg.sTapMs) || 150)
  if (cfg.hitCooldownMs != null) _hitCooldownMs = Math.max(0, Number(cfg.hitCooldownMs) || 600)
  if (cfg.tbPollMs != null) {
    _pollMs = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, Number(cfg.tbPollMs) || DEFAULT_POLL_MS))
  }
}

function setStatusCallback(fn) {
  _statusCb = fn
}

function setFocusLocked(val) {
  _focusLocked = val
}

function loopTick() {
  if (!_tbActive) return
  if (_pollInFlight) {
    _tbTimer = setTimeout(loopTick, Math.max(MIN_POLL_MS, _pollMs))
    return
  }
  const tickStarted = Date.now()
  _pollInFlight = true
  try {
    poll()
  } finally {
    _pollInFlight = false
    if (_tbActive) {
      const tickCost = Date.now() - tickStarted
      const adaptiveBackoff = tickCost > 8 ? Math.min(20, tickCost) : 0
      const notFocused = _focusLocked && !focusLock.isMcFocused()
      const hasRecentSignal = _state !== 'idle' || _waitingForCrit
      const baseDelay = notFocused
        ? UNFOCUSED_POLL_MS
        : (hasRecentSignal ? _pollMs : Math.min(MAX_POLL_MS, _pollMs + IDLE_POLL_EXTRA_MS))
      const nextDelay = Math.max(MIN_POLL_MS, Math.min(MAX_POLL_MS, baseDelay + adaptiveBackoff))
      _tbTimer = setTimeout(loopTick, Math.max(MIN_POLL_MS, nextDelay))
    }
  }
}

function startTB(cfg) {
  if (_tbActive) return
  setTBConfig(cfg)
  _center = null
  _lastCenterRefreshMs = 0
  refreshCenter(true)
  _tbActive = true
  _state = 'idle'
  _clicking = false
  _lastHitMs = 0
  _lastSignalMs = 0
  _waitingForCrit = false
  _sampleCounter = 0
  _pollInFlight = false
  _tbTimer = setTimeout(loopTick, _pollMs)
  console.log('[triggerbot] started mode=%s poll=%dms center (%d, %d)', _mode, _pollMs, _center.cx, _center.cy)
  _statusCb?.(true)
}

function stopTB() {
  if (!_tbActive) return
  _tbActive = false
  clearTimeout(_tbTimer)
  _tbTimer = null
  _pollInFlight = false
  _state = 'idle'
  _clicking = false
  _waitingForCrit = false
  console.log('[triggerbot] stopped')
  _statusCb?.(false)
}

function toggleTB(cfg) {
  if (_tbActive) stopTB()
  else startTB(cfg)
}

function isTBActive() {
  return _tbActive
}

module.exports = { toggleTB, stopTB, setTBConfig, setStatusCallback, isTBActive, setFocusLocked }
