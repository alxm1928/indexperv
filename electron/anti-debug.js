'use strict';

/**
 * Stability-first anti-debug shim.
 *
 * Keep API compatibility with `antiDebug.enforce(win)` but avoid destructive
 * behavior that can terminate legitimate users' sessions.
 */
function enforce(win) {
  if (!win || win.isDestroyed?.()) return;

  // Never auto-close/kill on client machines.
  // Only hard-disable accidental devtools opening in packaged builds.
  try {
    if (process.env.NODE_ENV !== 'development' && !process.argv.includes('--dev')) {
      win.webContents?.on?.('devtools-opened', () => {
        try {
          win.webContents.closeDevTools();
        } catch {
          // no-op
        }
      });
    }
  } catch {
    // no-op
  }
}

module.exports = { enforce };
