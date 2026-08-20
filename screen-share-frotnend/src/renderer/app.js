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

  $('display-room-id').textContent = roomId
  showScreen('room')
  appLog('INFO', `Entrando na sala ${roomId} como "${name}" (servidor: ${server})`)
  connectWebSocket()
}

// ──────────────────────────────────────────────
// WEBSOCKET
// ──────────────────────────────────────────────
function connectWebSocket() {
  const url = `${state.serverUrl}/ws/${state.roomId}`
  state.ws = new WebSocket(url)

  state.ws.onopen = () => {
    sendWS({ type: 'join-room', username: state.myName })
    toast('Conectado à sala!')
    startPing()
  }

  state.ws.onmessage = (event) => handleMessage(JSON.parse(event.data))

  state.ws.onerror = () => {
    appLog('ERROR', `Erro de conexão WebSocket com ${url}`)
    toast('Erro de conexão com o servidor.')
  }

  state.ws.onclose = () => {
    appLog('WARN', 'Desconectado do servidor.')
    toast('Desconectado do servidor.')
    // Limpa peers
    Object.values(state.watchPeers).forEach(pc => pc.close())
    Object.values(state.sharePeers).forEach(pc => pc.close())
    state.watchPeers = {}
    state.sharePeers = {}
    stopPing()
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
        toast(`${msg.username} está compartilhando a tela`)
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
// AUTOVISUALIZAÇÃO — opcional, canto inferior direito, sempre mudo.
// Preferência salva em sessionStorage e usada como padrão dali pra frente.
// ──────────────────────────────────────────────
const chkSelfPreview = $('chk-self-preview')
chkSelfPreview.checked = state.showSelfPreview

chkSelfPreview.onchange = () => {
  state.showSelfPreview = chkSelfPreview.checked
  sessionStorage.setItem(SELF_PREVIEW_KEY, String(state.showSelfPreview))
  updateSelfPreview()
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
let selectedQuality = { resolution: 1080, fps: 30 }

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

// Grupos de botões de qualidade (resolução / FPS) — só um ativo por grupo
function setupQualityGroup(containerId, onChange) {
  const container = $(containerId)
  container.querySelectorAll('.quality-opt').forEach(btn => {
    btn.onclick = () => {
      container.querySelectorAll('.quality-opt').forEach(b => b.classList.remove('active'))
      btn.classList.add('active')
      onChange(Number(btn.dataset.value))
    }
  })
}
setupQualityGroup('quality-resolution', (v) => { selectedQuality.resolution = v })
setupQualityGroup('quality-fps', (v) => { selectedQuality.fps = v })

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

async function captureSource(sourceId, quality) {
  $('modal-source').classList.add('hidden')

  try {
    // Tenta primeiro com getDisplayMedia, pedindo áudio do sistema (tela toda).
    // Obs: não há API do navegador/Electron para excluir o áudio de um app
    // específico (ex.: Discord) — só é possível incluir ou não o áudio inteiro.
    let stream
    let audioIssue = null
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: buildVideoConstraints(quality),
        audio: true,
        systemAudio: 'include',
      })
    } catch (err) {
      // "Could not start audio source" é a captura de loopback do Windows
      // falhando (dispositivo de saída em modo exclusivo, desconectado,
      // mudo, etc.) — isso não deveria impedir compartilhar o vídeo, mas o
      // fallback abaixo também pedia áudio do desktop e batia no mesmo
      // problema, derrubando o compartilhamento inteiro por causa só do áudio.
      const isAudioIssue = err?.name === 'NotReadableError' && /audio/i.test(err.message || '')
      if (!isAudioIssue) throw err

      audioIssue = err
      appLog('WARN', `Captura de áudio do sistema falhou (${err.message}) — tentando só vídeo`)
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ video: buildVideoConstraints(quality), audio: false })
      } catch {
        // Último recurso: getUserMedia com sourceId específico, só vídeo
        // (pular áudio aqui também, já que acabamos de ver que ele falha)
        stream = await navigator.mediaDevices.getUserMedia({
          video: buildMandatoryVideoConstraints(sourceId, quality),
        })
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

    $('btn-toggle-share').classList.add('sharing')
    $('share-btn-text').textContent = 'Desligar'

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
          <button type="button" class="pip-btn" title="Ver em Picture-in-Picture">🗔</button>
        </div>
      </div>
      <div class="stream-video-wrap">
        <video class="stream-video" autoplay muted playsinline></video>
        <div class="stream-loading">
          <div class="spinner"></div>
          <span>Carregando tela…</span>
        </div>
      </div>
      <div class="stream-controls">
        <button type="button" class="vol-icon muted" title="Ativar som">🔇</button>
        <input type="range" class="vol-slider" min="0" max="100" value="0" />
        <span class="vol-value">0%</span>
        <select class="quality-select" title="Qualidade da transmissão (economiza banda)">
          <option value="auto" selected>Automática</option>
          <option value="1080">1080p</option>
          <option value="720">720p</option>
          <option value="480">480p</option>
          <option value="360">360p</option>
        </select>
      </div>
    `

    // Clicar na stream coloca ela em foco (as demais minimizam embaixo)
    card.addEventListener('click', () => toggleFocus(uid))

    // Controle de volume — 0% a 100% (não interfere no foco). A live
    // sempre começa mutada (0%) — a pessoa escolhe ativar o som.
    const video = card.querySelector('video')
    const slider = card.querySelector('.vol-slider')
    const volValue = card.querySelector('.vol-value')
    const volIcon = card.querySelector('.vol-icon')
    let lastVolume = 100 // pra restaurar ao clicar no ícone depois de mutar

    function syncVolumeIcon() {
      const muted = video.muted || Number(slider.value) === 0
      volIcon.textContent = muted ? '🔇' : '🔊'
      volIcon.title = muted ? 'Ativar som' : 'Mutar'
      volIcon.classList.toggle('muted', muted)
    }

    slider.addEventListener('click', (e) => e.stopPropagation())
    slider.addEventListener('input', () => {
      const v = Number(slider.value)
      video.volume = v / 100
      // Se o autoplay mudo inicial não conseguiu desmutar sozinho (ver
      // comentário mais abaixo), essa interação do usuário é um gesto
      // válido pro navegador permitir desmutar aqui.
      video.muted = v === 0
      if (v > 0) lastVolume = v
      volValue.textContent = `${v}%`
      syncVolumeIcon()
      if (video.paused) video.play().catch(() => {})
    })

    // Ícone de volume também funciona como botão de mutar/desmutar rápido
    volIcon.addEventListener('click', (e) => {
      e.stopPropagation()
      const isMuted = video.muted || Number(slider.value) === 0
      if (isMuted) {
        const restore = lastVolume > 0 ? lastVolume : 100
        slider.value = restore
        video.volume = restore / 100
        video.muted = false
        volValue.textContent = `${restore}%`
      } else {
        lastVolume = Number(slider.value) || lastVolume
        slider.value = 0
        video.volume = 0
        video.muted = true
        volValue.textContent = '0%'
      }
      syncVolumeIcon()
      if (video.paused) video.play().catch(() => {})
    })

    // Qualidade — quem assiste escolhe pra economizar banda (ver
    // applyViewerQuality, do lado de quem compartilha). `uid` aqui é quem
    // está compartilhando, então o pedido vai pra ele.
    const qualitySelect = card.querySelector('.quality-select')
    qualitySelect.addEventListener('click', (e) => e.stopPropagation())
    qualitySelect.addEventListener('change', () => {
      const height = qualitySelect.value === 'auto' ? null : Number(qualitySelect.value)
      appLog('INFO', `Pedindo qualidade ${height ? height + 'p' : 'automática'} de ${uid}`)
      sendWS({ type: 'set-quality', to: uid, payload: { height } })
    })

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
  $('share-btn-text').textContent = 'Compartilhar tela'

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