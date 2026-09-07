'use strict'

let _native = undefined
let _error = null

function _ensureNative() {
  if (_native !== undefined) return _native
  try {
    _native = require('keysender')
    _error = null
  } catch (err) {
    _native = null
    _error = err
  }
  return _native
}

function _peekNative() {
  return _native === undefined ? null : _native
}

const _noop = () => {}
const _noopAsync = async () => {}
const _noopPos = () => ({ x: 0, y: 0 })

class SafeHardware {
  constructor() {
    this.keyboard = {
      sendKey: _noopAsync,
      toggleKey: _noopAsync,
      sendKeys: _noopAsync,
      printText: _noopAsync,
    }
    this.mouse = {
      toggle: _noopAsync,
      click: _noopAsync,
      moveTo: _noopAsync,
      move: _noopAsync,
      scrollWheel: _noopAsync,
      getPos: _noopPos,
    }
    this.workwindow = {
      colorAt: (_x, _y, format = 'string') => {
        if (format === 'array') return [0, 0, 0]
        if (format === 'number') return 0
        return '000000'
      },
      refresh: () => false,
      setForeground: _noop,
      isForeground: () => false,
      isOpen: () => false,
      capture: () => ({ data: Buffer.alloc(0), width: 0, height: 0 }),
      kill: _noop,
      close: _noop,
      getView: () => ({ x: 0, y: 0, width: 0, height: 0 }),
      setView: _noop,
      set: _noop,
      get: () => ({ handle: 0, className: '', title: '' }),
    }
  }
}

class LazyHardware {
  constructor(...args) {
    const native = _ensureNative()
    if (native && typeof native.Hardware === 'function') {
      return new native.Hardware(...args)
    }
    return new SafeHardware(...args)
  }
}

const SafeLowLevelHook = {
  on: () => _noop,
  deleteAll: _noop,
}

const LazyLowLevelHook = {
  on: (...args) => {
    const native = _ensureNative()
    if (native?.LowLevelHook?.on) return native.LowLevelHook.on(...args)
    return SafeLowLevelHook.on(...args)
  },
  deleteAll: (...args) => {
    const native = _peekNative()
    if (native?.LowLevelHook?.deleteAll) return native.LowLevelHook.deleteAll(...args)
    return SafeLowLevelHook.deleteAll(...args)
  }
}

function isButtonPressed(...args) {
  const native = _ensureNative()
  if (native && typeof native.isButtonPressed === 'function') {
    return native.isButtonPressed(...args)
  }
  return false
}

function getAllWindows(...args) {
  const native = _ensureNative()
  if (native && typeof native.getAllWindows === 'function') {
    return native.getAllWindows(...args)
  }
  return []
}

function isAvailable() {
  return Boolean(_ensureNative())
}

function getError() {
  _ensureNative()
  return _error || null
}

function getErrorMessage() {
  const err = getError()
  return err ? (err.stack || err.message || String(err)) : ''
}

const api = {
  isAvailable,
  getError,
  getErrorMessage,
  Hardware: LazyHardware,
  LowLevelHook: LazyLowLevelHook,
  isButtonPressed,
  getAllWindows,
}

Object.defineProperty(api, 'available', {
  enumerable: true,
  get: () => isAvailable(),
})

Object.defineProperty(api, 'error', {
  enumerable: true,
  get: () => getError(),
})

Object.defineProperty(api, 'errorMessage', {
  enumerable: true,
  get: () => getErrorMessage(),
})

module.exports = api
