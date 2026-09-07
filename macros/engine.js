const { globalShortcut } = require('electron')
const { LowLevelHook, isButtonPressed } = require('../electron/keysender-safe')
const {
  runSA, runDA, runAP, runKP,
  runIDH, runOHT, runASB, startFXP, stopFXP, startAC, stopAC,
  runES, runPC, runSS, runBS, runHC, runLS,
  runIC, runXB, runDR, runLW, runLA,
  stopAll
} = require('./input')
const { toggleTB, stopTB, setFocusLocked: tbSetFocusLocked } = require('./triggerbot')

let macroConfig = {}
let focusLocked = true   // default on; updated by setFocusLock()
let mcHasFocus  = false
let chatPaused  = false
let runtimeGuard = () => true

// Mouse button keybinds → LowLevelHook 'mouse' event names
const MOUSE_BUTTONS = new Set(['Mouse3', 'Mouse4', 'Mouse5'])
const MOUSE_BTN_MAP = { 'Mouse3': 'middle', 'Mouse4': 'x1', 'Mouse5': 'x2' }

// key -> { type: 'global'|'lowlevel'|'mouse', unlisten?: fn }
const registeredMacroKeys = new Map()

function setConfig(config) {
  macroConfig = config
}

function setRuntimeGuard(fn) {
  runtimeGuard = typeof fn === 'function' ? fn : (() => true)
}

function setFocusLock(val) {
  focusLocked = val
  tbSetFocusLocked(val)
  if (!focusLocked) {
    // Lock turned off — register macros unconditionally (ignore MC focus)
    if (!chatPaused) registerAll()
  } else {
    // Lock turned on — respect current MC focus state
    if (mcHasFocus && !chatPaused) {
      registerAll()
    } else {
      unregisterMacros()
      stopAll()
      stopTB()
    }
  }
}

function setMcFocus(val) {
  mcHasFocus = val
  if (!focusLocked) return  // lock off — focus changes don't affect macro registration
  if (val && !chatPaused) {
    registerAll()
  } else {
    unregisterMacros()
    stopAll()
    stopTB()
  }
}

function setChatPaused(val) {
  chatPaused = val
  if (val) {
    unregisterMacros()
    stopAll()
    stopTB()
  } else if (!focusLocked || mcHasFocus) {
    registerAll()
  }
}

function unregisterMacros() {
  registeredMacroKeys.forEach((info, key) => {
    try {
      if (info.type === 'global') {
        globalShortcut.unregister(key)
      } else if ((info.type === 'lowlevel' || info.type === 'mouse') && info.unlisten) {
        info.unlisten()
      }
    } catch (_) {}
  })
  registeredMacroKeys.clear()
  stopFXP()
  stopAC()
}

function registerAll() {
  unregisterMacros()
  if (!runtimeGuard()) return
  if (focusLocked && !mcHasFocus) return

  Object.entries(macroConfig).forEach(([id, cfg]) => {
    if (!cfg.active || !cfg.keybind || cfg.keybind === 'None') return
    const keybind = cfg.keybind

    // Skip duplicate keybinds — if another active macro already claimed this
    // key, don't register a second hook (the first macro wins).
    // Without this guard, both hooks fire when the key is pressed AND the
    // Map only stores the last registration, so the first hook leaks and
    // can never be unlistened — causing ghost macros even after disabling.
    if (registeredMacroKeys.has(keybind)) return

    // FXP: hold-to-run (press starts, release stops)
    if (id === 'fxp') {
      registerFXP(keybind, cfg)
      return
    }
    // AC: hold-to-run (press starts, release stops)
    if (id === 'ac') {
      registerAC(keybind, cfg)
      return
    }

    const base        = keybind.split('+').pop()
    const isMouse     = MOUSE_BUTTONS.has(base)
    const hasModifier = !isMouse && keybind.includes('+') &&
                        (keybind.includes('Shift') || keybind.includes('Ctrl') || keybind.includes('Alt'))

    try {
      if (isMouse) {
        // ── Side / middle mouse button ──────────────────────────────────────
        const mouseBtn = MOUSE_BTN_MAP[base]
        if (!mouseBtn) return
        const unlisten = LowLevelHook.on('mouse', mouseBtn, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'mouse', unlisten })
        console.log(`[engine] Registered [${id}] mouse: ${mouseBtn}`)

      } else if (hasModifier) {
        // ── Modifier combo (Shift+X, Ctrl+X) — globalShortcut handles these ─
        // globalShortcut correctly fires ONLY when the exact combo is pressed.
        const normalizedKey = normalizeShortcut(keybind)
        const ok = globalShortcut.register(normalizedKey, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        if (ok) registeredMacroKeys.set(keybind, { type: 'global' })
        console.log(`[engine] Registered [${id}] global: ${normalizedKey}`)

      } else {
        // ── Simple key — use LowLevelHook so it fires even when Shift/Ctrl ──
        // are physically held (sprinting with Ctrl, crouching with Shift, etc.)
        // globalShortcut('R') silently fails when any extra modifier is held.
        const ksKey = convertToKeySenderKey(keybind)
        if (!ksKey) return
        const unlisten = LowLevelHook.on('keyboard', ksKey, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten })
        console.log(`[engine] Registered [${id}] lowlevel: ${ksKey}`)
      }
    } catch (e) {
      console.log(`[engine] Could not register [${id}]: ${keybind}`, e.message)
    }
  })
}

function _modsDown(keybind) {
  if (!keybind) return true
  const need = []
  if (keybind.includes('Ctrl'))  need.push('ctrl')
  if (keybind.includes('Alt'))   need.push('alt')
  if (keybind.includes('Shift')) need.push('shift')
  if (!need.length) return true
  try {
    return need.every(m => isButtonPressed('keyboard', m))
  } catch (_) {
    return false
  }
}

function registerFXP(keybind, cfg) {
  const base = keybind.split('+').pop()
  const isMouse = MOUSE_BUTTONS.has(base)

  try {
    if (isMouse) {
      const mouseBtn = MOUSE_BTN_MAP[base]
      if (!mouseBtn) return
      const unlistenDown = LowLevelHook.on('mouse', mouseBtn, true, () => {
        if ((focusLocked && !mcHasFocus) || chatPaused) return
        if (!_modsDown(keybind)) return
        startFXP(cfg.delay || '35')
      })
      const unlistenUp = LowLevelHook.on('mouse', mouseBtn, false, () => {
        stopFXP()
      })
      registeredMacroKeys.set(keybind, { type: 'mouse', unlisten: () => { unlistenDown(); unlistenUp() } })
      console.log(`[engine] Registered [fxp] hold mouse: ${mouseBtn}`)
      return
    }

    const ksKey = convertToKeySenderKey(keybind)
    if (!ksKey) return
    const unlistenDown = LowLevelHook.on('keyboard', ksKey, true, () => {
      if ((focusLocked && !mcHasFocus) || chatPaused) return
      if (!_modsDown(keybind)) return
      startFXP(cfg.delay || '35')
    })
    const unlistenUp = LowLevelHook.on('keyboard', ksKey, false, () => {
      stopFXP()
    })
    registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten: () => { unlistenDown(); unlistenUp() } })
    console.log(`[engine] Registered [fxp] hold key: ${ksKey}`)
  } catch (e) {
    console.log(`[engine] Could not register [fxp]: ${keybind}`, e.message)
  }
}

function registerAC(keybind, cfg) {
  const base = keybind.split('+').pop()
  const isMouse = MOUSE_BUTTONS.has(base)

  try {
    if (isMouse) {
      const mouseBtn = MOUSE_BTN_MAP[base]
      if (!mouseBtn) return
      const unlistenDown = LowLevelHook.on('mouse', mouseBtn, true, () => {
        if ((focusLocked && !mcHasFocus) || chatPaused) return
        if (!_modsDown(keybind)) return
        startAC(cfg.crystalKey || '5', cfg.delay || '25')
      })
      const unlistenUp = LowLevelHook.on('mouse', mouseBtn, false, () => {
        stopAC()
      })
      registeredMacroKeys.set(keybind, { type: 'mouse', unlisten: () => { unlistenDown(); unlistenUp() } })
      console.log(`[engine] Registered [ac] hold mouse: ${mouseBtn}`)
      return
    }

    const ksKey = convertToKeySenderKey(keybind)
    if (!ksKey) return
    const unlistenDown = LowLevelHook.on('keyboard', ksKey, true, () => {
      if ((focusLocked && !mcHasFocus) || chatPaused) return
      if (!_modsDown(keybind)) return
      startAC(cfg.crystalKey || '5', cfg.delay || '25')
    })
    const unlistenUp = LowLevelHook.on('keyboard', ksKey, false, () => {
      stopAC()
    })
    registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten: () => { unlistenDown(); unlistenUp() } })
    console.log(`[engine] Registered [ac] hold key: ${ksKey}`)
  } catch (e) {
    console.log(`[engine] Could not register [ac]: ${keybind}`, e.message)
  }
}

// Convert keybind to keysender format for LowLevelHook
function convertToKeySenderKey(keybind) {
  if (!keybind || keybind === 'None') return null
  const base = keybind.split('+').pop()
  if (!base) return null

  // Map to keysender key names
  const map = {
    'Return': 'enter', 'Escape': 'escape', 'Space': 'space',
    'Tab': 'tab', 'Backspace': 'backspace', 'Delete': 'delete',
    'Insert': 'insert', 'Home': 'home', 'End': 'end',
    'PageUp': 'pageup', 'PageDown': 'pagedown',
    'Up': 'up', 'Down': 'down', 'Left': 'left', 'Right': 'right',
    'CapsLock': 'capslock',
    'Ctrl': 'ctrl', 'Control': 'ctrl',
    'Alt': 'alt', 'Shift': 'shift',
    'Meta': 'meta',
    'Mouse1': 'left', 'Mouse2': 'right', 'Mouse3': 'middle',
    'Mouse4': 'x1', 'Mouse5': 'x2'
  }

  const key = map[base] || base.toLowerCase()
  return key
}

function triggerMacro(id, cfg) {
  if (!runtimeGuard()) {
    console.log(`[engine] Blocked [${id}] - runtime lease invalid`)
    stopAll()
    stopTB()
    return
  }

  if (focusLocked && !mcHasFocus) {
    console.log(`[engine] Blocked [${id}] — Minecraft not focused`)
    return
  }

  // ── Key-guard: ONLY needed for KP and IDH ────────────────────────────────
  //
  // robot.keyTap() uses Win32 SendInput which also fires RegisterHotKey
  // listeners — so macros that re-press their own keybind key would loop:
  //   • IDH presses its inventoryKey (= the keybind, often 'E')
  //   • KP  presses its pearlKey    (may equal the keybind)
  //
  // All other macros (SA, DA, AP, OHT, ASB, FXP) only press hotbar
  // keys / mouse — none match the macro's own keybind — so they NEVER
  // need to unregister.  This lets the user spam-trigger immediately.
  // ──────────────────────────────────────────────────────────────────────────
  const needsGuard = (id === 'kp' || id === 'idh')
  const keybind    = needsGuard ? cfg.keybind : null

  if (keybind) {
    const entry = registeredMacroKeys.get(keybind)
    if (entry) {
      if (entry.type === 'global') {
        try { globalShortcut.unregister(keybind) } catch (_) {}
      } else if ((entry.type === 'lowlevel' || entry.type === 'mouse') && entry.unlisten) {
        // Defer hook.delete() — calling it synchronously from within the hook
        // callback causes a native WH_MOUSE_LL / WH_KEYBOARD_LL crash.
        const fn = entry.unlisten
        setImmediate(() => { try { fn() } catch (_) {} })
      }
      registeredMacroKeys.delete(keybind)
    }
  }

  function reregister() {
    if (!keybind) return
    if (focusLocked && !mcHasFocus) return

    const base        = keybind.split('+').pop()
    const isMouse     = MOUSE_BUTTONS.has(base)
    const hasModifier = !isMouse && keybind.includes('+') &&
                        (keybind.includes('Shift') || keybind.includes('Ctrl') || keybind.includes('Alt'))

    try {
      if (isMouse) {
        const mouseBtn = MOUSE_BTN_MAP[base]
        if (!mouseBtn) return
        const unlisten = LowLevelHook.on('mouse', mouseBtn, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'mouse', unlisten })
      } else if (hasModifier) {
        const normalizedKey = normalizeShortcut(keybind)
        const ok = globalShortcut.register(normalizedKey, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        if (ok) registeredMacroKeys.set(keybind, { type: 'global' })
      } else {
        const ksKey = convertToKeySenderKey(keybind)
        if (!ksKey) return
        const unlisten = LowLevelHook.on('keyboard', ksKey, true, () => {
          triggerMacro(id, macroConfig[id] || cfg)
        })
        registeredMacroKeys.set(keybind, { type: 'lowlevel', unlisten })
      }
    } catch (_) {}
  }

  switch (id) {

    // ── Placement ── no key-guard needed, fire-and-forget with cancel token
    case 'sa':
      runSA(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
        cfg.explodeKey   || 'None',
        cfg.delay        || '27'
      )
      break

    case 'da':
      runDA(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
        cfg.explodeKey   || 'None',
        cfg.delay        || '48'
      )
      break

    case 'ap':
      runAP(
        cfg.anchorKey    || '4',
        cfg.glowstoneKey || '5',
        cfg.explodeKey   || 'None',
        cfg.pearlKey     || '6',
        (cfg.totemKey && cfg.totemKey !== 'None') ? cfg.totemKey : '9',
        cfg.delay        || '25'
      )
      break

    case 'hc':
      runHC(
        cfg.obsidianKey || '4',
        cfg.crystalKey  || '5',
        cfg.delay       || '1'
      )
      break

    // ── KP / IDH — press own keybind, must guard ──────────────────────────
    case 'kp':
      runKP(
        cfg.pearlKey  || '6',
        cfg.returnKey || '1',
        cfg.delay     || '30'
      ).finally(reregister)
      break

    case 'idh': {
      // Stop any running anchor/crystal macros first — if SA/DA is mid-sequence
      // their rClick calls would fire into the open inventory and move items.
      stopAll()
      // Guard: if keybind is a mouse button (Mouse3/4/5), getBaseKey returns
      // e.g. 'Mouse4' which is NOT a valid keyboard key — fall back to 'e'.
      const invKey = getBaseKey(cfg.keybind)
      runIDH(
        (!invKey || MOUSE_BUTTONS.has(invKey)) ? 'e' : null,
        cfg.totemKey || '9',
        cfg.delay    || '25'
      ).finally(reregister)
      break
    }

    // ── Triggerbot — toggle polling loop ──────────────────────────────────
    case 'tb':
      toggleTB(cfg)
      break

    // ── Rest — no key-guard ────────────────────────────────────────────────
    case 'oht':
      runOHT(
        cfg.totemKey || '9',
        cfg.swapKey  || 'f',
        cfg.delay    || '35'
      )
      break

    case 'asb':
      runASB(
        cfg.axeKey    || '2',
        cfg.swordKey  || '1',
        cfg.swapDelay || '35'
      )
      break

    case 'ls':
      runLS(
        cfg.swordKey || '1',
        cfg.spearKey || '3'
      )
      break


    // ── Mace macros ────────────────────────────────────────────────────────
    case 'es':
      runES(
        cfg.elytraKey || '5',
        cfg.returnKey || '1',
        cfg.delay     || '50'
      )
      break

    case 'pc':
      runPC(
        cfg.pearlKey      || '6',
        cfg.windChargeKey || '7',
        cfg.delay         || '50'
      )
      break

    case 'ss':
      runSS(
        cfg.axeKey  || '2',
        cfg.maceKey || '3',
        cfg.delay   || '10'
      )
      break

    case 'bs':
      runBS(
        cfg.maceKey  || '3',
        cfg.swordKey || '1',
        cfg.delay    || '25'
      )
      break

    // ── Cart macros ────────────────────────────────────────────────────────
    case 'ic':
      runIC(
        cfg.railKey   || '5',
        cfg.bowKey    || '4',
        cfg.cartKey   || '6',
        cfg.bowHoldMs || '150',
        cfg.delay     || '50'
      )
      break

    case 'xb':
      runXB(
        cfg.railKey      || '5',
        cfg.cartKey      || '6',
        cfg.fnsKey       || '7',
        cfg.crossbowKey  || '4',
        cfg.delay        || '50'
      )
      break

    // ── UHC macros ─────────────────────────────────────────────────────────
    case 'dr':
      runDR(
        cfg.bucketKey || '7',
        cfg.delay     || '30'
      )
      break

    case 'lw':
      runLW(
        cfg.lavaKey   || '8',
        cfg.cobwebKey || '9',
        cfg.delay     || '30'
      )
      break

    case 'la':
      runLA(
        cfg.lavaKey || '8',
        cfg.delay   || '30'
      )
      break
  }
}

function getBaseKey(keybind) {
  if (!keybind || keybind === 'None') return null
  return keybind.split('+').pop()
}

function normalizeShortcut(key) {
  if (!key || key === 'None') return null
  return key
    .replace('Ctrl', 'CommandOrControl')
    .replace('Shift', 'Shift')
    .replace('Alt', 'Alt')
}

module.exports = { setConfig, setFocusLock, setMcFocus, setChatPaused, setRuntimeGuard, registerAll, stopAll }
