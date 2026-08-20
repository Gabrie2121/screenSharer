const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron')
const path = require('path')
const fs = require('fs')

// ──────────────────────────────────────────────
// LOG BÁSICO (processo principal)
// Grava eventos do app em disco para facilitar suporte/depuração.
// ──────────────────────────────────────────────
const LOG_DIR = path.join(app.getPath('userData'), 'logs')
const LOG_FILE = path.join(LOG_DIR, 'main.log')

function log(level, message) {
  const line = `${new Date().toISOString()} [${level}] ${message}`
  console.log(line)
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true })
    fs.appendFileSync(LOG_FILE, line + '\n')
  } catch (err) {
    console.error('Falha ao gravar log:', err)
  }
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    backgroundColor: '#0f1117',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  // Deixa o Electron mostrar o seletor nativo de tela.
  // `audio: 'loopback'` captura o áudio de saída do Windows inteiro (tela toda),
  // que é exatamente o que o getDisplayMedia({ audio: true }) do renderer pede.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      // Pega a primeira tela disponível automaticamente
      callback({ video: sources[0], audio: 'loopback' })
    })
  })

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// Permite que o renderer também grave eventos no log básico do app
// (entrar em sala, iniciar/parar compartilhamento, erros, etc.)
ipcMain.on('renderer-log', (_e, level, message) => log(level, `[renderer] ${message}`))

ipcMain.on('window-minimize', (e) => BrowserWindow.fromWebContents(e.sender)?.minimize())
ipcMain.on('window-maximize', (e) => {
  const win = BrowserWindow.fromWebContents(e.sender)
  win?.isMaximized() ? win.unmaximize() : win.maximize()
})
ipcMain.on('window-close', (e) => BrowserWindow.fromWebContents(e.sender)?.close())

ipcMain.handle('get-sources', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
  })
  return sources.map((s) => ({
    id: s.id,
    name: s.name,
    thumbnail: s.thumbnail.toDataURL(),
  }))
})

app.whenReady().then(() => {
  log('INFO', '🚀 App iniciado')
  createWindow()
})
app.on('window-all-closed', () => {
  log('INFO', '🛑 Todas as janelas fechadas')
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })