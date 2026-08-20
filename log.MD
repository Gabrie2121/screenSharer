## v0.0.1
 - Apenas rodando o código

## v0.0.2

 - Features
    Compartilhamento
    - Poder Selecionar uma stream para ficar em foco na tela, enquanto as outras são minimizada abaixo
    - Não exibir o meu próprio compartilhamento de tela
    - Compartilhar o audio da transmissão em tempo real da tela toda
    - Não compartilhar o audio da ferramenta Discord em compartilhamentos de tela
    - Opção de diminuir e aumentar o audio da tela da pessoa, de 0% a 100% 
    - Tela de carregando, enquanto a tela da pessoa não carrega
    - demonstração de PING em conexão com servidor utilizando um simbolo de rede em formato de barrinhas, e um valor em MS do lado

-----

Backend (screen-share-backend/)

ws.py — novo tipo de sinal ping/pong: o cliente manda {type: "ping", payload:{t}} e o servidor ecoa de volta, permitindo medir latência.
main.py — log básico com rotação: console + arquivo screen-share-backend/logs/backend.log (1MB, 3 backups), com eventos de startup/shutdown.
Frontend (screen-share-frotnend/)

Foco de stream (app.js) — clicar numa tela a coloca em destaque; as demais viram uma tira minimizada embaixo (toggleFocus/updateGridLayout).
Não exibir a própria tela — removi o preview local; agora só os outros participantes veem sua stream.
Áudio da tela toda — getDisplayMedia({audio: true, systemAudio: 'include'}) + audio: 'loopback' no handler do Electron (main.js).
Áudio do Discord — ⚠️ não é tecnicamente possível excluir o áudio de um app específico via APIs do Chromium/Electron (só existe include/exclude do áudio do sistema inteiro). Documentei isso no código e adicionei um aviso na UI orientando a silenciar o Discord no mixer de volume do Windows antes de compartilhar.
Volume por pessoa (0–100%) — slider em cada card de stream.
Tela de carregando — overlay com spinner até o <video> disparar loadeddata.
Indicador de PING — barrinhas de sinal + valor em ms no sidebar, atualizado a cada 3s.
Log básico

Backend: screen-share-backend/logs/backend.log (rotativo).
Desktop: main.js grava em <userData>/logs/main.log; o renderer manda eventos-chave (entrar em sala, iniciar/parar compartilhamento, erros de conexão) via IPC para esse mesmo arquivo.
Validei sintaxe de todos os arquivos Python (py_compile) e JS (node --check), e confirmei que o backend importa sem erros.

## v0.0.3 (backlog) — Bugs e features a desenvolver

Revisão de código feita em cima do que entrou na v0.0.2. Marcar `[x]` ao
resolver e anotar a versão/commit.

### Bugs conhecidos

Bugs corrigidos (seção "Bugs" do context.MD)
1. "Quando eu compartilho minha tela, a de outra pessoa fica preta"
Causa raiz: ao adicionar áudio ao compartilhamento (feature da v0.0.2), o Chromium/Electron passou a bloquear o autoplay de um <video> não-mutado com faixa de áudio sem interação do usuário — o vídeo remoto nunca começava a tocar e ficava preto.
Correção em app.js upsertStreamCard(): o vídeo começa mutado (autoplay sempre permitido nesse caso), chama .play() explicitamente e só desmuta depois que o play realmente inicia.

2. "Em alguns casos, quando a pessoa entra na stream, fica carregando infinito"
Mesma causa acima explica parte dos casos (sem play, sem frame decodificado, loading nunca some) — resolvida pelo fix acima. Para os demais casos (offer perdida, pessoa parou de compartilhar bem na hora, ICE travado), adicionei um timeout de 12s em toggleWatch(): se nenhum track chegar nesse prazo, cancela a tentativa, mostra um toast de erro e libera o botão "Assistir" para tentar de novo, em vez de travar pra sempre.

Feature nova: botão de atualização
electron-updater instalado e configurado em main.js apontando pro GitHub Releases do repo (Gabrie2121/screenSharer, já configurado como publish no package.json).
Botão fixo no canto inferior esquerdo (index.html/style.css), oculto por padrão — aparece quando o app detecta uma versão nova no GitHub. Um clique baixa, mostra progresso (%), instala e reinicia sozinho.
Só verifica update quando o app está empacotado (app.isPackaged), então não faz nada incômodo em modo dev.
Novo script npm run release (precisa de GH_TOKEN no ambiente) para publicar builds no GitHub Releases.
Validei sintaxe de todos os arquivos JS (node --check) e do package.json. log.MD e context.MD seguem intocados — só o package-lock.json mudou por causa do npm install electron-updater.