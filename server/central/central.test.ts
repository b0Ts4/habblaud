import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import { sseRewriter } from './app';
import { CentralSessions } from './auth';
import { allowed, hashToken, memberByToken, parseCentralFile } from './config';
import { globalId, mergeSnapshots, personalize, SlotAllocator, splitId, type MemberState } from './merge';
import { checkCommand, parseCentralUplink, readSse } from './uplink';
import { ptyArgs } from '../pty/manager';

const HASH = 'scrypt:10:8:1:AAAAAAAAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

function agent(id: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId: '/p/app',
    name: 'Ana',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: {} as unknown as AgentInfo['stats'],
    seed: 1,
    ...extra,
  };
}

function snap(agents: AgentInfo[]): OfficeSnapshot {
  return {
    rev: 1,
    serverTime: 0,
    rooms: [{ id: '/p/app', name: 'app', path: '/p/app', slot: 0, seed: 1, createdAt: 0 }],
    agents,
    accounts: [{ id: '.claude', short: 'C', name: 'Conta C', color: '#fff', configDir: '~/.claude', sessions: 1, usageStatus: 'ok' }],
    meta: { demo: false, sources: [], startedAt: 0, version: '1' },
  };
}

describe('ids da sede', () => {
  it('prefixa e separa', () => {
    expect(globalId('bruno', '.claude:123')).toBe('bruno~.claude:123');
    expect(splitId('bruno~.claude:123')).toEqual({ member: 'bruno', id: '.claude:123' });
    expect(splitId('s1~a~b')).toEqual({ member: 's1', id: 'a~b' });
    expect(splitId('semprefixo')).toBeUndefined();
    expect(splitId('Maiúscula~x')).toBeUndefined();
    expect(splitId('bruno~')).toBeUndefined();
  });
});

describe('mergeSnapshots', () => {
  const members: MemberState[] = [
    { id: 'ana', name: 'Ana', snapshot: snap([agent('.claude:1', { permission: { id: 'p1' } as AgentInfo['permission'], canMessage: true })]) },
    { id: 'bia', name: 'Bia', snapshot: snap([agent('.claude:1'), agent('s1:sub', { kind: 'sub', parentId: '.claude:1' })]) },
  ];
  const merged = mergeSnapshots(members, { rev: 7, now: 1, startedAt: 0, version: 'x', slots: new SlotAllocator() });

  it('salas e agentes de computadores diferentes não colidem', () => {
    expect(merged.rooms.map((r) => r.id)).toEqual(['ana~/p/app', 'bia~/p/app']);
    expect(merged.rooms.map((r) => r.name)).toEqual(['Ana · app', 'Bia · app']);
    expect(new Set(merged.rooms.map((r) => r.slot)).size).toBe(2);
    expect(merged.agents.map((a) => a.id)).toEqual(['ana~.claude:1', 'bia~.claude:1', 'bia~s1:sub']);
    expect(merged.agents[2].parentId).toBe('bia~.claude:1');
    expect(merged.agents[0].roomId).toBe('ana~/p/app');
    expect(merged.agents[0].account).toBe('ana~.claude');
    expect(merged.agents[0].permission?.id).toBe('ana~p1');
    expect(merged.accounts.map((a) => a.id)).toEqual(['ana~.claude', 'bia~.claude']);
    expect(merged.meta.pty?.enabled).toBe(false);
    expect(merged.meta.world?.enabled).toBe(false);
  });

  it('a vaga de uma sala não muda quando outra sai', () => {
    const slots = new SlotAllocator();
    slots.assign(['a', 'b', 'c']);
    const after = slots.assign(['a', 'c', 'd']);
    expect(after.get('a')).toBe(0);
    expect(after.get('c')).toBe(2);
    expect(after.get('d')).toBe(1);
  });

  it('esconde o que a pessoa não pode fazer com agentes dos outros', () => {
    const asBia = personalize(merged, { member: 'bia', messageOthers: false, answerOthers: false });
    const ana = asBia.agents.find((a) => a.id === 'ana~.claude:1')!;
    expect(ana.canMessage).toBeUndefined();
    expect(ana.permission).toBeUndefined();
    const asAna = personalize(merged, { member: 'ana', messageOthers: false, answerOthers: false });
    expect(asAna.agents.find((a) => a.id === 'ana~.claude:1')!.canMessage).toBe(true);
  });
});

describe('configuração da sede', () => {
  const cfg = parseCentralFile({
    policy: { terminal: 'all', messages: 'own' },
    members: [
      { id: 'ana', name: 'Ana', passwordHash: HASH, tokenHash: hashToken('t-ana'), admin: true },
      { id: 'bia', name: 'Bia', passwordHash: HASH, tokenHash: hashToken('t-bia') },
    ],
  });

  it('acha o membro pelo token', () => {
    expect(memberByToken(cfg, 't-bia')?.id).toBe('bia');
    expect(memberByToken(cfg, 'outro')).toBeUndefined();
    expect(memberByToken(cfg, undefined)).toBeUndefined();
  });

  it('aplica a política (admin passa por cima)', () => {
    const ana = cfg.members.get('ana')!;
    const bia = cfg.members.get('bia')!;
    expect(allowed(cfg, bia, 'ana', 'terminal')).toBe(true);
    expect(allowed(cfg, bia, 'ana', 'messages')).toBe(false);
    expect(allowed(cfg, bia, 'bia', 'messages')).toBe(true);
    expect(allowed(cfg, bia, 'ana', 'permissions')).toBe(false);
    expect(allowed(cfg, ana, 'bia', 'permissions')).toBe(true);
  });

  it('recusa configuração ruim', () => {
    expect(() => parseCentralFile({ members: [{ id: 'X', passwordHash: HASH, tokenHash: hashToken('a') }] })).toThrow();
    expect(() => parseCentralFile({ members: [{ id: 'a', passwordHash: 'x', tokenHash: hashToken('a') }] })).toThrow();
    const dup = { passwordHash: HASH, tokenHash: hashToken('a') };
    expect(() => parseCentralFile({ members: [{ id: 'a', ...dup }, { id: 'b', ...dup }] })).toThrow();
  });

  it('sessão de login diz de quem é e cai com a senha trocada', () => {
    let now = 1_000_000_000_000;
    const s = new CentralSessions(Buffer.alloc(32, 1), (id) => cfg.members.get(id), () => now);
    const { token } = s.issue(cfg.members.get('bia')!);
    expect(s.verify(token)?.id).toBe('bia');
    expect(s.verify(token.replace('bia', 'ana'))).toBeUndefined();
    const changed = new CentralSessions(Buffer.alloc(32, 1), (id) => ({ ...cfg.members.get(id)!, passwordHash: 'outra' }), () => now);
    expect(changed.verify(token)).toBeUndefined();
    now += 31 * 24 * 3600 * 1000;
    expect(s.verify(token)).toBeUndefined();
  });
});

describe('uplink', () => {
  it('só repassa o que o computador libera', () => {
    const allow = new Set(['terminal'] as const);
    expect(checkCommand({ id: 'x', method: 'GET', path: '/api/agents/a' }, allow)).toBeNull();
    expect(checkCommand({ id: 'x', method: 'GET', path: '/api/agents/a/terminal' }, allow)).toBeNull();
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/messages' }, allow)).toMatch(/messages/);
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/pty' }, allow)).toMatch(/control/);
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/world/cmd' }, allow)).toMatch(/não repassa/);
    expect(checkCommand({ id: 'x', method: 'GET', path: '/api/agents/a/../../world' }, allow)).toMatch(/não repassa/);
  });

  it('lê a configuração do ambiente', () => {
    expect(parseCentralUplink({})).toEqual({});
    expect(parseCentralUplink({ HABBLAUD_CENTRAL_URL: 'https://sede.x' }).warning).toBeTruthy();
    expect(parseCentralUplink({ HABBLAUD_CENTRAL_URL: 'http://sede.x', HABBLAUD_CENTRAL_TOKEN: 't' }).warning).toMatch(/https/);
    const ok = parseCentralUplink({ HABBLAUD_CENTRAL_URL: 'https://sede.x/', HABBLAUD_CENTRAL_TOKEN: 't', HABBLAUD_CENTRAL_ALLOW: 'terminal,permissions,xyz' });
    expect(ok.config?.url).toBe('https://sede.x');
    expect([...ok.config!.allow]).toEqual(['terminal', 'permissions']);
    expect([...parseCentralUplink({ HABBLAUD_CENTRAL_URL: 'http://localhost:4800', HABBLAUD_CENTRAL_TOKEN: 't' }).config!.allow]).toEqual(['terminal', 'messages', 'permissions', 'control']);
  });

  it('lê SSE em pedaços', async () => {
    const parts = ['event: request\nda', 'ta: {"a":1}\n\n: ping\n\nevent: cancel\ndata: {"b":2}\n\n'];
    const body = Readable.toWeb(Readable.from(parts.map((p) => Buffer.from(p)))) as ReadableStream<Uint8Array>;
    const got: [string, string][] = [];
    await readSse(body, (e, d) => got.push([e, d]));
    expect(got).toEqual([
      ['request', '{"a":1}'],
      ['cancel', '{"b":2}'],
    ]);
  });
});

describe('sseRewriter', () => {
  it('troca o data só do evento escolhido, mesmo cortado no meio', async () => {
    const t = sseRewriter('init', (d) => ({ ...(d as object), agentId: 'm~' + (d as { agentId: string }).agentId }));
    const out: string[] = [];
    t.on('data', (c: Buffer) => out.push(c.toString()));
    t.write('event: init\ndata: {"agentId":"a1","entries":[]}\n');
    t.write('\nevent: append\ndata: [{"agentId":"x"}]\n\n');
    t.end();
    await new Promise((r) => t.on('end', r));
    const text = out.join('');
    expect(text).toContain('"agentId":"m~a1"');
    expect(text).toContain('data: [{"agentId":"x"}]');
  });
});

describe('comandar o computador pela sede', () => {
  it('argumentos de cada ferramenta: pedido sempre depois de --', () => {
    expect(ptyArgs({ provider: 'codex', prompt: '--yolo apaga tudo' })).toEqual(['--', '--yolo apaga tudo']);
    expect(ptyArgs({ provider: 'codex', login: true })).toEqual(['login', '--device-auth']);
    expect(ptyArgs({ provider: 'claude', prompt: 'oi' })).toEqual(['--', 'oi']);
    expect(ptyArgs({ provider: 'claude', login: true })).toEqual(['--', '/login']);
    expect(ptyArgs({ provider: 'claude' }, 'abc')).toEqual(['--resume', 'abc']);
    expect(ptyArgs({ provider: 'codex' })).toEqual([]);
  });

  it('control só com o terminal interativo ligado e liberado no computador', () => {
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/pty' }, new Set(['terminal'] as const))).toMatch(/control/);
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/pty/p1-2/input' }, new Set(['control'] as const))).toBeNull();
    expect(checkCommand({ id: 'x', method: 'POST', path: '/api/agents/a/stop' }, new Set(['control'] as const))).toBeNull();
  });

  it('cada pessoa vê e comanda só os terminais do próprio computador', () => {
    const pty = { id: 'p1-9', pid: 9, cwd: '/p', account: '.codex', agentId: '.codex:p1-9', startedAt: 0, provider: 'codex' as const };
    const ana: MemberState = { id: 'ana', name: 'Ana', snapshot: { ...snap([]), ptys: [pty] }, caps: { allow: ['control'], pty: true, providers: ['codex'] } };
    const bia: MemberState = { id: 'bia', name: 'Bia', snapshot: snap([]), caps: { allow: ['terminal'], pty: true, providers: ['claude'] } };
    const merged = mergeSnapshots([ana, bia], { rev: 1, now: 1, startedAt: 0, version: 'x', slots: new SlotAllocator() });
    const asAna = personalize(merged, { member: 'ana', messageOthers: true, answerOthers: true }, ana);
    expect(asAna.ptys?.map((p) => [p.id, p.agentId, p.account])).toEqual([['ana~p1-9', 'ana~.codex:p1-9', 'ana~.codex']]);
    expect(asAna.meta.pty).toEqual({ enabled: true, providers: ['codex'] });
    const asBia = personalize(merged, { member: 'bia', messageOthers: true, answerOthers: true }, bia);
    expect(asBia.ptys).toEqual([]);
    expect(asBia.meta.pty?.enabled).toBe(false);
  });
});
