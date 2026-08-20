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
const state = {
  myId:      null,
  myName:    '',
  roomId:    null,
  serverUrl: '',

  // WebSocket
  ws: null,

  // Peers: { userId: RTCPeerConnection }
  peers: {},

  // Streams recebidos: { userId: MediaStream }
  remoteStreams: {},

  // Usuários na sala: { userId: { username, sharing } }
  users: {},

  // Quem estou assistindo
  watching: new Set(),

  // Minha stream local (quando compartilho) — nunca é exibida na tela,
  // só é usada para enviar aos outros participantes.
  localStream: null,
  sharing: false,

  // Stream em foco na tela (as demais ficam minimizadas embaixo)
  focusedId: null,

  // Medição de latência (ping)
  pingInterval: null,
  pingWaiting: false,
}

// ──────────────────────────────────────────────
// ICE SERVERS (STUN público)
// ──────────────────────────────────────────────
const ICE_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
    Object.values(state.peers).forEach(pc => pc.close())
    state.peers = {}
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
        state.watching.delete(msg.user_id)
        renderParticipants()
        removeStreamCard(msg.user_id)
        closePeer(msg.user_id)
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

  const watching = state.watching.has(uid)

  li.innerHTML = `
    <div class="participant-avatar">${initial}</div>
    <div class="participant-info">
      <div class="participant-name">${name}${isMe ? ' (você)' : ''}</div>
      <div class="participant-status ${sharing ? 'sharing' : ''}">${statusText}</div>
    </div>
    ${(!isMe && sharing)
      ? `<button class="btn-watch ${watching ? 'watching' : ''}" data-uid="${uid}">
           ${watching ? 'Assistindo' : 'Assistir'}
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
async function toggleWatch(uid) {
  if (state.watching.has(uid)) {
    // Para de assistir
    state.watching.delete(uid)
    closePeer(uid)
    removeStreamCard(uid)
    renderParticipants()
  } else {
    // Começa a assistir — inicia negociação WebRTC
    state.watching.add(uid)
    renderParticipants()
    await startPeerConnection(uid)
  }
}

// ──────────────────────────────────────────────
// WEBRTC — QUEM ASSISTE INICIA A OFERTA
// ──────────────────────────────────────────────
// ──────────────────────────────────────────────
// WEBRTC
// ──────────────────────────────────────────────
async function startPeerConnection(remoteId) {
  const pc = createPeer(remoteId, false)

  const offer = await pc.createOffer({
    offerToReceiveVideo: true,
    offerToReceiveAudio: true,
  })
  await pc.setLocalDescription(offer)

  sendWS({ type: 'offer', to: remoteId, payload: offer })
}

function createPeer(remoteId, isAnswerer) {
  if (state.peers[remoteId]) {
    state.peers[remoteId].close()
    delete state.peers[remoteId]
  }

  const pc = new RTCPeerConnection(ICE_CONFIG)
  state.peers[remoteId] = pc

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      sendWS({ type: 'ice-candidate', to: remoteId, payload: e.candidate })
    }
  }

  pc.oniceconnectionstatechange = () => {
    console.log(`[ICE ${remoteId}]`, pc.iceConnectionState)
  }

  pc.onconnectionstatechange = () => {
    console.log(`[CONN ${remoteId}]`, pc.connectionState)
  }

  // Quem ASSISTE recebe a stream aqui
  pc.ontrack = (e) => {
    console.log(`[TRACK de ${remoteId}]`, e.track.kind, e.streams)
    const stream = e.streams[0]
    if (!stream) return
    state.remoteStreams[remoteId] = stream
    upsertStreamCard(remoteId, stream)
  }

  // Se é o RESPONDEDOR (quem compartilha), adiciona tracks agora
  if (isAnswerer && state.sharing && state.localStream) {
    state.localStream.getTracks().forEach(track => {
      console.log('[ADD TRACK]', track.kind)
      pc.addTrack(track, state.localStream)
    })
  }

  return pc
}

// Recebe offer (quem está compartilhando)
async function handleOffer(fromId, offer) {
  console.log('[OFFER recebida de]', fromId, '| sharing:', state.sharing)

  if (!state.sharing || !state.localStream) {
    console.warn('Recebi offer mas não estou compartilhando, ignorando.')
    return
  }

  // Cria peer JÁ com os tracks antes de responder
  const pc = createPeer(fromId, true)

  await pc.setRemoteDescription(new RTCSessionDescription(offer))

  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)

  console.log('[ANSWER enviado para]', fromId)
  sendWS({ type: 'answer', to: fromId, payload: answer })
}

async function handleAnswer(fromId, answer) {
  console.log('[ANSWER recebido de]', fromId)
  const pc = state.peers[fromId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
}

async function handleIceCandidate(fromId, candidate) {
  const pc = state.peers[fromId]
  if (!pc) {
    console.warn('[ICE] Peer não encontrado para', fromId)
    return
  }
  try {
    await pc.addIceCandidate(new RTCIceCandidate(candidate))
  } catch (e) {
    console.warn('[ICE ERROR]', e)
  }
}

function closePeer(uid) {
  state.peers[uid]?.close()
  delete state.peers[uid]
  delete state.remoteStreams[uid]
}

function removeUser(uid) {
  delete state.users[uid]
  state.watching.delete(uid)
  closePeer(uid)
  removeStreamCard(uid)
  renderParticipants()
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

async function startSharing() {
  // Pede ao main process a lista de fontes
  const sources = await window.electronAPI.getSources()
  showSourcePicker(sources)
}

function showSourcePicker(sources) {
  const grid = $('source-grid')
  grid.innerHTML = ''

  sources.forEach(src => {
    const div = document.createElement('div')
    div.className = 'source-item'
    div.innerHTML = `
      <img class="source-thumb" src="${src.thumbnail}" alt="${src.name}" />
      <div class="source-label">${src.name}</div>
    `
    div.onclick = () => captureSource(src.id)
    grid.appendChild(div)
  })

  $('modal-source').classList.remove('hidden')
}

$('btn-close-modal').onclick = () => $('modal-source').classList.add('hidden')
$('modal-source').onclick = (e) => {
  if (e.target === $('modal-source')) $('modal-source').classList.add('hidden')
}

async function captureSource(sourceId) {
  $('modal-source').classList.add('hidden')

  try {
    // Tenta primeiro com getDisplayMedia, pedindo áudio do sistema (tela toda).
    // Obs: não há API do navegador/Electron para excluir o áudio de um app
    // específico (ex.: Discord) — só é possível incluir ou não o áudio inteiro.
    let stream
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: true,
        systemAudio: 'include',
      })
    } catch {
      // Fallback: usa getUserMedia com sourceId específico (vídeo + áudio do desktop)
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            minWidth: 1280,
            maxWidth: 1920,
            minHeight: 720,
            maxHeight: 1080,
          },
        },
        audio: {
          mandatory: {
            chromeMediaSource: 'desktop',
          },
        },
      })
    }

    if (!stream || stream.getVideoTracks().length === 0) {
      toast('Nenhuma track de vídeo capturada.')
      return
    }

    console.log('Stream capturada:', stream.getVideoTracks()[0].label,
      '| áudio:', stream.getAudioTracks().length > 0)

    state.localStream = stream
    state.sharing = true

    $('btn-toggle-share').classList.add('sharing')
    $('share-btn-text').textContent = 'Parar de compartilhar'

    sendWS({ type: 'start-sharing' })

    stream.getVideoTracks()[0].onended = () => stopSharing()

    // A própria tela compartilhada NÃO é exibida para quem está
    // compartilhando — só os outros participantes a veem.
    renderParticipants()
    appLog('INFO', `Compartilhamento iniciado (áudio: ${stream.getAudioTracks().length > 0})`)
    toast(stream.getAudioTracks().length
      ? 'Você está compartilhando a tela com áudio!'
      : 'Você está compartilhando a tela (sem áudio).')

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
      </div>
      <div class="stream-video-wrap">
        <video class="stream-video" autoplay playsinline></video>
        <div class="stream-loading">
          <div class="spinner"></div>
          <span>Carregando tela…</span>
        </div>
      </div>
      <div class="stream-controls">
        <span class="vol-icon">🔊</span>
        <input type="range" class="vol-slider" min="0" max="100" value="100" />
        <span class="vol-value">100%</span>
      </div>
    `

    // Clicar na stream coloca ela em foco (as demais minimizam embaixo)
    card.addEventListener('click', () => toggleFocus(uid))

    // Controle de volume — 0% a 100% (não interfere no foco)
    const video = card.querySelector('video')
    const slider = card.querySelector('.vol-slider')
    const volValue = card.querySelector('.vol-value')
    slider.addEventListener('click', (e) => e.stopPropagation())
    slider.addEventListener('input', () => {
      const v = Number(slider.value)
      video.volume = v / 100
      volValue.textContent = `${v}%`
    })

    grid.appendChild(card)
  }

  const video = card.querySelector('video')
  const loading = card.querySelector('.stream-loading')

  // Tela de carregando enquanto o vídeo da pessoa ainda não chegou
  loading?.classList.remove('hidden')
  video.onloadeddata = () => loading?.classList.add('hidden')

  video.srcObject = stream
  video.volume = Number(card.querySelector('.vol-slider')?.value ?? 100) / 100

  updateGridLayout()
}

function removeStreamCard(uid) {
  const card = $('streams-grid').querySelector(`[data-stream="${uid}"]`)
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

  $('btn-toggle-share').classList.remove('sharing')
  $('share-btn-text').textContent = 'Compartilhar tela'

  sendWS({ type: 'stop-sharing' })

  Object.keys(state.peers).forEach(uid => closePeer(uid))

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
  state.peers = {}
  state.users = {}
  state.watching.clear()
  state.remoteStreams = {}
  state.focusedId = null
  $('streams-grid').innerHTML = ''
  $('stage-empty').classList.remove('hidden')
  $('streams-grid').classList.add('hidden')
  $('participants-list').innerHTML = ''
  showScreen('login')
}