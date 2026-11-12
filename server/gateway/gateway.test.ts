import { describe, expect, it } from 'vitest';
import { levelsFor, parseGatewayConfig, tenantsFor } from './config';
import { firstWord, formatResult, GatewayDb, sqlProblem } from './db';
import { GatewayService } from './service';
import { credentialFor } from './web';

const cfg = parseGatewayConfig({
  tenants: { acme: 'ACME', beta: 'Beta' },
  db: { readUrl: 'postgres://l@x/db', writeUrl: 'postgres://e@x/db' },
  web: { baseUrl: 'http://sis.local:5600/', credentials: { '*': { user: 'robo', passwordEnv: 'SENHA' }, beta: { user: 'b', password: 'p' } } },
  rules: [
    { members: ['*'], tenants: ['acme'], db: 'read', web: 'view' },
    { members: ['ana'], tenants: ['*'], db: 'write', web: 'interact' },
  ],
});

describe('regras do gateway', () => {
  it('a regra mais permissiva que vale para o membro e o tenant vence', () => {
    expect(levelsFor(cfg, 'bia', 'acme')).toEqual({ db: 'read', web: 'view' });
    expect(levelsFor(cfg, 'bia', 'beta')).toEqual({ db: 'none', web: 'none' });
    expect(levelsFor(cfg, 'ana', 'acme')).toEqual({ db: 'write', web: 'interact' });
    expect(tenantsFor(cfg, 'bia').map((t) => t.id)).toEqual(['acme']);
  });

  it('sem usuário de escrita, "write" vira leitura', () => {
    const c = parseGatewayConfig({ tenants: { a: 'A' }, db: { readUrl: 'postgres://x/y' }, rules: [{ members: ['*'], tenants: ['*'], db: 'write' }] });
    expect(levelsFor(c, 'qualquer', 'a').db).toBe('read');
  });

  it('valida a configuração', () => {
    expect(() => parseGatewayConfig({ db: { readUrl: 'mysql://x' } })).toThrow();
    expect(() => parseGatewayConfig({ db: { readUrl: 'postgres://x', tenantSetting: 'x; drop' } })).toThrow();
    expect(cfg.web?.allowedHosts).toEqual(['sis.local:5600']);
    expect(cfg.approvers).toBe('owner');
  });

  it('credencial do sistema por tenant, com a senha no ambiente', () => {
    expect(credentialFor(cfg.web!, 'acme', { SENHA: 's3' })).toEqual({ user: 'robo', password: 's3' });
    expect(credentialFor(cfg.web!, 'acme', {})).toBeUndefined();
    expect(credentialFor(cfg.web!, 'beta', {})).toEqual({ user: 'b', password: 'p' });
  });
});

describe('SQL dos agentes', () => {
  it('consulta só SELECT; alteração só INSERT/UPDATE (DELETE se ligado)', () => {
    expect(sqlProblem('select * from t', 'read')).toBeNull();
    expect(sqlProblem('  /* oi */ WITH x AS (select 1) select * from x', 'read')).toBeNull();
    expect(sqlProblem('update t set a=1', 'read')).toBeTruthy();
    expect(sqlProblem('update t set a=1', 'write')).toBeNull();
    expect(sqlProblem('delete from t', 'write')).toBeTruthy();
    expect(sqlProblem('delete from t', 'write', true)).toBeNull();
    expect(sqlProblem('drop table t', 'write', true)).toBeTruthy();
    expect(sqlProblem('-- comentário\nalter table t add c int', 'write')).toBeTruthy();
    expect(firstWord('-- x\n (select 1)')).toBe('select');
  });

  it('recusa trocar o tenant por dentro (set_config) e funções perigosas', () => {
    expect(sqlProblem("select set_config('app.tenant_id','b',true)", 'read')).toBeTruthy();
    expect(sqlProblem('select pg_catalog.SET_CONFIG($$a.b$$,$$c$$,false)', 'read')).toBeTruthy();
    expect(sqlProblem("select pg_read_file('/etc/passwd')", 'read')).toBeTruthy();
    expect(sqlProblem('copy t to stdout', 'read')).toBeTruthy();
  });

  it('formata o resultado com limite', () => {
    expect(formatResult({ columns: ['id', 'v'], rows: [[1, null]], rowCount: 3, truncated: true })).toBe('id | v\n1 | NULL\n(mostrando 1 de 3 linhas; refine a consulta)');
  });
});

describe('aprovações', () => {
  it('só o dono (ou admin) decide; alteração nunca roda sem aprovação', async () => {
    const changes: { commit: boolean }[] = [];
    const db = {
      change: async (_t: string, _s: string, commit: boolean) => (changes.push({ commit }), { columns: [], rows: [], rowCount: 2, truncated: false }),
      close: async () => undefined,
    } as unknown as GatewayDb;
    const g = new GatewayService({ config: cfg, auditFile: '/dev/null', db, web: undefined });
    const caller = { member: 'ana', memberName: 'Ana', agentId: 'ana~c:1', agentName: 'Nina' };
    const r = await g.run(caller, 'alterar', { tenant: 'acme', sql: 'update pedidos set x=1', motivo: 'teste' });
    expect(r).toMatchObject({ text: expect.stringContaining('Mexeria em 2') });
    expect(changes).toEqual([{ commit: false }]);
    expect(await g.run(caller, 'alterar', { tenant: 'acme', sql: 'update t set x=1', motivo: '' })).toMatchObject({ error: expect.any(String) });
    expect(await g.run({ ...caller, member: 'bia' }, 'alterar', { tenant: 'acme', sql: 'update t set x=1', motivo: 'm' })).toMatchObject({ error: expect.any(String) });
    const [a] = g.list({ id: 'ana' });
    expect(g.list({ id: 'bia' })).toEqual([]);
    expect(await g.decide(a.id, { id: 'bia', name: 'Bia' }, true)).toMatchObject({ error: expect.any(String) });
    expect(await g.decide(a.id, { id: 'ana', name: 'Ana' }, true)).toMatchObject({ status: 'done' });
    expect(changes).toEqual([{ commit: false }, { commit: true }]);
    expect(await g.run(caller, 'alteracao', { id: a.id })).toMatchObject({ text: expect.stringContaining('aprovado por Ana') });
    expect(await g.decide(a.id, { id: 'ana', name: 'Ana' }, true)).toMatchObject({ error: expect.any(String) });
  });
});

// Com um Postgres de teste (HABBLAUD_TEST_PG=postgres://...), confere o RLS de verdade: o tenant vem do gateway.
const PG = process.env.HABBLAUD_TEST_PG;
describe.skipIf(!PG)('banco de verdade', () => {
  it('consulta só vê o tenant e não grava nada', async () => {
    const db = new GatewayDb({ readUrl: PG!, tenantSetting: 'app.tenant_id', settings: {}, maxRows: 100, maxWriteRows: 10, timeoutMs: 5000, allowDelete: false });
    try {
      const r = await db.query('acme', 'select distinct tenant_id from pedidos');
      expect(r.rows).toEqual([['acme']]);
      await expect(db.query('acme', 'update pedidos set valor = 0')).rejects.toThrow(/read-only/);
      await expect(db.query('acme', 'select 1; select 2')).rejects.toThrow(/multiple commands/);
    } finally {
      await db.close();
    }
  });
});
