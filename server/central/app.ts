// Rotas da sede. Três públicos:
//  - o Habblaud do computador de cada membro (/central/uplink/*, com o token dele no Authorization);
//  - a página de login (/login, /api/remote/login e /api/remote/logout, as mesmas rotas da porta remota, que a
//    página do Habblaud já conhece);
//  - a página do escritório, logada: o snapshot de todos juntos e, pelo túnel, o terminal, os detalhes, as mensagens
//    e os pedidos de permissão dos agentes de cada membro, conforme a política da sede (config.ts, allowed).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Transform } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { tr } from '../../shared/i18n';
import type { AccessInfo, AgentDetail, OutboxMessage, PermissionRequestInfo, TerminalInit } from '../../shared/types';
import { COOKIE, LoginThrottle, loginPage, readCookie, safeEqual } from '../http/remote';
import { verifyPassword } from '../remote/password';
import type { CentralSessions } from './auth';
import { allowed, memberByToken, type CentralConfig, type CentralPolicy, type Member } from './config';
import type { CentralHub } from './hub';
import type { PtyInfo, PtyStatus } from '../../shared/types';
import { canControl, mapDetail, mapOutbox, mapPermission, mapPty, mapTerminalInit, splitId, type ViewerRights } from './merge';
import type { MemberUpdate, Members, TunnelRequest } from './members';
import { AskRegistry } from '../talk/registry';
import { handleTalk } from './talk';

/** Maior estado aceito de um membro (snapshot descomprimido). */
const MAX_STATE = 16 * 1024 * 1024;
/** Maior corpo aceito de uma página (mensagem, decisão de permissão). */
const MAX_BODY = 256 * 1024;
/** Maior resposta JSON do túnel que a sede lê inteira para trocar os ids. */
const MAX_TUNNEL_JSON = 4 * 1024 * 1024;

export interface CentralAppDeps {
  config: () => CentralConfig;
  members: Members;
  hub: CentralHub;
  sessions: CentralSessions;
  secure: boolean;
  version: string;
  throttle?: LoginThrottle;
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(data);
}

function readBody(req: IncomingMessage, max: number, gzip = false): Promise<Buffer> {
  return new Promise((ok, fail) => {
    const src = gzip ? req.pipe(createGunzip()) : req;
    const chunks: Buffer[] = [];
    let size = 0;
    src.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        src.destroy();
        fail(new Error(tr('corpo grande demais')));
      } else chunks.push(c);
    });
    src.on('end', () => ok(Buffer.concat(chunks)));
    src.on('error', fail);
  });
}

async function readJson<T>(req: IncomingMessage, max = MAX_BODY): Promise<T> {
  return JSON.parse((await readBody(req, max, req.headers['content-encoding'] === 'gzip')).toString('utf8')) as T;
}

function cookieHeader(value: string, maxAgeS: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`;
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  res.end(html);
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers.authorization;
  const m = typeof h === 'string' ? /^Bearer\s+(\S+)$/i.exec(h) : null;
  return m?.[1];
}

/**
 * Reescreve, num fluxo SSE, o `data` de um evento (ex.: o `init` do terminal, que leva o id local do agente). Os
 * outros eventos passam como vieram.
 */
export function sseRewriter(event: string, map: (data: unknown) => unknown): Transform {
  let buf = '';
  const fix = (block: string): string => {
    const lines = block.split('\n');
    if (!lines.some((l) => l === `event: ${event}`)) return block;
    return lines
      .map((l) => {
        if (!l.startsWith('data: ')) return l;
        try {
          return `data: ${JSON.stringify(map(JSON.parse(l.slice(6))))}`;
        } catch {
          return l;
        }
      })
      .join('\n');
  };
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      buf += chunk.toString('utf8');
      const parts = buf.split('\n\n');
      buf = parts.pop() ?? '';
      cb(null, parts.length ? parts.map((p) => `${fix(p)}\n\n`).join('') : undefined);
    },
    flush(cb) {
      cb(null, buf ? fix(buf) : undefined);
    },
  });
}

export function createCentralApp(deps: CentralAppDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const throttle = deps.throttle ?? new LoginThrottle();
  const { members, hub, sessions } = deps;
  // Conversa entre agentes de computadores diferentes (central/talk.ts).
  const talk = { config: deps.config, members, registry: new AskRegistry(), sendJson, readJson: <T>(req: IncomingMessage) => readJson<T>(req) };

  const rights = (m: Member): ViewerRights => {
    const cfg = deps.config();
    return { member: m.id, messageOthers: m.admin === true || cfg.policy.messages === 'all', answerOthers: m.admin === true || cfg.policy.permissions === 'all' };
  };

  /** Repassa um pedido ao membro e devolve a resposta à página, trocando os ids locais pelos da sede quando é JSON. */
  const tunnel = (res: ServerResponse, member: string, r: TunnelRequest, opts: { json?: (data: unknown) => unknown; sse?: { event: string; map: (d: unknown) => unknown } } = {}) => {
    const t = members.request(member, r);
    res.on('close', () => t.cancel());
    t.response
      .then(async (out) => {
        if (opts.sse && out.status === 200 && out.contentType.startsWith('text/event-stream')) {
          res.writeHead(200, { 'Content-Type': out.contentType, 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
          out.body.pipe(sseRewriter(opts.sse.event, opts.sse.map)).pipe(res);
          out.body.on('close', () => res.end());
          return;
        }
        const raw = await readBody(out.body, MAX_TUNNEL_JSON);
        if (!raw.length) {
          res.writeHead(out.status, { 'Cache-Control': 'no-store' });
          return void res.end();
        }
        let data: unknown;
        try {
          data = JSON.parse(raw.toString('utf8'));
        } catch {
          return sendJson(res, 502, { error: tr('resposta inválida do computador do membro') });
        }
        sendJson(res, out.status, out.status < 300 && opts.json ? opts.json(data) : data);
      })
      .catch((err: Error) => {
        if (!res.headersSent) sendJson(res, 502, { error: err.message });
        else res.end();
      });
  };

  const forbidden = (res: ServerResponse) => sendJson(res, 403, { error: tr('a política da sede não permite isso com agentes de outra pessoa') });

  return (req, res, url) => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const cfg = deps.config();

    // ---- Computador do membro -------------------------------------------------------------------------------
    if (path.startsWith('/central/uplink/')) {
      const m = memberByToken(cfg, bearer(req));
      if (!m) {
        req.resume();
        sendJson(res, 401, { error: tr('token do membro inválido') });
        return true;
      }
      if (path === '/central/uplink/commands' && method === 'GET') {
        members.attachCommands(m.id, m.name, req, res);
        return true;
      }
      if (path === '/central/uplink/state' && method === 'POST') {
        readJson<MemberUpdate>(req, MAX_STATE)
          .then((u) => {
            const caps = u.caps && Array.isArray(u.caps.allow) ? { allow: u.caps.allow.map(String), pty: u.caps.pty === true, providers: Array.isArray(u.caps.providers) ? u.caps.providers.map(String) : [] } : undefined;
            members.update(m.id, m.name, { snapshot: u.snapshot, caps, feed: Array.isArray(u.feed) ? u.feed : undefined, notices: Array.isArray(u.notices) ? u.notices : undefined });
            sendJson(res, 200, { ok: true, member: m.id });
          })
          .catch(() => sendJson(res, 400, { error: tr('estado inválido') }));
        return true;
      }
      const r = /^\/central\/uplink\/response\/([0-9a-f-]{36})$/.exec(path);
      if (r && method === 'POST') {
        if (!members.respond(m.id, r[1], req)) {
          req.resume();
          sendJson(res, 410, { error: tr('pedido cancelado') });
        } else req.on('end', () => sendJson(res, 200, { ok: true }));
        return true;
      }
      if (handleTalk(talk, m, req, res, url)) return true;
      req.resume();
      sendJson(res, 404, { error: tr('rota desconhecida') });
      return true;
    }

    // ---- Login ----------------------------------------------------------------------------------------------
    const who = sessions.verify(readCookie(req.headers.cookie, COOKIE));
    if (path === '/api/remote/login') {
      if (method !== 'POST') {
        sendJson(res, 405, { error: tr('método não permitido') }, { Allow: 'POST' });
        return true;
      }
      const tooMany = () => {
        const wait = Math.max(1, throttle.retryAfter());
        sendJson(res, 429, { error: tr('Muitas tentativas. Tente de novo em {0} s.', [wait]) }, { 'Retry-After': String(wait) });
      };
      if (throttle.retryAfter() > 0) {
        req.resume();
        tooMany();
        return true;
      }
      let begun = false;
      let ok = false;
      readJson<{ user?: unknown; password?: unknown }>(req, 8 * 1024)
        .catch(() => ({}) as { user?: unknown; password?: unknown })
        .then(async (body) => {
          if (!throttle.begin()) return tooMany();
          begun = true;
          const user = typeof body.user === 'string' ? body.user.trim().toLowerCase() : '';
          const password = typeof body.password === 'string' ? body.password : '';
          const member = cfg.members.get(user);
          // O scrypt roda sempre (com um membro qualquer quando o usuário não existe), sem atalho que denuncie o erro.
          const ref = member ?? cfg.members.values().next().value;
          const okPassword = ref ? await verifyPassword(password, ref.password) : false;
          if (!member || !okPassword || !safeEqual(member.id, user)) return sendJson(res, 401, { error: tr('Usuário ou senha incorretos.') });
          ok = true;
          const { token, maxAgeS } = sessions.issue(member);
          sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(token, maxAgeS, deps.secure) });
        })
        .catch(() => {
          if (!res.headersSent) sendJson(res, 400, { error: tr('requisição inválida') });
        })
        .finally(() => {
          if (begun) throttle.end(ok);
        });
      return true;
    }
    if (path === '/api/remote/logout') {
      req.resume();
      sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', 0, deps.secure) });
      return true;
    }
    if (path === '/login') {
      req.resume();
      if (who) {
        res.writeHead(302, { Location: '/', 'Cache-Control': 'no-store' });
        res.end();
      } else sendHtml(res, loginPage({ caDownload: false }));
      return true;
    }
    if (!who) {
      req.resume();
      if (path === '/api' || path.startsWith('/api/')) sendJson(res, 401, { error: tr('faça login na sede') });
      else if ((method === 'GET' || method === 'HEAD') && /^\/(manifest\.webmanifest|assets\/brand\/[\w.@-]+\.png)$/.test(path)) return false;
      else {
        res.writeHead(302, { Location: '/login', 'Cache-Control': 'no-store' });
        res.end();
      }
      return true;
    }

    // ---- Página logada --------------------------------------------------------------------------------------
    if (!path.startsWith('/api/')) return false;
    const may = (owner: string, what: keyof CentralPolicy) => allowed(cfg, who, owner, what);

    if (path === '/api/access') {
      // "Novo agente" abre no computador da própria pessoa (pelo terminal interativo dele).
      const access: AccessInfo = { remote: true, local: false, permissions: true, messages: true, terminal: true, spawn: canControl(members.state(who.id)), world: false };
      sendJson(res, 200, access);
      return true;
    }
    if (path === '/api/stream') {
      hub.attach(req, res, rights(who));
      return true;
    }
    if (path === '/api/snapshot') {
      sendJson(res, 200, hub.current(rights(who)));
      return true;
    }
    if (path === '/api/health') {
      sendJson(res, 200, { ok: true, version: deps.version, central: true, member: who.id, members: members.states().map((m) => ({ id: m.id, name: m.name, online: members.online(m.id) })) });
      return true;
    }
    if (path === '/api/central/whoami') {
      sendJson(res, 200, { id: who.id, name: who.name, admin: who.admin === true, policy: cfg.policy });
      return true;
    }

    // Agente: detalhes e terminal.
    const agent = /^\/api\/agents\/([^/]+)(\/terminal)?$/.exec(path);
    if (agent && method === 'GET') {
      const id = splitId(decodeURIComponent(agent[1]));
      if (!id) return sendJson(res, 404, { error: tr('agente desconhecido') }), true;
      const local = `/api/agents/${encodeURIComponent(id.id)}`;
      if (agent[2]) {
        if (!may(id.member, 'terminal')) return forbidden(res), true;
        tunnel(res, id.member, { method: 'GET', path: `${local}/terminal` }, { sse: { event: 'init', map: (d) => mapTerminalInit(id.member, d as TerminalInit) } });
      } else tunnel(res, id.member, { method: 'GET', path: local }, { json: (d) => mapDetail(id.member, d as AgentDetail) });
      return true;
    }

    // Mensagens.
    if (path === '/api/messages' && method === 'POST') {
      readJson<{ agentId?: unknown; text?: unknown }>(req)
        .then((body) => {
          const id = typeof body.agentId === 'string' ? splitId(body.agentId) : undefined;
          if (!id) return sendJson(res, 404, { error: tr('agente desconhecido') });
          if (!may(id.member, 'messages')) return forbidden(res);
          tunnel(res, id.member, { method: 'POST', path: '/api/messages', body: { ...body, agentId: id.id } }, { json: (d) => mapOutbox(id.member, d as OutboxMessage) });
        })
        .catch(() => sendJson(res, 400, { error: tr('requisição inválida') }));
      return true;
    }
    const msg = /^\/api\/messages\/([^/]+)$/.exec(path);
    if (msg && method === 'GET') {
      const id = splitId(decodeURIComponent(msg[1]));
      if (!id) return sendJson(res, 404, { error: tr('mensagem desconhecida') }), true;
      tunnel(res, id.member, { method: 'GET', path: `/api/messages/${encodeURIComponent(id.id)}` }, { json: (d) => mapOutbox(id.member, d as OutboxMessage) });
      return true;
    }

    // Pedidos de permissão.
    const perm = /^\/api\/permissions\/([^/]+)(\/decision)?$/.exec(path);
    if (perm) {
      const id = splitId(decodeURIComponent(perm[1]));
      if (!id) return sendJson(res, 404, { error: tr('pedido desconhecido') }), true;
      if (!may(id.member, 'permissions')) return req.resume(), forbidden(res), true;
      const local = `/api/permissions/${encodeURIComponent(id.id)}`;
      if (perm[2] && method === 'POST') {
        readJson<unknown>(req)
          .then((body) => tunnel(res, id.member, { method: 'POST', path: `${local}/decision`, body }))
          .catch(() => sendJson(res, 400, { error: tr('requisição inválida') }));
      } else if (!perm[2] && method === 'GET') {
        tunnel(res, id.member, { method: 'GET', path: local }, { json: (d) => mapPermission(id.member, d as PermissionRequestInfo) });
      } else sendJson(res, 405, { error: tr('método não permitido') });
      return true;
    }

    // ---- Comandar o próprio computador (terminal interativo, agentes novos) -------------------------------
    // Só o dono: ninguém, nem administrador, digita no computador de outra pessoa pela sede.
    const control = () => {
      if (!canControl(members.state(who.id))) {
        req.resume();
        sendJson(res, 409, { error: tr('o seu computador não está conectado à sede com o terminal interativo ligado (HABBLAUD_PTY=1)') });
        return false;
      }
      return true;
    };
    if (path === '/api/pty') {
      if (!control()) return true;
      if (method === 'GET') {
        tunnel(res, who.id, { method: 'GET', path: '/api/pty' }, { json: (d) => {
          const r = d as { status: PtyStatus; ptys: PtyInfo[] };
          return { ...r, ptys: (r.ptys ?? []).map((p) => mapPty(who.id, p)) };
        } });
      } else if (method === 'POST') {
        readJson<Record<string, unknown>>(req)
          .then((body) => {
            // A conta vem com o prefixo do membro; só vale conta do próprio computador.
            let account = body.account;
            if (typeof account === 'string') {
              const id = splitId(account);
              if (!id || id.member !== who.id) return sendJson(res, 403, { error: tr('conta de outra pessoa') });
              account = id.id;
            }
            tunnel(res, who.id, { method: 'POST', path: '/api/pty', body: { ...body, account } }, { json: (d) => mapPty(who.id, d as PtyInfo) });
          })
          .catch(() => sendJson(res, 400, { error: tr('requisição inválida') }));
      } else sendJson(res, 405, { error: tr('método não permitido') });
      return true;
    }
    const pty = /^\/api\/pty\/([^/]+)\/(stream|input|resize|close)$/.exec(path);
    const act = /^\/api\/agents\/([^/]+)\/(stop|takeover)$/.exec(path);
    if (pty || act) {
      const m = (pty ?? act)!;
      const id = splitId(decodeURIComponent(m[1]));
      if (!id || id.member !== who.id) {
        req.resume();
        sendJson(res, 403, { error: tr('só dá para comandar o próprio computador') });
        return true;
      }
      if (!control()) return true;
      const local = pty ? `/api/pty/${encodeURIComponent(id.id)}/${m[2]}` : `/api/agents/${encodeURIComponent(id.id)}/${m[2]}`;
      if (pty && m[2] === 'stream') {
        tunnel(res, who.id, { method: 'GET', path: local }, { sse: { event: '-', map: (d) => d } });
        return true;
      }
      if (method !== 'POST') {
        req.resume();
        sendJson(res, 405, { error: tr('método não permitido') });
        return true;
      }
      readJson<unknown>(req)
        .catch(() => ({}))
        .then((body) => tunnel(res, who.id, { method: 'POST', path: local, body }, { json: (d) => (act && d && typeof d === 'object' && 'id' in (d as object) ? mapPty(who.id, d as PtyInfo) : d) }));
      return true;
    }
    if (path === '/api/spawn/folders' && method === 'GET') {
      if (!control()) return true;
      tunnel(res, who.id, { method: 'GET', path: '/api/spawn/folders' });
      return true;
    }

    req.resume();
    sendJson(res, 404, { error: tr('indisponível na sede') });
    return true;
  };
}
