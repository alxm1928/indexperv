// ─────────────────────────────────────────────────────────────────────────────
//  macros/input.js  —  native Win32 input
//
//  Keyboard:  keysender Hardware  (sendKey → SendInput, KEYEVENTF_SCANCODE)
//             KEY_HOLD_MS=20 → key held 20ms between down and up, spanning
//             at least one GLFW poll at 60fps (16.7ms/frame) so the slot
//             switch is registered before keyup arrives.
//             Anchor macros (SA/DA/AP) use slotClick() instead of press():
//             keydown and mousedown are queued concurrently via Win32 SendInput,
//             reducing step time from 27ms to 10ms (CLICK_HOLD_MS).
//             focusLock.focusMc() is called before every anchor sequence to force
//             SetForegroundWindow(mcHwnd), ensuring SendInput goes to
//             Minecraft instead of the Electron window.
//  Mouse:     keysender Hardware  (mouseToggle → SendInput WITH hardware flags)
//             Minecraft/GLFW ignores software mouse events without hardware flags.
//  Timing:    deterministic delays only (no stealth jitter or pattern breaks).
// ─────────────────────────────────────────────────────────────────────────────

const { Hardware }  = require('../electron/keysender-safe')
const focusLock     = require('../electron/focus-lock')
const timing = {
  vary(ms) {
    return Math.max(0, Number(ms) || 0)
  },
  varyHold(ms) {
    return Math.max(0, Number(ms) || 0)
  },
  shouldSkipClick() {
    return false
  }
}
const { getClickBinds, resolveMouseButton, setClickBinds } = require('./click-binds')

// Global hardware input instance — desktop mode (no window handle).
// Keyboard SendInput goes to the Win32 foreground window (set by focusMc).
// Mouse hardware events go to the cursor position unconditionally.
let _hwInstance = null
const hw = new Proxy({}, {
  get(_target, prop) {
    if (!_hwInstance) _hwInstance = new Hardware()
    const value = _hwInstance[prop]
    return typeof value === 'function' ? value.bind(_hwInstance) : value
  }
})

// Base hold time (ms) between keydown and keyup.
const KEY_HOLD_MS   = 20
// Base hold time between mousedown and mouseup so Minecraft registers the click.
const CLICK_HOLD_MS = 10
// How long to hold the slot-switch key when it is a mouse button (ms).
// Also the minimum key hold inside slotClick's concurrent path — key is released
// concurrently with the click so 17ms > one 60fps GLFW frame (16.7ms) is not
// strictly required here, but keeping it consistent avoids edge-case misses.
const SLOT_HOLD_MS  = 17

// Maps user-facing mouse button names → keysender mouse button strings.
// Used by press() so macro action keys (anchorKey, glowstoneKey, etc.) can be
// bound to mouse buttons — routed through hw.mouse.toggle() instead of sendKey.
const PRESS_MOUSE_MAP = {
  Mouse1: 'left',
  Mouse2: 'right',
  Mouse3: 'middle',
  Mouse4: 'x1',
  Mouse5: 'x2',
}

// ── Cancellation tokens ───────────────────────────────────────────────────────
const macroTokens = {}

function sleep(ms, token) {
  return new Promise(resolve => {
    if (token?.cancelled) return resolve()
    const tid = setTimeout(resolve, ms)
    if (token) token._cancel = () => { clearTimeout(tid); resolve() }
  })
}

async function startMacro(id, fn) {
  // Skip if this macro is still running.
  // Prevents mouse-button contact bounce / accidental double-press from
  // cancelling the first run mid-sequence (e.g. glowstone never pressed
  // because the anchor→glowstone sleep token was cancelled by the second trigger).
  // KP/IDH are safe: their hook is unregistered while running so they
  // cannot be double-triggered from the hook side anyway.
  if (macroTokens[id]) return

  const token = { cancelled: false, _cancel: null }
  macroTokens[id] = token

  try { await fn(token) }
  catch(e) { if (!token.cancelled) console.error(`[macro:${id}]`, e.message) }
  finally  { if (macroTokens[id] === token) delete macroTokens[id] }
}

// Queue-one scheduler for anchor macros (SA / DA / AP).
//
// Why not cancel-and-restart:
//   Cancelling mid-sequence leaves a partially-executed run (sendKey / mouse.toggle
//   calls already in flight in the OS queue).  The new run then starts immediately,
//   so both runs are pushing hardware events concurrently — slot switches and clicks
//   interleave and the sequence corrupts.
//
// Queue-one behaviour:
//   • If no run is active  → start immediately.
//   • If a run is active   → store fn as the pending next-run (latest press wins).
//   • When the active run finishes → if a next-run was queued, fire it with zero gap.
//   • stopAll()            → clears both the active token and any queued run.
//
// This means spam-pressing always chains sequences back-to-back with no gap and
// no interleaved hardware events, because each sequence runs to completion before
// the next begins.
const macroQueue = {}

async function startAnchorMacro(id, fn) {
  if (macroTokens[id]) {
    // Run in progress — park this press; it will fire the moment the run ends.
    macroQueue[id] = fn
    return
  }

  const token = { cancelled: false, _cancel: null }
  macroTokens[id] = token
  try { await fn(token) }
  catch(e) { if (!token.cancelled) console.error(`[macro:${id}]`, e.message) }
  finally {
    if (macroTokens[id] === token) delete macroTokens[id]
    // Fire the queued run immediately — but not if stopAll() cancelled us.
    if (macroQueue[id] && !token.cancelled) {
      const next = macroQueue[id]
      delete macroQueue[id]
      startAnchorMacro(id, next)  // fire-and-forget; runSA/DA/AP already returned
    } else {
      delete macroQueue[id]       // discard stale queue if we were stopped
    }
  }
}

// ── Low-level input primitives ────────────────────────────────────────────────

// focusMc() → SetForegroundWindow(mcHwnd): guarantees the next SendInput
// keyboard event is directed to Minecraft's thread, not Electron's.
// varyHold(KEY_HOLD_MS) applies ±(1–7)ms jitter to the hold duration.
async function press(key, token, holdMs) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  // If the macro action key is a mouse button, toggle it via SendInput hardware
  // flags (same path as lClick/rClick) — sendKey only accepts keyboard keys.
  const mouseBtn = PRESS_MOUSE_MAP[String(key)]
  if (mouseBtn) {
    const clickHold = holdMs ?? CLICK_HOLD_MS
    try {
      await hw.mouse.toggle(mouseBtn, true)
      await sleep(timing.varyHold(clickHold), token)
      if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(mouseBtn, false)
    } catch (_) {}
    return
  }

  const keyHold = holdMs ?? KEY_HOLD_MS
  focusLock.focusMc()
  await sleep(2, token)
  if (token?.cancelled) return
  try { await hw.keyboard.sendKey(String(key).toLowerCase(), timing.varyHold(keyHold), 0) } catch(_) {}
}

// Hardware mouse clicks — keysender sends SendInput with MOUSEEVENTF_* flags
// so Minecraft/GLFW processes them regardless of keyboard focus state.
// varyHold(CLICK_HOLD_MS) applies ±(1–7)ms jitter to the hold duration.
async function _clickWithBind(bindKey, token, holdMs) {
  if (token?.cancelled) return
  if (!bindKey || bindKey === 'None') return

  const mouseBtn = resolveMouseButton(bindKey)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(timing.varyHold(holdMs ?? CLICK_HOLD_MS), token)
    if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
    await hw.mouse.toggle(mouseBtn, false)
    return
  }

  try {
    await hw.keyboard.sendKey(String(bindKey).toLowerCase(), timing.varyHold(holdMs ?? CLICK_HOLD_MS), 0)
  } catch (_) {}
}

async function rClick(token, holdMs) {
  if (token?.cancelled) return
  const { right } = getClickBinds()
  await _clickWithBind(right || 'Mouse2', token, holdMs)
}

async function lClickFixed(token) {
  if (token?.cancelled) return
  const { left } = getClickBinds()
  const bind = left || 'Mouse1'
  const mouseBtn = resolveMouseButton(bind)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false)
    return
  }
  try { await hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0) } catch (_) {}
}

// Fixed-duration right-click for anchor sequences (SA / DA / AP).
// rClick() passes through varyHold() which can vary hold by ±55 ms — at
// sub-30 ms step delays that collapses the inter-click gap below what
// Minecraft needs to process consecutive block interactions, causing misses.
// This version always holds for exactly CLICK_HOLD_MS with no jitter.
async function rClickFixed(token) {
  if (token?.cancelled) return
  const { right } = getClickBinds()
  const bind = right || 'Mouse2'
  const mouseBtn = resolveMouseButton(bind)
  if (mouseBtn) {
    await hw.mouse.toggle(mouseBtn, true)
    await sleep(CLICK_HOLD_MS, token)
    await hw.mouse.toggle(mouseBtn, false)
    return
  }
  try { await hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0) } catch (_) {}
}

// Dedicated physical right-click (Mouse2) path for placement-critical flows.
async function rClickMouse2Fixed(token) {
  if (token?.cancelled) return
  await hw.mouse.toggle('right', true)
  await sleep(CLICK_HOLD_MS, token)
  await hw.mouse.toggle('right', false)
}

// slotClick — concurrent slot-switch + right-click for anchor sequences.
//
// Keyboard key path (the common case):
//   sendKey and the mouse chain run concurrently via Promise.all, and both are
//   fully awaited — slotClick only resolves after keyup AND mouseup are sent.
//   Key hold uses SLOT_HOLD_MS (17ms > one 60fps GLFW frame) so keydown and
//   keyup span at least one GLFW poll cycle — preventing both events landing in
//   the same cycle which would cause an intermittent missed slot switch.
//   Mouse hold uses CLICK_HOLD_MS (10ms).  Promise.all resolves at ~17ms
//   (keyboard governs).
//
//   Why Promise.all instead of the old fire-and-forget sendKey:
//   When startAnchorMacro chains a queued run immediately in its finally block,
//   the next slotClick's keydown must not reach GLFW before the previous keyup.
//   With fire-and-forget the keyup timer (17ms) outlived the function (10ms),
//   so the next keydown arrived before keyup — GLFW saw two consecutive keydowns
//   for the same key, treated the key as already-held, and ignored the slot
//   switch → partial sequence (only anchor placed / only glowstone placed) on spam.
//
// Mouse-button slot key path:
//   Two mouse buttons cannot be toggled simultaneously, so we fall back to
//   sequential: hold slot button for SLOT_HOLD_MS, release, then right-click.
async function slotClick(key, token) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  const slotMouseBtn = PRESS_MOUSE_MAP[String(key)]
  if (slotMouseBtn) {
    // Mouse button as slot key — sequential to avoid simultaneous mouse buttons.
    try {
      await hw.mouse.toggle(slotMouseBtn, true)
      await sleep(SLOT_HOLD_MS, token)
      if (token?.cancelled) { await hw.mouse.toggle(slotMouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(slotMouseBtn, false)
    } catch (_) {}
    await rClickFixed(token)
    return
  }

  // Keyboard key — run sendKey (17ms hold) and mouse chain (10ms hold) concurrently,
  // await both so slotClick resolves only after keyup AND mouseup are sent.
  const { right } = getClickBinds()
  const bind = right || 'Mouse2'
  const mouseBtn = resolveMouseButton(bind)

  await Promise.all([
    hw.keyboard.sendKey(String(key).toLowerCase(), SLOT_HOLD_MS, 0).catch(() => {}),
    (async () => {
      if (token?.cancelled) return
      if (mouseBtn) {
        await hw.mouse.toggle(mouseBtn, true)
        await sleep(CLICK_HOLD_MS, token)
        await hw.mouse.toggle(mouseBtn, false).catch(() => {})
        return
      }
      try { await hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0) } catch (_) {}
    })()
  ])
}

// slotLClick — concurrent slot-switch + left-click for tick-sensitive swaps.
// Used by Lunge Swap so spear select and attack land in the same game tick.
async function slotLClick(key, token) {
  if (token?.cancelled) return
  if (!key || key === 'None') return

  const slotMouseBtn = PRESS_MOUSE_MAP[String(key)]
  if (slotMouseBtn) {
    try {
      await hw.mouse.toggle(slotMouseBtn, true)
      await sleep(SLOT_HOLD_MS, token)
      if (token?.cancelled) { await hw.mouse.toggle(slotMouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(slotMouseBtn, false)
    } catch (_) {}
    await lClickFixed(token)
    return
  }

  const { left } = getClickBinds()
  const bind = left || 'Mouse1'
  const mouseBtn = resolveMouseButton(bind)

  await Promise.all([
    hw.keyboard.sendKey(String(key).toLowerCase(), SLOT_HOLD_MS, 0).catch(() => {}),
    (async () => {
      if (token?.cancelled) return
      if (mouseBtn) {
        await hw.mouse.toggle(mouseBtn, true)
        await sleep(CLICK_HOLD_MS, token)
        await hw.mouse.toggle(mouseBtn, false).catch(() => {})
        return
      }
      try { await hw.keyboard.sendKey(String(bind).toLowerCase(), CLICK_HOLD_MS, 0) } catch (_) {}
    })()
  ])
}

async function lClick(token, holdMs) {
  if (token?.cancelled) return
  const { left } = getClickBinds()
  await _clickWithBind(left || 'Mouse1', token, holdMs)
}

// ── pressBare — press without re-focusing ─────────────────────────────────────
// Used inside anchor sequences after a single focusMc() at the top.
// Skipping repeated SetForegroundWindow calls saves ~2ms per keypress and
// eliminates the race where a rapid second focusMc() disturbs focus mid-sequence.
async function pressBare(key, token, holdMs = 1) {
  if (token?.cancelled) return
  if (!key || key === 'None') return
  const mouseBtn = PRESS_MOUSE_MAP[String(key)]
  if (mouseBtn) {
    try {
      await hw.mouse.toggle(mouseBtn, true)
      await sleep(holdMs, token)
      if (token?.cancelled) { await hw.mouse.toggle(mouseBtn, false).catch(() => {}); return }
      await hw.mouse.toggle(mouseBtn, false)
    } catch (_) {}
    return
  }
  try { await hw.keyboard.sendKey(String(key).toLowerCase(), holdMs, 0) } catch (_) {}
}

// ── SA — Single Anchor ────────────────────────────────────────────────────────
// Each step uses slotClick(): keydown and mousedown sent concurrently via the
// Win32 SendInput queue.  Queue ordering guarantees slot switch (keydown) is
// processed by GLFW before right-click (mousedown), so no sequential hold is
// needed between the two.  Step time = CLICK_HOLD_MS (10ms) vs the old 27ms.
//
// Sequence: anchor slot → rclick (place) → glowstone slot → rclick (charge)
//           → explode slot (or anchor slot if None) → rclick (detonate)
async function runSA(anchorKey, glowstoneKey, explodeKey, delay) {
  await startAnchorMacro('sa', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (explodeKey && explodeKey !== 'None') ? explodeKey : anchorKey

    focusLock.focusMc()
    await slotClick(anchorKey,    tok); await sleep(d, tok)
    await slotClick(glowstoneKey, tok); await sleep(d, tok)
    await slotClick(det,          tok)
  })
}

// ── DA — Double Anchor ────────────────────────────────────────────────────────
// Two full SA cycles back-to-back, separated by delay between them.
async function runDA(anchorKey, glowstoneKey, explodeKey, delay) {
  await startAnchorMacro('da', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (explodeKey && explodeKey !== 'None') ? explodeKey : anchorKey
    const cycleGap = d + 20  // extra buffer to avoid glowstone replacing the next anchor

    focusLock.focusMc()
    for (let i = 0; i < 2; i++) {
      await slotClick(anchorKey,    tok); await sleep(d, tok)
      await slotClick(glowstoneKey, tok); await sleep(d, tok)
      await slotClick(det,          tok)
      if (i === 0) await sleep(cycleGap, tok)
    }
  })
}

// ── AP — Anchor Pearl ─────────────────────────────────────────────────────────
// SA cycle, then throw an ender pearl immediately after detonation.
async function runAP(anchorKey, glowstoneKey, explodeKey, pearlKey, totemKey, delay) {
  await startAnchorMacro('ap', async tok => {
    const d   = Math.max(0, Number(delay))
    const det = (explodeKey && explodeKey !== 'None') ? explodeKey : anchorKey
    const endSwapKey = (explodeKey && explodeKey !== 'None')
      ? explodeKey
      : ((totemKey && totemKey !== 'None') ? totemKey : '9')

    focusLock.focusMc()
    await slotClick(anchorKey,    tok); await sleep(d, tok)
    await slotClick(glowstoneKey, tok); await sleep(d, tok)
    await slotClick(det,          tok); await sleep(d, tok)
    await pressBare(pearlKey,     tok, SLOT_HOLD_MS)
    await sleep(12, tok)
    await rClickFixed(tok)
    await sleep(Math.max(10, d), tok)
    await pressBare(endSwapKey,   tok, SLOT_HOLD_MS)
  })
}

// ── KP — Key Pearl ────────────────────────────────────────────────────────────
// Pattern break applies — 1 in 20 fires the pearl click is skipped.
async function runKP(pearlKey, returnKey, delay) {
  await startMacro('kp', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(pearlKey, tok);  await sleep(timing.vary(d), tok)
    if (!timing.shouldSkipClick()) await rClick(tok)
    await sleep(timing.vary(d), tok)
    await press(returnKey, tok)
  })
}

// ── IDH — Inventory D-Hand ────────────────────────────────────────────────────
// 1. Switch to totem hotbar slot
// 2. Open inventory immediately after (minimal delay — just enough for MC to
//    register the slot switch before the inventory key fires)
async function runIDH(inventoryKey, totemKey, delay) {
  await startMacro('idh', async tok => {
    const d = Math.max(0, Number(delay))
    await press(totemKey, tok)
    await sleep(timing.vary(d), tok)
    await press(inventoryKey, tok)
  })
}

// ── OHT — Offhand Totem ───────────────────────────────────────────────────────
async function runOHT(totemKey, swapKey, delay) {
  await startMacro('oht', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(totemKey, tok); await sleep(timing.vary(d), tok)
    await press(swapKey, tok)
  })
}

// ── ASB — Auto Shield Breaker ─────────────────────────────────────────────────
// Pattern break applies — 1 in 20 fires the attack click is skipped.
async function runASB(axeKey, swordKey, delay) {
  await startMacro('asb', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(axeKey, tok);   await sleep(timing.vary(d), tok)
    if (!timing.shouldSkipClick()) {
      await lClick(tok)
    }
    await sleep(timing.vary(d), tok)
    await press(swordKey, tok)
  })
}

// ── FXP — Fast XP (toggle) ───────────────────────────────────────────────────
// Pattern break applies — 1 in 20 ticks the click is skipped.
let _fxpActive = false
let _fxpTimer  = null

function startFXP(delay) {
  if (_fxpActive) return
  _fxpActive = true
  console.log('[macro:fxp] started')
  const d = Math.max(1, Number(delay) || 35)
  _fxpTimer = setInterval(async () => {
    if (_fxpActive && !timing.shouldSkipClick()) {
      await rClick(null)
    }
  }, d)
}

function stopFXP() {
  if (!_fxpActive) return
  _fxpActive = false
  clearInterval(_fxpTimer)
  _fxpTimer = null
  console.log('[macro:fxp] stopped')
}

// ── ES — Elytra Swap ──────────────────────────────────────────────────────────
// Switch to elytra slot → wait delay → right-click to equip → return to set key.
async function runES(elytraKey, returnKey, delay) {
  await startMacro('es', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    focusLock.focusMc()
    await pressBare(elytraKey, tok, SLOT_HOLD_MS)
    await sleep(timing.vary(d), tok)
    await rClickFixed(tok)
    await sleep(Math.max(12, d), tok)
    await pressBare(returnKey, tok, SLOT_HOLD_MS)
  })
}

// ── HC — Hit Crystal ──────────────────────────────────────────────────────────
// Swap to obsidian and place, then swap to crystal and place immediately.
async function runHC(obsidianKey, crystalKey, delay) {
  await startMacro('hc', async tok => {
    const d = Math.max(0, Number(delay))
    const step = Math.max(18, d) // ensure slot switch is polled before each place
    await sleep(20, tok)
    focusLock.focusMc()
    await pressBare(obsidianKey, tok, SLOT_HOLD_MS)
    await sleep(step, tok)
    await rClickMouse2Fixed(tok)
    await sleep(step, tok)
    await pressBare(crystalKey, tok, SLOT_HOLD_MS)
    await sleep(step, tok)
    await rClickMouse2Fixed(tok)
  })
}

// ── PC — Pearl Catch ──────────────────────────────────────────────────────────
// Switch to pearl → throw → wait delay ms → switch to wind charge → throw.
async function runPC(pearlKey, windChargeKey, delay) {
  await startMacro('pc', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(pearlKey, tok);      await rClick(tok)
    await sleep(timing.vary(d), tok)
    await press(windChargeKey, tok); await rClick(tok)
  })
}

// ── SS — Stun Slam ────────────────────────────────────────────────────────────
// Switch to axe → lClick (break shield) → wait delay → switch to mace → lClick.
async function runSS(axeKey, maceKey, delay) {
  await startMacro('ss', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(axeKey, tok)
    await lClick(tok)
    await sleep(timing.vary(d), tok)
    await press(maceKey, tok)
    await lClick(tok)
  })
}


// ── BS — Breach Swap ──────────────────────────────────────────────────────────
// Switch to mace → lClick (hit) → wait delay → switch back to sword.
async function runBS(maceKey, swordKey, delay) {
  await startMacro('bs', async tok => {
    const d = Math.max(0, Number(delay))
    await sleep(30, tok)
    await press(maceKey, tok)
    await lClick(tok)
    await sleep(timing.vary(d), tok)
    await press(swordKey, tok)
  })
}

// ── LS — Lunge Swap ───────────────────────────────────────────────────────────
// Attribute swap sequence in one tick:
// sword slot -> spear slot + hit -> sword slot
async function runLS(swordKey, spearKey) {
  await startMacro('ls', async tok => {
    focusLock.focusMc()
    await sleep(2, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
    await slotLClick(spearKey, tok)
    await sleep(8, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
    await sleep(4, tok)
    await pressBare(swordKey, tok, SLOT_HOLD_MS)
  })
}

// ── IC — Insta Cart ───────────────────────────────────────────────────────────
// Place rail first, then draw and release bow (arrow airborne), then place
// cart instantly — the arrow lands on the cart and detonates it.
// Aim toward where you want the cart before triggering.
async function runIC(railKey, bowKey, cartKey, bowHoldMs, delay) {
  await startMacro('ic', async tok => {
    const d      = Math.max(0, Number(delay))
    const holdMs = Math.max(50, Number(bowHoldMs))

    // Place rail
    await press(railKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
    await sleep(timing.vary(d), tok)

    // Draw and fire bow (arrow now in flight)
    await press(bowKey, tok)
    await sleep(timing.vary(d), tok)
    if (tok.cancelled) return
    await hw.mouse.toggle('right', true)
    await sleep(holdMs, tok)
    await hw.mouse.toggle('right', false)
    await sleep(timing.vary(d), tok)  // let Minecraft register the shot

    // Place cart — arrow already airborne
    await press(cartKey, tok)
    await rClick(tok)
  })
}

// ── XB — Crossbow Cart ────────────────────────────────────────────────────────
// Place rail, place cart, light the ground with flint & steel, then fire a
// pre-loaded crossbow through the fire to detonate the cart.
// Load the crossbow before triggering this macro.
async function runXB(railKey, cartKey, fnsKey, crossbowKey, delay) {
  await startMacro('xb', async tok => {
    const d = Math.max(0, Number(delay))

    await press(railKey, tok);     await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(cartKey, tok);     await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(fnsKey, tok);      await sleep(timing.vary(d), tok)
    await rClick(tok);             await sleep(timing.vary(d), tok)
    await press(crossbowKey, tok); await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── DR — Drain ────────────────────────────────────────────────────────────────
// Switch to bucket and scoop up water or lava instantly.
async function runDR(bucketKey, delay) {
  await startMacro('dr', async tok => {
    const d = Math.max(0, Number(delay))
    await press(bucketKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── LW — Lava Web ─────────────────────────────────────────────────────────────
// Place lava (burns enemies), immediately pick it back up (empty bucket),
// then lay a cobweb to trap them in the fire zone.
async function runLW(lavaKey, cobwebKey, delay) {
  await startMacro('lw', async tok => {
    const d = Math.max(0, Number(delay))
    await press(lavaKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // place lava
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // pick lava back up
    await sleep(timing.vary(d), tok)
    await press(cobwebKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)    // place cobweb
  })
}

// ── LA — Lava ─────────────────────────────────────────────────────────────────
// Switch to lava bucket and place instantly.
async function runLA(lavaKey, delay) {
  await startMacro('la', async tok => {
    const d = Math.max(0, Number(delay))
    await press(lavaKey, tok)
    await sleep(timing.vary(d), tok)
    await rClick(tok)
  })
}

// ── Stop everything ───────────────────────────────────────────────────────────
// Auto Crystal (hold): crystal slot -> right click -> left click, repeating.
let _acActive = false
let _acToken = null

function startAC(crystalKey, delay) {
  if (_acActive) return
  _acActive = true

  const tok = { cancelled: false, _cancel: null }
  _acToken = tok
  const slotKey = (crystalKey && crystalKey !== 'None') ? String(crystalKey) : '5'
  const d = Math.max(0, Number(delay) || 25)
  console.log('[macro:ac] started')

  ;(async () => {
    try {
      focusLock.focusMc()
      await sleep(2, tok)
      if (tok.cancelled || !_acActive) return

      // Switch to crystal slot once when the hold starts.
      await pressBare(slotKey, tok, SLOT_HOLD_MS)
      if (tok.cancelled || !_acActive) return

      while (_acActive && !tok.cancelled) {
        await rClickFixed(tok)
        await sleep(d, tok)
        if (tok.cancelled || !_acActive) break

        await lClickFixed(tok)
        await sleep(d, tok)
      }
    } catch (_) {
    } finally {
      if (_acToken === tok) {
        _acToken = null
        _acActive = false
      }
    }
  })()
}

function stopAC() {
  if (!_acActive && !_acToken) return
  _acActive = false
  const tok = _acToken
  _acToken = null
  if (tok) {
    tok.cancelled = true
    tok._cancel?.()
  }
  console.log('[macro:ac] stopped')
}

function stopAll() {
  // Clear queued anchor runs first so the finally-block chain doesn't fire them.
  Object.keys(macroQueue).forEach(id => delete macroQueue[id])
  Object.keys(macroTokens).forEach(id => {
    const tok = macroTokens[id]
    if (tok) { tok.cancelled = true; tok._cancel?.() }
  })
  stopFXP()
  stopAC()
}

module.exports = {
  runSA, runDA, runAP, runKP,
  runIDH, runOHT, runASB, startFXP, stopFXP, startAC, stopAC,
  runES, runPC, runSS, runBS, runHC, runLS,
  runIC, runXB, runDR, runLW, runLA,
  stopAll,
  setClickBinds
}


