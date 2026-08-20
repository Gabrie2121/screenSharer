const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron')
const { autoUpdater } = require('electron-updater')
const path = require('path')
const fs = require('fs')

let mainWindow = null

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

// ──────────────────────────────────────────────
// AUTO-UPDATE
// Verifica o GitHub Releases (config em package.json → build.publish) e
// avisa o renderer, que mostra o botão de atualização no canto inferior
// esquerdo da sidebar. O download/instalação só rodam quando a pessoa clica.
// ──────────────────────────────────────────────
autoUpdater.autoDownload = false
autoUpdater.autoInstallOnAppQuit = false
autoUpdater.logger = {
  info:  (msg) => log('INFO', `[updater] ${msg}`),
  warn:  (msg) => log('WARN', `[updater] ${msg}`),
  error: (msg) => log('ERROR', `[updater] ${msg}`),
}

autoUpdater.on('update-available', (info) => {
  log('INFO', `Atualização disponível: v${info.version}`)
  mainWindow?.webContents.send('update-available', { version: info.version })
})

autoUpdater.on('update-not-available', () => {
  log('INFO', 'Nenhuma atualização disponível')
})

autoUpdater.on('download-progress', (progress) => {
  mainWindow?.webContents.send('update-download-progress', {
    percent: Math.round(progress.percent),
  })
})

autoUpdater.on('update-downloaded', () => {
  log('INFO', 'Atualização baixada — aguardando confirmação do usuário para reiniciar')
  mainWindow?.webContents.send('update-ready')
})

autoUpdater.on('error', (err) => {
  log('ERROR', `Falha no auto-update: ${err.message}`)
  mainWindow?.webContents.send('update-error', { message: err.message })
})

ipcMain.on('update-start', () => {
  log('INFO', 'Usuário iniciou o download da atualização')
  autoUpdater.downloadUpdate()
})

// Só instala e reinicia quando a pessoa confirma — evita derrubar uma
// sessão de compartilhamento em andamento sem aviso (ver 'update-ready' acima).
ipcMain.on('update-install', () => {
  log('INFO', 'Usuário confirmou — instalando atualização e reiniciando')
  autoUpdater.quitAndInstall()
})

function checkForUpdates() {
  if (!app.isPackaged) {
    log('INFO', 'Auto-update ignorado (app rodando em modo dev, não empacotado)')
    return
  }
  autoUpdater.checkForUpdates().catch((err) => {
    log('ERROR', `Falha ao verificar atualizações: ${err.message}`)
  })
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
  // Só tenta o loopback quando o renderer realmente pediu áudio
  // (`request.audioRequested`) — o renderer cai pra um retry só de vídeo
  // quando a captura de áudio falha (ver captureSource em app.js), e se
  // aqui a gente forçasse 'loopback' sempre, esse retry falharia igual.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      // Pega a primeira tela disponível automaticamente
      callback({ video: sources[0], audio: request.audioRequested ? 'loopback' : undefined })
    })
  })

  // Só checa atualizações depois que o renderer termina de carregar —
  // do contrário 'update-available' pode ser enviado antes do listener
  // IPC ser registrado em app.js, e o Electron não bufferiza a mensagem.
  win.webContents.once('did-finish-load', () => checkForUpdates())

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  mainWindow = win
  win.on('closed', () => { if (mainWindow === win) mainWindow = null })
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

// Versão exibida no canto inferior esquerdo (ver context.MD → Features)
ipcMain.handle('get-app-version', () => app.getVersion())

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