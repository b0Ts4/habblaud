// Os computadores conectados à sede. Cada membro mantém aberta uma conexão de "comandos" (SSE, de lá para cá: o
// computador do membro é quem conecta, então nada precisa ser exposto na máquina de ninguém) e manda o estado do
// escritório dele por POST. Pela conexão de comandos a sede pede coisas ao Habblaud do membro (o terminal de um
// agente, mandar uma mensagem...): é o túnel. A resposta volta num POST cujo corpo é repassado à página aos poucos,
// o que serve também para respostas que não acabam (o SSE do terminal).
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedItem, Notice, OfficeSnapshot } from '../../shared/types';
import { tr } from '../../shared/i18n';

/** Prazo para o computador do membro começar a responder um pedido do túnel. */
export const TUNNEL_TIMEOUT_MS = 15_000;
/** Sem a conexão de comandos por este tempo, o escritório do membro sai da sede. */
export const OFFLINE_GRACE_MS = 30_000;
/** Ping na conexão de comandos (proxies derrubam conexão parada). */
const PING_MS = 15_000;

export interface TunnelRequest {
  method: 'GET' | 'POST';
  /** Caminho na API local do membro (ex.: /api/agents/<id>/terminal). */
  path: string;
  body?: unknown;
}

/** Resposta do túnel: status e tipo vindos do membro, corpo para repassar (pode não acabar, no caso do SSE). */
export interface TunnelResponse {
  status: number;
  contentType: string;
  body: IncomingMessage;
}

interface Pending {
  resolve: (r: TunnelResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** Já respondeu: o corpo está correndo (cancelar = avisar o membro). */
  streaming?: IncomingMessage;
}

interface Link {
  name: string;
  commands?: ServerResponse;
  lastSeen: number;
  snapshot?: OfficeSnapshot;
  caps?: MemberCaps;
  pending: Map<string, Pending>;
}

export interface MemberCaps {
  allow: string[];
  pty: boolean;
  providers: string[];
}

export interface MemberUpdate {
  snapshot?: OfficeSnapshot;
  caps?: MemberCaps;
  feed?: FeedItem[];
  notices?: Notice[];
}

export class Members {
  private links = new Map<string, Link>();
  private pinger: ReturnType<typeof setInterval> | null = null;
  private listeners = new Set<(member: string, u: MemberUpdate | 'gone') => void>();

  constructor(private readonly now: () => number = Date.now) {}

  start(): void {
    this.pinger = setInterval(() => this.sweep(), PING_MS);
    this.pinger.unref?.();
  }

  stop(): void {
    if (this.pinger) clearInterval(this.pinger);
    for (const l of this.links.values()) l.commands?.end();
  }

  /** Avisado a cada estado novo de um membro (ou quando ele sai: 'gone'). */
  onUpdate(cb: (member: string, u: MemberUpdate | 'gone') => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  /** Membros com escritório conhecido: id, nome e o último snapshot. */
  states(): { id: string; name: string; snapshot: OfficeSnapshot; caps?: MemberCaps }[] {
    const out: { id: string; name: string; snapshot: OfficeSnapshot; caps?: MemberCaps }[] = [];
    for (const [id, l] of this.links) if (l.snapshot) out.push({ id, name: l.name, snapshot: l.snapshot, caps: l.commands ? l.caps : undefined });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  state(id: string): { id: string; name: string; snapshot: OfficeSnapshot; caps?: MemberCaps } | undefined {
    return this.states().find((m) => m.id === id);
  }

  online(id: string): boolean {
    return !!this.links.get(id)?.commands;
  }

  private link(id: string, name: string): Link {
    let l = this.links.get(id);
    if (!l) {
      l = { name, lastSeen: this.now(), pending: new Map() };
      this.links.set(id, l);
    }
    l.name = name;
    return l;
  }

  /** Conexão de comandos do membro (GET /central/uplink/commands): substitui uma anterior. */
  attachCommands(id: string, name: string, req: IncomingMessage, res: ServerResponse): void {
    const l = this.link(id, name);
    if (l.commands && l.commands !== res) l.commands.end();
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.write(': conectado\n\n');
    l.commands = res;
    l.lastSeen = this.now();
    const drop = () => {
      if (l.commands !== res) return;
      l.commands = undefined;
      l.lastSeen = this.now();
      // Pedidos esperando resposta não vão chegar por esta conexão.
      for (const [rid, p] of l.pending) if (!p.streaming) this.fail(l, rid, new Error(tr('o computador do membro desconectou')));
    };
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /** Estado novo do escritório do membro (POST /central/uplink/state). */
  update(id: string, name: string, u: MemberUpdate): void {
    const l = this.link(id, name);
    l.lastSeen = this.now();
    if (u.snapshot) l.snapshot = u.snapshot;
    if (u.caps) l.caps = u.caps;
    for (const cb of this.listeners) cb(id, u);
  }

  /** Pede algo à API local do membro. Rejeita se ele não está conectado ou não começa a responder a tempo. */
  request(id: string, r: TunnelRequest): { id: string; response: Promise<TunnelResponse>; cancel: () => void } {
    const l = this.links.get(id);
    const rid = randomUUID();
    const response = new Promise<TunnelResponse>((resolve, reject) => {
      if (!l?.commands) return reject(new Error(tr('o computador deste membro não está conectado à sede')));
      const timer = setTimeout(() => this.fail(l, rid, new Error(tr('o computador do membro não respondeu a tempo'))), TUNNEL_TIMEOUT_MS);
      timer.unref?.();
      l.pending.set(rid, { resolve, reject, timer });
      l.commands.write(`event: request\ndata: ${JSON.stringify({ id: rid, ...r })}\n\n`);
    });
    const cancel = () => {
      if (!l) return;
      const p = l.pending.get(rid);
      if (!p) return;
      clearTimeout(p.timer);
      l.pending.delete(rid);
      p.streaming?.destroy();
      l.commands?.write(`event: cancel\ndata: ${JSON.stringify({ id: rid })}\n\n`);
    };
    return { id: rid, response, cancel };
  }

  /**
   * Resposta de um pedido do túnel (POST /central/uplink/response/:id): o status e o tipo vêm nos cabeçalhos
   * X-Tunnel-Status e X-Tunnel-Type, o corpo é o da resposta local. false se o pedido não existe (já cancelado).
   */
  respond(member: string, rid: string, req: IncomingMessage): boolean {
    const l = this.links.get(member);
    const p = l?.pending.get(rid);
    if (!l || !p || p.streaming) return false;
    clearTimeout(p.timer);
    p.streaming = req;
    const status = Number(req.headers['x-tunnel-status']);
    const contentType = typeof req.headers['x-tunnel-type'] === 'string' ? req.headers['x-tunnel-type'] : 'application/octet-stream';
    req.on('close', () => l.pending.delete(rid));
    p.resolve({ status: Number.isInteger(status) && status >= 100 && status < 600 ? status : 502, contentType, body: req });
    return true;
  }

  private fail(l: Link, rid: string, err: Error): void {
    const p = l.pending.get(rid);
    if (!p) return;
    clearTimeout(p.timer);
    l.pending.delete(rid);
    p.reject(err);
  }

  private sweep(): void {
    const now = this.now();
    for (const [id, l] of this.links) {
      if (l.commands) {
        l.commands.write(': ping\n\n');
        continue;
      }
      if (now - l.lastSeen > OFFLINE_GRACE_MS) {
        this.links.delete(id);
        for (const cb of this.listeners) cb(id, 'gone');
      }
    }
  }
}
