const { app, BrowserWindow, ipcMain, globalShortcut, dialog, shell } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawn } = require('child_process')

// Required for elevated (admin) mode — Chromium's sandbox cannot initialize
// when the process runs at high integrity level. This must be set before
// app.whenReady() / any BrowserWindow creation.
app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()

const _bootLogPaths = [
  path.join(os.tmpdir(), 'ZenithMacros-startup.log'),
]
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  _bootLogPaths.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'ZenithMacros-startup.log'))
}

const MAX_BOOT_LOG_BYTES = 2 * 1024 * 1024
const MAX_RUNTIME_LOG_BYTES = 2 * 1024 * 1024

function _trimLogFile(fp, maxBytes) {
  try {
    const st = fs.statSync(fp)
    if (!Number.isFinite(st.size) || st.size <= maxBytes) return
    fs.truncateSync(fp, 0)
  } catch (_) {}
}

function _bootLog(msg) {
  const line = `[${new Date().toISOString()}] ${String(msg)}\n`
  for (const fp of _bootLogPaths) {
    try {
      _trimLogFile(fp, MAX_BOOT_LOG_BYTES)
      fs.appendFileSync(fp, line, 'utf8')
    } catch (_) {}
  }
}

_bootLog(`startup pid=${process.pid} version=${app.getVersion()} exec=${process.execPath}`)
_bootLog(`platform=${process.platform} arch=${process.arch} os_release=${os.release()}`)

process.on('uncaughtException', (err) => {
  const msg = err?.stack || err?.message || String(err)
  _bootLog(`uncaughtException: ${msg}`)
})

process.on('unhandledRejection', (reason) => {
  const msg = reason?.stack || reason?.message || String(reason)
  _bootLog(`unhandledRejection: ${msg}`)
})

const { autoUpdater } = require('electron-updater')
const keysenderSafe = require('./keysender-safe')
const { LowLevelHook } = keysenderSafe
_bootLog('keysender init deferred')
const antiDebug  = require('./anti-debug')   // ← must be required before anything else
const procGuard  = require('./anti-vm')

// ── Auto-updater config ───────────────────────────────────────────────────────
autoUpdater.autoDownload        = true   // download in background automatically
autoUpdater.autoInstallOnAppQuit = true  // install when user closes the app
autoUpdater.autoRunAppAfterInstall = true
// Allow version-sequence resets (e.g. 1.20.x -> 1.1.x) when release cadence changes.
autoUpdater.allowDowngrade = String(process.env.ZENITH_UPDATER_ALLOW_DOWNGRADE || 'true').toLowerCase() !== 'false'
autoUpdater.logger              = null   // no log files on customer machines
const {
  activateKey,
  validateLicense,
  getStoredLicense,
  updateStoredLicense,
  clearLicense,
  buildSignedPayload,
  requestHwidReset
} = require('./license')
const engine      = require('../macros/engine')
const triggerbot  = require('../macros/triggerbot')
const input       = require('../macros/input')
const optimizer   = require('./optimizer')
const focusLock   = require('./focus-lock')
const stealth   = require('./stealth')
const tray      = require('./tray')
const settings  = require('./settings')
const nativeSecure = require('./native-secure')

_bootLog(`native-secure available=${nativeSecure.available} ${nativeSecure.available ? '' : (nativeSecure.errorMessage || '')}`)

let win
let _revalTimer = null
let _leaseTimer = null
let _runtimeLeaseUntil = Number.MAX_SAFE_INTEGER
let _runtimeUnlocked = false
let _lastLeaseSuccessAt = 0
let _leaseRefreshInFlight = false
let _latestMacroConfig = null
let _updateDownloaded = false
let _isShuttingDown = false
let _portableUpdatePath = null
let _portableUpdateChecking = false
let _portableInstallQueued = false
let _streamProofMode = false

const IS_PORTABLE_BUILD = Boolean(process.env.PORTABLE_EXECUTABLE_DIR)
const UPDATER_ENABLED = app.isPackaged && !IS_PORTABLE_BUILD
const UPDATER_ALLOW_DOWNGRADE = String(process.env.ZENITH_UPDATER_ALLOW_DOWNGRADE || 'true').toLowerCase() !== 'false'
const RELEASE_OWNER = 'harrisonjonathan05-dev'
const RELEASE_REPO = 'zenith-releases'
const APP_START_MS = Date.now()
const PANIC_STARTUP_GUARD_MS = 15000

const _singleInstance = app.requestSingleInstanceLock()
if (!_singleInstance) {
  _bootLog('second instance detected; exiting duplicate process')
  app.quit()
}

// AUTH REMOVED: LICENSE_API_BASE no longer used (was 'https://zenith-license.fly.dev')
const LEASE_REFRESH_MS = 45 * 1000
const LEASE_FAIL_GRACE_MS = 10 * 60 * 1000

function _runtimeAllowed() {
  return _runtimeUnlocked && Date.now() < _runtimeLeaseUntil
}

function _logUpdaterError(context, err) {
  const msg = err?.message || String(err || '')
  console.warn(`[updater] ${context}:`, msg)
  if (win && !win.isDestroyed()) {
    win.webContents.send('update-error', msg)
  }
}

function _appendRuntimeLog(msg) {
  try {
    const dir = app.getPath('userData')
    fs.mkdirSync(dir, { recursive: true })
    const fp = path.join(dir, 'runtime.log')
    _trimLogFile(fp, MAX_RUNTIME_LOG_BYTES)
    const line = `[${new Date().toISOString()}] ${String(msg)}\n`
    fs.appendFileSync(fp, line, 'utf8')
  } catch (_) {}
}

function _getKeysenderState() {
  const available = keysenderSafe.isAvailable()
  return {
    available,
    errorMessage: available ? '' : keysenderSafe.getErrorMessage()
  }
}

function _compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => Number(n) || 0)
  const pb = String(b || '').split('.').map((n) => Number(n) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const da = pa[i] || 0
    const db = pb[i] || 0
    if (da > db) return 1
    if (da < db) return -1
  }
  return 0
}

async function _downloadPortableUpdate(url, targetPath) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'ZenithMacros-Updater' },
    signal: AbortSignal.timeout(60 * 1000),
  })
  if (!res.ok) {
    throw new Error(`portable download failed (${res.status})`)
  }
  const buf = Buffer.from(await res.arrayBuffer())
  await fs.promises.mkdir(path.dirname(targetPath), { recursive: true })
  await fs.promises.writeFile(targetPath, buf)
}

function _isTrustedReleaseAssetUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''))
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === 'github.com'
      || host === 'objects.githubusercontent.com'
      || host.endsWith('.githubusercontent.com')
  } catch (_) {
    return false
  }
}

async function _checkPortableForUpdates() {
  if (_portableUpdateChecking) return
  _portableUpdateChecking = true
  try {
    const api = `https://api.github.com/repos/${RELEASE_OWNER}/${RELEASE_REPO}/releases/latest`
    const res = await fetch(api, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'ZenithMacros-Updater',
      },
      signal: AbortSignal.timeout(12 * 1000),
    })
    if (!res.ok) throw new Error(`portable update check failed (${res.status})`)

    const rel = await res.json()
    if (!rel || rel.draft || rel.prerelease) {
      if (win && !win.isDestroyed()) win.webContents.send('update-not-available')
      return
    }

    const latestVersion = String(rel.tag_name || '').replace(/^v/i, '').trim()
    const currentVersion = String(app.getVersion() || '').trim()
    const cmp = _compareVersions(latestVersion, currentVersion)
    if (!latestVersion || latestVersion === currentVersion || (!UPDATER_ALLOW_DOWNGRADE && cmp <= 0)) {
      if (win && !win.isDestroyed()) win.webContents.send('update-not-available')
      return
    }

    const expectedAsset = `ZenithMacros-${latestVersion}.exe`
    const asset = Array.isArray(rel.assets)
      ? rel.assets.find((a) => a && a.name === expectedAsset && a.browser_download_url)
      : null
    if (!asset) throw new Error(`portable asset not found for ${latestVersion}`)
    if (!_isTrustedReleaseAssetUrl(asset.browser_download_url)) {
      throw new Error('portable asset URL rejected')
    }

    const updateDir = path.join(app.getPath('temp'), 'zenith-portable-update')
    const updatePath = path.join(updateDir, expectedAsset)

    const hasCached =
      fs.existsSync(updatePath) &&
      Number.isFinite(Number(asset.size)) &&
      fs.statSync(updatePath).size === Number(asset.size)

    if (!hasCached) {
      await _downloadPortableUpdate(asset.browser_download_url, updatePath)
    }

    _portableUpdatePath = updatePath
    _updateDownloaded = true
    if (win && !win.isDestroyed()) win.webContents.send('update-ready')
  } catch (err) {
    _logUpdaterError('portable check failed', err)
  } finally {
    _portableUpdateChecking = false
  }
}

function _queuePortableInstall() {
  if (_portableInstallQueued) return false
  if (!_portableUpdatePath || !fs.existsSync(_portableUpdatePath)) return false
  if (!process.execPath || !/\.exe$/i.test(process.execPath)) return false

  const escape = (s) => String(s).replace(/"/g, '""')
  const scriptDir = path.join(app.getPath('temp'), 'zenith-portable-update')
  const scriptPath = path.join(scriptDir, 'apply-update.cmd')

  const script = [
    '@echo off',
    'setlocal',
    `set "PID=${process.pid}"`,
    `set "SRC=${escape(_portableUpdatePath)}"`,
    `set "DST=${escape(process.execPath)}"`,
    ':waitloop',
    'tasklist /FI "PID eq %PID%" 2>NUL | find "%PID%" >NUL',
    'if not errorlevel 1 (',
    '  timeout /t 1 /nobreak >NUL',
    '  goto waitloop',
    ')',
    'copy /Y "%SRC%" "%DST%" >NUL',
    'start "" "%DST%"',
    'del /Q "%SRC%" >NUL 2>&1',
    'del /Q "%~f0" >NUL 2>&1',
    'endlocal',
  ].join('\r\n')

  fs.mkdirSync(scriptDir, { recursive: true })
  fs.writeFileSync(scriptPath, script, 'utf8')
  const child = spawn('cmd.exe', ['/c', scriptPath], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  child.unref()
  _portableInstallQueued = true
  return true
}

function _setRuntimeUnlocked(unlocked, reason = '') {
  _runtimeUnlocked = !!unlocked
  _runtimeLeaseUntil = _runtimeUnlocked ? Date.now() + LEASE_FAIL_GRACE_MS : 0
  engine.setRuntimeGuard(_runtimeAllowed)
  if (_latestMacroConfig && _runtimeUnlocked) {
    engine.setConfig(_latestMacroConfig)
    engine.registerAll()
  }
}

function _isTransientLeaseStatus(status) {
  const s = Number(status) || 0
  return s === 408 || s === 425 || s === 429 || s >= 500
}

function _isInvalidSessionReason(reason = '') {
  return String(reason || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_') === 'INVALID_SESSION'
}

function _isHardInvalidReason(reason = '') {
  const r = String(reason || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '_')
  return r === 'HWID_MISMATCH'
    || r === 'KEY_NOT_FOUND'
    || r === 'INVALID_LICENSE_KEY'
    || r === 'INVALID_REQUEST_SIGNATURE'
    || r === 'MISSING_REQUEST_SIGNATURE'
    || r.includes('REVOKE')
    || r.includes('DEACTIVATED')
    || r.includes('EXPIRED')
    || r.includes('SIGNATURE')
}

function _handleTransientLeaseFailure(reason = '') {
  const now = Date.now()
  const cached = getStoredLicense()
  const expiresTs = Date.parse(String(cached?.expiresAt || ''))
  const notExpired = !Number.isFinite(expiresTs) || expiresTs > now
  if (cached?.valid && notExpired) {
    _runtimeLeaseUntil = now + Math.max(15 * 60 * 1000, LEASE_REFRESH_MS * 2, LEASE_FAIL_GRACE_MS)
    _setRuntimeUnlocked(true)
    if (reason) console.warn('[license] runtime lease temporary failure:', reason)
    return true
  }
  _setRuntimeUnlocked(false, reason || 'runtime lease grace expired')
  return false
}

async function _refreshRuntimeLease() {
  const result = await validateLicense()
  if (result?.valid) {
    _lastLeaseSuccessAt = Date.now()
    _runtimeLeaseUntil = Date.now() + LEASE_REFRESH_MS * 2
    _setRuntimeUnlocked(true)
    return true
  }
  if (_isTransientLeaseStatus(result?.status)) return _handleTransientLeaseFailure(result?.reason || 'temporary validation failure')
  _setRuntimeUnlocked(false, result?.reason || 'license validation failed')
  if (win && !win.isDestroyed()) win.webContents.send('license-revoked', result?.reason || 'LICENSE_INVALID')
  return false
}

function _applyStreamProofMode(enabled) {
  _streamProofMode = !!enabled
  if (!win || win.isDestroyed()) return
  try { win.setContentProtection(_streamProofMode) } catch (_) {}
}

function createWindow() {
  let rendererReloadAttempts = 0

  win = new BrowserWindow({
    width: 1100,
    height: 700,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    backgroundColor: '#0e0e10',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged   // DevTools completely off in production builds
    }
  })

  // Default behavior: allow screenshots/screenshares unless user explicitly
  // enables stream-proof mode in settings.
  _applyStreamProofMode(false)

  // Renderer is local-only; block renderer-initiated navigation/popups.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    const target = String(url || '')
    const current = String(win?.webContents?.getURL?.() || '')
    if (target && current && target !== current) event.preventDefault()
  })
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
    callback(false)
  })

  win.loadFile(path.join(__dirname, '../renderer/index.html'))

  // Spoof window title — what alt-tab, EnumWindows and AC scanners see.
  // Frame is hidden so customers never see this title.
  if (app.isPackaged) win.setTitle('RuntimeHelper')

  // Activate ongoing anti-debug protection for this window
  antiDebug.enforce(win)

  // Start process blacklist monitor (x64dbg, Cheat Engine, Fiddler, VMs, etc.)
  procGuard.startMonitor(win)

  win.on('closed', () => {
    win = null
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = String(details?.reason || 'unknown')
    const code = Number(details?.exitCode)
    _bootLog(`render-process-gone reason=${reason} code=${Number.isFinite(code) ? code : 'n/a'}`)
    _appendRuntimeLog(`renderer gone: reason=${reason} code=${Number.isFinite(code) ? code : 'n/a'}`)
    if (rendererReloadAttempts >= 2) return
    rendererReloadAttempts += 1
    setTimeout(() => {
      try {
        if (win && !win.isDestroyed()) win.webContents.reloadIgnoringCache()
      } catch (_) {}
    }, 400)
  })

  win.webContents.on('did-fail-load', (_event, code, desc, validatedURL) => {
    _bootLog(`did-fail-load code=${code} url=${validatedURL || 'n/a'} reason=${desc || 'unknown'}`)
  })

  win.on('unresponsive', () => {
    _bootLog('window unresponsive')
    _appendRuntimeLog('window unresponsive')
  })

  win.webContents.once('did-finish-load', () => {
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      const ksState = _getKeysenderState()
      if (ksState.available) return
      const errMsg = ksState.errorMessage || 'Unknown keysender load error'
      _appendRuntimeLog(`keysender unavailable: ${errMsg}`)
      if (!win.isDestroyed()) {
        win.webContents.send(
          'update-error',
          'Input driver failed to load. Reinstall ZenithMacros and Microsoft Visual C++ 2015-2022 x64.'
        )
      }
      try {
        dialog.showMessageBox(win, {
          type: 'warning',
          title: 'Input Driver Unavailable',
          message: 'ZenithMacros launched in safe mode.',
          detail: 'Native input driver could not load on this PC. Reinstall ZenithMacros and Microsoft Visual C++ 2015-2022 x64 runtime.',
          buttons: ['OK'],
          noLink: true,
        })
      } catch (_) {}
    }, 1200)

    // Validate the cached session before allowing the renderer to enter the app.
    _refreshRuntimeLease().then((validation) => {
      if (validation && win && !win.isDestroyed()) win.webContents.send('license-refreshed', { ...getStoredLicense(), valid: true })
    }).catch(() => {})

    // Check for updates silently — downloads in background, installs on quit.
    setTimeout(() => {
      if (!win || win.isDestroyed()) return
      if (UPDATER_ENABLED) {
        autoUpdater.checkForUpdates().catch((err) => _logUpdaterError('check failed', err))
      } else if (IS_PORTABLE_BUILD) {
        _checkPortableForUpdates()
      }
    }, 2500)
  })

  // Notify renderer when update is downloaded and ready to install
  autoUpdater.on('update-downloaded', () => {
    _updateDownloaded = true
    if (win && !win.isDestroyed()) win.webContents.send('update-ready')
  })
  autoUpdater.on('error', (err) => _logUpdaterError('runtime error', err))
  autoUpdater.on('update-not-available', () => {
    if (win && !win.isDestroyed()) win.webContents.send('update-not-available')
  })

  // Periodic session validation keeps revocations and bans enforced.
  _revalTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return
    await _refreshRuntimeLease()
  }, 5 * 60 * 1000)

  _leaseTimer = setInterval(async () => {
    if (!win || win.isDestroyed()) return
    await _refreshRuntimeLease()
  }, LEASE_REFRESH_MS)

  // Start focus-lock monitor
  focusLock.start(
    win, engine,
    // onRunningChanged
    (_running) => {},
    // onFocusChanged — auto-resume if MC loses focus mid-pause
    (focused) => {
      if (!focused) {
        if (_chatIsPaused) _resumeFromChat()
      }
    }
  )

  // Create system tray
  tray.create(win, engine, app, stealth)

  // Re-register saved keys on launch
  const saved = settings.getSettings()
  _applyStreamProofMode(saved.streamProofMode === true)
  input.setClickBinds({
    left:  saved.leftClickBind  || 'Mouse1',
    right: saved.rightClickBind || 'Mouse2'
  })
  // Restore optimizer applied-set and re-spawn timer if it was running before
  if (Array.isArray(saved.appliedOpts)) {
    optimizer.restoreApplied(saved.appliedOpts)
    if (saved.appliedOpts.includes('timer')) optimizer.applyOpt('timer')
  }
  if (saved.panicKey && saved.panicKey !== 'None') {
    _configuredPanicKey = saved.panicKey
    _registerPanicKey(saved.panicKey)
  }
  if (saved.chatKey && saved.chatKey !== 'None') {
    _configuredChatKey = saved.chatKey
    _registerChatKey(saved.chatKey)
  }

  // Always pause on '/' — Minecraft opens command chat on slash, just like T opens chat.
  // 'oem_2' is the Windows VK name for the /? key on US layouts.
  try {
    _slashUnlisten = LowLevelHook.on('keyboard', '/', true, _pauseForChat)
    console.log('[chat] slash (/) hook registered')
  } catch (err) {
    console.warn('[chat] slash hook error:', err.message)
  }
}

// ── Window controls ───────────────────────────────────────────────────────────
ipcMain.on('win-minimize', () => win.minimize())
ipcMain.on('win-maximize', () => {
  win.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('win-close', () => {
  _shutdown()
  win.close()
})

// ── License ───────────────────────────────────────────────────────────────────
ipcMain.handle('activate-key', async (e, key) => {
  const data = await activateKey(key)
  if (data?.valid) await _refreshRuntimeLease()
  return data
})
ipcMain.handle('get-license',  () => getStoredLicense())
ipcMain.handle('validate-license', async () => { const ok = await _refreshRuntimeLease(); return ok ? getStoredLicense() : { valid: false } })
ipcMain.handle('request-hwid-reset', async (_e, reason) => requestHwidReset(reason))
ipcMain.handle('discord-invite', () => 'https://discord.gg/perventversion2')
ipcMain.handle('clear-license', () => {
  clearLicense()
  _setRuntimeUnlocked(false, 'logged out')
  engine.setRuntimeGuard(_runtimeAllowed)
  return true
})
ipcMain.handle('app-version', () => app.getVersion())
// ── Updates ───────────────────────────────────────────────────────────────────
ipcMain.on('install-update', () => {
  if (!_updateDownloaded) return

  if (UPDATER_ENABLED) {
    _shutdown()
    try {
      autoUpdater.quitAndInstall(false, true)
    } catch (err) {
      _logUpdaterError('quitAndInstall failed', err)
      app.quit()
    }
    return
  }

  if (IS_PORTABLE_BUILD) {
    _shutdown()
    try {
      if (_queuePortableInstall()) app.quit()
    } catch (err) {
      _logUpdaterError('portable install queue failed', err)
      app.quit()
    }
  }
})

// ── External links ────────────────────────────────────────────────────────────
// Whitelist-only — renderer cannot open arbitrary URLs
function _isAllowedExternalUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length > 2048) return false
  try {
    const u = new URL(rawUrl)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    const allowedHosts = new Set([
      'perventclient.example',
      'discord.gg',
      'modrinth.com',
      'www.modrinth.com'
    ])
    return allowedHosts.has(host)
  } catch (_) {
    return false
  }
}

ipcMain.on('open-external', (e, url) => {
  if (_isAllowedExternalUrl(url)) {
    shell.openExternal(url).catch(() => {})
  }
})

// ── Macros ────────────────────────────────────────────────────────────────────
ipcMain.on('macro-config', (e, config) => {
  _latestMacroConfig = config
  if (!_runtimeUnlocked || !_runtimeAllowed()) { engine.stopAll(); return }
  engine.setConfig(config)
  engine.registerAll()
})
ipcMain.on('macro-stop-all', () => engine.stopAll())
ipcMain.on('focus-lock', (e, val) => engine.setFocusLock(val))

// Renderer reports active macro count → update tray tooltip
ipcMain.on('macro-count', (e, count) => {
  tray.updateMacroCount(count, win, engine, app, stealth)
})

// ── Stealth ───────────────────────────────────────────────────────────────────
ipcMain.on('toggle-stealth', () => stealth.toggle(win))

let currentStealthKey = null
ipcMain.on('set-stealth-key', (e, key) => {
  if (currentStealthKey) {
    try { globalShortcut.unregister(currentStealthKey) } catch (_) {}
    currentStealthKey = null
  }
  if (!key || key === 'None') return

  const accel = key
    .replace('Ctrl', 'CommandOrControl')
    .replace(/\+/g, '+')

  try {
    const ok = globalShortcut.register(accel, () => stealth.toggle(win))
    if (ok) {
      currentStealthKey = accel
      console.log('[stealth] Global hotkey registered:', accel)
    } else {
      console.warn('[stealth] Could not register global hotkey:', accel)
    }
  } catch (err) {
    console.warn('[stealth] Error registering hotkey:', err.message)
  }
})

// ── Key conversion ────────────────────────────────────────────────────────────
// Convert Electron accelerator format ("T", "Return", "F3") → keysender key names ("t", "enter", "f3")
function accelToKsKey(key) {
  if (!key || key === 'None') return null
  const base = key.split('+').pop()  // strip modifiers like "Ctrl+"
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
  }
  return map[base] || base.toLowerCase()
}

// ── Panic key ─────────────────────────────────────────────────────────────────
// Uses LowLevelHook so the key PASSES THROUGH to Minecraft too.
// On press, executes an emergency shutdown sequence and exits.

let _configuredPanicKey = null
let _panicUnlisten      = null

function _clearRuntimeSessionState(reason = 'panic key triggered') {
  // Panic clears the active runtime session and stops all macros
  _leaseRefreshInFlight = false
  engine.stopAll()
  if (reason) console.warn('[panic] runtime state cleared:', reason)
}

function _cleanupPanicArtifacts() {
  const files = new Set([
    ..._bootLogPaths,
    path.join(app.getPath('userData'), 'runtime.log'),
  ])
  for (const fp of files) {
    try {
      if (fp && fs.existsSync(fp)) fs.unlinkSync(fp)
    } catch (_) {}
  }
}

function _panicShutdown() {
  // Visually hide the app first so the action is immediate for the user.
  if (win && !win.isDestroyed()) {
    try { win.webContents.send('panic-all') } catch (_) {}
    try { win.hide() } catch (_) {}
  }

  try { engine.stopAll() } catch (_) {}
  try { triggerbot.stopTB() } catch (_) {}
  try { engine.setChatPaused(false) } catch (_) {}
  try { _clearRuntimeSessionState() } catch (_) {}
  _shutdown({ scrubRuntimeArtifacts: true })
}

function _registerPanicKey(key) {
  if (_panicUnlisten) { _panicUnlisten(); _panicUnlisten = null }
  if (!key || key === 'None') return

  const ksKey = accelToKsKey(key)
  if (!ksKey) return

  try {
    _panicUnlisten = LowLevelHook.on('keyboard', ksKey, true, () => {
      // Ignore accidental startup key-state glitches right after launch.
      if (Date.now() - APP_START_MS < PANIC_STARTUP_GUARD_MS) return
      console.log('[panic] Emergency shutdown triggered')
      _panicShutdown()
      app.quit()
    })
    console.log('[panic] Hook registered:', ksKey)
  } catch (err) {
    console.warn('[panic] Error registering hook:', err.message)
  }
}

ipcMain.on('set-panic-key', (e, key) => {
  _configuredPanicKey = (key && key !== 'None') ? key : null
  _registerPanicKey(key)
  settings.saveSettings({ panicKey: key })
})

// ── Chat pause ────────────────────────────────────────────────────────────────
// Uses LowLevelHook so the key PASSES THROUGH to Minecraft — chat opens naturally.
// On press: pauses all macros, registers Enter/Escape via LowLevelHook to resume.
// On resume: unregisters Enter/Escape hooks, re-registers macros.

let _configuredChatKey  = null  // desired key from renderer (Pro users only)
let _chatUnlisten       = null  // LowLevelHook.on unlisten fn for the chat key
let _slashUnlisten      = null  // permanent hook for '/' (opens Minecraft command chat)
let _chatEnterUnlisten  = null  // unlisten fn for Enter (resume)
let _chatEscapeUnlisten = null  // unlisten fn for Escape (resume)
let _chatResumeTimer    = null  // failsafe auto-resume timeout
let _chatIsPaused       = false
let _chatTimerSecs      = 10

function _pauseForChat() {
  if (_chatIsPaused) return
  if (!focusLock.isMcFocused()) return  // only pause when MC has focus
  _chatIsPaused = true

  // Stop macros while chat is open
  engine.setChatPaused(true)

  // MC receives the physical chat key naturally — no re-send needed.
  // Listen for Enter or Escape (pass-through) to resume macros after chat closes.
  _chatEnterUnlisten  = LowLevelHook.on('keyboard', 'enter',  true, _resumeFromChat)
  _chatEscapeUnlisten = LowLevelHook.on('keyboard', 'escape', true, _resumeFromChat)

  // Failsafe timer
  if (_chatResumeTimer) clearTimeout(_chatResumeTimer)
  _chatResumeTimer = setTimeout(_resumeFromChat, _chatTimerSecs * 1000)

  // Tell renderer to show the banner
  if (win && !win.isDestroyed()) win.webContents.send('chat-paused')
}

function _resumeFromChat() {
  if (!_chatIsPaused) return
  _chatIsPaused = false

  if (_chatResumeTimer) { clearTimeout(_chatResumeTimer); _chatResumeTimer = null }
  if (_chatEnterUnlisten)  { _chatEnterUnlisten();  _chatEnterUnlisten  = null }
  if (_chatEscapeUnlisten) { _chatEscapeUnlisten(); _chatEscapeUnlisten = null }

  engine.setChatPaused(false)

  // Tell renderer to hide the banner
  if (win && !win.isDestroyed()) win.webContents.send('chat-resumed')
}

function _registerChatKey(key) {
  if (_chatUnlisten) { _chatUnlisten(); _chatUnlisten = null }
  if (!key || key === 'None') return

  const ksKey = accelToKsKey(key)
  if (!ksKey) return

  try {
    _chatUnlisten = LowLevelHook.on('keyboard', ksKey, true, _pauseForChat)
    console.log('[chat] hook registered:', ksKey)
  } catch (err) {
    console.warn('[chat] error registering hook:', err.message)
  }
}

ipcMain.on('set-chat-key', (e, key) => {
  _configuredChatKey = (key && key !== 'None') ? key : null
  if (_configuredChatKey) {
    _registerChatKey(_configuredChatKey)
  } else {
    if (_chatUnlisten) { _chatUnlisten(); _chatUnlisten = null }
    if (_chatIsPaused) _resumeFromChat()
  }
  settings.saveSettings({ chatKey: key })
})

ipcMain.on('set-chat-timer', (e, secs) => {
  _chatTimerSecs = Number(secs) || 10
  settings.saveSettings({ chatTimer: secs })
})

// ── Optimizer ─────────────────────────────────────────────────────────────────
ipcMain.handle('apply-opt', async (e, id) => {
  const saved = settings.getSettings()
  const result = optimizer.applyOpt(id, saved.mcExePath || '')
  if (result.ok) settings.saveSettings({ appliedOpts: optimizer.getApplied() })
  return result
})

ipcMain.handle('revert-opt', async (e, id) => {
  const saved = settings.getSettings()
  const result = optimizer.revertOpt(id, saved.mcExePath || '')
  if (result.ok) settings.saveSettings({ appliedOpts: optimizer.getApplied() })
  return result
})

// Click binds (left/right) — affects all macros + triggerbot
ipcMain.on('set-click-binds', (e, binds) => {
  input.setClickBinds(binds || {})
})

// ── Settings ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-settings', () => settings.getSettings())
ipcMain.on('save-settings', (e, partial) => {
  settings.saveSettings(partial)
  if (partial && Object.prototype.hasOwnProperty.call(partial, 'streamProofMode')) {
    _applyStreamProofMode(partial.streamProofMode === true)
  }
})

// File picker for Minecraft exe path
ipcMain.handle('pick-mc-exe', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Select Minecraft launcher or javaw.exe',
    filters: [{ name: 'Executables', extensions: ['exe'] }],
    properties: ['openFile']
  })
  if (!result.canceled && result.filePaths.length > 0) {
    const exePath = result.filePaths[0]
    settings.saveSettings({ mcExePath: exePath })
    return exePath
  }
  return null
})

// ── Config persistence ────────────────────────────────────────────────────────
ipcMain.handle('load-macro-config', () => settings.getMacroConfig())
ipcMain.on('save-macro-config', (e, config) => settings.saveMacroConfig(config))

// ── Profiles ──────────────────────────────────────────────────────────────────
ipcMain.handle('get-profiles', () => ({
  profiles: settings.getProfiles(),
  activeProfile: settings.getActiveProfile(),
}))
ipcMain.on('save-profile', (e, { id, name, config }) => {
  settings.saveProfile(id, name, config)
})
ipcMain.on('delete-profile', (e, id) => settings.deleteProfile(id))
ipcMain.on('switch-profile', (e, id) => settings.setActiveProfile(id))
ipcMain.on('rename-profile', (e, { id, name }) => settings.renameProfile(id, name))

// ── Cleanup ───────────────────────────────────────────────────────────────────
function _shutdown(opts = {}) {
  const scrubRuntimeArtifacts = opts && opts.scrubRuntimeArtifacts === true
  if (_isShuttingDown) return
  _isShuttingDown = true
  if (_revalTimer)      { clearInterval(_revalTimer); _revalTimer = null }
  if (_leaseTimer)      { clearInterval(_leaseTimer); _leaseTimer = null }
  if (_chatResumeTimer) { clearTimeout(_chatResumeTimer); _chatResumeTimer = null }
  procGuard.stop()
  optimizer.cleanup()
  // Clean up all LowLevelHook listeners
  LowLevelHook.deleteAll()
  focusLock.stop()
  engine.stopAll()
  triggerbot.stopTB()
  tray.destroy()
  globalShortcut.unregisterAll()
  if (scrubRuntimeArtifacts) _cleanupPanicArtifacts()
}

// Spoof the app/window class name registered with Windows.
// EnumWindows and process scanners see "RuntimeHelper", not "ZenithMacros".
// The exe is already named RuntimeHelper.exe via executableName in package.json.
if (app.isPackaged) app.setName('RuntimeHelper')

app.whenReady().then(() => {
  if (!_singleInstance) return

  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.focus()
  })

  // Start locked until the license session is validated.
  _setRuntimeUnlocked(false, 'startup')
  createWindow()
  // Forward triggerbot active/inactive state to renderer for status display
  triggerbot.setStatusCallback((active) => {
    if (win && !win.isDestroyed()) win.webContents.send('tb-status', active)
  })
})

app.on('window-all-closed', () => {
  _shutdown()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  if (!IS_PORTABLE_BUILD) return
  if (!_updateDownloaded) return
  try {
    _queuePortableInstall()
  } catch (err) {
    _logUpdaterError('portable before-quit queue failed', err)
  }
})

