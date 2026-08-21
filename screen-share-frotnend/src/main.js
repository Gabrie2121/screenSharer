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
  pendingManualCheck = false
  log('INFO', `Atualização disponível: v${info.version}`)
  mainWindow?.webContents.send('update-available', { version: info.version })
})

// Verificação automática no início fica silenciosa se não achar nada (senão
// toda abertura do app mostraria um aviso à toa); já uma checagem manual
// (clique no badge de versão) precisa de retorno pra pessoa saber que
// rodou e não achou nada — ver `pendingManualCheck`.
let pendingManualCheck = false

autoUpdater.on('update-not-available', () => {
  log('INFO', 'Nenhuma atualização disponível')
  if (pendingManualCheck) {
    pendingManualCheck = false
    mainWindow?.webContents.send('update-not-available')
  }
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
  pendingManualCheck = false
  log('ERROR', `Falha no auto-update: ${err.message}`)
  mainWindow?.webContents.send('update-error', { message: err.message })
})

ipcMain.on('update-start', () => {
  log('INFO', 'Usuário iniciou o download da atualização')
  autoUpdater.downloadUpdate()
})

// Só instala e reinicia quando a pessoa confirma — evita derrubar uma
// sessão de compartilhamento em andamento sem aviso (ver 'update-ready' acima).
// quitAndInstall(isSilent, isForceRunAfter): sem os argumentos, o Windows
// abre o instalador NSIS completo (escolher pasta, Next, Instalar, Concluir)
// toda vez que atualiza — exatamente o assistente que só faz sentido na
// primeira instalação. Com isSilent=true ele roda com a flag /S do NSIS
// (sem nenhuma UI, só substitui os arquivos) e isForceRunAfter=true garante
// que o app reabre sozinho depois — no modo silencioso isso não é automático.
ipcMain.on('update-install', () => {
  log('INFO', 'Usuário confirmou — instalando atualização (silenciosa) e reiniciando')
  autoUpdater.quitAndInstall(true, true)
})

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    log('INFO', 'Auto-update ignorado (app rodando em modo dev, não empacotado)')
    if (manual) {
      mainWindow?.webContents.send('update-error', {
        message: 'Checagem de atualização não disponível em modo de desenvolvimento.',
      })
    }
    return
  }
  if (manual) pendingManualCheck = true
  autoUpdater.checkForUpdates().catch((err) => {
    log('ERROR', `Falha ao verificar atualizações: ${err.message}`)
  })
}

// Verificação manual disparada pelo clique no badge de versão (ver app.js)
ipcMain.on('check-for-updates', () => {
  log('INFO', 'Usuário pediu verificação manual de atualização')
  checkForUpdates(true)
})

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
  //
  // A fonte a usar é a que a pessoa escolheu no modal "Escolher o que
  // compartilhar" (ver pendingSourceId, setado via IPC pouco antes do
  // getDisplayMedia() em captureSource/app.js) — `getDisplayMedia()` não
  // carrega esse id no `request`, por isso o vínculo é feito por fora.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    desktopCapturer.getSources({ types: ['screen', 'window'] }).then((sources) => {
      const match = sources.find((s) => s.id === pendingSourceId) || sources[0]
      callback({ video: match, audio: request.audioRequested ? 'loopback' : undefined })
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

// Fonte escolhida no modal de compartilhar (ver captureSource em app.js) —
// usada pelo setDisplayMediaRequestHandler acima.
let pendingSourceId = null
ipcMain.on('set-capture-source-id', (_e, id) => { pendingSourceId = id })

app.whenReady().then(() => {
  log('INFO', '🚀 App iniciado')
  createWindow()
})
app.on('window-all-closed', () => {
  log('INFO', '🛑 Todas as janelas fechadas')
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })