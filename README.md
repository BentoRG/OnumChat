# OnumChat (offline)

Este projeto está **desligado** desde junho de 2026. O chat não está mais acessível na internet.

## O que foi desativado

- Servidor Node (`onumchat.service`)
- Túnel Cloudflare (`onumchat.timgo.uk`)
- GitHub Pages (`bentorg.github.io/OnumChat`)

O código permanece neste repositório para uso futuro.

## Como religar um dia

1. Clone o repositório e rode `npm install`.
2. (Opcional) Restaure o banco: renomeie `messages.db.offline-*` para `messages.db` na pasta do projeto.
3. Suba o servidor: `PORT=3010 node server.js` ou reative os serviços systemd em `onumchat.service` e `onumchat-tunnel.service`.
4. Reconfigure o túnel Cloudflare (`~/.cloudflared/onumchat.yml`) e o DNS `onumchat.timgo.uk`.
5. Se quiser página no GitHub de novo: Settings → Pages → branch `main`.

## Arquivos locais (não vão para o Git)

- `onumchat.service` — credenciais/servidor (ver `onumchat.service.example`)
- `messages.db` — mensagens e usuários do chat
