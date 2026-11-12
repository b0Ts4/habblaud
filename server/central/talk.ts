// Conversa entre agentes na sede: o MCP de um agente pergunta (pelo Habblaud do computador dele, server/talk/central.ts)
// e a sede entrega a mensagem ao agente de destino, em qualquer computador, pelo túnel (POST /api/office/deliver no
// Habblaud de lá). A resposta volta pelo mesmo caminho. Quem pode falar com quem: a política `agents` da sede
// (padrão: todos com todos) e o "agents" no HABBLAUD_CENTRAL_ALLOW do computador de destino.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { AgentInfo } from '../../shared/types';
import { AskRegistry, deliveryText, OPEN_MAX, resolveTarget, TALK_TEXT_MAX, type TalkTarget } from '../talk/registry';
import { view } from '../talk/local';
import type { CentralConfig, Member } from './config';
import { globalId, splitId } from './merge';
import type { Members } from './members';

export interface CentralTalkDeps {
  config: () => CentralConfig;
  members: Members;
  registry: AskRegistry;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: <T>(req: IncomingMessage) => Promise<T>;
}

/** Os agentes que dá para chamar: os principais de cada computador conectado que aceita conversa entre agentes. */
export function talkTargets(members: Members): TalkTarget[] {
  const out: TalkTarget[] = [];
  for (const m of members.states()) {
    if (!m.caps?.allow.includes('agents')) continue;
    const rooms = new Map(m.snapshot.rooms.map((r) => [r.id, r.name]));
    for (const a of m.snapshot.agents) {
      if (a.kind !== 'main') continue;
      out.push({ id: globalId(m.id, a.id), name: a.name, kind: a.kind, status: a.status, provider: a.provider ?? 'claude', title: a.title, room: rooms.get(a.roomId), owner: m.name, ownerId: m.id });
    }
  }
  return out;
}

function agentOf(members: Members, gid: string): { member: string; agent: AgentInfo; room?: string; owner: string } | undefined {
  const id = splitId(gid);
  const m = id && members.state(id.member);
  const agent = m?.snapshot.agents.find((a) => a.id === id!.id);
  if (!m || !agent) return undefined;
  return { member: m.id, agent, room: m.snapshot.rooms.find((r) => r.id === agent.roomId)?.name, owner: m.name };
}

async function readAll(stream: NodeJS.ReadableStream, max = 64 * 1024): Promise<string> {
  let out = '';
  for await (const c of stream as AsyncIterable<Buffer>) {
    out += c.toString('utf8');
    if (out.length > max) break;
  }
  return out;
}

/** Rotas /central/uplink/{office,ask,reply,inbox}, já com o membro autenticado pelo token. true = respondeu. */
export function handleTalk(deps: CentralTalkDeps, m: Member, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const { members, registry } = deps;
  const path = url.pathname;
  const method = req.method ?? 'GET';
  const send = deps.sendJson;
  const mine = (local: unknown) => (typeof local === 'string' ? agentOf(members, globalId(m.id, local)) : undefined);

  if (path === '/central/uplink/office' && method === 'GET') {
    send(res, 200, { agents: talkTargets(members) });
    return true;
  }
  if (path === '/central/uplink/inbox' && method === 'GET') {
    const from = globalId(m.id, url.searchParams.get('from') ?? '');
    send(res, 200, { asks: registry.pendingFor(from).map((a) => view(a, true)) });
    return true;
  }
  const wait = /^\/central\/uplink\/ask\/([\w-]{1,40})$/.exec(path);
  if (wait && method === 'GET') {
    const a = registry.get(wait[1]);
    if (!a || a.from.id !== globalId(m.id, url.searchParams.get('from') ?? '')) {
      send(res, 404, { error: tr('pedido desconhecido (expirou ou o id está errado): {0}', [wait[1]]) });
      return true;
    }
    const s = Math.max(0, Math.min(600, Number(url.searchParams.get('wait')) || 0));
    void registry.wait(a.id, s * 1000).then((r) => send(res, 200, view(r ?? a)));
    return true;
  }
  if (path === '/central/uplink/ask' && method === 'POST') {
    deps
      .readJson<{ from?: unknown; to?: unknown; text?: unknown; reply?: unknown }>(req)
      .then(async (b) => {
        const from = mine(b.from);
        if (!from) return send(res, 404, { error: tr('agente de origem desconhecido na sede (o escritório ainda não chegou lá?)') });
        if (typeof b.to !== 'string' || typeof b.text !== 'string' || !b.text.trim()) return send(res, 400, { error: tr('falta o destino ou a mensagem') });
        const r = resolveTarget(talkTargets(members), b.to);
        if ('error' in r) return send(res, 409, r);
        const to = r.target;
        const fromGid = globalId(m.id, from.agent.id);
        if (to.id === fromGid) return send(res, 409, { error: tr('não dá para mandar mensagem para si mesmo') });
        const cfg = deps.config();
        if (cfg.policy.agents === 'own' && to.ownerId !== m.id) return send(res, 403, { error: tr('a política da sede só deixa os agentes falarem com os da mesma pessoa') });
        const expectReply = b.reply !== false;
        if (expectReply && registry.open(fromGid) >= OPEN_MAX) return send(res, 429, { error: tr('perguntas demais sem resposta (máximo de {0})', [OPEN_MAX]) });
        const a = registry.create({ id: fromGid, name: from.agent.name, owner: from.owner, room: from.room }, { id: to.id, name: to.name, owner: to.owner, room: to.room }, b.text.slice(0, TALK_TEXT_MAX), expectReply);
        const target = splitId(to.id)!;
        const t = members.request(target.member, { method: 'POST', path: '/api/office/deliver', body: { agentId: target.id, text: deliveryText(a) } });
        try {
          const out = await t.response;
          const body = await readAll(out.body);
          if (out.status !== 200) {
            let err = tr('o computador de destino recusou ({0})', [out.status]);
            try {
              err = (JSON.parse(body) as { error?: string }).error ?? err;
            } catch {
              // fica a mensagem genérica
            }
            registry.fail(a.id, err);
          } else if (!expectReply) a.status = 'answered';
        } catch (err) {
          registry.fail(a.id, (err as Error).message);
        } finally {
          t.cancel();
        }
        send(res, 200, view(registry.get(a.id)!));
      })
      .catch(() => send(res, 400, { error: tr('requisição inválida') }));
    return true;
  }
  if (path === '/central/uplink/reply' && method === 'POST') {
    deps
      .readJson<{ from?: unknown; id?: unknown; text?: unknown }>(req)
      .then((b) => {
        if (typeof b.from !== 'string' || typeof b.id !== 'string' || typeof b.text !== 'string') return send(res, 400, { error: tr('requisição inválida') });
        const r = registry.reply(b.id, globalId(m.id, b.from), b.text);
        send(res, 'error' in r ? 409 : 200, 'error' in r ? r : { ok: true });
      })
      .catch(() => send(res, 400, { error: tr('requisição inválida') }));
    return true;
  }
  return false;
}
