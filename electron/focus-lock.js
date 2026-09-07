'use strict'
const { getAllWindows, Hardware } = require('./keysender-safe')

// ── Minecraft window detector ──────────────────────────────────────────────────
// Detection strategy (in priority order):
//
//  1. Window CLASS NAME — most reliable. Every Java Minecraft client uses LWJGL
//     which registers a known Win32 class regardless of the window title:
//       GLFW30          → LWJGL 3   (Minecraft 1.13+, Lunar, BadLion, Feather…)
//       SunAwtFrame     → LWJGL 2   (legacy clients, very old MC versions)
//       SunAwtDialog    → LWJGL 2   fullscreen / secondary dialogs
//       SunAwtCanvas    → LWJGL 2   embedded canvas (some fullscreen configs)
//
//     IMPORTANT: GLFW30 is not exclusive to Minecraft — other GLFW3 applications
//     (games, tools) use the same class.  For LWJGL class windows we therefore
//     also require the title to match the MC pattern OR be blank (some clients
//     intentionally leave the title empty) OR look like a bare version string
//     ("1.21.1", "21w38a").  This prevents false-focused reports when a non-MC
//     GLFW3 app is in the foreground.
//
//  2. Title regex — fallback for native/Electron-based launchers that don't use
//     Java (e.g. some Cosmic Client builds, TLauncher native mode, etc.)
//
// Focus debounce:
//   Unfocused is committed immediately (macros must stop the moment MC loses focus).
//   Focused requires FOCUS_DEBOUNCE_TICKS consecutive polls to commit — this
//   prevents false "focused" flashes during the windowed↔fullscreen HWND
//   transition where isForeground() can flicker true for one tick.
//
// Poll every POLL_MS ms.  Each tick does a full EnumWindows() pass so a fullscreen
// transition (which may create a new HWND) is caught within one tick.

const POLL_MS             = 280
const FOCUS_DEBOUNCE_TICKS = 2   // 2 x 280 ms = 560 ms before "focused" commits

// Java/LWJGL window classes — all modes (windowed + fullscreen)
const MC_CLASS_RE = /^(GLFW\d+|SunAwtFrame|SunAwtDialog|SunAwtCanvas)$/i

// MC title patterns — used as primary check for non-LWJGL windows and as
// secondary validation for LWJGL windows (see note above).
const MC_TITLE_RE = /minecraft|lunar|lunarclient|badlion|feather|pvplounge|cosmic|salwyrr|blaze|crystal|tlauncher|multimc|prism launcher|atlauncher|gdlauncher|curseforge/i

// Bare version string titles some clients / dev builds use: "1.21.1", "21w38a"
const MC_VERSION_RE = /^1\.\d+(\.\d+)?([a-z]\d+)?$|^\d{2}w\d{2}[a-z]$/i

// Exclude browser tabs that happen to mention Minecraft in their title
const BROWSER_RE = /- (google chrome|mozilla firefox|microsoft edge|opera|brave browser|safari)/i

// Strict: matches only actual Java game windows (LWJGL class required).
// Used for focus detection and building hwList.
// Launchers (Prism, CurseForge, ATLauncher, etc.) use native/Electron windows
// and will NOT have a LWJGL class, so they never match here — preventing the
// false "focused" report when the user alt-tabs to their launcher.
function isMcGameWindow(w) {
  if (!w) return false
  if (BROWSER_RE.test(w.title)) return false
  if (!MC_CLASS_RE.test(w.className)) return false
  // LWJGL class confirmed — still validate title to exclude other GLFW3 apps
  const t = (w.title || '').trim()
  return !t || MC_TITLE_RE.test(t) || MC_VERSION_RE.test(t)
}

// Broad: matches game windows AND native launcher windows (title-only fallback).
// Used only for the "is MC running" check — launchers count as "running"
// so the UI can show "Instance detected" even before the game launches.
function isMcWindow(w) {
  if (!w) return false
  if (BROWSER_RE.test(w.title)) return false

  if (MC_CLASS_RE.test(w.className)) {
    // LWJGL class detected — validate title to avoid false positives from other
    // GLFW3 / AWT applications.  Accept if:
    //   • title is blank/empty  (client hasn't set a title yet, or intentionally blank)
    //   • title matches known MC client names
    //   • title looks like a bare version string ("1.21.1", "21w38a")
    const t = (w.title || '').trim()
    return !t || MC_TITLE_RE.test(t) || MC_VERSION_RE.test(t)
  }

  // Non-LWJGL window — match by title only (native launchers, Electron-based
  // launchers like some CurseForge / GDLauncher builds, etc.)
  return MC_TITLE_RE.test(w.title)
}

let timer     = null
let hwList    = []    // active Hardware instances bound to current MC HWNDs
let mcFocused = null  // null = unknown (before first tick)
let mcRunning = null

// Debounce state — only used for the focused=true edge
let _focusPendingTicks = 0   // consecutive ticks that returned focused=true
let _lastGameHandleSig = ''

function buildHandleSignature(windows) {
  if (!Array.isArray(windows) || !windows.length) return ''
  const handles = windows
    .map((w) => Number(w?.handle) || 0)
    .filter((h) => h > 0)
    .sort((a, b) => a - b)
  return handles.join(',')
}

function rebuildHwList(gameWindows) {
  hwList = []
  for (const w of gameWindows) {
    try { hwList.push(new Hardware(w.handle)) } catch (_) {}
  }
}

function poll(win, engine, onRunningChanged, onFocusChanged) {
  try {
    // Re-enumerate every tick — EnumWindows() is fast (~1 ms) and ensures we
    // catch any HWND change from a windowed↔fullscreen transition immediately.
    const allWins    = getAllWindows()
    const mcWins     = allWins.filter(isMcWindow)      // broad: game + launchers → running state
    const mcGameWins = mcWins.filter(isMcGameWindow)   // strict: LWJGL only → focus state
    const running    = mcWins.length > 0
    let   focused    = false

    if (running) {
      // Rebuild Hardware list from GAME windows only (not launchers).
      // This ensures isForeground() is only checked against actual MC game
      // HWNDs — alt-tabbing to Prism Launcher / CurseForge will NOT falsely
      // report focused=true because launcher windows are excluded here.
      const handleSig = buildHandleSignature(mcGameWins)
      if (handleSig !== _lastGameHandleSig) {
        _lastGameHandleSig = handleSig
        rebuildHwList(mcGameWins)
      }
      focused = hwList.some(h => {
        try { return h.workwindow.isForeground() } catch { return false }
      })
    } else {
      hwList = []
      _lastGameHandleSig = ''
    }

    // ── Focus debounce ────────────────────────────────────────────────────────
    // Unfocused  → commit immediately (macros must stop right away).
    // Focused    → require FOCUS_DEBOUNCE_TICKS consecutive polls to commit,
    //              preventing one-tick flickers during fullscreen transitions.
    if (focused) {
      _focusPendingTicks++
      if (_focusPendingTicks < FOCUS_DEBOUNCE_TICKS) {
        // Not enough consecutive focused ticks yet — don't commit, but also
        // don't reset the running-changed logic below.
        // Still need to handle running state change.
        if (running !== mcRunning) {
          mcRunning = running
          if (!win.isDestroyed()) win.webContents.send('mc-running-changed', running)
          try { onRunningChanged?.(running) } catch (_) {}
        }
        return
      }
      // Enough ticks — fall through and commit focused=true
    } else {
      _focusPendingTicks = 0  // reset debounce counter on any unfocused tick
    }

    if (focused !== mcFocused) {
      mcFocused = focused
      engine.setMcFocus(focused)
      if (!win.isDestroyed()) win.webContents.send('focus-lock-changed', focused)
      try { onFocusChanged?.(focused) } catch (_) {}
    }

    if (running !== mcRunning) {
      mcRunning = running
      if (!win.isDestroyed()) win.webContents.send('mc-running-changed', running)
      try { onRunningChanged?.(running) } catch (_) {}
    }
  } catch (err) {
    console.warn('[focus-lock] poll error:', err.message)
  }
}

function start(win, engine, onRunningChanged, onFocusChanged) {
  stop()
  poll(win, engine, onRunningChanged, onFocusChanged)
  timer = setInterval(() => poll(win, engine, onRunningChanged, onFocusChanged), POLL_MS)
}

function stop() {
  if (timer) { clearInterval(timer); timer = null }
  hwList             = []
  _lastGameHandleSig = ''
  mcFocused          = null
  mcRunning          = null
  _focusPendingTicks = 0
}

// SetForegroundWindow(mcHwnd) — bring Minecraft to foreground before SendInput
// so keystrokes go to MC, not Electron.  Uses the most-recently-focused instance.
function focusMc() {
  try { if (hwList.length) hwList[0].workwindow.setForeground() } catch (_) {}
}

function getFocusedGameView() {
  try {
    if (!hwList.length) return null

    let hw = null
    for (const h of hwList) {
      try {
        if (h.workwindow.isForeground()) {
          hw = h
          break
        }
      } catch (_) {}
    }
    if (!hw) hw = hwList[0]
    if (!hw) return null

    const view = hw.workwindow.getView()
    if (!view) return null

    const x = Number(view.x)
    const y = Number(view.y)
    const width = Number(view.width)
    const height = Number(view.height)
    if (![x, y, width, height].every(Number.isFinite)) return null
    if (width <= 0 || height <= 0) return null

    return {
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height),
    }
  } catch (_) {
    return null
  }
}

module.exports = {
  start,
  stop,
  isMcFocused: () => mcFocused === true,
  focusMc,
  getFocusedGameView,
}
