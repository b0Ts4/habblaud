# Sede: o escritório do time inteiro

A **sede** junta o Habblaud de cada pessoa do time num prédio só. Cada um continua rodando os próprios agentes
(Claude Code ou Codex) **na própria conta e no próprio computador**; o Habblaud dessa pessoa manda o escritório dela
para a sede, e a sede mostra todo mundo junto, com login por pessoa.

```
 Computador da Ana (Windows)        Computador da Bia (Linux)
 Claude/Codex na conta da Ana       Claude/Codex na conta da Bia
        │                                   │
   Habblaud local ──┐               ┌── Habblaud local
                    │  HTTPS, saindo │
                    ▼  daqui pra lá  ▼
              ┌──────────────────────────┐
              │  Sede (server/central.ts) │◀── navegador de qualquer um do time (login)
              └──────────────────────────┘
```

- **Nada fica exposto no computador de ninguém.** Quem conecta é o Habblaud de cada pessoa (conexões saindo para a
  sede); a sede pede coisas a ele por essa mesma conexão (o "túnel").
- **Cada sala tem o nome da pessoa na frente** ("Ana · app-mobile"), e os agentes, contas e pedidos ganham o prefixo
  do membro por baixo (`ana~...`), então nada colide entre computadores.
- **Terminal ao vivo de qualquer agente**, pela página da sede, conforme a política (abaixo).
- **Mensagens e pedidos de permissão** pelo túnel, também conforme a política.
- **Comandar o próprio computador pelo navegador ou pelo celular**: abrir agentes novos (Claude Code ou Codex), digitar
  no terminal deles, conectar as contas e encerrar agentes. Ninguém precisa abrir o Claude nem o Codex no computador:
  o Habblaud local abre e mantém os agentes rodando, mesmo com a página fechada.

## Subir a sede

Num servidor do time (uma VPS, por exemplo; a sede não roda agentes, então gasta pouca memória):

```bash
git clone https://github.com/b0Ts4/habblaud.git && cd habblaud
npm install
npm run build
```

Cadastre as pessoas. Cada uma ganha login (o id), senha e um **token** para o computador dela, que aparece uma vez só:

```bash
npm run central:member -- add ana "Ana Souza" --admin
npm run central:member -- add bia "Bia Lima"
npm run central:member -- list
```

Suba:

```bash
npm run start:central
```

A sede escuta em `0.0.0.0:4800` (`HABBLAUD_CENTRAL_PORT`, `HABBLAUD_CENTRAL_HOST`). Ponha um proxy reverso com HTTPS na
frente (Caddy, nginx, Cloudflare Tunnel, Tailscale...) e libere o nome dele:

```bash
HABBLAUD_ALLOWED_HOSTS=habblaud.suaempresa.com npm run start:central
```

Exemplo com o **Caddy** (HTTPS automático) numa VPS Linux (Hostinger, por exemplo), com o domínio
`habblaud.suaempresa.com` apontando para o IP dela:

```bash
sudo apt install -y caddy
echo 'habblaud.suaempresa.com {
  reverse_proxy 127.0.0.1:4800 {
    flush_interval -1
  }
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
HABBLAUD_CENTRAL_HOST=127.0.0.1 HABBLAUD_ALLOWED_HOSTS=habblaud.suaempresa.com npm run start:central
```

Para a sede subir sozinha com a VPS, use um serviço do systemd (ou `pm2`) rodando o mesmo comando.

> O proxy precisa repassar **corpo de requisição em fluxo, sem buffer** (o terminal ao vivo volta assim). No nginx:
> `proxy_request_buffering off; proxy_buffering off; proxy_read_timeout 1d;` nos `location /`. O Caddy já faz isso.

Para testar sem HTTPS na própria máquina: `HABBLAUD_CENTRAL_INSECURE_HTTP=1 npm run start:central`.

| Variável | Padrão | Para quê |
| --- | --- | --- |
| `HABBLAUD_CENTRAL_CONFIG` | `~/.habblaud/central.json` | Membros e política (mantido pelo `central:member`). |
| `HABBLAUD_CENTRAL_PORT` / `HABBLAUD_CENTRAL_HOST` | `4800` / `0.0.0.0` | Onde a sede escuta. |
| `HABBLAUD_ALLOWED_HOSTS` | — | O domínio público da sede (sem ele, só `localhost` e IPs). |
| `HABBLAUD_CENTRAL_INSECURE_HTTP` | desligado | `1` tira o `Secure` do cookie de login (só para teste). |

Mudou a configuração (membro novo, senha, política)? `kill -HUP <pid da sede>` relê sem derrubar ninguém.

## Ligar o Habblaud de cada pessoa

No computador de cada um (Windows, Linux ou macOS), no `.env` do Habblaud ou no ambiente:

```bash
HABBLAUD_CENTRAL_URL=https://habblaud.suaempresa.com
HABBLAUD_CENTRAL_TOKEN=hbs_...        # o token que o central:member mostrou
HABBLAUD_PTY=1                        # deixa a sede abrir e comandar agentes neste computador
HABBLAUD_WORLD=0                      # nada da empresa vai para o Habblaud World público
```

e suba o Habblaud **com `npm start`** (fora do Docker: o terminal interativo precisa rodar no próprio computador, onde
estão o Claude Code, o Codex e os projetos). O log mostra `Sede: conectado a ...` e `Terminal interativo: ligado`.
Precisa do Claude Code e/ou do Codex CLI instalados (`npm i -g @anthropic-ai/claude-code @openai/codex`); não precisa
abrir nenhum dos dois.

`HABBLAUD_CENTRAL_ALLOW` é a palavra final **de quem é dono do computador** sobre o que a sede pode fazer ali, seja
qual for a política da sede:

| Valor | Libera |
| --- | --- |
| `terminal` | ver a conversa ao vivo dos agentes deste computador |
| `messages` | mandar mensagens aos agentes daqui (como se digitadas no terminal) |
| `permissions` | aprovar/recusar pedidos de permissão dos agentes daqui |
| `control` | abrir agentes novos, digitar no terminal deles, fazer login das contas e encerrar agentes (só pelo dono) |

O padrão é `terminal,messages,permissions,control`. Detalhes de agente (o histórico que o escritório já mostra) vão sempre. Nada além
dessas rotas passa pelo túnel: terminal interativo, Novo agente, arquivos e o Habblaud World ficam de fora.

> Para uso no escritório, desligue o Habblaud World público: `HABBLAUD_WORLD=0`.

## Comandar o computador pela web (e pelo celular)

Com `HABBLAUD_PTY=1` e `control` liberado, a página da sede, logada como você, comanda **o seu** computador:

- **Novo agente** (botão na barra do topo): escolha **Claude Code** ou **Codex**, o projeto e o pedido. O agente abre
  no seu computador, já trabalhando no pedido, e continua rodando com a página fechada. Acompanhe pelo escritório,
  responda as permissões e mande mensagens; o terminal dele abre por cima para digitar (no celular, em tela cheia).
- **Conectar conta** (no fim da janela Novo agente): abre o login da ferramenta num terminal. No Codex é o login por
  código (`codex login --device-auth`): aparece um link e um código, que dá para autorizar pelo celular com a conta do
  ChatGPT. No Claude Code é o `/login`. Quem tem as duas contas conecta as duas. As credenciais ficam só no seu
  computador; a sede nunca as vê.
- **Encerrar** e **Assumir daqui** (Claude Code), como no Habblaud local.

O terminal interativo é sempre só do dono: nem administrador digita no computador de outra pessoa pela sede. A sede
confere isso em cada pedido, e o seu computador confere de novo o `control` no `HABBLAUD_CENTRAL_ALLOW`.

> Primeira vez com o Codex neste computador? Depois do primeiro login, reinicie o Habblaud local para ele passar a
> mostrar as conversas do Codex no escritório.

## Política: quem faz o quê com os agentes dos outros

```bash
npm run central:member -- policy terminal=all messages=own permissions=own
```

| Regra | `own` | `all` | Padrão |
| --- | --- | --- | --- |
| `terminal` | cada um vê só o terminal dos próprios agentes | todos veem o de todos | `all` |
| `messages` | cada um manda mensagem só aos próprios agentes | a qualquer agente | `own` |
| `permissions` | cada um responde só os próprios pedidos | os de qualquer um | `own` |

Administradores (`--admin`) fazem tudo. A página de cada pessoa só oferece o que ela pode fazer; a sede confere de
novo em cada pedido, e o computador do dono confere mais uma vez contra o `HABBLAUD_CENTRAL_ALLOW`.

## Segurança

- Senhas guardadas como hash scrypt; tokens dos computadores como SHA-256. O token só aparece na hora de criar
  (`central:member -- token <id>` gera outro e invalida o antigo).
- Login com cookie `HttpOnly`, `SameSite=Strict`, `Secure`, assinado por pessoa (trocar a senha derruba as sessões
  dela); freio contra tentativa e erro.
- O Habblaud de cada pessoa só aceita `https://` para a sede (exceto `localhost`), e só repassa as rotas da tabela
  acima, conferindo cada pedido.
- O terminal mostra a conversa inteira dos agentes (comandos, arquivos, saídas). Com `terminal=all`, todo o time vê
  tudo: combine isso com o time antes.

## Próximos passos (planejados)

- **Anexos e ditado** no Novo agente pela sede (hoje só o pedido em texto).
- **Agentes conversando entre si**, entre computadores, pela sede (`list`, `ask`, `check`, no estilo do Maestri).
- **Gateway do sistema**: acesso dos agentes ao sistema da empresa (Postgres com RLS por `tenant_id` e navegador
  controlado), com regras por tenant e papel, aprovação humana e auditoria.
- **Tela ao vivo do navegador** do agente quando ele estiver mexendo no sistema pela web.
