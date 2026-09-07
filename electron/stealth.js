// stealth.js — hides the app window and removes it from the taskbar.
// Macros keep running. The tray icon is the only way back.

let stealthActive = false

function activate(win) {
  if (stealthActive) return
  stealthActive = true
  win.setSkipTaskbar(true)
  win.hide()
}

function deactivate(win) {
  if (!stealthActive) return
  stealthActive = false
  win.setSkipTaskbar(false)
  win.show()
  win.focus()
}

function toggle(win) {
  stealthActive ? deactivate(win) : activate(win)
}

function isActive() {
  return stealthActive
}

module.exports = { activate, deactivate, toggle, isActive }
