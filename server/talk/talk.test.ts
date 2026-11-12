import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { mcpArgs } from '../pty/manager';
import { LocalTalk } from './local';
import { AskRegistry, deliveryText, resolveTarget, type TalkTarget } from './registry';

const list: TalkTarget[] = [
  { id: 'ana~a:1', name: 'Cecília', owner: 'Ana Souza', ownerId: 'ana', kind: 'main' },
  { id: 'bia~b:2', name: 'Cecília', owner: 'Bia Lima', ownerId: 'bia', kind: 'main' },
  { id: 'bia~b:3', name: 'Ricardo', owner: 'Bia Lima', ownerId: 'bia', kind: 'main' },
  { id: 'bia~s:4', name: 'Explorador', owner: 'Bia Lima', ownerId: 'bia', kind: 'sub' },
];

describe('resolveTarget', () => {
  it('acha por id, nome, "Nome @ Pessoa" e "Nome da Pessoa", sem acento e sem caixa', () => {
    expect(resolveTarget(list, 'bia~b:3')).toEqual({ target: list[2] });
    expect(resolveTarget(list, 'ricardo')).toEqual({ target: list[2] });
    expect(resolveTarget(list, 'Cecilia @ Bia')).toEqual({ target: list[1] });
    expect(resolveTarget(list, 'Cecília da Ana')).toEqual({ target: list[0] });
    expect(resolveTarget(list, 'cecilia @ bia')).toEqual({ target: list[1] });
  });

  it('nome repetido ou desconhecido vira erro explicado; subagente não recebe', () => {
    expect('error' in resolveTarget(list, 'Cecília') && resolveTarget(list, 'Cecília')).toMatchObject({ error: expect.stringContaining('Bia Lima') });
    expect(resolveTarget(list, 'Ninguém')).toMatchObject({ error: expect.stringContaining('escritorio_agentes') });
    expect(resolveTarget(list, 'Explorador')).toMatchObject({ error: expect.any(String) });
  });
});

describe('AskRegistry', () => {
  it('pergunta, espera e só o destinatário responde', async () => {
    const r = new AskRegistry();
    const a = r.create({ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, 'oi?', true);
    expect(deliveryText(a)).toContain(`id: ${a.id}`);
    const waiting = r.wait(a.id, 5_000);
    expect(r.reply(a.id, 'z', 'eu')).toMatchObject({ error: expect.any(String) });
    expect(r.pendingFor('y').map((p) => p.id)).toEqual([a.id]);
    expect(r.reply(a.id, 'y', 'oi!')).toMatchObject({ ok: true });
    expect((await waiting)?.reply).toBe('oi!');
    expect(r.reply(a.id, 'y', 'de novo')).toMatchObject({ error: expect.any(String) });
    expect(r.pendingFor('y')).toEqual([]);
  });

  it('espera com prazo devolve o pedido ainda aberto', async () => {
    const r = new AskRegistry();
    const a = r.create({ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }, 'oi?', true);
    expect((await r.wait(a.id, 10))?.status).toBe('delivered');
    expect(r.open('x')).toBe(1);
  });
});

function agent(id: string, name: string): AgentInfo {
  return { id, name, kind: 'main', roomId: 'r', look: 'f', role: '', sessionId: 's', account: 'c', status: 'idle', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, statusSince: 0, stats: {} as AgentInfo['stats'], seed: 1 };
}

describe('LocalTalk (sem sede: agentes do mesmo computador)', () => {
  it('entrega, recebe a resposta e não fala consigo mesmo', async () => {
    const a = agent('c:1', 'Nina');
    const b = agent('c:2', 'Simone');
    const got: [string, string][] = [];
    const t = new LocalTalk(() => [a, b], () => 'app', (id, text) => (got.push([id, text]), { ok: true }));
    const q = await t.ask(a, 'simone', 'qual a coluna?', true);
    expect(q).toMatchObject({ status: 'delivered', to: 'Simone' });
    expect(got[0][0]).toBe('c:2');
    expect(got[0][1]).toContain('qual a coluna?');
    const id = (q as { id: string }).id;
    expect(await t.inbox(b)).toMatchObject([{ id, from: 'Nina', text: 'qual a coluna?' }]);
    expect(await t.reply(b, id, 'tenant_id')).toEqual({ ok: true });
    expect(await t.wait(a, id, 0)).toMatchObject({ status: 'answered', reply: 'tenant_id' });
    expect(await t.wait(b, id, 0)).toMatchObject({ error: expect.any(String) });
    expect(await t.ask(a, 'Nina', 'oi', true)).toMatchObject({ error: expect.any(String) });
  });

  it('entrega que falha vira pedido falho', async () => {
    const t = new LocalTalk(() => [agent('c:1', 'Nina'), agent('c:2', 'Simone')], () => undefined, () => ({ error: 'sem plugin' }));
    expect(await t.ask(agent('c:1', 'Nina'), 'Simone', 'oi', true)).toMatchObject({ status: 'failed', error: 'sem plugin' });
  });
});

describe('MCP do escritório', () => {
  it('registra no Claude Code (--mcp-config) e no Codex (-c, com prazo longo)', () => {
    const c = mcpArgs('claude', { script: '/x/server.mjs', url: 'http://127.0.0.1:4747', node: '/n' }, 'k1');
    expect(c[0]).toBe('--mcp-config');
    expect(JSON.parse(c[1]).mcpServers.escritorio).toMatchObject({ command: '/n', args: ['/x/server.mjs'], env: { HABBLAUD_AGENT_KEY: 'k1' } });
    const x = mcpArgs('codex', { script: 'C:\\h\\server.mjs', url: 'http://127.0.0.1:4747', node: 'C:\\node.exe' }, 'k2');
    expect(x).toContain('mcp_servers.escritorio.args=["C:\\\\h\\\\server.mjs"]');
    expect(x).toContain('mcp_servers.escritorio.tool_timeout_sec=900');
    expect(x.join(' ')).toContain('HABBLAUD_AGENT_KEY = "k2"');
  });

  it('fala MCP por stdio: initialize, tools/list e erro claro sem o Habblaud', async () => {
    const child = spawn(process.execPath, [join(__dirname, '..', '..', 'mod', 'habblaud-mcp', 'server.mjs')], { env: { ...process.env, HABBLAUD_URL: 'http://127.0.0.1:9' } });
    const lines: Record<string, unknown>[] = [];
    let buf = '';
    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)) as Record<string, unknown>);
        buf = buf.slice(i + 1);
      }
    });
    const send = (m: unknown) => child.stdin.write(`${JSON.stringify(m)}\n`);
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'escritorio_agentes', arguments: {} } });
    const until = Date.now() + 10_000;
    while (lines.length < 3 && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    child.kill();
    const byId = new Map(lines.map((l) => [l.id, l.result as Record<string, unknown>]));
    expect(byId.get(1)).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} } });
    expect((byId.get(2)!.tools as { name: string }[]).map((t) => t.name)).toEqual([
      'escritorio_agentes',
      'escritorio_perguntar',
      'escritorio_enviar',
      'escritorio_ver_resposta',
      'escritorio_responder',
      'escritorio_pendentes',
      'sistema_tenants',
      'sistema_consultar',
      'sistema_alterar',
      'sistema_ver_alteracao',
      'sistema_web_abrir',
      'sistema_web_ler',
      'sistema_web_clicar',
      'sistema_web_preencher',
      'sistema_web_print',
    ]);
    expect(byId.get(3)).toMatchObject({ isError: true });
  });
});
