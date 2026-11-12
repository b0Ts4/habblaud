// O Habblaud deste computador conectado à sede do time (server/central.ts). Liga com HABBLAUD_CENTRAL_URL e
// HABBLAUD_CENTRAL_TOKEN (o token que o `npm run central:member -- add` mostrou). Duas conexões, as duas daqui para lá
// (nada neste computador fica exposto):
//  - estado: cada snapshot novo do escritório (com throttle), o feed e os avisos vão por POST para a sede;
//  - comandos: um SSE aberto com a sede, por onde ela pede coisas à API local deste Habblaud (o terminal de um agente,
//    mandar uma mensagem, responder uma permissão). Cada pedido é conferido contra HABBLAUD_CENTRAL_ALLOW antes de
//    chegar à API local: o dono do computador decide o que a sede pode fazer aqui, seja qual for a política dela.
import { gzipSync } from 'node:zlib';
import { tr } from '../../shared/i18n';
import type { FeedItem, Notice, OfficeSnapshot } from '../../shared/types';
import { errMsg } from '../log';

/**
 * terminal: ver a conversa; messages: mandar mensagens; permissions: responder pedidos; control: abrir agentes novos,
 * digitar no terminal interativo e encerrar agentes neste computador (comandar o computador pela sede); agents: agentes de
 * outros computadores conversando com os daqui.
 */
export type CentralFeature = 'terminal' | 'messages' | 'permissions' | 'control' | 'agents';
export const DEFAULT_CENTRAL_ALLOW: readonly CentralFeature[] = ['terminal', 'messages', 'permissions', 'control', 'agents'];

/** O que este computador oferece à sede (vai junto com o estado). */
export interface CentralCaps {
  allow: CentralFeature[];
  /** Terminal interativo ligado aqui (HABBLAUD_PTY=1, node-pty). */
  pty: boolean;
  /** Ferramentas instaladas aqui para abrir agentes novos. */
  providers: ('claude' | 'codex')[];
}

export interface CentralUplinkConfig {
  /** Endereço da sede (https://...). */
  url: string;
  token: string;
  allow: Set<CentralFeature>;
}

/** HABBLAUD_CENTRAL_*; undefined quando não configurado, `warning` quando configurado errado. */
export function parseCentralUplink(env: NodeJS.ProcessEnv): { config?: CentralUplinkConfig; warning?: string } {
  const raw = env.HABBLAUD_CENTRAL_URL?.trim();
  const token = env.HABBLAUD_CENTRAL_TOKEN?.trim();
  if (!raw && !token) return {};
  if (!raw || !token) return { warning: tr('sede desligada: defina HABBLAUD_CENTRAL_URL e HABBLAUD_CENTRAL_TOKEN juntos') };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { warning: tr('sede desligada: HABBLAUD_CENTRAL_URL inválida ({0})', [raw]) };
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (local || env.HABBLAUD_CENTRAL_INSECURE_HTTP === '1'))) {
    return { warning: tr('sede desligada: use https:// em HABBLAUD_CENTRAL_URL (o token iria aberto na rede)') };
  }
  const allow = new Set<CentralFeature>();
  const list = env.HABBLAUD_CENTRAL_ALLOW?.trim();
  for (const f of list === undefined || list === '' ? DEFAULT_CENTRAL_ALLOW : list.split(',').map((s) => s.trim())) {
    if (f === 'terminal' || f === 'messages' || f === 'permissions' || f === 'control' || f === 'agents') allow.add(f);
  }
  return { config: { url: url.origin, token, allow } };
}

interface TunnelCommand {
  id: string;
  method: 'GET' | 'POST';
  path: string;
  body?: unknown;
}

/** O que a sede pode pedir à API local, e o que cada pedido exige em HABBLAUD_CENTRAL_ALLOW (null = sempre). */
const ROUTES: { method: 'GET' | 'POST'; re: RegExp; needs: CentralFeature | null }[] = [
  // Detalhes do agente: o mesmo que o snapshot já mostra, com o histórico mais longo.
  { method: 'GET', re: /^\/api\/agents\/[^/]+$/, needs: null },
  { method: 'GET', re: /^\/api\/agents\/[^/]+\/terminal$/, needs: 'terminal' },
  { method: 'POST', re: /^\/api\/messages$/, needs: 'messages' },
  { method: 'GET', re: /^\/api\/messages\/[^/]+$/, needs: 'messages' },
  { method: 'GET', re: /^\/api\/permissions\/[^/]+$/, needs: 'permissions' },
  { method: 'POST', re: /^\/api\/permissions\/[^/]+\/decision$/, needs: 'permissions' },
  // Comandar o computador: terminal interativo (abrir, ver, digitar, encerrar) e agentes (encerrar, assumir).
  { method: 'GET', re: /^\/api\/pty$/, needs: 'control' },
  { method: 'POST', re: /^\/api\/pty$/, needs: 'control' },
  { method: 'GET', re: /^\/api\/pty\/[^/]+\/stream$/, needs: 'control' },
  { method: 'POST', re: /^\/api\/pty\/[^/]+\/(input|resize|close)$/, needs: 'control' },
  { method: 'POST', re: /^\/api\/agents\/[^/]+\/(stop|takeover)$/, needs: 'control' },
  { method: 'GET', re: /^\/api\/spawn\/folders$/, needs: 'control' },
  // Agentes de outros computadores falando com os daqui (mensagem entra na sessão do agente).
  { method: 'POST', re: /^\/api\/office\/deliver$/, needs: 'agents' },
];

/** null = pode; senão o motivo da recusa. */
export function checkCommand(c: TunnelCommand, allow: ReadonlySet<CentralFeature>): string | null {
  const route = ROUTES.find((r) => r.method === c.method && r.re.test(c.path));
  if (!route) return tr('a sede pediu algo que o Habblaud não repassa: {0} {1}', [c.method, c.path]);
  if (route.needs && !allow.has(route.needs)) return tr('este computador não libera "{0}" para a sede (HABBLAUD_CENTRAL_ALLOW)', [route.needs]);
  return null;
}

/** Lê um fluxo SSE: chama `on` com o nome e o data de cada evento. */
export async function readSse(body: ReadableStream<Uint8Array>, on: (event: string, data: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) on(event, data.join('\n'));
    }
  }
}

/**
 * O corpo da resposta local, mas que se fecha de verdade quando a sede cancela: sem isso, o envio para a sede para de
 * ler e a conexão local (o SSE do terminal) fica aberta para sempre, ocupando uma das vagas de terminal.
 */
export function cancellable(body: ReadableStream<Uint8Array>, signal: AbortSignal): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  const stop = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) stop();
  else signal.addEventListener('abort', stop, { once: true });
  return new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { done, value } = await reader.read();
        if (done) ctl.close();
        else ctl.enqueue(value);
      } catch (err) {
        ctl.error(err);
      }
    },
    cancel(reason) {
      signal.removeEventListener('abort', stop);
      return reader.cancel(reason);
    },
  });
}

export interface CentralUplinkDeps {
  config: CentralUplinkConfig;
  /** Base da API local deste Habblaud (ex.: http://127.0.0.1:4747). */
  localBase: string;
  current: () => OfficeSnapshot;
  /** O que este computador oferece (terminal interativo, ferramentas instaladas). */
  caps?: () => Omit<CentralCaps, 'allow'>;
  onSnapshot: (cb: (snap: OfficeSnapshot) => void) => () => void;
  onFeed: (cb: (feed: FeedItem[], notices: Notice[]) => void) => () => void;
  log: { info: (m: string) => void; warn: (m: string) => void };
  fetch?: typeof fetch;
  /** Intervalo mínimo entre remessas de estado. */
  throttleMs?: number;
  /** Reenvia o escritório inteiro de tempos em tempos (a sede reiniciou? volta a saber de tudo). */
  heartbeatMs?: number;
}

export type CentralUplinkState = 'connecting' | 'online' | 'offline' | 'refused';

export class CentralUplink {
  private readonly fetch: typeof fetch;
  private stopped = false;
  private state: CentralUplinkState = 'connecting';
  private commands: AbortController | null = null;
  private inflight = new Map<string, AbortController>();
  private pendingSnap: OfficeSnapshot | null = null;
  private pendingFeed: FeedItem[] = [];
  private pendingNotices: Notice[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private lastSend = 0;
  private sending = false;
  private unsubs: (() => void)[] = [];
  private backoff = 1_000;

  constructor(private readonly deps: CentralUplinkDeps) {
    this.fetch = deps.fetch ?? fetch;
  }

  status(): CentralUplinkState {
    return this.state;
  }

  start(): void {
    this.unsubs.push(
      this.deps.onSnapshot((snap) => {
        this.pendingSnap = snap;
        this.schedule();
      }),
      this.deps.onFeed((feed, notices) => {
        this.pendingFeed.push(...feed);
        this.pendingNotices.push(...notices);
        this.schedule();
      }),
    );
    this.heartbeat = setInterval(() => {
      this.pendingSnap = this.deps.current();
      this.schedule();
    }, this.deps.heartbeatMs ?? 20_000);
    this.heartbeat.unref?.();
    this.pendingSnap = this.deps.current();
    this.schedule();
    void this.connect();
  }

  stop(): void {
    this.stopped = true;
    for (const u of this.unsubs) u();
    if (this.timer) clearTimeout(this.timer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.commands?.abort();
    for (const c of this.inflight.values()) c.abort();
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Authorization: `Bearer ${this.deps.config.token}`, ...extra };
  }

  // ---- Estado ------------------------------------------------------------------------------------------------

  private schedule(): void {
    if (this.timer || this.stopped) return;
    const wait = Math.max(0, this.lastSend + (this.deps.throttleMs ?? 1_000) - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.send();
    }, wait);
    this.timer.unref?.();
  }

  private async send(): Promise<void> {
    if (this.sending) return this.schedule();
    const snapshot = this.pendingSnap;
    const feed = this.pendingFeed.splice(0);
    const notices = this.pendingNotices.splice(0);
    this.pendingSnap = null;
    if (!snapshot && !feed.length && !notices.length) return;
    this.sending = true;
    this.lastSend = Date.now();
    try {
      const caps: CentralCaps = { allow: [...this.deps.config.allow], ...(this.deps.caps?.() ?? { pty: false, providers: [] }) };
      const body = gzipSync(JSON.stringify({ snapshot: snapshot ?? undefined, feed, notices, caps }));
      const res = await this.fetch(`${this.deps.config.url}/central/uplink/state`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' }),
        body,
        signal: AbortSignal.timeout(15_000),
      });
      await res.body?.cancel();
      if (res.status === 401) this.refused();
      else if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      // Volta para a fila: o próximo envio leva o snapshot mais novo (o heartbeat garante que ele exista).
      if (snapshot && !this.pendingSnap) this.pendingSnap = snapshot;
      this.deps.log.warn(tr('Sede: não consegui mandar o escritório ({0}).', [errMsg(err)]));
    } finally {
      this.sending = false;
    }
  }

  private refused(): void {
    if (this.state !== 'refused') this.deps.log.warn(tr('Sede: o token foi recusado (HABBLAUD_CENTRAL_TOKEN). Peça um novo a quem administra a sede.'));
    this.state = 'refused';
  }

  // ---- Comandos (túnel) --------------------------------------------------------------------------------------

  private async connect(): Promise<void> {
    while (!this.stopped) {
      const ctl = new AbortController();
      this.commands = ctl;
      try {
        const res = await this.fetch(`${this.deps.config.url}/central/uplink/commands`, { headers: this.headers({ Accept: 'text/event-stream' }), signal: ctl.signal });
        if (res.status === 401) {
          await res.body?.cancel();
          this.refused();
        } else if (!res.ok || !res.body) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status}`);
        } else {
          if (this.state !== 'online') this.deps.log.info(tr('Sede: conectado a {0}.', [this.deps.config.url]));
          this.state = 'online';
          this.backoff = 1_000;
          // Reconectou: a sede pode ter esquecido o escritório.
          this.pendingSnap = this.deps.current();
          this.schedule();
          await readSse(res.body, (event, data) => this.onCommand(event, data));
          throw new Error(tr('conexão encerrada'));
        }
      } catch (err) {
        if (this.stopped) return;
        if (this.state === 'online') this.deps.log.warn(tr('Sede: conexão perdida ({0}); tentando de novo.', [errMsg(err)]));
        if (this.state !== 'refused') this.state = 'offline';
      }
      const wait = this.state === 'refused' ? 60_000 : this.backoff;
      this.backoff = Math.min(30_000, this.backoff * 2);
      await new Promise((r) => setTimeout(r, wait).unref?.());
    }
  }

  private onCommand(event: string, data: string): void {
    let c: TunnelCommand;
    try {
      c = JSON.parse(data) as TunnelCommand;
    } catch {
      return;
    }
    if (typeof c?.id !== 'string' || !/^[0-9a-f-]{36}$/.test(c.id)) return;
    if (event === 'cancel') {
      this.inflight.get(c.id)?.abort();
      this.inflight.delete(c.id);
    } else if (event === 'request') void this.handle(c);
  }

  private async handle(c: TunnelCommand): Promise<void> {
    const refuse = checkCommand(c, this.deps.config.allow);
    if (refuse) return this.reply(c.id, 403, 'application/json', JSON.stringify({ error: refuse }));
    const ctl = new AbortController();
    this.inflight.set(c.id, ctl);
    try {
      const local = await this.fetch(`${this.deps.localBase}${c.path}`, {
        method: c.method,
        headers: c.method === 'POST' ? { 'Content-Type': 'application/json' } : { Accept: '*/*' },
        body: c.method === 'POST' ? JSON.stringify(c.body ?? {}) : undefined,
        signal: ctl.signal,
      });
      await this.reply(c.id, local.status, local.headers.get('content-type') ?? 'application/octet-stream', local.body ? cancellable(local.body, ctl.signal) : '', ctl.signal);
    } catch (err) {
      if (!ctl.signal.aborted) await this.reply(c.id, 502, 'application/json', JSON.stringify({ error: errMsg(err) }));
    } finally {
      // Acabou o envio (inteiro, cancelado ou caído do lado da sede, que às vezes chega antes do aviso de cancelar):
      // a resposta local não serve mais. Sem isto, o SSE do terminal ficaria aberto aqui, ocupando uma vaga.
      ctl.abort();
      this.inflight.delete(c.id);
    }
  }

  /** Devolve a resposta à sede; o corpo vai aos poucos (o SSE do terminal só acaba quando alguém cancela). */
  private async reply(id: string, status: number, type: string, body: ReadableStream<Uint8Array> | string, signal?: AbortSignal): Promise<void> {
    try {
      const res = await this.fetch(`${this.deps.config.url}/central/uplink/response/${id}`, {
        method: 'POST',
        headers: this.headers({ 'X-Tunnel-Status': String(status), 'X-Tunnel-Type': type, 'Content-Type': 'application/octet-stream' }),
        body,
        signal,
        // Corpo em fluxo (Node): obrigatório para mandar um ReadableStream.
        ...({ duplex: 'half' } as object),
      });
      await res.body?.cancel();
    } catch {
      // cancelado pela sede ou conexão caiu: nada a fazer
    }
  }
}
