// Banco do gateway (Postgres). Cada pedido roda numa transação própria, com o tenant aplicado por SET LOCAL na variável
// que as políticas de RLS leem, e um comando só (protocolo estendido: o Postgres recusa vários comandos de uma vez):
//  - consulta: transação READ ONLY, desfeita no fim, com limite de linhas e de tempo;
//  - alteração: primeiro um ensaio (roda e desfaz, para contar as linhas afetadas e mostrar a quem aprova); depois da
//    aprovação humana, roda de verdade, e desfaz se passar do limite de linhas.
// O SQL que tenta trocar variáveis de sessão (set_config, SET) é recusado: o tenant é o gateway quem põe. Recomende ao
// DBA revogar EXECUTE de set_config do usuário dos agentes (docs/gateway.md) — o gateway não precisa dela.
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { tr } from '../../shared/i18n';
import type { GatewayConfig } from './config';

type DbConfig = NonNullable<GatewayConfig['db']>;

/** O mínimo do `pg` que o gateway usa (dependência opcional, carregada só na sede com o gateway ligado). */
interface PgClient {
  query(q: string | { text: string; values?: unknown[]; name?: string; rowMode?: string }): Promise<{ rows: unknown[]; rowCount: number | null; fields?: { name: string }[] }>;
  release(err?: boolean): void;
}
interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

export function loadPg(): { Pool: new (o: Record<string, unknown>) => PgPool; escapeLiteral: (s: string) => string } {
  const req = createRequire(import.meta.url);
  let pg: { Pool: new (o: Record<string, unknown>) => PgPool; Client: { prototype: { escapeLiteral: (s: string) => string } } };
  try {
    pg = req('pg');
  } catch {
    throw new Error(tr('o gateway do banco precisa do pacote "pg": rode npm install na pasta do Habblaud da sede'));
  }
  return { Pool: pg.Pool, escapeLiteral: (s) => pg.Client.prototype.escapeLiteral.call({}, s) };
}

const COMMENTS = /--[^\n]*|\/\*[\s\S]*?\*\//g;

/** A primeira palavra do comando, sem comentários e em minúsculas. */
export function firstWord(sql: string): string {
  return /^[\s(]*([a-z]+)/i.exec(sql.replace(COMMENTS, ' '))?.[1]?.toLowerCase() ?? '';
}

/** Motivo da recusa (ou null) de um SQL vindo de um agente. */
export function sqlProblem(sql: string, kind: 'read' | 'write', allowDelete = false): string | null {
  if (!sql.trim()) return tr('SQL vazio');
  if (sql.length > 20_000) return tr('SQL grande demais');
  const clean = sql.replace(COMMENTS, ' ');
  if (/\bset_config\b|\bpg_read_file\b|\bpg_ls_dir\b|\blo_import\b|\bdblink\b|\bcopy\b/i.test(clean)) return tr('o SQL usa uma função ou comando que o gateway não permite');
  const w = firstWord(sql);
  if (kind === 'read') {
    return ['select', 'with', 'table', 'values', 'explain'].includes(w) ? null : tr('consultas só com SELECT (para alterar, use sistema_alterar)');
  }
  const ok = ['insert', 'update', ...(allowDelete ? ['delete'] : [])];
  return ok.includes(w) ? null : allowDelete ? tr('alterações só com INSERT, UPDATE ou DELETE') : tr('alterações só com INSERT ou UPDATE (DELETE está desligado no gateway)');
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  rowCount: number;
  truncated: boolean;
}

export class GatewayDb {
  private read: PgPool;
  private write?: PgPool;
  private readonly esc: (s: string) => string;

  constructor(
    private readonly cfg: DbConfig,
    pg = loadPg(),
  ) {
    this.esc = pg.escapeLiteral;
    this.read = new pg.Pool({ connectionString: cfg.readUrl, max: 5, idleTimeoutMillis: 30_000 });
    if (cfg.writeUrl) this.write = new pg.Pool({ connectionString: cfg.writeUrl, max: 2, idleTimeoutMillis: 30_000 });
  }

  async close(): Promise<void> {
    await Promise.all([this.read.end(), this.write?.end()]);
  }

  /** Abre a transação com o tenant e as variáveis fixas (SET LOCAL: valem só nesta transação). */
  private async begin(c: PgClient, tenant: string, readOnly: boolean): Promise<void> {
    await c.query(readOnly ? 'BEGIN READ ONLY' : 'BEGIN');
    await c.query(`SET LOCAL statement_timeout = ${Math.round(this.cfg.timeoutMs)}`);
    for (const [k, v] of [[this.cfg.tenantSetting, tenant], ...Object.entries(this.cfg.settings)]) await c.query(`SET LOCAL ${k} = ${this.esc(v)}`);
  }

  /** Um comando só: um nome de comando preparado único força o protocolo estendido. */
  private one(c: PgClient, sql: string) {
    return c.query({ text: sql, name: `gw_${randomBytes(6).toString('hex')}`, rowMode: 'array' });
  }

  async query(tenant: string, sql: string): Promise<QueryResult> {
    const c = await this.read.connect();
    let broken = false;
    try {
      await this.begin(c, tenant, true);
      const r = await this.one(c, sql);
      const rows = r.rows as unknown[][];
      return { columns: (r.fields ?? []).map((f) => f.name), rows: rows.slice(0, this.cfg.maxRows), rowCount: rows.length, truncated: rows.length > this.cfg.maxRows };
    } catch (err) {
      broken = !isPgError(err);
      throw err;
    } finally {
      await c.query('ROLLBACK').catch(() => (broken = true));
      c.release(broken);
    }
  }

  /** Roda a alteração; `commit` false = ensaio (desfaz sempre). Passou do limite de linhas: desfaz e avisa. */
  async change(tenant: string, sql: string, commit: boolean): Promise<QueryResult> {
    if (!this.write) throw new Error(tr('o gateway não tem usuário de escrita (db.writeUrl)'));
    const c = await this.write.connect();
    let done = false;
    let broken = false;
    try {
      await this.begin(c, tenant, false);
      const r = await this.one(c, sql);
      const n = r.rowCount ?? 0;
      if (n > this.cfg.maxWriteRows) throw new Error(tr('a alteração mexeria em {0} linhas (o limite é {1}); nada foi gravado', [n, this.cfg.maxWriteRows]));
      if (commit) {
        await c.query('COMMIT');
        done = true;
      }
      const rows = (r.rows as unknown[][]) ?? [];
      return { columns: (r.fields ?? []).map((f) => f.name), rows: rows.slice(0, 20), rowCount: n, truncated: rows.length > 20 };
    } catch (err) {
      broken = !isPgError(err) && !(err instanceof Error && /linhas/.test(err.message));
      throw err;
    } finally {
      if (!done) await c.query('ROLLBACK').catch(() => (broken = true));
      c.release(broken);
    }
  }
}

function isPgError(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string';
}

/** Tabela em texto para o agente ler. */
export function formatResult(r: QueryResult): string {
  if (!r.columns.length) return tr('{0} linha(s).', [r.rowCount]);
  const cell = (v: unknown) => (v === null ? 'NULL' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ').slice(0, 200);
  const lines = [r.columns.join(' | '), ...r.rows.map((row) => row.map(cell).join(' | '))];
  const tail = r.truncated ? tr('\n(mostrando {0} de {1} linhas; refine a consulta)', [r.rows.length, r.rowCount]) : tr('\n({0} linha(s))', [r.rowCount]);
  return lines.join('\n') + tail;
}
