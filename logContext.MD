# ShareSync — Log de Contexto

Histórico de tudo que foi pedido nesta conversa com o assistente, cruzado com a
linha do tempo real de versões do `package.json`/commits do git. Gerado em
2026-08-20 a partir do histórico de chat e de `git log`.

> Nota: as versões v0.0.1 e v0.0.2 (e o conteúdo do `resolucao eder` / v0.0.10,
> ambos marcados abaixo) não passaram por esta conversa — foram trabalho seu,
> direto no código. Deixei registrado o que os diffs mostram, sem inventar
> detalhes que eu não vi acontecer.

---

## Linha do tempo de versões

| Versão | Commit | Data/hora | Origem | O que entrou |
|---|---|---|---|---|
| — | `8d5e9ea` | 20/08 14:08 | você | `versão 0.0.1 inicial` — scaffold do projeto (`.gitignore`). |
| 0.0.2 | `9f5d127` | 20/08 14:43 | você (fora desta conversa) | Feature grande já documentada em `log.MD`: foco de stream, ocultar a própria tela, áudio do sistema junto do vídeo, slider de volume 0–100%, tela de carregando, indicador de PING, log básico em disco (front + back). |
| 0.0.6 | `f34cc7c` | 20/08 17:29 | **esta conversa** — pedidos 1 e 2 | Ver pedidos 1–2 abaixo: os 6 bugs do `/code-review`, o fix da tela preta ao assistir mutuamente, servidor padrão `ws://177.85.121.34:8000`, badge de versão fixo. |
| 0.0.8 | `8d4b806` | 20/08 17:44 | **esta conversa** — pedidos 3 e 4 | Ver pedidos 3–4 abaixo: estado "Conectando…" pro botão de assistir, e o fallback de áudio no compartilhamento (`Could not start audio source`). Commit é "sim, pulei" — você pulou o número 0.0.7 de propósito. |
| — | `4dfa5c7` | 20/08 18:00 | você (fora desta conversa) | `resolucao eder` — `<video>` do card passou a nascer com `muted` fixo no HTML e ganhou `if (video.paused) video.play()` no listener do slider. Foi essa mudança que motivou o pedido 5 (o volume da UI precisava nascer zerado pra combinar). |
| 0.0.10 | `fe2661a` | 20/08 18:11 | você (fora desta conversa) | Removidos os STUN públicos do Google (`stun.l.google.com`/`stun1.l.google.com`) do `ICE_CONFIG`, ficando só com os servidores STUN/TURN do metered.ca. |
| 0.1.0 | `d77c175` | 20/08 18:39 | **esta conversa** — pedido 5 | Ver pedido 5 abaixo: `LICENSE.md`, ícone de volume virou botão de mudo, minimizadas centralizadas, botão "Parar de assistir" em vermelho, texto do Discord removido, volume da UI nascendo em 0%. |
| 0.1.1 | `8208501` | 20/08 18:57 | **esta conversa** — pedido 7 | Ver pedido 7 abaixo: badge de versão virou botão de "verificar atualização" manual, botão de compartilhar renomeado para "Desligar". |
| 0.1.2 | `3777b78` | 20/08 19:08 | **esta conversa** — pedido 8 | Ver pedido 8 abaixo: modal de compartilhar ganhou seleção de fonte + qualidade (720p/1080p, 30/60 FPS) + botão "Transmitir". |

---

## Pedidos feitos nesta conversa (em ordem)

### 1. "verifica os bugs"
Rodei o `/code-review` no diff atual. Achou 6 problemas em `main.js`/`app.js`:
auto-updater reiniciando o app sem avisar durante uma sessão ativa, watchdog de
"assistir" de 12s cancelando conexões que ainda negociavam TURN, stream ficando
mudo pra sempre se o autoplay inicial falhasse, `upsertStreamCard` chamando
`video.play()` duas vezes (uma por track), checagem de update podendo rodar
antes do listener do renderer existir, e o botão de retry de update não
limpando o estilo de erro.

### 2. "pode corrigir"
Apliquei as 6 correções do pedido 1: fluxo de update com confirmação antes de
reiniciar (`update-ready` + `update-install`), timeout subiu pra 25s,
slider de volume passou a controlar `video.muted`, `upsertStreamCard` só
chama `play()` quando `video.srcObject` muda, `checkForUpdates()` movido pra
depois do `did-finish-load`, botão de retry limpando a classe `.error`.
→ entrou na v0.0.6.

### 3. "como sobe a release?"
Só orientação, sem mudança de código: expliquei o fluxo `GH_TOKEN` +
`npm run release` (`electron-builder --publish always`) publicando no GitHub
Releases do repo `Gabrie2121/screenSharer`.

### 4. "eu fiz o release e não foi no sistema o botão, tem q fazer mais algo?"
Diagnostiquei via API pública do GitHub: o release tinha saído como **draft**
(comportamento padrão do electron-builder) — por isso não aparecia pro
`electron-updater`. Orientei publicar o draft manualmente e sugeri
`"draft": false` no `package.json` pros próximos releases saírem direto.
Sem mudança de código nessa resposta.

### 5. "verifica os bugs e features do context.MD"
Bug relatado: *"quando eu assisto a tela do meu amigo, e ele tá assistindo a
minha, minha tela fica preta pra ele, e vice-versa."* Causa raiz: uma única
`RTCPeerConnection` por usuário sendo usada pros dois sentidos ao mesmo tempo
— glare de sinalização. Troquei por dois mapas independentes
(`state.watchPeers` / `state.sharePeers`) e corrigi todos os pontos que
fechavam peers. Também implementei as duas features pendentes: servidor
padrão `ws://177.85.121.34:8000` e o badge de versão fixo no canto inferior
esquerdo.
→ entrou na v0.0.6 (junto com os pedidos 1–2).

### 6. Erro reportado: `DOMException: play() request was interrupted because the media was removed from the document`
O botão de assistir virava "Assistindo" antes da negociação WebRTC terminar,
levando a cliques duplos que cancelavam a conexão bem na hora em que o vídeo
chegava. Adicionei o estado `state.connecting` — o botão mostra "Conectando…"
até o primeiro track chegar de verdade.
→ entrou na v0.0.8.

### 7. Erro reportado: `Could not start audio source`
A captura de áudio do sistema (loopback do Windows) falhando derrubava o
compartilhamento inteiro, mesmo o vídeo funcionando. Adicionei um retry
automático só-vídeo em `captureSource` e corrigi `main.js` pra só forçar
`audio: 'loopback'` quando o renderer realmente pediu áudio
(`request.audioRequested`), senão o retry batia no mesmo problema.
→ entrou na v0.0.8 (junto com o pedido 6).

### 8. "realize as features da context.MD"
Seis pedidos do `context.MD`:
- Volume da UI nascendo em 0% (combinando com a live sempre iniciar mutada).
- Streams minimizadas centralizadas (`justify-content: center`).
- Ícone de volume virou botão de mudo/desmudo, sincronizado com o slider.
- Removido o texto sobre o áudio do Discord.
- Botão "Assistindo" → "Parar de assistir", em vermelho.
- Criado `LICENSE.md`: autoria sua, isenção de responsabilidade pelo uso de
  terceiros e pela ideia geral (compartilhamento de tela via WebRTC, que já
  existe em Meet/Discord/Zoom/Parsec).
→ entrou na v0.1.0.

### 9. "faça as features do context.md"
Dois pedidos:
- Botão de verificar atualização: o badge de versão virou clicável, dispara
  checagem manual no GitHub Releases, mostra "Verificando…" e depois toast
  (achou / já é a última versão / erro).
- Renomeado "Parar de compartilhar" → "Desligar".
→ entrou na v0.1.1.

### 10. "Faça a atualização da Feature no context.MD"
Pedido: no modal de compartilhar tela, selecionar a fonte não deveria mais
iniciar a transmissão na hora — precisa de um botão "Transmitir" no final,
com opções de qualidade (720p/1080p, 30/60 FPS). Implementado: clique na
miniatura só seleciona (borda destacada); grupos de botões de resolução e
FPS; "Transmitir" habilita só depois de escolher a fonte; a qualidade virou
constraints reais (`width`/`height`/`frameRate` no `getDisplayMedia`, e o
equivalente `mandatory` no fallback via `getUserMedia`).
→ entrou na v0.1.2.

### 11. "como ter certeza se a resolução e a taxa de quadros mudaram?"
Só orientação, sem mudança de código: expliquei como ler
`track.getSettings()` no console (log que já existe desde o pedido 10) e como
usar `pc.getStats()` (`outbound-rtp`/`inbound-rtp`) pra ver a resolução/FPS
realmente sendo enviada e recebida. Ofereci implementar um overlay de
estatísticas ao vivo no app, ainda não decidido.

### 12. "me crie um arquivo logContext.MD..."
Este arquivo.

---

## Pendências / ofertas em aberto

- Overlay de estatísticas de stream ao vivo (resolução/FPS/bitrate por card),
  oferecido no pedido 11 — não implementado ainda.
