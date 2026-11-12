// Rotas que o MCP dos agentes (mod/habblaud-mcp/server.mjs) chama neste computador, só pela porta local:
//   GET  /api/office/agents                         quem está no escritório (o do time inteiro, com sede)
//   POST /api/office/ask    {who, to, text, reply}  pergunta (reply=true) ou avisa (reply=false) outro agente
//   GET  /api/office/ask/:id?wait=<s>               espera a resposta
//   POST /api/office/reply  {who, id, text}         responde uma pergunta recebida
//   GET  /api/office/inbox?who=...                  perguntas recebidas ainda sem resposta
//   POST /api/office/deliver {agentId, text}        (a sede, pelo túnel) entrega uma mensagem a um agente daqui
// `who` identifica o agente que chama: a chave do terminal que o Habblaud abriu (HABBLAUD_AGENT_KEY) ou, para uma
// sessão do Claude Code aberta à mão, o PID dela (o processo pai do MCP).
// Sem sede, a conversa é roteada aqui mesmo (LocalTalk); com sede, vai para ela (central/talk.ts no servidor da sede).
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { AgentInfo } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';
import { AskRegistry, deliveryText, OPEN_MAX, resolveTarget, TALK_TEXT_MAX, type Ask, type TalkTarget } from './registry';

export interface Who {
  key?: string;
  ppid?: number;
}

/** Resposta pública de um pedido (o que o MCP mostra ao agente). */
export interface AskView {
  id: string;
  to: string;
  status: Ask['status'];
  reply?: string;
  error?: string;
  from?: string;
  text?: string;
}

export function view(a: Ask, withText = false): AskView {
  const out: AskView = { id: a.id, to: a.to.owner ? `${a.to.name} @ ${a.to.owner}` : a.to.name, status: a.status };
  if (a.reply !== undefined) out.reply = a.reply;
  if (a.error) out.error = a.error;
  if (withText) {
    out.from = a.from.owner ? `${a.from.name} @ ${a.from.owner}` : a.from.name;
    out.text = a.text;
  }
  return out;
}

/** Para onde vai a conversa: o registro deste computador ou a sede. */
export interface TalkBackend {
  agents(): Promise<TalkTarget[]>;
  ask(from: AgentInfo, to: string, text: string, expectReply: boolean): Promise<AskView | { error: string }>;
  wait(from: AgentInfo, id: string, ms: number): Promise<AskView | { error: string }>;
  reply(from: AgentInfo, id: string, text: string): Promise<{ ok: true } | { error: string }>;
  inbox(from: AgentInfo): Promise<AskView[]>;
}

/** Entrega uma mensagem a um agente deste computador (terminal do Habblaud ou mensagens pelo escritório). */
export type Deliver = (agentId: string, text: string) => { ok: true } | { error: string };

export function targetOf(a: AgentInfo, room?: string, owner?: string, ownerId?: string): TalkTarget {
  return { id: a.id, name: a.name, kind: a.kind, status: a.status, provider: a.provider ?? 'claude', title: a.title, room, owner, ownerId };
}

/** Conversa só entre os agentes deste computador (sem sede). */
export class LocalTalk implements TalkBackend {
  readonly registry = new AskRegistry();

  constructor(
    private readonly list: () => AgentInfo[],
    private readonly roomName: (roomId: string) => string | undefined,
    private readonly deliver: Deliver,
  ) {}

  async agents(): Promise<TalkTarget[]> {
    return this.list().map((a) => targetOf(a, this.roomName(a.roomId)));
  }

  async ask(from: AgentInfo, to: string, text: string, expectReply: boolean): Promise<AskView | { error: string }> {
    const r = resolveTarget(await this.agents(), to);
    if ('error' in r) return r;
    if (r.target.id === from.id) return { error: tr('não dá para mandar mensagem para si mesmo') };
    if (expectReply && this.registry.open(from.id) >= OPEN_MAX) return { error: tr('perguntas demais sem resposta (máximo de {0})', [OPEN_MAX]) };
    const a = this.registry.create({ id: from.id, name: from.name, room: this.roomName(from.roomId) }, { id: r.target.id, name: r.target.name, room: r.target.room }, text, expectReply);
    const d = this.deliver(r.target.id, deliveryText(a));
    if ('error' in d) this.registry.fail(a.id, d.error);
    else if (!expectReply) a.status = 'answered';
    return view(this.registry.get(a.id)!);
  }

  async wait(from: AgentInfo, id: string, ms: number): Promise<AskView | { error: string }> {
    const a = this.registry.get(id);
    if (!a) return { error: tr('pedido desconhecido (expirou ou o id está errado): {0}', [id]) };
    if (a.from.id !== from.id) return { error: tr('este pedido foi feito por outro agente') };
    return view((await this.registry.wait(id, ms)) ?? a);
  }

  async reply(from: AgentInfo, id: string, text: string): Promise<{ ok: true } | { error: string }> {
    const r = this.registry.reply(id, from.id, text);
    return 'error' in r ? r : { ok: true };
  }

  async inbox(from: AgentInfo): Promise<AskView[]> {
    return this.registry.pendingFor(from.id).map((a) => view(a, true));
  }
}

export interface TalkRoutesDeps {
  /** O agente que chama, pela chave do terminal ou pelo PID do Claude Code. */
  whoIs: (who: Who) => AgentInfo | undefined;
  backend: () => TalkBackend;
  deliver: Deliver;
  /** Gateway do sistema (só pela sede): ferramentas sistema_* do MCP. */
  gateway?: (from: AgentInfo, action: string, args: Record<string, unknown>) => Promise<unknown>;
}

function parseWho(raw: unknown): Who {
  const w = (raw ?? {}) as { key?: unknown; ppid?: unknown };
  return {
    key: typeof w.key === 'string' && w.key.length <= 100 ? w.key : undefined,
    ppid: typeof w.ppid === 'number' && Number.isSafeInteger(w.ppid) && w.ppid > 0 ? w.ppid : undefined,
  };
}

function text(v: unknown): string {
  if (typeof v !== 'string' || !v.trim()) throw new HttpError(400, tr('mensagem vazia'));
  if (v.length > TALK_TEXT_MAX) throw new HttpError(400, tr('mensagem grande demais (máximo de {0} caracteres)', [TALK_TEXT_MAX]));
  return v.trim();
}

export function createTalkRoutes(deps: TalkRoutesDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => void {
  const me = (raw: unknown): AgentInfo => {
    const a = deps.whoIs(parseWho(raw));
    if (!a) throw new HttpError(404, tr('não sei qual agente está chamando: abra o agente pelo Habblaud (Novo agente) ou numa sessão do Claude Code com o MCP do escritório'));
    return a;
  };
  const handle = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (path === '/api/office/agents' && method === 'GET') return sendJson(res, 200, { agents: await deps.backend().agents() });
    if (path === '/api/office/inbox' && method === 'GET') {
      const who = { key: url.searchParams.get('key') ?? undefined, ppid: Number(url.searchParams.get('ppid')) || undefined };
      return sendJson(res, 200, { asks: await deps.backend().inbox(me(who)) });
    }
    if (method !== 'POST' && !path.startsWith('/api/office/ask/')) throw new HttpError(405, tr('método não permitido'));
    if (path === '/api/office/ask') {
      const b = (await readJson(req)) as { who?: unknown; to?: unknown; text?: unknown; reply?: unknown };
      const from = me(b.who);
      if (typeof b.to !== 'string' || !b.to.trim()) throw new HttpError(400, tr('diga para qual agente'));
      const r = await deps.backend().ask(from, b.to.trim(), text(b.text), b.reply !== false);
      return sendJson(res, 'error' in r && !('id' in r) ? 409 : 200, r);
    }
    const wait = /^\/api\/office\/ask\/([\w-]{1,40})$/.exec(path);
    if (wait && method === 'GET') {
      const who = { key: url.searchParams.get('key') ?? undefined, ppid: Number(url.searchParams.get('ppid')) || undefined };
      const s = Math.max(0, Math.min(600, Number(url.searchParams.get('wait')) || 0));
      const r = await deps.backend().wait(me(who), wait[1], s * 1000);
      return sendJson(res, 'error' in r && !('id' in r) ? 404 : 200, r);
    }
    if (path === '/api/office/reply') {
      const b = (await readJson(req)) as { who?: unknown; id?: unknown; text?: unknown };
      if (typeof b.id !== 'string') throw new HttpError(400, tr('falta o id do pedido'));
      const r = await deps.backend().reply(me(b.who), b.id, text(b.text));
      return sendJson(res, 'error' in r ? 409 : 200, r);
    }
    if (path === '/api/office/gateway') {
      const b = (await readJson(req, 256 * 1024)) as { who?: unknown; action?: unknown; args?: unknown };
      const from = me(b.who);
      if (!deps.gateway) return sendJson(res, 200, { error: tr('o acesso ao sistema da empresa passa pela sede: este computador não está ligado a uma sede (HABBLAUD_CENTRAL_URL)') });
      return sendJson(res, 200, await deps.gateway(from, String(b.action ?? ''), (b.args ?? {}) as Record<string, unknown>));
    }
    if (path === '/api/office/deliver') {
      const b = (await readJson(req)) as { agentId?: unknown; text?: unknown };
      if (typeof b.agentId !== 'string') throw new HttpError(400, tr('falta o agente'));
      const r = deps.deliver(b.agentId, text(b.text));
      return sendJson(res, 'error' in r ? 409 : 200, r);
    }
    throw new HttpError(404, tr('rota desconhecida'));
  };
  return (req, res, url) => {
    handle(req, res, url).catch((err: unknown) => {
      if (res.headersSent) return void res.destroy();
      if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
      else sendJson(res, 500, { error: tr('erro interno') });
    });
  };
}
