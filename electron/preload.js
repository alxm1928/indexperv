'use strict';

const { contextBridge, ipcRenderer } = require('electron');
const APP_VERSION = (() => {
  try {
    return String(require('../package.json')?.version || '').trim()
  } catch (_) {
    return ''
  }
})()

contextBridge.exposeInMainWorld('zenith', {
  version: APP_VERSION,
  getAppVersion: () => ipcRenderer.invoke('app-version'),
  minimize: () => ipcRenderer.send('win-minimize'),
  maximize: () => ipcRenderer.send('win-maximize'),
  close: () => ipcRenderer.send('win-close'),

  activateKey: (key) => ipcRenderer.invoke('activate-key', key),
  getLicense: () => ipcRenderer.invoke('get-license'),
  validateLicense: () => ipcRenderer.invoke('validate-license'),
  clearLicense: () => ipcRenderer.invoke('clear-license'),
  requestHwidReset: (reason) => ipcRenderer.invoke('request-hwid-reset', reason),
  getDiscordInvite: () => ipcRenderer.invoke('discord-invite'),
  onLicenseRevoked: (cb) => ipcRenderer.on('license-revoked', (_e, reason) => cb?.(reason)),
  onLicenseRefreshed: (cb) => ipcRenderer.on('license-refreshed', (_e, data) => cb?.(data)),

  sendMacroConfig: (config) => ipcRenderer.send('macro-config', config),
  stopAll: () => ipcRenderer.send('macro-stop-all'),
  setFocusLock: (enabled) => ipcRenderer.send('focus-lock', enabled),
  sendMacroCount: (count) => ipcRenderer.send('macro-count', count),

  toggleStealth: () => ipcRenderer.send('toggle-stealth'),
  setStealthKey: (key) => ipcRenderer.send('set-stealth-key', key),
  setPanicKey: (key) => ipcRenderer.send('set-panic-key', key),

  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.send('save-settings', settings),
  pickMcExe: () => ipcRenderer.invoke('pick-mc-exe'),

  loadMacroConfig: () => ipcRenderer.invoke('load-macro-config'),
  saveMacroConfig: (config) => ipcRenderer.send('save-macro-config', config),

  getProfiles: () => ipcRenderer.invoke('get-profiles'),
  saveProfile: (id, name, config) => ipcRenderer.send('save-profile', { id, name, config }),
  renameProfile: (id, name) => ipcRenderer.send('rename-profile', { id, name }),
  deleteProfile: (id) => ipcRenderer.send('delete-profile', id),
  switchProfile: (id) => ipcRenderer.send('switch-profile', id),

  onFocusChanged: (cb) => ipcRenderer.on('focus-lock-changed', (_e, hasFocus) => cb?.(hasFocus)),
  onMcRunning: (cb) => ipcRenderer.on('mc-running-changed', (_e, running) => cb?.(running)),
  onPanicAll: (cb) => ipcRenderer.on('panic-all', () => cb?.()),

  setClickBinds: (cfg) => ipcRenderer.send('set-click-binds', cfg),

  applyOpt: (id) => ipcRenderer.invoke('apply-opt', id),
  revertOpt: (id) => ipcRenderer.invoke('revert-opt', id),

  setChatKey: (key) => ipcRenderer.send('set-chat-key', key),
  setChatTimer: (ms) => ipcRenderer.send('set-chat-timer', ms),
  onChatPaused: (cb) => ipcRenderer.on('chat-paused', () => cb?.()),
  onChatResumed: (cb) => ipcRenderer.on('chat-resumed', () => cb?.()),

  onUpdateReady: (cb) => ipcRenderer.on('update-ready', () => cb?.()),
  installUpdate: () => ipcRenderer.send('install-update'),

  openExternal: (url) => ipcRenderer.send('open-external', url),
  onTbStatus: (cb) => ipcRenderer.on('tb-status', (_e, active) => cb?.(active)),
});
