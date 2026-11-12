// Sede (escritório central): junta os escritórios de cada membro num só OfficeSnapshot, que a mesma página do
// Habblaud desenha sem saber que veio de vários computadores. Cada id local ganha o prefixo do membro
// ("<membro>~<id>"): assim salas, agentes, contas e pedidos de permissão nunca colidem entre computadores, e a sede
// sabe para quem repassar cada pedido da página (ver splitId).
import type {
  AccountInfo,
  AgentDetail,
  AgentInfo,
  FeedItem,
  Notice,
  OfficeSnapshot,
  OutboxMessage,
  PermissionRequestInfo,
  RoomInfo,
  TerminalInit,
} from '../../shared/types';

/** Separador entre o membro e o id local. Não aparece em ids de membro (ver MEMBER_ID). */
export const SEP = '~';
/** Id de membro: minúsculas, dígitos e hífen (vai em URLs, ids e nomes de arquivo). */
export const MEMBER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function globalId(member: string, id: string): string {
  return `${member}${SEP}${id}`;
}

/** "<membro>~<id local>" -> partes; undefined se não tem o formato. */
export function splitId(gid: string): { member: string; id: string } | undefined {
  const i = gid.indexOf(SEP);
  if (i <= 0) return undefined;
  const member = gid.slice(0, i);
  const id = gid.slice(i + 1);
  if (!MEMBER_ID.test(member) || !id) return undefined;
  return { member, id };
}

/** O que a sede sabe de cada membro conectado. */
export interface MemberState {
  id: string;
  /** Nome exibido (ex.: "Bruno"). */
  name: string;
  snapshot: OfficeSnapshot;
}

/** Regras de quem vê e faz o quê na sede, do ponto de vista de quem está olhando. */
export interface ViewerRights {
  /** Membro da pessoa que olha (os agentes "dela"). */
  member: string;
  /** Pode mandar mensagem a agentes de outros membros. */
  messageOthers: boolean;
  /** Pode responder pedidos de permissão de agentes de outros membros. */
  answerOthers: boolean;
}

const g = globalId;

export function mapPermission(member: string, p: PermissionRequestInfo): PermissionRequestInfo {
  return { ...p, id: g(member, p.id) };
}

export function mapAgent(member: string, a: AgentInfo): AgentInfo {
  return {
    ...a,
    id: g(member, a.id),
    roomId: g(member, a.roomId),
    parentId: a.parentId === undefined ? undefined : g(member, a.parentId),
    account: g(member, a.account),
    permission: a.permission ? mapPermission(member, a.permission) : undefined,
  };
}

export function mapRoom(member: MemberState, r: RoomInfo): RoomInfo {
  return { ...r, id: g(member.id, r.id), name: `${member.name} · ${r.name}` };
}

export function mapAccount(member: MemberState, a: AccountInfo): AccountInfo {
  return { ...a, id: g(member.id, a.id), name: `${member.name} · ${a.name}` };
}

export function mapFeed(member: MemberState, f: FeedItem): FeedItem {
  return {
    ...f,
    id: g(member.id, f.id),
    agentId: g(member.id, f.agentId),
    roomId: g(member.id, f.roomId),
    roomName: `${member.name} · ${f.roomName}`,
    account: f.account === undefined ? undefined : g(member.id, f.account),
  };
}

export function mapNotice(member: MemberState, n: Notice): Notice {
  return {
    ...n,
    id: g(member.id, n.id),
    text: `${member.name}: ${n.text}`,
    agentId: n.agentId === undefined ? undefined : g(member.id, n.agentId),
    roomId: n.roomId === undefined ? undefined : g(member.id, n.roomId),
  };
}

export function mapDetail(member: string, d: AgentDetail): AgentDetail {
  return { ...d, agent: mapAgent(member, d.agent) };
}

export function mapTerminalInit(member: string, t: TerminalInit): TerminalInit {
  return { ...t, agentId: g(member, t.agentId) };
}

export function mapOutbox(member: string, m: OutboxMessage): OutboxMessage {
  return { ...m, id: g(member, m.id), agentId: g(member, m.agentId) };
}

/**
 * Vagas das salas no prédio da sede: estáveis enquanto a sala existe (o cliente usa a vaga como ordem e posição). Uma
 * vaga liberada volta para o fim da fila de livres, para a sala nova não cair no lugar de uma que acabou de sair.
 */
export class SlotAllocator {
  private slots = new Map<string, number>();

  assign(ids: Iterable<string>): Map<string, number> {
    const live = new Set(ids);
    for (const id of [...this.slots.keys()]) if (!live.has(id)) this.slots.delete(id);
    const used = new Set(this.slots.values());
    let next = 0;
    for (const id of live) {
      if (this.slots.has(id)) continue;
      while (used.has(next)) next++;
      this.slots.set(id, next);
      used.add(next);
    }
    return this.slots;
  }
}

export interface MergeOptions {
  rev: number;
  now: number;
  startedAt: number;
  version: string;
  build?: string;
  slots: SlotAllocator;
}

/**
 * O escritório da sede: as salas de todos os membros (com o nome da pessoa na frente), os agentes e as contas.
 * Terminal interativo, Habblaud World e verificação de versão ficam de fora (são coisas de cada computador).
 */
export function mergeSnapshots(members: readonly MemberState[], opts: MergeOptions): OfficeSnapshot {
  const rooms: RoomInfo[] = [];
  const agents: AgentInfo[] = [];
  const accounts: AccountInfo[] = [];
  const sources: OfficeSnapshot['meta']['sources'] = [];
  for (const m of members) {
    for (const r of m.snapshot.rooms) rooms.push(mapRoom(m, r));
    for (const a of m.snapshot.agents) agents.push(mapAgent(m.id, a));
    for (const a of m.snapshot.accounts) accounts.push(mapAccount(m, a));
    for (const s of m.snapshot.meta.sources) sources.push({ ...s, label: g(m.id, s.label) });
  }
  const slots = opts.slots.assign(rooms.map((r) => r.id));
  for (const r of rooms) r.slot = slots.get(r.id) ?? r.slot;
  return {
    rev: opts.rev,
    serverTime: opts.now,
    rooms,
    agents,
    accounts,
    meta: {
      demo: members.some((m) => m.snapshot.meta.demo),
      sources,
      startedAt: opts.startedAt,
      version: opts.version,
      build: opts.build,
      terminal: true,
      messages: true,
      pty: { enabled: false, reason: 'sede' },
      world: { enabled: false, configured: false, state: 'off' },
    },
  };
}

/**
 * O mesmo escritório visto por uma pessoa: o que ela não pode fazer com os agentes dos outros some (mensagem e
 * pedido de permissão respondível), para a página não oferecer o que a sede vai recusar.
 */
export function personalize(snap: OfficeSnapshot, who: ViewerRights): OfficeSnapshot {
  if (who.messageOthers && who.answerOthers) return snap;
  const own = `${who.member}${SEP}`;
  return {
    ...snap,
    agents: snap.agents.map((a) => {
      if (a.id.startsWith(own)) return a;
      const out = { ...a };
      if (!who.messageOthers) delete out.canMessage;
      if (!who.answerOthers) delete out.permission;
      return out;
    }),
  };
}
