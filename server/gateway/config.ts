// Gateway do sistema: o acesso dos agentes ao sistema da empresa (banco Postgres e interface web), sempre pela sede,
// com regras por pessoa e por tenant. Os agentes nunca recebem a senha do banco nem o login do sistema: pedem ao
// gateway (ferramentas sistema_* do MCP do escritório), que confere a regra, aplica o tenant e registra tudo.
// Configuração em HABBLAUD_GATEWAY_CONFIG (padrão: gateway.json ao lado da configuração da sede). Exemplo em
// docs/gateway.md.
import { readFileSync } from 'node:fs';
import { tr } from '../../shared/i18n';
import type { TableLabels } from './change';

/** none: nada; read: consultas (SELECT); write: consultas e alterações com aprovação humana. */
export type DbLevel = 'none' | 'read' | 'write';
/** none: nada; view: abrir e ler páginas; interact: também clicar e preencher. */
export type WebLevel = 'none' | 'view' | 'interact';

export interface GatewayRule {
  /** Ids dos membros (ou "*"). */
  members: string[];
  /** Ids dos tenants (ou "*"). */
  tenants: string[];
  db?: DbLevel;
  web?: WebLevel;
  /** Navegador livre (sites externos), para os membros da regra (o tenant não importa). */
  externo?: WebLevel;
}

export interface WebLogin {
  /** Caminho da página de login (relativo à base). */
  path: string;
  /** Seletor do campo -> valor; {user} e {password} viram a credencial do tenant. */
  fields: Record<string, string>;
  /** Seletor do botão de entrar (sem ele, Enter no último campo). */
  submit?: string;
}

export interface WebCredential {
  user: string;
  /** Senha em texto (evite) ou o nome de uma variável de ambiente que a guarda. */
  password?: string;
  passwordEnv?: string;
}

export interface GatewayConfig {
  /** Tenants conhecidos: id -> nome. */
  tenants: Record<string, string>;
  /**
   * `"tenants": "*"`: qualquer tenant com id válido (ex.: um subdomínio por cliente, sem listar todos). As regras
   * continuam decidindo quem acessa o quê.
   */
  anyTenant: boolean;
  db?: {
    readUrl: string;
    /**
     * Traduz o id do tenant que os agentes usam (ex.: o subdomínio do cliente) para o valor que as políticas de RLS
     * esperam (ex.: o UUID): um SELECT com $1 que devolve uma linha e uma coluna. Sem ele, o id vai direto.
     */
    tenantQuery?: string;
    writeUrl?: string;
    /** Variável de sessão que as políticas de RLS leem (padrão app.tenant_id). */
    tenantSetting: string;
    /** Outras variáveis de sessão fixas (ex.: {"app.origem": "agente"}). */
    settings: Record<string, string>;
    maxRows: number;
    maxWriteRows: number;
    timeoutMs: number;
    allowDelete: boolean;
    /** Coluna do tenant nas tabelas (padrão tenant_id): o gateway preenche ao criar e não deixa trocar. */
    tenantColumn?: string;
    /** Nomes amigáveis para o texto das aprovações (tabela -> nome, singular, registro, colunas). */
    labels: Record<string, TableLabels>;
  };
  web?: {
    baseUrl: string;
    /** Endereço inicial de cada tenant ({base} e {tenant}); padrão: a base. */
    tenantUrl?: string;
    login?: WebLogin;
    /** Credencial por tenant ("*" = para todos). */
    credentials: Record<string, WebCredential>;
    /** Hosts (host:porta) por onde o navegador pode andar; padrão: o da base. */
    allowedHosts: string[];
  };
  rules: GatewayRule[];
  /** Navegador livre (sites externos, sem login) para todos; regras com `externo` podem dar mais. Padrão: interact. */
  external: WebLevel;
  /** Quem aprova alterações no banco: o dono do agente ("owner", padrão) ou só administradores ("admins"). */
  approvers: 'owner' | 'admins';
}

const DB_RANK: Record<DbLevel, number> = { none: 0, read: 1, write: 2 };
const WEB_RANK: Record<WebLevel, number> = { none: 0, view: 1, interact: 2 };

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
}

function num(v: unknown, d: number, min: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(min, Math.min(max, Math.round(v))) : d;
}

export function parseGatewayConfig(data: unknown): GatewayConfig {
  const f = (data ?? {}) as Record<string, unknown>;
  const tenants: Record<string, string> = {};
  if (f.tenants && typeof f.tenants === 'object') {
    for (const [id, name] of Object.entries(f.tenants as Record<string, unknown>)) if (/^[\w.-]{1,64}$/.test(id)) tenants[id] = typeof name === 'string' ? name : id;
  }
  const ext = f.externo === false ? 'none' : f.externo === 'view' || f.externo === 'none' || f.externo === 'interact' ? f.externo : 'interact';
  const out: GatewayConfig = { tenants, anyTenant: f.tenants === '*', rules: [], external: ext, approvers: f.approvers === 'admins' ? 'admins' : 'owner' };
  const db = f.db as Record<string, unknown> | undefined;
  if (db) {
    if (typeof db.readUrl !== 'string' || !/^postgres(ql)?:\/\//.test(db.readUrl)) throw new Error(tr('gateway: db.readUrl precisa ser postgres://...'));
    const setting = typeof db.tenantSetting === 'string' ? db.tenantSetting : 'app.tenant_id';
    if (!/^[a-z_][\w]*\.[a-z_][\w]*$/i.test(setting)) throw new Error(tr('gateway: db.tenantSetting inválido (ex.: app.tenant_id)'));
    const settings: Record<string, string> = {};
    for (const [k, v] of Object.entries((db.settings as Record<string, unknown>) ?? {})) {
      if (!/^[a-z_][\w]*\.[a-z_][\w]*$/i.test(k) || typeof v !== 'string') throw new Error(tr('gateway: db.settings inválido ({0})', [k]));
      settings[k] = v;
    }
    out.db = {
      readUrl: db.readUrl,
      writeUrl: typeof db.writeUrl === 'string' ? db.writeUrl : undefined,
      tenantSetting: setting,
      settings,
      maxRows: num(db.maxRows, 200, 1, 5000),
      maxWriteRows: num(db.maxWriteRows, 50, 1, 10_000),
      timeoutMs: num(db.timeoutMs, 10_000, 500, 120_000),
      allowDelete: db.allowDelete === true,
      tenantQuery: typeof db.tenantQuery === 'string' && /\$1\b/.test(db.tenantQuery) && /^\s*select\b/i.test(db.tenantQuery) ? db.tenantQuery : undefined,
      tenantColumn: db.tenantColumn === '' ? undefined : typeof db.tenantColumn === 'string' ? db.tenantColumn : 'tenant_id',
      labels: db.labels && typeof db.labels === 'object' ? (db.labels as Record<string, TableLabels>) : {},
    };
  }
  const web = f.web as Record<string, unknown> | undefined;
  if (web) {
    let base: URL;
    try {
      base = new URL(String(web.baseUrl));
    } catch {
      throw new Error(tr('gateway: web.baseUrl inválida'));
    }
    const credentials: Record<string, WebCredential> = {};
    for (const [t, c] of Object.entries((web.credentials as Record<string, Record<string, unknown>>) ?? {})) {
      if (typeof c?.user !== 'string') throw new Error(tr('gateway: web.credentials.{0} sem user', [t]));
      credentials[t] = { user: c.user, password: typeof c.password === 'string' ? c.password : undefined, passwordEnv: typeof c.passwordEnv === 'string' ? c.passwordEnv : undefined };
    }
    const login = web.login as Record<string, unknown> | undefined;
    out.web = {
      baseUrl: base.origin + base.pathname.replace(/\/+$/, ''),
      tenantUrl: typeof web.tenantUrl === 'string' ? web.tenantUrl : undefined,
      login:
        login && typeof login.path === 'string' && login.fields && typeof login.fields === 'object'
          ? { path: login.path, fields: login.fields as Record<string, string>, submit: typeof login.submit === 'string' ? login.submit : undefined }
          : undefined,
      credentials,
      allowedHosts: list(web.allowedHosts).length ? list(web.allowedHosts) : [base.host],
    };
  }
  for (const r of (Array.isArray(f.rules) ? f.rules : []) as Record<string, unknown>[]) {
    const dbl = r.db === 'read' || r.db === 'write' || r.db === 'none' ? r.db : undefined;
    const webl = r.web === 'view' || r.web === 'interact' || r.web === 'none' ? r.web : undefined;
    const extl = r.externo === 'view' || r.externo === 'interact' || r.externo === 'none' ? r.externo : undefined;
    out.rules.push({ members: list(r.members), tenants: list(r.tenants), db: dbl, web: webl, externo: extl });
  }
  return out;
}

export function readGatewayConfig(file: string): GatewayConfig | undefined {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  return parseGatewayConfig(JSON.parse(raw));
}

const match = (list: string[], v: string) => list.includes('*') || list.includes(v);

/** O que o membro pode fazer no tenant: a soma das regras que valem para os dois (a mais permissiva vence). */
export function levelsFor(cfg: GatewayConfig, member: string, tenant: string): { db: DbLevel; web: WebLevel } {
  let db: DbLevel = 'none';
  let web: WebLevel = 'none';
  for (const r of cfg.rules) {
    if (!match(r.members, member) || !match(r.tenants, tenant)) continue;
    if (r.db && DB_RANK[r.db] > DB_RANK[db]) db = r.db;
    if (r.web && WEB_RANK[r.web] > WEB_RANK[web]) web = r.web;
  }
  if (!cfg.db) db = 'none';
  else if (db === 'write' && !cfg.db.writeUrl) db = 'read';
  if (!cfg.web) web = 'none';
  return { db, web };
}

/** Tenants em que o membro tem alguma permissão, com o que pode em cada um. */
export function tenantsFor(cfg: GatewayConfig, member: string): { id: string; name: string; db: DbLevel; web: WebLevel }[] {
  return Object.entries(cfg.tenants)
    .map(([id, name]) => ({ id, name, ...levelsFor(cfg, member, id) }))
    .filter((t) => t.db !== 'none' || t.web !== 'none');
}

/** Id de tenant aceito: um dos listados ou, com "tenants": "*", qualquer nome que sirva de subdomínio. */
export const TENANT_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export function knownTenant(cfg: GatewayConfig, tenant: string): boolean {
  return tenant in cfg.tenants || (cfg.anyTenant && TENANT_ID.test(tenant));
}

/** Host aceito pelo navegador: igual a um da lista ou, para "*.dominio", qualquer subdomínio dele. */
export function hostAllowed(list: readonly string[], host: string): boolean {
  const h = host.toLowerCase();
  return list.some((p) => {
    const pat = p.toLowerCase();
    if (pat.startsWith('*.')) return h.endsWith(pat.slice(1)) && h.length > pat.length - 1;
    return h === pat;
  });
}

/** O que o membro pode no navegador livre: o padrão da configuração ou mais, por regra. */
export function externalLevelFor(cfg: GatewayConfig, member: string): WebLevel {
  let lv = cfg.external;
  for (const r of cfg.rules) if (r.externo && match(r.members, member) && WEB_RANK[r.externo] > WEB_RANK[lv]) lv = r.externo;
  return lv;
}

export function hasWebLevel(have: WebLevel, need: WebLevel): boolean {
  return WEB_RANK[have] >= WEB_RANK[need];
}
