// Alterações no banco pedidas pelos agentes, em forma estruturada (nunca SQL): criar, atualizar ou apagar registros de
// uma tabela, com um filtro simples. O gateway confere tabela e colunas no próprio banco, monta o SQL com parâmetros e
// ENSAIA a alteração (roda e desfaz) para guardar o "antes e depois" de cada registro. Do ensaio sai o texto em
// português que a pessoa lê para aprovar ("Pedido 3: Situação de “aberto” para “pago”"): quem aprova vê o que vai
// mudar de verdade, não o que o agente disse que ia mudar. Na aprovação, roda de novo e só grava se mexer no mesmo
// número de registros do ensaio (senão os dados mudaram no meio e nada é gravado).
import { tr } from '../../shared/i18n';
import type { GatewayConfig } from './config';
import { GatewayRefusal, type GatewayDb } from './db';

type DbConfig = NonNullable<GatewayConfig['db']>;

export type ChangeAction = 'criar' | 'atualizar' | 'apagar';
export type Operator = '=' | '!=' | '>' | '>=' | '<' | '<=' | 'contem' | 'vazio' | 'nao_vazio';
export type Value = string | number | boolean | null;

export interface Condition {
  coluna: string;
  operador?: Operator;
  valor?: Value;
}

export interface ChangeRequest {
  acao: ChangeAction;
  tabela: string;
  onde?: Condition[];
  valores?: Record<string, Value>;
}

/** Nomes amigáveis de tabela e colunas para o texto da aprovação (db.labels no gateway.json). */
export interface TableLabels {
  /** Nome da tabela no plural (ex.: "Pedidos"). */
  nome?: string;
  /** Um registro (ex.: "pedido"). */
  singular?: string;
  /** Como chamar cada registro, com {coluna} (ex.: "Pedido {id} de {cliente}"). */
  registro?: string;
  colunas?: Record<string, string>;
}

export interface ChangePlan {
  request: ChangeRequest;
  schema: string;
  table: string;
  sql: string;
  params: Value[];
  rowCount: number;
  /** Antes e depois de cada registro (antes vazio ao criar; depois vazio ao apagar). */
  rows: { before?: Record<string, unknown>; after?: Record<string, unknown> }[];
  pk: string[];
}

const OPS: Record<Operator, string> = { '=': '=', '!=': '<>', '>': '>', '>=': '>=', '<': '<', '<=': '<=', contem: 'ILIKE', vazio: 'IS NULL', nao_vazio: 'IS NOT NULL' };
const IDENT = /^[A-Za-z_][\w$]{0,62}$/;

function quote(id: string): string {
  return `"${id.replace(/"/g, '""')}"`;
}

function refuse(msg: string): never {
  throw new GatewayRefusal(msg);
}

/** Lê e valida o pedido do agente (formato da ferramenta sistema_alterar). */
export function parseChange(args: Record<string, unknown>, cfg: DbConfig): ChangeRequest {
  const acao = args.acao;
  if (acao !== 'criar' && acao !== 'atualizar' && acao !== 'apagar') refuse(tr('acao precisa ser "criar", "atualizar" ou "apagar"'));
  if (acao === 'apagar' && !cfg.allowDelete) refuse(tr('apagar registros está desligado no gateway'));
  const tabela = typeof args.tabela === 'string' ? args.tabela.trim() : '';
  if (!/^([A-Za-z_][\w$]*\.)?[A-Za-z_][\w$]*$/.test(tabela)) refuse(tr('tabela inválida: {0}', [tabela]));
  const value = (v: unknown, where: string): Value => {
    if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return typeof v === 'string' ? v.slice(0, 10_000) : v;
    refuse(tr('valor inválido em {0} (use texto, número, verdadeiro/falso ou null)', [where]));
  };
  const onde: Condition[] = [];
  for (const raw of Array.isArray(args.onde) ? (args.onde as Record<string, unknown>[]) : []) {
    const coluna = typeof raw?.coluna === 'string' ? raw.coluna : '';
    const operador = (raw?.operador ?? '=') as Operator;
    if (!(operador in OPS)) refuse(tr('operador inválido: {0}', [String(operador)]));
    onde.push({ coluna, operador, valor: operador === 'vazio' || operador === 'nao_vazio' ? undefined : value(raw?.valor, coluna) });
  }
  const valores: Record<string, Value> = {};
  if (args.valores && typeof args.valores === 'object') for (const [k, v] of Object.entries(args.valores as Record<string, unknown>)) valores[k] = value(v, k);
  if (acao !== 'criar' && !onde.length) refuse(tr('diga quais registros (campo onde): o gateway não altera nem apaga a tabela inteira'));
  if (acao !== 'apagar' && !Object.keys(valores).length) refuse(tr('diga os valores (campo valores)'));
  if (acao === 'criar' && onde.length) refuse(tr('ao criar não há filtro (onde)'));
  return { acao, tabela, onde, valores: acao === 'apagar' ? undefined : valores };
}

/** SQL e parâmetros do pedido (só identificadores conferidos no banco; valores sempre como parâmetros). */
export function buildSql(req: ChangeRequest, schema: string, table: string, returning: string[]): { sql: string; params: Value[]; where: string; whereParams: Value[] } {
  const params: Value[] = [];
  const t = `${quote(schema)}.${quote(table)}`;
  const where = (req.onde ?? [])
    .map((c) => {
      const op = c.operador ?? '=';
      if (op === 'vazio' || op === 'nao_vazio') return `${quote(c.coluna)} ${OPS[op]}`;
      params.push(op === 'contem' ? `%${String(c.valor).replace(/[\\%_]/g, (m) => `\\${m}`)}%` : c.valor!);
      return op === 'contem' ? `${quote(c.coluna)}::text ILIKE $${params.length}` : `${quote(c.coluna)} ${OPS[op]} $${params.length}`;
    })
    .join(' AND ');
  const whereParams = [...params];
  const ret = returning.length ? ` RETURNING ${returning.map(quote).join(', ')}` : '';
  if (req.acao === 'apagar') return { sql: `DELETE FROM ${t} WHERE ${where}${ret}`, params, where, whereParams };
  const entries = Object.entries(req.valores ?? {});
  if (req.acao === 'criar') {
    const cols = entries.map(([k]) => quote(k)).join(', ');
    const vals = entries.map(([, v]) => (params.push(v), `$${params.length}`)).join(', ');
    return { sql: `INSERT INTO ${t} (${cols}) VALUES (${vals})${ret}`, params, where: '', whereParams: [] };
  }
  const set = entries.map(([k, v]) => (params.push(v), `${quote(k)} = $${params.length}`)).join(', ');
  return { sql: `UPDATE ${t} SET ${set} WHERE ${where}${ret}`, params, where, whereParams };
}

const keyOf = (row: Record<string, unknown>, pk: string[]) => JSON.stringify(pk.map((k) => row[k]));

/** Confere a tabela, ensaia e guarda o antes e depois. */
export async function planChange(db: GatewayDb, cfg: DbConfig, tenant: string, req: ChangeRequest): Promise<ChangePlan> {
  const [schema, table] = req.tabela.includes('.') ? req.tabela.split('.') : ['public', req.tabela];
  const { columns, pk: realPk } = await db.describeTable(schema, table);
  if (!columns.size) refuse(tr('tabela não encontrada (ou sem acesso): {0}', [req.tabela]));
  const used = [...(req.onde ?? []).map((c) => c.coluna), ...Object.keys(req.valores ?? {})];
  for (const col of used) if (!IDENT.test(col) || !columns.has(col)) refuse(tr('coluna desconhecida em {0}: {1}', [req.tabela, col]));
  // A coluna do tenant: o gateway põe sozinho ao criar e ninguém a troca (o RLS também barraria).
  const tcol = cfg.tenantColumn;
  if (tcol && columns.has(tcol)) {
    // O valor de verdade (ex.: o UUID do cliente), não o subdomínio que o agente usou.
    const tv = await db.tenantValue(tenant);
    if (req.valores && tcol in req.valores && String(req.valores[tcol]) !== tv) refuse(tr('não dá para mudar a coluna do tenant ({0})', [tcol]));
    if (req.acao === 'criar') req = { ...req, valores: { ...req.valores, [tcol]: tv } };
    else if (req.acao === 'atualizar' && req.valores) {
      const { [tcol]: _drop, ...rest } = req.valores;
      req = { ...req, valores: rest };
      if (!Object.keys(rest).length) refuse(tr('diga os valores (campo valores)'));
    }
  }
  const pk = realPk.length ? realPk : columns.has('id') ? ['id'] : [];
  const all = [...columns.keys()];
  const { sql, params, where, whereParams } = buildSql(req, schema, table, all);
  return db.tx(tenant, false, async (q) => {
    const before = req.acao === 'criar' ? [] : (await q(`SELECT * FROM ${quote(schema)}.${quote(table)} WHERE ${where} LIMIT ${cfg.maxWriteRows + 1}`, whereParams)).rows;
    const r = await q(sql, params);
    if (r.rowCount > cfg.maxWriteRows) refuse(tr('a alteração mexeria em {0} registros (o limite é {1}); peça algo mais específico', [r.rowCount, cfg.maxWriteRows]));
    if (r.rowCount === 0) refuse(tr('nenhum registro corresponde ao filtro: nada a alterar'));
    const byKey = new Map(before.map((b) => [keyOf(b, pk), b]));
    const rows =
      req.acao === 'criar'
        ? r.rows.map((after) => ({ after }))
        : req.acao === 'apagar'
          ? r.rows.map((b) => ({ before: b }))
          : r.rows.map((after) => ({ after, before: pk.length ? byKey.get(keyOf(after, pk)) : undefined }));
    return { request: req, schema, table, sql: buildSql(req, schema, table, []).sql, params, rowCount: r.rowCount, rows, pk };
  });
}

/** Grava de verdade; se o número de registros mudou desde o ensaio, desfaz e avisa. */
export async function applyChange(db: GatewayDb, tenant: string, plan: ChangePlan): Promise<number> {
  return db.tx(tenant, true, async (q) => {
    const r = await q(plan.sql, plan.params);
    if (r.rowCount !== plan.rowCount) refuse(tr('os dados mudaram desde o pedido ({0} registro(s) em vez de {1}); nada foi gravado. Peça a alteração de novo.', [r.rowCount, plan.rowCount]));
    return r.rowCount;
  });
}

// ---- Texto em português -------------------------------------------------------------------------------------

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return tr('(vazio)');
  if (typeof v === 'boolean') return v ? tr('sim') : tr('não');
  if (v instanceof Date) return v.toLocaleString('pt-BR');
  const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
  return `“${s.length > 80 ? `${s.slice(0, 79)}…` : s}”`;
}

const OP_TEXT: Record<Operator, string> = {
  '=': 'é',
  '!=': 'não é',
  '>': 'é maior que',
  '>=': 'é maior ou igual a',
  '<': 'é menor que',
  '<=': 'é menor ou igual a',
  contem: 'contém',
  vazio: 'está vazio',
  nao_vazio: 'não está vazio',
};

export interface ChangeSummary {
  /** Frase principal (ex.: "Vai alterar 1 pedido em Pedidos (ACME Ltda)"). */
  title: string;
  /** Uma linha por registro (ex.: "Pedido 3: Situação de “aberto” para “pago”"). */
  lines: string[];
}

/** O que a pessoa lê para aprovar, montado do ensaio (dados reais), não do que o agente disse. */
export function describeChange(plan: ChangePlan, labels: TableLabels | undefined, tenantName: string, tenantColumn?: string): ChangeSummary {
  const col = (c: string) => labels?.colunas?.[c] ?? c.replace(/_/g, ' ');
  const tableName = labels?.nome ?? plan.table.replace(/_/g, ' ');
  const one = labels?.singular ?? tr('registro');
  const many = labels?.singular ? `${labels.singular}s` : tr('registros');
  const n = plan.rowCount;
  const what = `${n} ${n === 1 ? one : many}`;
  const title = (row: Record<string, unknown> | undefined): string => {
    if (!row) return tr('Registro');
    if (labels?.registro) return labels.registro.replace(/\{(\w+)\}/g, (_, k: string) => String(row[k] ?? '?'));
    const key = plan.pk.map((k) => row[k]).join('/');
    return key ? `${labels?.singular ? labels.singular[0].toUpperCase() + labels.singular.slice(1) : tr('Registro')} ${key}` : tr('Registro');
  };
  const hidden = new Set([tenantColumn ?? '']);
  const filter = (plan.request.onde ?? []).map((c) => `${col(c.coluna)} ${OP_TEXT[c.operador ?? '=']}${c.operador === 'vazio' || c.operador === 'nao_vazio' ? '' : ` ${show(c.valor)}`}`).join(tr(' e '));
  if (plan.request.acao === 'criar') {
    return {
      title: tr('Vai criar {0} em {1} ({2})', [what, tableName, tenantName]),
      lines: plan.rows.map((r) =>
        Object.keys(plan.request.valores ?? {})
          .filter((k) => !hidden.has(k))
          .map((k) => `${col(k)}: ${show(r.after?.[k] ?? plan.request.valores?.[k])}`)
          .join('; '),
      ),
    };
  }
  if (plan.request.acao === 'apagar') {
    return { title: tr('Vai APAGAR {0} de {1} ({2}), onde {3}', [what, tableName, tenantName, filter]), lines: plan.rows.map((r) => title(r.before)) };
  }
  const set = Object.keys(plan.request.valores ?? {}).filter((k) => !hidden.has(k));
  // Filtro só pela chave (ex.: id = 3): os registros já aparecem pelo nome em cada linha, sem repetir o filtro técnico.
  const byKey = (plan.request.onde ?? []).every((c) => (c.operador ?? '=') === '=' && plan.pk.includes(c.coluna));
  return {
    title: byKey ? tr('Vai alterar {0} em {1} ({2})', [what, tableName, tenantName]) : tr('Vai alterar {0} em {1} ({2}), onde {3}', [what, tableName, tenantName, filter]),
    lines: plan.rows.map((r) => {
      const changes = set.map((k) => {
        const before = r.before?.[k];
        const after = r.after?.[k];
        if (r.before && String(before) === String(after)) return tr('{0} continua {1}', [col(k), show(after)]);
        return r.before ? tr('{0} de {1} para {2}', [col(k), show(before), show(after)]) : tr('{0} passa a ser {1}', [col(k), show(after)]);
      });
      return `${title(r.after ?? r.before)}: ${changes.join('; ')}`;
    }),
  };
}
