'use strict';

/**
 * Compatibility shim for previous anti-vm monitor API.
 *
 * Old behavior performed frequent process scanning and could cause
 * false positives, forced exits, and stutter on some systems.
 * We keep the same exported methods used by main.js.
 */
let _timer = null;

function startMonitor(win) {
  stop();
  if (!win || win.isDestroyed?.()) return;

  // Lightweight heartbeat only; no process scanning, no forced close.
  _timer = setInterval(() => {
    if (!win || win.isDestroyed?.()) stop();
  }, 5000);

  win.on?.('closed', stop);
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}

module.exports = { startMonitor, stop };
