/* ═══════════════════════════════════════════════════════════════
   ShareSync — Renderer
   Responsabilidades:
   - Conecta ao backend via WebSocket
   - Gerencia sinalização WebRTC (offer/answer/ICE)
   - Exibe streams de quem o usuário escolher assistir
   - Permite compartilhar a própria tela
═══════════════════════════════════════════════════════════════ */

// ──────────────────────────────────────────────
// ESTADO
// ──────────────────────────────────────────────
const SELF_PREVIEW_KEY = 'sharesync:show-self-preview'
const DEFAULT_WATCH_QUALITY_KEY = 'sharesync:default-watch-quality'
const SHARE_AUDIO_KEY = 'sharesync:share-audio'

const state = {
  myId:      null,
  myName:    '',
  roomId:    null,
  serverUrl: '',

  // WebSocket
  ws: null,

  // Cada par de usuários pode ter DUAS conexões independentes, uma pra
  // cada sentido — "eu assisto ele" e "ele assiste eu" são coisas
  // diferentes e podem estar ativas ao mesmo tempo (assistir mútuo).
  // Antes isso dividia uma única RTCPeerConnection por usuário, e cada
  // offer recém-chegada substituía a conexão existente por baixo do pano
  // — causava colisão de sinalização (glare) e a tela ficava preta pro
  // outro lado quando os dois se assistiam ao mesmo tempo.
  // watchPeers: { userId: RTCPeerConnection } — eu sou o offerer, só recebo
  watchPeers: {},
  // sharePeers: { userId: RTCPeerConnection } — eu sou o answerer, só envio
  sharePeers: {},

  // Streams recebidos: { userId: MediaStream }
  remoteStreams: {},

  // Usuários na sala: { userId: { username, sharing } }
  users: {},

  // Quem estou assistindo (stream já chegou e está exibindo)
  watching: new Set(),

  // Quem eu pedi pra assistir mas a negociação WebRTC ainda não terminou
  // (ver toggleWatch) — importante pra não mostrar "Assistindo" antes da
  // hora: isso fazia a pessoa clicar de novo achando que travou, cancelando
  // a conexão bem na hora em que o vídeo chegava (video.play() interrompido
  // porque o card foi removido no meio do play — DOMException no console).
  connecting: new Set(),

  // Minha stream local (quando compartilho) — por padrão não aparece na
  // tela, só é usada pra enviar aos outros participantes. Opcionalmente
  // (ver checkbox "Mostrar minha tela") aparece numa prévia local mudinha
  // no canto inferior direito (ver updateSelfPreview).
  localStream: null,
  sharing: false,

  // Preferência de mostrar a autovisualização — persiste em sessionStorage
  // (SELF_PREVIEW_KEY) e vira o padrão pras próximas vezes que compartilhar.
  showSelfPreview: sessionStorage.getItem(SELF_PREVIEW_KEY) === 'true',

  // Qualidade padrão ao começar a assistir alguém (Configurações → Live) —
  // 'auto' ou uma altura em px ('360'/'480'/'720'/'1080'). Dá pra mudar na
  // hora por live, no seletor de cada card (ver upsertStreamCard).
  defaultWatchQuality: sessionStorage.getItem(DEFAULT_WATCH_QUALITY_KEY) || 'auto',

  // Stream em foco na tela (as demais ficam minimizadas embaixo)
  focusedId: null,

  // Medição de latência (ping)
  pingInterval: null,
  pingWaiting: false,

  // Timeouts de "assistir" pendente — evita loading infinito (ver toggleWatch)
  watchTimeouts: {},

  // Intervalos que leem getStats() pra mostrar resolução/bitrate reais
  // recebidos em cada card (ver upsertStreamCard) — prova concreta de que
  // o seletor de qualidade está realmente mudando o que chega pela rede.
  statsIntervals: {},
}

// ──────────────────────────────────────────────
// ICE SERVERS (STUN + TURN)
// STUN sozinho só resolve o IP público — quando as duas pontas estão em
// redes diferentes (NAT restritivo/CGNAT de operadora, por trás de
// firewall, etc.) a conexão direta não fecha e o ICE cai em "failed" sem
// um TURN pra retransmitir a mídia. As credenciais abaixo são do Open
// Relay Project (metered.ca) — gratuitas e compartilhadas, então servem
// pra destravar o uso entre amigos, mas não são garantia de uptime/banda
// pra produção. Se a instabilidade continuar, considere subir um coturn
// próprio ou um TURN pago.
// ──────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.relay.metered.ca:80' },
    {
      urls: 'turn:global.relay.metered.ca:80',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
    {
      urls: 'turn:global.relay.metered.ca:443?transport=tcp',
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
}

// ──────────────────────────────────────────────
// HELPERS UI
// ──────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

// Log básico — imprime no console e grava no arquivo de log do app
// (via processo principal, ver src/main.js).
function appLog(level, message) {
  console.log(`[${level}] ${message}`)
  window.electronAPI?.log(level, message)
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'))
  $(`screen-${name}`).classList.add('active')
}

function showError(msg) {
  const el = $('login-error')
  el.textContent = msg
  el.classList.remove('hidden')
}

function hideError() { $('login-error').classList.add('hidden') }

let toastTimer = null
function toast(msg) {
  const t = $('toast')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => t.classList.remove('show'), 2500)
}

// Toast de cima, com borda verde — separado do de baixo (que fica pra
// "alguém entrou"/erros/etc.) pra avisos de "alguém compartilhou a tela"
// não brigarem pelo mesmo espaço.
let toastTopTimer = null
function toastTop(msg) {
  const t = $('toast-top')
  t.textContent = msg
  t.classList.add('show')
  t.classList.remove('hidden')
  clearTimeout(toastTopTimer)
  toastTopTimer = setTimeout(() => t.classList.remove('show'), 3000)
}

// Aviso sonoro quando alguém começa a compartilhar — src/assets/holy.mp3
// (caminho relativo a este arquivo, src/renderer/app.js). Fica em 40% do
// volume o tempo todo e corta em 1s — o arquivo original dura mais que
// isso, mas só precisamos do começo como aviso rápido.
const shareSound = new Audio('../assets/holy.mp3')
shareSound.volume = 0.4
let shareSoundCutTimer = null

function playShareSound() {
  try {
    shareSound.currentTime = 0
    shareSound.play().catch((err) => {
      console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
    })
    clearTimeout(shareSoundCutTimer)
    shareSoundCutTimer = setTimeout(() => {
      shareSound.pause()
      shareSound.currentTime = 0
    }, 1000)
  } catch (err) {
    console.warn('[SOM] Falha ao tocar aviso de compartilhamento:', err)
  }
}

// ──────────────────────────────────────────────
// TITLEBAR
// ──────────────────────────────────────────────
$('btn-min').onclick   = () => window.electronAPI?.minimize()
$('btn-max').onclick   = () => window.electronAPI?.maximize()
$('btn-close').onclick = () => window.electronAPI?.close()

// ──────────────────────────────────────────────
// VERSÃO DO APP — canto inferior esquerdo, em toda a tela do sistema.
// Também funciona como botão de "verificar atualização" manual (antes só
// checava sozinho ao abrir o app, sem jeito de forçar uma nova checagem).
// ──────────────────────────────────────────────
const appVersionBtn = $('app-version')
let appVersionLabel = ''
let checkingUpdate = false

window.electronAPI?.getAppVersion().then((version) => {
  appVersionLabel = `v${version}`
  appVersionBtn.textContent = appVersionLabel
})

appVersionBtn.onclick = () => {
  if (checkingUpdate) return
  checkingUpdate = true
  appVersionBtn.textContent = 'Verificando…'
  appLog('INFO', 'Usuário pediu verificação manual de atualização')
  window.electronAPI?.checkForUpdates()
}

window.electronAPI?.onUpdateNotAvailable(() => {
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  toast('Você já está na versão mais recente.')
})

// ──────────────────────────────────────────────
// ATUALIZAÇÃO DO APP
// Botão fica escondido até o processo principal avisar que há uma versão
// nova (ver src/main.js). Um clique baixa, instala e reinicia sozinho.
// ──────────────────────────────────────────────
const btnUpdate = $('btn-update')
const updateText = $('update-text')

// Depois que o download termina, a atualização só é instalada quando a
// pessoa confirma clicando de novo — reiniciar sozinho derrubaria uma
// sessão de compartilhamento em andamento sem aviso.
let updateReady = false

btnUpdate.onclick = () => {
  if (btnUpdate.disabled) return

  if (updateReady) {
    appLog('INFO', 'Usuário confirmou reinício para instalar a atualização')
    window.electronAPI?.installUpdate()
    return
  }

  btnUpdate.disabled = true
  btnUpdate.classList.remove('error')
  updateText.textContent = 'Baixando atualização…'
  appLog('INFO', 'Download de atualização iniciado pelo usuário')
  window.electronAPI?.startUpdate()
}

window.electronAPI?.onUpdateAvailable(({ version }) => {
  appLog('INFO', `Nova versão disponível: v${version}`)
  checkingUpdate = false
  appVersionBtn.textContent = appVersionLabel
  updateReady = false
  btnUpdate.classList.remove('hidden', 'error')
  btnUpdate.disabled = false
  updateText.textContent = `Atualizar para v${version}`
})

window.electronAPI?.onUpdateProgress(({ percent }) => {
  updateText.textContent = `Baixando atualização… ${percent}%`
})

window.electronAPI?.onUpdateReady(() => {
  appLog('INFO', 'Atualização baixada — aguardando confirmação para reiniciar')
  updateReady = true
  btnUpdate.classList.remove('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Reiniciar para atualizar'
})

window.electronAPI?.onUpdateError(({ message }) => {
  appLog('ERROR', `Falha na atualização: ${message}`)
  // Se o erro veio de uma checagem manual (clique no badge de versão), o
  // botão de atualização ainda não apareceu — sem isso a pessoa clicava e
  // não via nenhum retorno.
  if (checkingUpdate) {
    checkingUpdate = false
    appVersionBtn.textContent = appVersionLabel
    toast(`Não foi possível verificar atualizações: ${message}`)
  }
  updateReady = false
  btnUpdate.classList.add('error')
  btnUpdate.disabled = false
  updateText.textContent = 'Erro ao atualizar — tentar de novo'
})

// ──────────────────────────────────────────────
// LOGIN
// ──────────────────────────────────────────────
$('btn-create-room').onclick = async () => {
  const name = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  if (!name) return showError('Digite seu nome para continuar.')
  hideError()

  // Cria sala via REST
  const httpUrl = server.replace(/^ws/, 'http')
  try {
    const res = await fetch(`${httpUrl}/api/rooms/`, { method: 'POST' })
    const data = await res.json()
    enterRoom(name, server, data.room_id)
  } catch {
    showError('Não foi possível conectar ao servidor. Verifique o endereço.')
  }
}

$('btn-join-room').onclick = () => {
  const name   = $('input-name').value.trim()
  const server = $('input-server').value.trim()
  const roomId = $('input-room-id').value.trim()
  if (!name)   return showError('Digite seu nome.')
  if (!roomId) return showError('Digite o código da sala.')
  hideError()
  enterRoom(name, server, roomId)
}

// ──────────────────────────────────────────────
// ENTRAR NA SALA
// ──────────────────────────────────────────────
function enterRoom(name, server, roomId) {
  state.myName   = name
  state.serverUrl = server
  state.roomId   = roomId
  manualDisconnect = false

  $('display-room-id').textContent = roomId
  showScreen('room')
  appLog('INFO', `Entrando na sala ${roomId} como "${name}" (servidor: ${server})`)
  connectWebSocket()
}

// ──────────────────────────────────────────────
// WEBSOCKET
// ──────────────────────────────────────────────
// Se o servidor cair, tenta reconectar sozinho a cada 5s até voltar (ou até
// a pessoa sair da sala de propósito — ver btn-leave, que desarma isso).
let manualDisconnect = false
let reconnectTimer = null
let isReconnecting = false

function scheduleReconnect() {
  if (manualDisconnect || reconnectTimer) return
  isReconnecting = true
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    appLog('INFO', 'Tentando reconectar ao servidor…')
    connectWebSocket()
  }, 5000)
}

function connectWebSocket() {
  const url = `${state.serverUrl}/ws/${state.roomId}`
  state.ws = new WebSocket(url)

  state.ws.onopen = () => {
    sendWS({ type: 'join-room', username: state.myName })
    toast(isReconnecting ? 'Reconectado à sala!' : 'Conectado à sala!')
    isReconnecting = false
    startPing()
  }

  state.ws.onmessage = (event) => handleMessage(JSON.parse(event.data))

  state.ws.onerror = () => {
    appLog('ERROR', `Erro de conexão WebSocket com ${url}`)
    if (!isReconnecting) toast('Erro de conexão com o servidor.')
  }

  state.ws.onclose = () => {
    appLog('WARN', 'Desconectado do servidor.')
    // Limpa peers
    Object.values(state.watchPeers).forEach(pc => pc.close())
    Object.values(state.sharePeers).forEach(pc => pc.close())
    state.watchPeers = {}
    state.sharePeers = {}
    stopPing()

    if (manualDisconnect) return

    // Só avisa uma vez quando cai — não fica repetindo toast a cada
    // tentativa de reconexão que falha (checa de 5 em 5s até voltar).
    if (!isReconnecting) toast('Desconectado do servidor. Tentando reconectar…')
    scheduleReconnect()
  }
}

function sendWS(obj) {
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(obj))
  }
}

// ──────────────────────────────────────────────
// PING — latência com o servidor (barrinhas + ms)
// ──────────────────────────────────────────────
function startPing() {
  stopPing()
  const tick = () => {
    if (state.ws?.readyState !== WebSocket.OPEN) return
    state.pingWaiting = true
    sendWS({ type: 'ping', payload: { t: Date.now() } })
  }
  tick()
  state.pingInterval = setInterval(tick, 3000)
}

function stopPing() {
  clearInterval(state.pingInterval)
  state.pingInterval = null
  updatePingUI(null)
}

function handlePong(payload) {
  state.pingWaiting = false
  const sentAt = payload?.t
  if (!sentAt) return
  updatePingUI(Date.now() - sentAt)
}

function updatePingUI(ms) {
  const box = $('ping-box')
  const msEl = $('ping-ms')
  if (ms == null) {
    box.dataset.level = '0'
    msEl.textContent = '-- ms'
    return
  }
  msEl.textContent = `${ms} ms`
  let level = 4
  if (ms > 400) level = 1
  else if (ms > 200) level = 2
  else if (ms > 100) level = 3
  box.dataset.level = String(level)
}

// ──────────────────────────────────────────────
// MENSAGENS DO SERVIDOR
// ──────────────────────────────────────────────
async function handleMessage(msg) {
  switch (msg.type) {

    // Entrei na sala — recebo meu ID e lista de usuários
    case 'room-info':
      state.myId = msg.user_id
      state.users = {}
      for (const [uid, u] of Object.entries(msg.users || {})) {
        if (uid !== state.myId) {
          state.users[uid] = u
        }
      }
      renderParticipants()
      break

    // Novo usuário entrou
    case 'user-joined':
      if (msg.user_id !== state.myId) {
        state.users[msg.user_id] = { username: msg.username, sharing: false }
        renderParticipants()
        toast(`${msg.username} entrou na sala`)
      }
      break

    // Usuário saiu
    case 'user-left':
      toast(`${msg.username || 'Alguém'} saiu da sala`)
      removeUser(msg.user_id)
      break

    // Alguém começou a compartilhar
    case 'user-sharing':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].sharing = true
        renderParticipants()
        // Toast de cima (borda verde) — separado do toast de baixo, que
        // fica só pra entrada/saída de gente na sala e outros avisos.
        toastTop(`${msg.username} está compartilhando a tela`)
        playShareSound()
      }
      break

    // Alguém parou de compartilhar
    case 'user-stopped-sharing':
      if (state.users[msg.user_id]) {
        state.users[msg.user_id].sharing = false
        stopWatchTimeout(msg.user_id)
        state.watching.delete(msg.user_id)
        state.connecting.delete(msg.user_id)
        renderParticipants()
        removeStreamCard(msg.user_id)
        // Só fecha a conexão em que EU assistia essa pessoa — se ela
        // também estiver me assistindo, essa outra conexão continua de pé.
        closeWatchPeer(msg.user_id)
      }
      break

    // ── WebRTC ──
    case 'offer':
      await handleOffer(msg.from, msg.payload)
      break

    case 'answer':
      await handleAnswer(msg.from, msg.payload)
      break

    case 'ice-candidate':
      await handleIceCandidate(msg.from, msg.payload)
      break

    // Quem está assistindo pediu outra resolução (economia de banda)
    case 'set-quality':
      await applyViewerQuality(msg.from, msg.payload?.height ?? null)
      break

    // Resposta do ping — mede a latência com o servidor
    case 'pong':
      handlePong(msg.payload)
      break
  }
}

// ──────────────────────────────────────────────
// PARTICIPANTES — RENDER
// ──────────────────────────────────────────────
function renderParticipants() {
  const list = $('participants-list')
  list.innerHTML = ''

  // Eu mesmo
  const meLi = makeParticipantItem(state.myId, state.myName, state.sharing, true)
  list.appendChild(meLi)

  // Outros
  for (const [uid, u] of Object.entries(state.users)) {
    const li = makeParticipantItem(uid, u.username, u.sharing, false)
    list.appendChild(li)
  }
}

function makeParticipantItem(uid, name, sharing, isMe) {
  const li = document.createElement('li')
  li.className = 'participant-item'
  li.dataset.uid = uid

  const initial = name[0]?.toUpperCase() || '?'
  const statusText = sharing
    ? (isMe ? '● Compartilhando' : '● Compartilhando')
    : (isMe ? 'Você' : 'Participante')

  const watching   = state.watching.has(uid)
  const connecting = state.connecting.has(uid)
  const watchLabel = connecting ? 'Conectando…' : (watching ? 'Parar de assistir' : 'Assistir')

  li.innerHTML = `
    <div class="participant-avatar">${initial}</div>
    <div class="participant-info">
      <div class="participant-name">${name}${isMe ? ' (você)' : ''}</div>
      <div class="participant-status ${sharing ? 'sharing' : ''}">${statusText}</div>
    </div>
    ${(!isMe && sharing)
      ? `<button class="btn-watch ${watching ? 'watching' : ''} ${connecting ? 'connecting' : ''}" data-uid="${uid}">
           ${watchLabel}
         </button>`
      : ''}
  `

  const watchBtn = li.querySelector('.btn-watch')
  if (watchBtn) {
    watchBtn.onclick = () => toggleWatch(uid)
  }

  return li
}

// ──────────────────────────────────────────────
// ASSISTIR / PARAR DE ASSISTIR
// ──────────────────────────────────────────────
// Precisa ser folgado o bastante pra não cancelar uma conexão que ainda
// está negociando o fallback TURN via TCP/443 (ver ICE_CONFIG acima) —
// em redes restritivas essa negociação sozinha pode levar vários segundos.
const WATCH_TIMEOUT_MS = 25000

async function toggleWatch(uid) {
  if (state.watching.has(uid)) {
    // Para de assistir (ou cancela uma conexão ainda "Conectando…") —
    // fecha só a MINHA conexão de assistir. Se essa pessoa também estiver
    // me assistindo, a conexão dela continua de pé.
    stopWatchTimeout(uid)
    state.watching.delete(uid)
    state.connecting.delete(uid)
    closeWatchPeer(uid)
    removeStreamCard(uid)
    renderParticipants()
  } else {
    // Começa a assistir — inicia negociação WebRTC. Fica em "connecting"
    // até o primeiro track chegar (ver ontrack em createPeer), pra não
    // mostrar "Assistindo" antes da hora.
    state.watching.add(uid)
    state.connecting.add(uid)
    renderParticipants()
    await startPeerConnection(uid)

    // Corrige o "carregando infinito": se em N segundos nenhum track
    // chegar (offer perdida, pessoa parou de compartilhar, ICE travado),
    // desiste, avisa e libera o botão para tentar de novo.
    stopWatchTimeout(uid)
    state.watchTimeouts[uid] = setTimeout(() => {
      delete state.watchTimeouts[uid]
      if (!state.watching.has(uid) || state.remoteStreams[uid]) return
      appLog('WARN', `Timeout esperando stream de ${uid} — cancelando`)
      state.watching.delete(uid)
      state.connecting.delete(uid)
      closeWatchPeer(uid)
      removeStreamCard(uid)
      renderParticipants()
      toast('Não foi possível carregar essa tela. Tente assistir de novo.')
    }, WATCH_TIMEOUT_MS)
  }
}

function stopWatchTimeout(uid) {
  clearTimeout(state.watchTimeouts[uid])
  delete state.watchTimeouts[uid]
}

// ──────────────────────────────────────────────
// WEBRTC — QUEM ASSISTE INICIA A OFERTA
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// WEBRTC
// ──────────────────────────────────────────────
async function startPeerConnection(remoteId) {
  const pc = createPeer(remoteId, 'watcher')

  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: true,
  })
  await pc.setLocalDescription(offer)

  sendWS({ type: 'offer', to: remoteId, payload: offer })
}

// role: 'watcher' → eu inicio a oferta pra RECEBER a tela de remoteId.
// role: 'sharer'  → eu respondo a uma oferta ENVIANDO minha tela pra remoteId.
// As duas conexões são independentes (mapas separados) porque "eu assisto
// ele" e "ele me assiste" podem estar ativos ao mesmo tempo; antes disso
// havia uma única RTCPeerConnection por usuário e a offer de um lado
// derrubava a conexão do outro lado no meio da negociação (glare),
// deixando a tela preta pra quem estava assistindo mutuamente.
function createPeer(remoteId, role) {
  const map = role === 'watcher' ? state.watchPeers : state.sharePeers
  if (map[remoteId]) {
    map[remoteId].close()
    delete map[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  map[remoteId] = pc

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      // Marca de qual das duas conexões esse candidato veio, pra quem
      // recebe saber em qual pc local aplicar (ver handleIceCandidate).
      sendWS({ type: 'ice-candidate', to: remoteId, payload: { candidate: e.candidate, role } })
    }
  }

  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE ${role} ${remoteId}]`, pc.iceConnectionState)
  }

  pc.onconnectionstatechange = () => {
    console.log(`[CONN ${role} ${remoteId}]`, pc.connectionState)

    if (pc.connectionState === 'failed') {
      appLog('WARN', `Conexão (${role}) com ${remoteId} falhou (ICE não conseguiu conectar nem via TURN)`)

      if (role === 'watcher') {
        // Se eu estava assistindo essa pessoa, limpa o card e deixa
        // tentar de novo — sem isso o card ficava "conectado" mas preto/parado.
        if (state.watching.has(remoteId)) {
          state.watching.delete(remoteId)
          state.connecting.delete(remoteId)
          removeStreamCard(remoteId)
          renderParticipants()
          toast('A conexão com essa tela falhou. Tente assistir de novo.')
        }
        closeWatchPeer(remoteId)
      } else {
        closeSharePeer(remoteId)
      }
    }
  }

  // Só a conexão em que EU assisto (watcher) recebe stream aqui.
  if (role === 'watcher') {
    pc.ontrack = (e) => {
      console.log(`[TRACK de ${remoteId}]`, e.track.kind, e.streams)
      const stream = e.streams[0]
      if (!stream) return
      stopWatchTimeout(remoteId)
      // Só agora o botão vira "Assistindo" — antes disso ficava
      // "Conectando…" (ver makeParticipantItem) pra ninguém clicar de
      // novo achando que travou e cancelar bem na hora em que o vídeo
      // ia carregar. Um stream chega em tracks separados (vídeo + áudio),
      // então só re-renderiza a lista na primeira vez que isso muda.
      if (state.connecting.delete(remoteId)) renderParticipants()
      state.remoteStreams[remoteId] = stream
      upsertStreamCard(remoteId, stream)
    }
  }

  // Se é a conexão em que eu COMPARTILHO (sharer), adiciona tracks agora
  if (role === 'sharer' && state.sharing && state.localStream) {
    state.localStream.getTracks().forEach(track => {
      console.log('[ADD TRACK]', track.kind)
      pc.addTrack(track, state.localStream)
    })
  }

  return pc
}

// Recebe offer (alguém quer assistir minha tela) — eu respondo como sharer
async function handleOffer(fromId, offer) {
  console.log('[OFFER recebida de]', fromId, '| sharing:', state.sharing)

  if (!state.sharing || !state.localStream) {
    console.warn('Recebi offer mas não estou compartilhando, ignorando.')
    return
  }

  // Cria peer JÁ com os tracks antes de responder
  const pc = createPeer(fromId, 'sharer')

  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  console.log('[ANSWER enviado para]', fromId)
  sendWS({ type: 'answer', to: fromId, payload: answer })
}

async function handleAnswer(fromId, answer) {
  console.log('[ANSWER recebido de]', fromId)
  // Só a minha conexão de watcher fica esperando uma answer.
  const pc = state.watchPeers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

async function handleIceCandidate(fromId, payload) {
  // payload.role é o papel de QUEM ENVIOU nessa conexão específica — pra
  // mim, o candidato é da conexão oposta: se ele mandou como 'watcher'
  // (ele assistindo a mim), esse candidato é da MINHA conexão de sharer
  // com ele, e vice-versa.
  const role = payload?.role === 'watcher' ? 'sharer' : 'watcher'
  const pc = role === 'watcher' ? state.watchPeers[fromId] : state.sharePeers[fromId]
  if (!pc) {
    console.warn('[ICE] Peer não encontrado para', fromId, role)
    return
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(payload.candidate))
  } catch (e) {
    console.warn('[ICE ERROR]', e)
  }
}

// ──────────────────────────────────────────────
// QUALIDADE POR ESPECTADOR — quem assiste escolhe 360p/480p/720p/1080p ou
// automática pra economizar banda (ver seletor em upsertStreamCard). Como
// cada par usuário↔usuário tem sua própria RTCPeerConnection
// (state.sharePeers), dá pra ajustar o encoder por espectador sem afetar
// quem está assistindo em qualidade automática/alta — não é simulcast, é
// só o mesmo vídeo sendo reescalado/recomprimido nessa conexão específica.
// ──────────────────────────────────────────────
const QUALITY_BITRATE_KBPS = { 360: 600, 480: 1000, 720: 2500, 1080: 4000 }

async function applyViewerQuality(viewerId, requestedHeight) {
  const pc = state.sharePeers[viewerId]
  if (!pc) return
  const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
  if (!sender) return

  const nativeHeight = state.localStream?.getVideoTracks()[0]?.getSettings()?.height

  try {
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}]

    if (!requestedHeight || !nativeHeight) {
      // "Automática" — volta a mandar na resolução nativa capturada
      delete params.encodings[0].scaleResolutionDownBy
      delete params.encodings[0].maxBitrate
    } else {
      params.encodings[0].scaleResolutionDownBy = Math.max(1, nativeHeight / requestedHeight)
      params.encodings[0].maxBitrate = (QUALITY_BITRATE_KBPS[requestedHeight] || 2000) * 1000
    }

    await sender.setParameters(params)
    appLog('INFO', `Qualidade ajustada para ${viewerId}: ${requestedHeight ? requestedHeight + 'p' : 'automática'}`)
  } catch (err) {
    console.warn('[QUALITY] Falha ao ajustar parâmetros do encoder:', err)
  }
}

function closeWatchPeer(uid) {
  state.watchPeers[uid]?.close()
  delete state.watchPeers[uid]
  delete state.remoteStreams[uid]
}

function closeSharePeer(uid) {
  state.sharePeers[uid]?.close()
  delete state.sharePeers[uid]
}

function removeUser(uid) {
  delete state.users[uid]
  state.watching.delete(uid)
  state.connecting.delete(uid)
  closeWatchPeer(uid)
  closeSharePeer(uid)
  removeStreamCard(uid)
  renderParticipants()
}

// ──────────────────────────────────────────────
// CONFIGURAÇÕES — modal com opções por seção (por enquanto só "Live").
// Botão fica meio a meio com o de compartilhar na sidebar.
// ──────────────────────────────────────────────
$('btn-settings').onclick = () => $('modal-settings').classList.remove('hidden')
$('btn-close-settings').onclick = () => $('modal-settings').classList.add('hidden')
$('modal-settings').onclick = (e) => {
  if (e.target === $('modal-settings')) $('modal-settings').classList.add('hidden')
}

// Autovisualização — opcional, canto inferior direito, sempre mudo.
// Preferência salva em sessionStorage e usada como padrão dali pra frente.
const chkSelfPreview = $('chk-self-preview')
chkSelfPreview.checked = state.showSelfPreview

chkSelfPreview.onchange = () => {
  state.showSelfPreview = chkSelfPreview.checked
  sessionStorage.setItem(SELF_PREVIEW_KEY, String(state.showSelfPreview))
  updateSelfPreview()
}

// Qualidade padrão ao assistir — aplicada de saída a cada nova live que
// você começa a assistir; a pessoa ainda pode trocar na hora, por live, no
// seletor do próprio card (ver upsertStreamCard).
const selDefaultWatchQuality = $('default-watch-quality')
selDefaultWatchQuality.value = state.defaultWatchQuality

selDefaultWatchQuality.onchange = () => {
  state.defaultWatchQuality = selDefaultWatchQuality.value
  sessionStorage.setItem(DEFAULT_WATCH_QUALITY_KEY, state.defaultWatchQuality)
}

function updateSelfPreview() {
  const wrap = $('self-preview')
  const video = $('self-preview-video')
  const show = state.sharing && state.showSelfPreview && state.localStream

  wrap.classList.toggle('hidden', !show)

  if (!show) {
    video.srcObject = null
    return
  }

  // Sempre mudo — é só uma prévia local, nunca deve tocar som (o pedido
  // era explícito: "que não transmita som"). Não é enviada a ninguém, é a
  // mesma state.localStream que já vai pros outros participantes.
  video.muted = true
  if (video.srcObject !== state.localStream) {
    video.srcObject = state.localStream
    video.play().catch(() => {})
  }
}

// ──────────────────────────────────────────────
// COMPARTILHAR TELA
// ──────────────────────────────────────────────
$('btn-toggle-share').onclick = async () => {
  if (state.sharing) {
    stopSharing()
  } else {
    await startSharing()
  }
}

// Qualidade de transmissão — resolução (altura, em px) e taxa de quadros.
// Escolhidas no modal de fonte, aplicadas como constraints da captura.
const QUALITY_HEIGHTS = { 720: { width: 1280, height: 720 }, 1080: { width: 1920, height: 1080 } }
let selectedSourceId = null
let selectedQuality = {
  resolution: 1080,
  fps: 30,
  // Vem por padrão com som; se a pessoa mudar no modal, fica salvo em
  // sessionStorage e essa vira a escolha padrão dali pra frente.
  audio: sessionStorage.getItem(SHARE_AUDIO_KEY) !== 'off',
}

async function startSharing() {
  // Pede ao main process a lista de fontes
  const sources = await window.electronAPI.getSources()
  selectedSourceId = null
  showSourcePicker(sources)
}

function showSourcePicker(sources) {
  const grid = $('source-grid')
  grid.innerHTML = ''

  sources.forEach(src => {
    const div = document.createElement('div')
    div.className = 'source-item'
    div.dataset.sourceId = src.id
    div.innerHTML = `
      <img class="source-thumb" src="${src.thumbnail}" alt="${src.name}" />
      <div class="source-label">${src.name}</div>
    `
    div.onclick = () => selectSource(src.id)
    grid.appendChild(div)
  })

  updateTransmitButton()
  $('modal-source').classList.remove('hidden')
}

// Seleciona a fonte (tela/janela) sem já iniciar a transmissão — quem
// dispara é o botão "Transmitir", depois de escolher a qualidade também.
function selectSource(sourceId) {
  selectedSourceId = sourceId
  $('source-grid').querySelectorAll('.source-item').forEach(el => {
    el.classList.toggle('selected', el.dataset.sourceId === sourceId)
  })
  updateTransmitButton()
}

function updateTransmitButton() {
  $('btn-start-transmit').disabled = !selectedSourceId
}

// Grupos de botões de qualidade (resolução / FPS / áudio) — só um ativo
// por grupo. `parse` converte o data-value do botão (número pra
// resolução/fps, texto cru pro grupo de áudio).
function setupQualityGroup(containerId, onChange, parse = Number) {
  const container = $(containerId)
  container.querySelectorAll('.quality-opt').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.quality-opt').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      onChange(parse(btn.dataset.value))
    }
  })
}
setupQualityGroup('quality-resolution', (v) => { selectedQuality.resolution = v })
setupQualityGroup('quality-fps', (v) => { selectedQuality.fps = v })
setupQualityGroup('quality-audio', (v) => {
  selectedQuality.audio = v === 'on'
  sessionStorage.setItem(SHARE_AUDIO_KEY, v)
}, (v) => v)

// Reflete a preferência salva no botão certo (o HTML vem com "Com som"
// marcado por padrão; se a sessão já tiver "Sem som" salvo, troca aqui).
if (!selectedQuality.audio) {
  $('quality-audio').querySelectorAll('.quality-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.value === 'off')
  })
}

function closeSourceModal() {
  $('modal-source').classList.add('hidden')
  selectedSourceId = null
}

$('btn-close-modal').onclick = () => closeSourceModal()
$('modal-source').onclick = (e) => {
  if (e.target === $('modal-source')) closeSourceModal()
}

$('btn-start-transmit').onclick = () => {
  if (!selectedSourceId) return
  captureSource(selectedSourceId, selectedQuality)
}

// Constraints de vídeo (getDisplayMedia) pra qualidade escolhida
function buildVideoConstraints({ resolution, fps }) {
  const { width, height } = QUALITY_HEIGHTS[resolution] || QUALITY_HEIGHTS[1080]
  return {
    width:     { ideal: width, max: width },
    height:    { ideal: height, max: height },
    frameRate: { ideal: fps, max: fps },
  }
}

// Constraints equivalentes no formato antigo (mandatory), usado só no
// último fallback via getUserMedia + chromeMediaSourceId.
function buildMandatoryVideoConstraints(sourceId, { resolution, fps }) {
  const { width, height } = QUALITY_HEIGHTS[resolution] || QUALITY_HEIGHTS[1080]
  return {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
      minWidth: width, maxWidth: width,
      minHeight: height, maxHeight: height,
      minFrameRate: fps, maxFrameRate: fps,
    },
  }
}

// Fallback comum de captura só-vídeo — usado tanto quando a pessoa escolhe
// "Sem som" no modal quanto quando a captura de áudio falha em runtime.
async function captureVideoOnly(sourceId, quality) {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: buildVideoConstraints(quality), audio: false })
  } catch {
    // Último recurso: getUserMedia com sourceId específico, só vídeo
    return await navigator.mediaDevices.getUserMedia({
      video: buildMandatoryVideoConstraints(sourceId, quality),
    })
  }
}

async function captureSource(sourceId, quality) {
  $('modal-source').classList.add('hidden')

  // Avisa o processo principal qual fonte usar quando o getDisplayMedia()
  // abaixo disparar o setDisplayMediaRequestHandler (main.js) — sem isso,
  // ele sempre pegava a primeira tela da lista, ignorando a escolhida aqui.
  window.electronAPI?.setCaptureSourceId(sourceId)

  try {
    let stream
    let audioIssue = null

    if (!quality.audio) {
      // Escolha explícita de "Sem som" no modal — nem tenta capturar áudio.
      stream = await captureVideoOnly(sourceId, quality)
    } else {
      // Tenta primeiro com getDisplayMedia, pedindo áudio do sistema (tela toda).
      // Obs: não há API do navegador/Electron para excluir o áudio de um app
      // específico (ex.: Discord) — só é possível incluir ou não o áudio inteiro.
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: buildVideoConstraints(quality),
          audio: true,
          systemAudio: 'include',
        })
      } catch (err) {
        // "Could not start audio source" é a captura de loopback do Windows
        // falhando (dispositivo de saída em modo exclusivo, desconectado,
        // mudo, etc.) — isso não deveria impedir compartilhar o vídeo.
        const isAudioIssue = err?.name === 'NotReadableError' && /audio/i.test(err.message || '')
        if (!isAudioIssue) throw err

        audioIssue = err
        appLog('WARN', `Captura de áudio do sistema falhou (${err.message}) — tentando só vídeo`)
        stream = await captureVideoOnly(sourceId, quality)
      }
    }

    if (!stream || stream.getVideoTracks().length === 0) {
      toast('Nenhuma track de vídeo capturada.')
      return
    }

    const track = stream.getVideoTracks()[0]
    console.log('Stream capturada:', track.label, track.getSettings(),
      '| áudio:', stream.getAudioTracks().length > 0)

    state.localStream = stream
    state.sharing = true

    // Botão só com ícone (a sidebar ficou estreita demais pra caber texto
    // depois que virou grid 1fr/1fr com o de configurações) — o estado
    // (compartilhando ou não) fica no title (tooltip) e na cor de fundo.
    $('btn-toggle-share').classList.add('sharing')
    $('btn-toggle-share').title = 'Desligar compartilhamento'

    sendWS({ type: 'start-sharing' })

    track.onended = () => stopSharing()

    // Por padrão a própria tela compartilhada não aparece — só os outros
    // participantes a veem. Se a preferência estiver ativa, mostra a
    // prévia local mudinha no canto inferior direito (ver updateSelfPreview).
    updateSelfPreview()
    renderParticipants()
    appLog('INFO', `Compartilhamento iniciado (áudio: ${stream.getAudioTracks().length > 0}, `
      + `qualidade: ${quality.resolution}p@${quality.fps}fps)`)
    if (audioIssue) {
      toast('Compartilhando a tela sem áudio — não foi possível capturar o áudio do sistema.')
    } else {
      toast(stream.getAudioTracks().length
        ? 'Você está compartilhando a tela com áudio!'
        : 'Você está compartilhando a tela (sem áudio).')
    }

  } catch (err) {
    console.error('Erro ao capturar:', err)
    appLog('ERROR', `Falha ao capturar tela: ${err.message}`)
    toast(`Erro: ${err.message}`)
  }
}

// ──────────────────────────────────────────────
// STREAM CARDS
// ──────────────────────────────────────────────
function upsertStreamCard(uid, stream) {
  const grid = $('streams-grid')
  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  let card = grid.querySelector(`[data-stream="${uid}"]`)

  if (!card) {
    const username = state.users[uid]?.username || 'Usuário'
    card = document.createElement('div')
    card.className = 'stream-card'
    card.dataset.stream = uid
    card.innerHTML = `
      <div class="stream-header">
        <span class="stream-name">${username}</span>
        <div class="stream-header-actions">
          <span class="stream-stats" title="Resolução e bitrate recebidos agora"></span>

          <select class="quality-select" title="Qualidade da transmissão (economiza banda)">
            <option value="auto">Automática</option>
            <option value="1080">1080p</option>
            <option value="720">720p</option>
            <option value="480">480p</option>
            <option value="360">360p</option>
          </select>

          <div class="vol-control">
            <button type="button" class="vol-icon muted" title="Volume">🔇</button>
            <div class="vol-popover hidden">
              <input type="range" class="vol-slider" min="0" max="100" value="0" />
              <span class="vol-value">0%</span>
            </div>
          </div>

          <button type="button" class="fullscreen-btn" title="Tela cheia">⛶</button>
          <button type="button" class="pip-btn" title="Ver em Picture-in-Picture">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2"/>
              <path d="M9 15 L16 8"/>
              <path d="M11 8 H16 V13"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="stream-video-wrap">
        <video class="stream-video" autoplay muted playsinline></video>
        <div class="stream-loading">
          <div class="spinner"></div>
          <span>Carregando tela…</span>
        </div>
      </div>
    `

    // Clicar na stream coloca ela em foco (as demais minimizam embaixo) —
    // não em tela cheia, onde um clique sem querer no vídeo não devia
    // mudar o foco por baixo dos panos.
    card.addEventListener('click', () => {
      if (document.fullscreenElement === card) return
      toggleFocus(uid)
    })

    // Controle de volume — dropdown: clicar no ícone abre/fecha um
    // popover com o slider (0% a 100%, mostra a porcentagem ao arrastar),
    // em vez de uma barra fixa ocupando espaço embaixo da transmissão. A
    // live sempre começa mutada (0%) — a pessoa escolhe ativar o som.
    const video = card.querySelector('video')
    const slider = card.querySelector('.vol-slider')
    const volValue = card.querySelector('.vol-value')
    const volIcon = card.querySelector('.vol-icon')
    const volPopover = card.querySelector('.vol-popover')

    // Transmissão sem áudio (a pessoa escolheu "Sem som" ao compartilhar,
    // ou a captura de áudio falhou) — bloqueia o controle de volume dessa
    // live específica, não tem o que ajustar.
    if (stream.getAudioTracks().length === 0) {
      slider.disabled = true
      volIcon.disabled = true
      volIcon.textContent = '🔇'
      volIcon.title = 'Esta transmissão não tem áudio'
      volIcon.classList.add('muted')
      volValue.textContent = '—'
    }

    function syncVolumeIcon() {
      const muted = video.muted || Number(slider.value) === 0
      volIcon.textContent = muted ? '🔇' : '🔊'
      volIcon.classList.toggle('muted', muted)
    }

    // Clicar no ícone abre/fecha o popover do slider (fecha sozinho ao
    // clicar fora — ver listener global no fim do arquivo).
    volIcon.addEventListener('click', (e) => {
      e.stopPropagation()
      document.querySelectorAll('.vol-popover').forEach(p => {
        if (p !== volPopover) p.classList.add('hidden')
      })
      volPopover.classList.toggle('hidden')
    })
    volPopover.addEventListener('click', (e) => e.stopPropagation())

    slider.addEventListener('input', () => {
      const v = Number(slider.value)
      video.volume = v / 100
      // Se o autoplay mudo inicial não conseguiu desmutar sozinho (ver
      // comentário mais abaixo), essa interação do usuário é um gesto
      // válido pro navegador permitir desmutar aqui.
      video.muted = v === 0
      volValue.textContent = `${v}%`
      syncVolumeIcon()
      if (video.paused) video.play().catch(() => {})
    })

    // Qualidade — quem assiste escolhe pra economizar banda (ver
    // applyViewerQuality, do lado de quem compartilha). `uid` aqui é quem
    // está compartilhando, então o pedido vai pra ele. Começa na qualidade
    // padrão definida em Configurações → Live (a pessoa ainda pode trocar
    // na hora, só pra essa live, pelo próprio seletor).
    const qualitySelect = card.querySelector('.quality-select')
    qualitySelect.value = state.defaultWatchQuality
    qualitySelect.addEventListener('click', (e) => e.stopPropagation())
    qualitySelect.addEventListener('change', () => {
      const height = qualitySelect.value === 'auto' ? null : Number(qualitySelect.value)
      appLog('INFO', `Pedindo qualidade ${height ? height + 'p' : 'automática'} de ${uid}`)
      sendWS({ type: 'set-quality', to: uid, payload: { height } })
    })
    if (state.defaultWatchQuality !== 'auto') {
      sendWS({ type: 'set-quality', to: uid, payload: { height: Number(state.defaultWatchQuality) } })
    }

    // Indicador de resolução/bitrate REAIS recebidos — prova concreta de
    // que o seletor de qualidade está funcionando (a olho, no vídeo, a
    // diferença nem sempre salta à vista: a caixa na tela continua do
    // mesmo tamanho, e tela compartilhada comprime bem mesmo em 1080p
    // quando tem pouco movimento).
    const statsEl = card.querySelector('.stream-stats')
    let lastBytes = 0
    let lastStatsTime = performance.now()
    state.statsIntervals[uid] = setInterval(async () => {
      const wp = state.watchPeers[uid]
      if (!wp || !statsEl) return
      try {
        const report = await wp.getStats()
        report.forEach(r => {
          if (r.type !== 'inbound-rtp' || r.kind !== 'video') return
          const now = performance.now()
          const dtSec = (now - lastStatsTime) / 1000
          const kbps = dtSec > 0 && lastBytes
            ? Math.max(0, Math.round(((r.bytesReceived - lastBytes) * 8) / dtSec / 1000))
            : 0
          lastBytes = r.bytesReceived
          lastStatsTime = now
          statsEl.textContent = r.frameWidth
            ? `${r.frameWidth}×${r.frameHeight} · ${kbps} kbps`
            : ''
        })
      } catch { /* pc pode já ter fechado entre o tick e a leitura */ }
    }, 2000)

    // Picture-in-Picture — janela flutuante nativa do SO, independente da
    // janela do app. O botão de fechar dela já é da própria janela nativa
    // (a gente só escuta o evento pra manter nosso botão sincronizado).
    const pipBtn = card.querySelector('.pip-btn')
    if (!document.pictureInPictureEnabled || video.disablePictureInPicture) {
      pipBtn.classList.add('hidden')
    } else {
      pipBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          if (document.pictureInPictureElement === video) {
            await document.exitPictureInPicture()
          } else {
            await video.requestPictureInPicture()
          }
        } catch (err) {
          console.warn('[PIP] Falha ao abrir Picture-in-Picture:', err)
          appLog('WARN', `Falha ao abrir Picture-in-Picture para ${uid}: ${err.message}`)
          toast('Não foi possível abrir o Picture-in-Picture.')
        }
      })
      video.addEventListener('enterpictureinpicture', () => pipBtn.classList.add('active'))
      video.addEventListener('leavepictureinpicture', () => pipBtn.classList.remove('active'))
    }

    // Tela cheia — fullscreena o card inteiro (não só o <video>), assim o
    // botão de sair e o controle de volume continuam na tela (reposicionados
    // via CSS `:fullscreen`, ver style.css) em vez de sumirem. O
    // sincronismo do botão e o reflow do grid ao sair ficam no listener
    // global de 'fullscreenchange' (ver mais abaixo).
    const fullscreenBtn = card.querySelector('.fullscreen-btn')
    if (!document.fullscreenEnabled) {
      fullscreenBtn.classList.add('hidden')
    } else {
      fullscreenBtn.addEventListener('click', async (e) => {
        e.stopPropagation()
        try {
          if (document.fullscreenElement === card) {
            await document.exitFullscreen()
          } else {
            await card.requestFullscreen()
          }
        } catch (err) {
          console.warn('[FULLSCREEN] Falha:', err)
          appLog('WARN', `Falha ao entrar em tela cheia para ${uid}: ${err.message}`)
          toast('Não foi possível entrar em tela cheia.')
        }
      })
    }

    grid.appendChild(card)
  }

  const video = card.querySelector('video')
  const loading = card.querySelector('.stream-loading')

  // Tela de carregando enquanto o vídeo da pessoa ainda não chegou
  loading?.classList.remove('hidden')
  video.onloadeddata = () => loading?.classList.add('hidden')

  // Uma tela compartilhada chega em tracks separadas (vídeo + áudio), cada
  // uma disparando ontrack → upsertStreamCard pra essa MESMA stream. Sem
  // essa checagem, chamávamos video.play() duas vezes quase juntas no
  // mesmo elemento, o que pode abortar uma chamada com a outra.
  if (video.srcObject !== stream) {
    // Corrige o bug da "tela preta": desde que passamos a compartilhar áudio
    // junto do vídeo, o Chromium/Electron bloqueia o autoplay de um <video>
    // não mutado com faixa de áudio sem interação do usuário — o vídeo nunca
    // chega a tocar e fica preto. A live sempre inicia mutada (0% — ver
    // template do card acima) então o autoplay é sempre permitido aqui;
    // quem assiste ativa o som depois, pelo ícone ou pelo slider.
    video.muted = true
    video.srcObject = stream
    video.volume = Number(card.querySelector('.vol-slider')?.value ?? 0) / 100
    video.play().catch((err) => {
      // AbortError: play() interrompido porque srcObject mudou antes do
      // promise resolver (ontrack dispara para vídeo e áudio em sequência).
      // Não é bloqueio real — o play() mais recente vai rodar sozinho.
      if (err.name === 'AbortError') return
      console.warn(`[AUTOPLAY] Bloqueado para ${uid}:`, err)
      appLog('WARN', `Autoplay bloqueado para stream de ${uid}: ${err.message}`)
    })
  }

  updateGridLayout()
}

function removeStreamCard(uid) {
  clearInterval(state.statsIntervals[uid])
  delete state.statsIntervals[uid]
  const card = $('streams-grid').querySelector(`[data-stream="${uid}"]`)
  // Sem isso, a janela flutuante de Picture-in-Picture ficava travada
  // mostrando um vídeo cujo elemento acabou de sair do DOM.
  const video = card?.querySelector('video')
  if (video && document.pictureInPictureElement === video) {
    document.exitPictureInPicture().catch(() => {})
  }
  // Mesma ideia pra tela cheia — se o card que está saindo é o que está em
  // fullscreen, sai antes de removê-lo do DOM.
  if (card && document.fullscreenElement === card) {
    document.exitFullscreen().catch(() => {})
  }
  card?.remove()
  if (state.focusedId === uid) state.focusedId = null
  updateGridLayout()
}

// ──────────────────────────────────────────────
// FOCO — uma stream em destaque, as demais minimizadas
// ──────────────────────────────────────────────
function toggleFocus(uid) {
  state.focusedId = state.focusedId === uid ? null : uid
  updateGridLayout()
}

// Fecha qualquer popover de volume aberto ao clicar fora dele (os cliques
// dentro do popover e no ícone que abre já param a propagação antes de
// chegar aqui — ver upsertStreamCard).
document.addEventListener('click', () => {
  document.querySelectorAll('.vol-popover:not(.hidden)').forEach(p => p.classList.add('hidden'))
})

// ──────────────────────────────────────────────
// TELA CHEIA — sincroniza o botão de cada card e corrige o grid ao sair.
// Um card em :fullscreen sai do fluxo normal de layout enquanto ativo; sem
// recalcular o grid ao voltar, ele ficava com o layout desatualizado
// (bugado) até alguém entrar/sair da sala de novo.
// ──────────────────────────────────────────────
document.addEventListener('fullscreenchange', () => {
  const fsCard = document.fullscreenElement
  document.querySelectorAll('.stream-card').forEach(c => {
    const isFs = c === fsCard
    c.classList.toggle('is-fullscreen', isFs)
    c.classList.remove('controls-hidden')
    const btn = c.querySelector('.fullscreen-btn')
    if (btn) {
      btn.textContent = isFs ? '⤬' : '⛶'
      btn.title = isFs ? 'Sair da tela cheia' : 'Tela cheia'
    }
  })
  clearTimeout(hideControlsTimer)
  clearTimeout(hideHeadersTimer)
  $('streams-grid').classList.remove('headers-hidden')
  if (fsCard) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
  updateGridLayout()
})

// Some com o cabeçalho/controles da tela cheia depois de 3s sem o mouse se
// mexer (padrão de player de vídeo em fullscreen) — volta a aparecer no
// primeiro movimento.
let hideControlsTimer = null
function resetControlsHideTimer() {
  const fsCard = document.fullscreenElement
  if (!fsCard || !fsCard.classList.contains('stream-card')) return
  fsCard.classList.remove('controls-hidden')
  clearTimeout(hideControlsTimer)
  hideControlsTimer = setTimeout(() => {
    fsCard.classList.add('controls-hidden')
  }, 3000)
}
// Mesma ideia fora da tela cheia, só que 5s (não está tampando o vídeo,
// então não precisa sumir tão rápido) e escondendo só o cabeçalho (os
// controles de volume/qualidade fora do fullscreen já ficam junto do card
// normalmente, sem precisar desse tratamento).
let hideHeadersTimer = null
function resetHeadersHideTimer() {
  const grid = $('streams-grid')
  grid.classList.remove('headers-hidden')
  clearTimeout(hideHeadersTimer)
  hideHeadersTimer = setTimeout(() => {
    grid.classList.add('headers-hidden')
  }, 5000)
}

document.addEventListener('mousemove', () => {
  if (document.fullscreenElement) {
    resetControlsHideTimer()
  } else {
    resetHeadersHideTimer()
  }
})

function updateGridLayout() {
  const grid = $('streams-grid')
  const cards = Array.from(grid.querySelectorAll('.stream-card'))

  if (cards.length === 0) {
    grid.className = 'streams-grid hidden'
    $('stage-empty').classList.remove('hidden')
    return
  }

  $('stage-empty').classList.add('hidden')
  grid.classList.remove('hidden')

  // Se a stream em foco não existe mais, limpa o foco
  if (state.focusedId && !cards.some(c => c.dataset.stream === state.focusedId)) {
    state.focusedId = null
  }

  if (state.focusedId) {
    grid.className = 'streams-grid has-focus'
    cards.forEach(c => {
      const isFocused = c.dataset.stream === state.focusedId
      c.classList.toggle('focused', isFocused)
      c.classList.toggle('minimized', !isFocused)
    })
  } else {
    grid.className = `streams-grid count-${Math.min(cards.length, 4)}`
    cards.forEach(c => c.classList.remove('focused', 'minimized'))
  }
}

// ──────────────────────────────────────────────
// COPIAR ID
// ──────────────────────────────────────────────
$('btn-copy-id').onclick = () => {
  navigator.clipboard.writeText(state.roomId)
  toast('Código copiado!')
}
function stopSharing() {
  if (!state.sharing) return
  state.localStream?.getTracks().forEach(t => t.stop())
  state.localStream = null
  state.sharing = false
  updateSelfPreview()

  $('btn-toggle-share').classList.remove('sharing')
  $('btn-toggle-share').title = 'Compartilhar tela'

  sendWS({ type: 'stop-sharing' })

  // Só fecha as conexões em que EU estava enviando minha tela — antes
  // isso fechava também as conexões em que eu estava assistindo outras
  // pessoas (mesmo mapa pros dois sentidos), derrubando o que eu via
  // só porque eu parei de compartilhar a minha.
  Object.keys(state.sharePeers).forEach(uid => closeSharePeer(uid))

  renderParticipants()
  appLog('INFO', 'Compartilhamento encerrado')
  toast('Você parou de compartilhar.')
}
// ──────────────────────────────────────────────
// SAIR DA SALA
// ──────────────────────────────────────────────
$('btn-leave').onclick = () => {
  // Desarma o auto-reconnect — sem isso, uma tentativa já agendada podia
  // disparar depois que a pessoa já tinha saído da sala de propósito.
  manualDisconnect = true
  clearTimeout(reconnectTimer)
  reconnectTimer = null
  isReconnecting = false

  stopSharing()
  state.ws?.close()
  stopPing()
  state.watchPeers = {}
  state.sharePeers = {}
  state.users = {}
  state.watching.clear()
  state.connecting.clear()
  state.remoteStreams = {}
  state.focusedId = null
  Object.values(state.statsIntervals).forEach(id => clearInterval(id))
  state.statsIntervals = {}
  if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {})
  $('streams-grid').innerHTML = ''
  $('stage-empty').classList.remove('hidden')
  $('streams-grid').classList.add('hidden')
  $('participants-list').innerHTML = ''
  showScreen('login')
}