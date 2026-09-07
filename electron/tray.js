const { Tray, Menu, nativeImage } = require('electron')
const path = require('path')

let tray      = null
let macroCount = 0

function create(win, engine, app, stealth) {
  if (tray) return   // already exists

  const iconPath = path.join(__dirname, '../assets/tray.png')
  const icon     = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })

  tray = new Tray(icon)
  tray.setToolTip('ZenithMacros — 0 macros active')

  _rebuildMenu(win, engine, app, stealth)

  // Double-click → restore window
  tray.on('double-click', () => {
    stealth.deactivate(win)
  })
}

function _rebuildMenu(win, engine, app, stealth) {
  if (!tray) return

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show ZenithMacros',
      click: () => stealth.deactivate(win)
    },
    { type: 'separator' },
    {
      label: `Active macros: ${macroCount}`,
      enabled: false
    },
    {
      label: 'Stop all macros',
      click: () => {
        engine.stopAll()
        if (!win.isDestroyed()) {
          win.webContents.send('panic-all')
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Quit ZenithMacros',
      click: () => {
        engine.stopAll()
        app.quit()
      }
    }
  ])

  tray.setContextMenu(menu)
}

function updateMacroCount(count, win, engine, app, stealth) {
  macroCount = count
  if (!tray) return
  tray.setToolTip(`ZenithMacros — ${count} macro${count !== 1 ? 's' : ''} active`)
  _rebuildMenu(win, engine, app, stealth)
}

function destroy() {
  if (tray) {
    tray.destroy()
    tray = null
  }
}

module.exports = { create, updateMacroCount, destroy }
