import { describe, expect, it } from 'vitest';
import { hostAllowed, knownTenant, levelsFor, parseGatewayConfig, tenantsFor } from './config';
import { CredentialStore } from './credentials';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pjoin } from 'node:path';
import { firstWord, formatResult, GatewayDb, sqlProblem } from './db';
import { GatewayService } from './service';
import { buildSql, describeChange, planChange, applyChange, parseChange } from './change';
import { credentialFor, privateAddress, publicUrl } from './web';
import { externalLevelFor } from './config';

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
  it('só o dono (ou admin) decide; nada é gravado sem aprovação; o texto é em português', async () => {
    const commits: boolean[] = [];
    const rows = [{ id: 3, tenant_id: 'acme', status: 'aberto' }];
    const db = {
      describeTable: async () => ({ columns: new Map([['id', 'integer'], ['tenant_id', 'text'], ['status', 'text']]), pk: ['id'] }),
      tenantValue: async (t: string) => t,
      tx: async (_t: string, commit: boolean, fn: (q: (sql: string) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>) => Promise<unknown>) => {
        commits.push(commit);
        return fn(async (sql) => (sql.startsWith('SELECT') ? { rows, rowCount: 1 } : { rows: [{ ...rows[0], status: 'pago' }], rowCount: 1 }));
      },
      close: async () => undefined,
    } as unknown as GatewayDb;
    const config = { ...cfg, db: { ...cfg.db!, labels: { pedidos: { nome: 'Pedidos', singular: 'pedido', registro: 'Pedido {id}', colunas: { status: 'Situação' } } } } };
    const g = new GatewayService({ config, auditFile: '/dev/null', db, web: undefined });
    const caller = { member: 'ana', memberName: 'Ana', agentId: 'ana~c:1', agentName: 'Nina' };
    const pedido = { tenant: 'acme', acao: 'atualizar', tabela: 'pedidos', onde: [{ coluna: 'id', valor: 3 }], valores: { status: 'pago' } };
    const r = await g.run(caller, 'alterar', { ...pedido, explicacao: 'O cliente pagou por PIX' });
    expect(r).toMatchObject({ text: expect.stringContaining('Pedido 3: Situação de “aberto” para “pago”') });
    expect(commits).toEqual([false]);
    expect(await g.run(caller, 'alterar', { ...pedido, explicacao: '' })).toMatchObject({ error: expect.stringContaining('português') });
    expect(await g.run(caller, 'alterar', { ...pedido, onde: [], explicacao: 'x' })).toMatchObject({ error: expect.stringContaining('tabela inteira') });
    expect(await g.run(caller, 'alterar', { ...pedido, valores: { tenant_id: 'beta' }, explicacao: 'x' })).toMatchObject({ error: expect.stringContaining('tenant') });
    expect(await g.run({ ...caller, member: 'bia' }, 'alterar', { ...pedido, explicacao: 'x' })).toMatchObject({ error: expect.any(String) });
    const [a] = g.list({ id: 'ana' });
    expect(a.summary.title).toBe('Vai alterar 1 pedido em Pedidos (ACME)');
    expect(g.list({ id: 'bia' })).toEqual([]);
    expect(await g.decide(a.id, { id: 'bia', name: 'Bia' }, true)).toMatchObject({ error: expect.any(String) });
    expect(await g.decide(a.id, { id: 'ana', name: 'Ana' }, true)).toMatchObject({ status: 'done' });
    expect(commits).toEqual([false, true]);
    expect(await g.run(caller, 'alteracao', { id: a.id })).toMatchObject({ text: expect.stringContaining('aprovado por Ana') });
    expect(await g.decide(a.id, { id: 'ana', name: 'Ana' }, true)).toMatchObject({ error: expect.any(String) });
  });
});

describe('texto das alterações', () => {
  const base = { schema: 'public', table: 'clientes', sql: '', params: [], pk: ['id'] };
  it('criar mostra os valores; apagar lista os registros; sem nomes amigáveis usa os da tabela', () => {
    const criar = describeChange(
      { ...base, request: { acao: 'criar', tabela: 'clientes', valores: { nome: 'Carla', email: 'c@x.com', tenant_id: 'acme', ativo: true } }, rowCount: 1, rows: [{ after: { id: 9, nome: 'Carla', email: 'c@x.com', tenant_id: 'acme', ativo: true } }] },
      { nome: 'Clientes', singular: 'cliente' },
      'ACME',
      'tenant_id',
    );
    expect(criar).toEqual({ title: 'Vai criar 1 cliente em Clientes (ACME)', lines: ['nome: “Carla”; email: “c@x.com”; ativo: sim'] });
    const apagar = describeChange(
      { ...base, request: { acao: 'apagar', tabela: 'clientes', onde: [{ coluna: 'email', operador: 'contem', valor: '@velho' }] }, rowCount: 2, rows: [{ before: { id: 1 } }, { before: { id: 2 } }] },
      undefined,
      'ACME',
    );
    expect(apagar.title).toBe('Vai APAGAR 2 registros de clientes (ACME), onde email contém “@velho”');
    expect(apagar.lines).toEqual(['Registro 1', 'Registro 2']);
  });

  it('o SQL montado usa só parâmetros para os valores', () => {
    const r = buildSql({ acao: 'atualizar', tabela: 'pedidos', onde: [{ coluna: 'id', valor: "3'; drop table x; --" }], valores: { status: 'pago' } }, 'public', 'pedidos', []);
    expect(r.sql).toBe('UPDATE "public"."pedidos" SET "status" = $2 WHERE "id" = $1');
    expect(r.params).toEqual(["3'; drop table x; --", 'pago']);
  });
});

// Com um Postgres de teste (HABBLAUD_TEST_PG=postgres://...), confere o RLS de verdade: o tenant vem do gateway.
const PG = process.env.HABBLAUD_TEST_PG;
describe.skipIf(!PG)('banco de verdade', () => {
  it('consulta só vê o tenant e não grava nada', async () => {
    const db = new GatewayDb({ readUrl: PG!, tenantSetting: 'app.tenant_id', settings: {}, maxRows: 100, maxWriteRows: 10, timeoutMs: 5000, allowDelete: false, labels: {} });
    try {
      const r = await db.query('acme', 'select distinct tenant_id from pedidos');
      expect(r.rows).toEqual([['acme']]);
      await expect(db.query('acme', 'update pedidos set valor = 0')).rejects.toThrow(/read-only/);
      await expect(db.query('acme', 'select 1; select 2')).rejects.toThrow(/multiple commands/);
    } finally {
      await db.close();
    }
  });

  it.skipIf(!process.env.HABBLAUD_TEST_PG_WRITE)('alteração estruturada: ensaio com antes e depois, grava só o ensaiado', async () => {
    const dbc = { readUrl: PG!, writeUrl: process.env.HABBLAUD_TEST_PG_WRITE!, tenantSetting: 'app.tenant_id', settings: {}, maxRows: 100, maxWriteRows: 10, timeoutMs: 5000, allowDelete: false, tenantColumn: 'tenant_id', labels: {} };
    const db = new GatewayDb(dbc);
    try {
      const req = parseChange({ acao: 'atualizar', tabela: 'pedidos', onde: [{ coluna: 'id', valor: 1 }], valores: { status: 'em_teste' } }, dbc);
      const plan = await planChange(db, dbc, 'acme', req);
      expect(plan.rowCount).toBe(1);
      expect(plan.rows[0].before?.status).not.toBe('em_teste');
      expect(plan.rows[0].after?.status).toBe('em_teste');
      const old = plan.rows[0].before!.status;
      // Nada gravado no ensaio.
      expect((await db.query('acme', 'select status from pedidos where id = 1')).rows).toEqual([[old]]);
      // De outro tenant, o mesmo filtro não acha nada (RLS).
      await expect(planChange(db, dbc, 'beta', req)).rejects.toThrow(/nenhum registro/);
      expect(await applyChange(db, 'acme', plan)).toBe(1);
      expect((await db.query('acme', 'select status from pedidos where id = 1')).rows).toEqual([['em_teste']]);
      const back = await planChange(db, dbc, 'acme', parseChange({ acao: 'atualizar', tabela: 'pedidos', onde: [{ coluna: 'id', valor: 1 }], valores: { status: old } }, dbc));
      await applyChange(db, 'acme', back);
      await expect(planChange(db, dbc, 'acme', parseChange({ acao: 'atualizar', tabela: 'pedidos', onde: [{ coluna: 'idx', valor: 1 }], valores: { status: 'x' } }, dbc))).rejects.toThrow(/coluna desconhecida/);
    } finally {
      await db.close();
    }
  });
});

describe('sistema com um subdomínio por cliente e login de cada pessoa', () => {
  it('qualquer tenant com nome de subdomínio; hosts curinga só no domínio da empresa', () => {
    const c = parseGatewayConfig({ tenants: '*', rules: [{ members: ['*'], tenants: ['*'], web: 'view' }], web: { baseUrl: 'https://app.empresa.com.br', allowedHosts: ['*.empresa.com.br'], credentials: {} } });
    expect(knownTenant(c, 'cliente-1')).toBe(true);
    expect(knownTenant(c, 'a.b')).toBe(false);
    expect(knownTenant(c, '-x')).toBe(false);
    expect(hostAllowed(c.web!.allowedHosts, 'cliente-1.empresa.com.br')).toBe(true);
    expect(hostAllowed(c.web!.allowedHosts, 'empresa.com.br.evil.com')).toBe(false);
    expect(hostAllowed(c.web!.allowedHosts, 'evilempresa.com.br')).toBe(false);
    expect(hostAllowed(c.web!.allowedHosts, 'x.EMPRESA.com.br')).toBe(true);
  });

  it('o login de cada pessoa fica cifrado e o específico do tenant vale mais', () => {
    const dir = mkdtempSync(pjoin(tmpdir(), 'cred-'));
    const store = new CredentialStore(pjoin(dir, 'c.json'), pjoin(dir, 'k'));
    store.set('ana', '*', 'ana@x.com', 'segredo-geral');
    store.set('ana', 'beta', 'ana.beta@x.com', 'segredo-beta');
    expect(store.get('ana', 'acme')).toEqual({ user: 'ana@x.com', password: 'segredo-geral' });
    expect(store.get('ana', 'beta')).toEqual({ user: 'ana.beta@x.com', password: 'segredo-beta' });
    expect(store.get('bia', 'acme')).toBeUndefined();
    expect(readFileSync(pjoin(dir, 'c.json'), 'utf8')).not.toContain('segredo');
    expect(store.list('ana').map((l) => l.user)).toEqual(['ana@x.com', 'ana.beta@x.com']);
    // Relido do disco com a mesma chave.
    expect(new CredentialStore(pjoin(dir, 'c.json'), pjoin(dir, 'k')).get('ana', 'acme')?.password).toBe('segredo-geral');
    store.remove('ana', 'beta');
    expect(store.get('ana', 'beta')?.user).toBe('ana@x.com');
  });
});

describe('navegador livre (sites externos)', () => {
  it('nunca vai à rede interna da sede', async () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.0.10', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) expect(privateAddress(ip)).toBe(true);
    for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1']) expect(privateAddress(ip)).toBe(false);
    const dns = async (h: string) => (h === 'interno.empresa.com' ? ['10.0.0.5'] : ['93.184.215.14']);
    expect(await publicUrl('https://exemplo.com/x', dns)).toBe(true);
    expect(await publicUrl('https://interno.empresa.com/', dns)).toBe(false);
    expect(await publicUrl('http://169.254.169.254/latest/meta-data', dns)).toBe(false);
    expect(await publicUrl('http://localhost:4800/', dns)).toBe(false);
    expect(await publicUrl('file:///etc/passwd', dns)).toBe(false);
    expect(await publicUrl('https://x.localhost/', dns)).toBe(false);
    const semDns = async () => {
      throw new Error('ENOTFOUND');
    };
    expect(await publicUrl('https://exemplo.com/', semDns)).toBe(false);
    expect(await publicUrl('https://exemplo.com/', semDns, true)).toBe(true);
    expect(await publicUrl('http://10.0.0.5/', semDns, true)).toBe(false);
  });

  it('ligado para todos por padrão; dá para limitar', () => {
    expect(externalLevelFor(cfg, 'qualquer')).toBe('interact');
    const off = parseGatewayConfig({ externo: false, rules: [{ members: ['ana'], tenants: ['*'], externo: 'view' }] });
    expect(externalLevelFor(off, 'bia')).toBe('none');
    expect(externalLevelFor(off, 'ana')).toBe('view');
  });
});

// Banco no formato do da empresa (tenant UUID, app.current_tenant, subdomínio numa tabela): HABBLAUD_TEST_PG_UUID=1.
describe.skipIf(!process.env.HABBLAUD_TEST_PG_UUID)('tenant por subdomínio traduzido para UUID', () => {
  it('cada subdomínio vê só os dados do seu UUID; ao criar, o gateway põe o UUID', async () => {
    const dbc = {
      readUrl: 'postgres://agente_leitura_f:l@127.0.0.1/freelux_teste',
      writeUrl: 'postgres://agente_escrita_f:e@127.0.0.1/freelux_teste',
      tenantSetting: 'app.current_tenant',
      tenantQuery: 'select id from tenants where subdominio = $1',
      settings: {},
      maxRows: 50,
      maxWriteRows: 10,
      timeoutMs: 5000,
      allowDelete: false,
      tenantColumn: 'tenant_id',
      labels: {},
    };
    const db = new GatewayDb(dbc);
    try {
      expect((await db.query('solarsul', "select uc from faturas where uc = 'UC-1'")).rows).toEqual([['UC-1']]);
      expect((await db.query('energianorte', "select uc from faturas where uc = 'UC-1'")).rows).toEqual([]);
      expect((await db.query('11111111-1111-1111-1111-111111111111', "select uc from faturas where uc = 'UC-1'")).rows).toEqual([['UC-1']]);
      await expect(db.query('naoexiste', 'select 1')).rejects.toThrow(/não encontrado/);
      const plan = await planChange(db, dbc, 'solarsul', parseChange({ acao: 'criar', tabela: 'faturas', valores: { uc: 'UC-T', valor: 1 } }, dbc));
      expect(plan.rows[0].after?.tenant_id).toBe('11111111-1111-1111-1111-111111111111');
      await expect(planChange(db, dbc, 'solarsul', parseChange({ acao: 'atualizar', tabela: 'faturas', onde: [{ coluna: 'uc', valor: 'UC-9' }], valores: { status: 'x' } }, dbc))).rejects.toThrow(/nenhum registro/);
    } finally {
      await db.close();
    }
  });
});
