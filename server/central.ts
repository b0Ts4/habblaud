// Sede: o escritório central do time. Recebe o escritório do Habblaud de cada membro (server/central/uplink.ts no
// computador de cada pessoa) e mostra todos juntos numa só página, com login por pessoa. Pelo túnel (members.ts), a
// página vê o terminal, manda mensagens e responde pedidos de permissão dos agentes de qualquer computador conforme a
// política (central/config.ts). Nada é lido do disco desta máquina além da configuração e da página compilada.
//   npm run central          -> tsx server/central.ts (precisa do npm run build:client antes)
//   npm run start:central    -> node dist/server/central.js
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tr } from '../shared/i18n';
import { createBuildReader } from './build';
import { isTruthy, loadConfig } from './config';
import { CentralSessions } from './central/auth';
import { createCentralApp, sendJson } from './central/app';
import { parseCentralFile, readCentralFile, type CentralConfig } from './central/config';
import { CentralHub } from './central/hub';
import { Members } from './central/members';
import { readGatewayConfig } from './gateway/config';
import { GatewayService } from './gateway/service';
import { CredentialStore } from './gateway/credentials';
import { createRequestGuard } from './http/guard';
import { createStaticHandler } from './http/static';
import { errMsg, log } from './log';

const base = loadConfig();
const env = process.env;
const file = env.HABBLAUD_CENTRAL_CONFIG?.trim() || join(base.dataDir, 'central.json');
const port = Number(env.HABBLAUD_CENTRAL_PORT ?? 4800);
const host = env.HABBLAUD_CENTRAL_HOST?.trim() || '0.0.0.0';
// O cookie de login sai com Secure: a sede deve ficar atrás de HTTPS (um proxy reverso como o Caddy ou o nginx).
// Só para testar na própria máquina: HABBLAUD_CENTRAL_INSECURE_HTTP=1.
const secure = !isTruthy(env.HABBLAUD_CENTRAL_INSECURE_HTTP);

let config: CentralConfig;
function reload(): void {
  config = parseCentralFile(readCentralFile(file));
}
try {
  reload();
} catch (err) {
  log.error(tr('Sede: não consegui ler {0}: {1}', [file, errMsg(err)]));
  process.exit(1);
}
if (!config!.members.size) log.warn(tr('Sede: nenhum membro em {0}. Cadastre com: npm run central:member -- add <id> "<Nome>"', [file]));

/** Segredo das sessões de login (gerado uma vez, ao lado da configuração). */
function loadSecret(path: string): Buffer {
  try {
    const s = readFileSync(path);
    if (s.length >= 32) return s;
  } catch {
    // ainda não existe
  }
  const s = randomBytes(32);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, s, { mode: 0o600 });
  return s;
}

const members = new Members();
const build = createBuildReader(base.rootDir);
const hub = new CentralHub(members, { version: base.version, startedAt: Date.now(), build });
const sessions = new CentralSessions(loadSecret(join(dirname(file), 'central-secret')), (id) => config.members.get(id));
// Gateway do sistema (banco e web), opcional: gateway.json ao lado da configuração da sede.
const gatewayFile = env.HABBLAUD_GATEWAY_CONFIG?.trim() || join(dirname(file), 'gateway.json');
let gateway: GatewayService | undefined;
try {
  const gcfg = readGatewayConfig(gatewayFile);
  if (gcfg) {
    gateway = new GatewayService({
      config: gcfg,
      auditFile: join(dirname(file), 'gateway-audit.jsonl'),
      credentials: gcfg.web ? new CredentialStore(join(dirname(file), 'gateway-credenciais.json'), join(dirname(file), 'gateway-key')) : undefined,
      notify: (a) =>
        hub.notice(a.caller.member, {
          id: a.id,
          level: 'warn',
          text: tr('✍️ {0} pede para alterar o sistema (tenant {1}): aprove ou recuse em Aprovações.', [a.caller.agentName, a.tenant]),
          at: a.createdAt,
        }),
    });
  }
} catch (err) {
  log.error(tr('Sede: gateway.json inválido ({0}): {1}', [gatewayFile, errMsg(err)]));
  process.exit(1);
}
const app = createCentralApp({ config: () => config, members, hub, sessions, secure, version: base.version, gateway });
const guard = createRequestGuard({ allowedHosts: base.allowedHosts });
const serveStatic = createStaticHandler(join(base.rootDir, 'dist', 'client'));

const server = http.createServer((req, res) => {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', 'http://localhost');
  } catch {
    url = new URL('/', 'http://localhost');
  }
  try {
    // O guard barra Host desconhecido (DNS rebinding) e POST de outra origem; o uplink dos membros não manda Origin.
    if (guard(req, res)) return;
    if (!app(req, res, url)) serveStatic(req, res, url.pathname);
  } catch (err) {
    log.warn(tr('Erro ao responder {0} {1}: {2}', [req.method, url.pathname, errMsg(err)]));
    if (!res.headersSent) sendJson(res, 500, { error: tr('erro interno') });
    else res.destroy();
  }
});
// Respostas do túnel e o SSE podem durar horas.
server.requestTimeout = 0;
server.headersTimeout = 30_000;

// Mudou a configuração (membro novo, senha trocada)? `kill -HUP` relê sem derrubar ninguém.
process.on('SIGHUP', () => {
  try {
    reload();
    log.info(tr('Sede: configuração relida ({0} membro(s)).', [config.members.size]));
  } catch (err) {
    log.warn(tr('Sede: configuração nova recusada, sigo com a anterior: {0}', [errMsg(err)]));
  }
});

members.start();
hub.start();
server.listen(port, host, () => {
  log.info(tr('🏢 Sede do Habblaud {0} ({1}) em http://{2}:{3}', [base.version, config.name, host === '0.0.0.0' ? 'localhost' : host, port]));
  log.info(tr('   Membros: {0} · política: terminal {1}, mensagens {2}, permissões {3}', [[...config.members.keys()].join(', ') || '-', config.policy.terminal, config.policy.messages, config.policy.permissions]));
  if (!secure) log.warn(tr('   Cookie de login sem Secure (HABBLAUD_CENTRAL_INSECURE_HTTP): use só para testar.'));
  log.info(
    gateway
      ? tr('   Gateway do sistema: {0} tenant(s); banco {1}; web {2}.', [gateway.config.anyTenant ? tr('qualquer') : Object.keys(gateway.config.tenants).length, gateway.db ? tr('ligado') : tr('não'), gateway.web ? gateway.config.web!.baseUrl : tr('não')])
      : tr('   Gateway do sistema: desligado (sem {0}).', [gatewayFile]),
  );
  if (!base.allowedHosts.size) log.info(tr('   Atrás de um domínio? Libere o nome em HABBLAUD_ALLOWED_HOSTS.'));
});

function shutdown(): void {
  void gateway?.close();
  hub.stop();
  members.stop();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1_500).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
