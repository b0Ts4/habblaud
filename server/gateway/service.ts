// O gateway na sede: recebe os pedidos das ferramentas sistema_* (vindos do MCP do escritório pelo Habblaud do
// computador do agente), confere a regra do membro no tenant, executa no banco ou no navegador e registra tudo
// (gateway-audit.jsonl). Alterações no banco nunca rodam direto: viram um pedido de aprovação, que o dono do agente (ou
// um administrador, conforme `approvers`) aprova ou recusa pela página da sede (/aprovacoes), também pelo celular.
import { appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tr } from '../../shared/i18n';
import { externalLevelFor, hasWebLevel, knownTenant, levelsFor, tenantsFor, type GatewayConfig, type WebLevel } from './config';
import { formatResult, GatewayDb, sqlProblem } from './db';
import { applyChange, describeChange, parseChange, planChange, type ChangePlan, type ChangeSummary } from './change';
import { EXTERNAL, GatewayWeb, type WebSession } from './web';
import type { CredentialStore } from './credentials';
import { knownTenant as isKnownTenant } from './config';

export interface Caller {
  member: string;
  memberName: string;
  agentId: string;
  agentName: string;
}

export interface Approval {
  id: string;
  caller: Caller;
  tenant: string;
  tenantName: string;
  /** O que o agente explicou, em português (por que e o quê). */
  reason: string;
  /** O que vai mudar, montado do ensaio com os dados reais (change.ts, describeChange). */
  summary: ChangeSummary;
  /** Detalhes técnicos (só para quem quiser conferir). */
  sql: string;
  params: unknown[];
  plan: ChangePlan;
  status: 'pending' | 'approved' | 'denied' | 'failed' | 'done';
  decidedBy?: string;
  note?: string;
  result?: string;
  createdAt: number;
  decidedAt?: number;
}

export type GatewayReply = { text: string } | { image: string; text: string } | { error: string };

const KEEP_MS = 24 * 60 * 60_000;

export interface GatewayDeps {
  config: GatewayConfig;
  auditFile: string;
  /** Avisa o dono (página da sede) de que há alteração esperando aprovação. */
  notify?: (a: Approval) => void;
  db?: GatewayDb;
  web?: GatewayWeb;
  /** Login de cada pessoa no sistema (página "Meu login no sistema"). */
  credentials?: CredentialStore;
}

export class GatewayService {
  readonly db?: GatewayDb;
  readonly web?: GatewayWeb;
  private approvals = new Map<string, Approval>();
  private waiters = new Map<string, Set<(a: Approval) => void>>();

  constructor(private readonly deps: GatewayDeps) {
    this.db = deps.db ?? (deps.config.db ? new GatewayDb(deps.config.db) : undefined);
    // O navegador também existe só para o navegador livre (sem o sistema da empresa configurado).
    const webCfg = deps.config.web ?? (deps.config.external !== 'none' ? { baseUrl: 'about:blank', credentials: {}, allowedHosts: [] } : undefined);
    this.web = deps.web ?? (webCfg ? new GatewayWeb(webCfg, process.env, (m, t) => deps.credentials?.get(m, t)) : undefined);
  }

  get config(): GatewayConfig {
    return this.deps.config;
  }

  async close(): Promise<void> {
    await Promise.all([this.db?.close(), this.web?.close()]);
  }

  private audit(c: Caller, action: string, data: Record<string, unknown>): void {
    const line = JSON.stringify({ at: new Date().toISOString(), member: c.member, agent: c.agentId, agentName: c.agentName, action, ...data });
    void appendFile(this.deps.auditFile, `${line}\n`, { mode: 0o600 }).catch(() => undefined);
  }

  private tenant(c: Caller, tenant: unknown): string {
    if (typeof tenant !== 'string' || !knownTenant(this.deps.config, tenant)) throw new Error(tr('tenant desconhecido: {0}. Use sistema_tenants.', [String(tenant)]));
    return tenant;
  }

  /** Executa uma ação de uma ferramenta sistema_*. */
  async run(c: Caller, action: string, args: Record<string, unknown>): Promise<GatewayReply> {
    try {
      return await this.dispatch(c, action, args);
    } catch (err) {
      const msg = (err as Error)?.message ?? String(err);
      this.audit(c, action, { tenant: args.tenant, error: msg });
      return { error: msg };
    }
  }

  private async dispatch(c: Caller, action: string, args: Record<string, unknown>): Promise<GatewayReply> {
    const cfg = this.deps.config;
    if (action === 'tenants') {
      const list = tenantsFor(cfg, c.member);
      if (cfg.anyTenant) {
        const any = levelsFor(cfg, c.member, '*');
        if (any.db !== 'none' || any.web !== 'none')
          list.push({ id: '<subdomínio>', name: tr('qualquer tenant (o id é o subdomínio do cliente)'), ...any });
      }
      if (!list.length) return { text: tr('Você não tem acesso a nenhum tenant pelo gateway (fale com quem administra a sede).') };
      return {
        text: list
          .map((t) => `- ${t.id} (${t.name}): ${tr('banco')} ${t.db === 'write' ? tr('leitura e alteração com aprovação') : t.db === 'read' ? tr('só leitura') : tr('não')}; web ${t.web === 'interact' ? tr('ver e interagir') : t.web === 'view' ? tr('só ver') : tr('não')}`)
          .join('\n'),
      };
    }
    if (action === 'alteracao') return this.waitApproval(c, String(args.id ?? ''), Number(args.esperar_segundos) || 0);
    if (action.startsWith('livre_')) return this.external(c, action, args);
    const tenant = this.tenant(c, args.tenant);
    const lv = levelsFor(cfg, c.member, tenant);

    if (action === 'consultar') {
      if (lv.db === 'none' || !this.db) throw new Error(tr('sem acesso ao banco do tenant {0}', [tenant]));
      const sql = String(args.sql ?? '');
      const bad = sqlProblem(sql, 'read');
      if (bad) throw new Error(bad);
      const r = await this.db.query(tenant, sql);
      this.audit(c, 'consultar', { tenant, sql, rows: r.rowCount });
      return { text: formatResult(r) };
    }

    if (action === 'alterar') {
      if (lv.db !== 'write' || !this.db || !cfg.db) throw new Error(tr('sem permissão para alterar o banco do tenant {0}', [tenant]));
      const reason = String(args.explicacao ?? args.motivo ?? '').trim().slice(0, 1000);
      if (!reason) throw new Error(tr('explique em português simples o que muda e por quê (campo explicacao): é o que a pessoa vai ler para aprovar'));
      const req = parseChange(args, cfg.db);
      const plan = await planChange(this.db, cfg.db, tenant, req);
      const tenantName = cfg.tenants[tenant] ?? tenant;
      const a: Approval = {
        id: `alt-${randomBytes(5).toString('hex')}`,
        caller: c,
        tenant,
        tenantName,
        reason,
        summary: describeChange(plan, cfg.db.labels[plan.table] ?? cfg.db.labels[`${plan.schema}.${plan.table}`], tenantName, cfg.db.tenantColumn),
        sql: plan.sql,
        params: plan.params,
        plan,
        status: 'pending',
        createdAt: Date.now(),
      };
      this.sweep();
      this.approvals.set(a.id, a);
      this.audit(c, 'alterar:pedido', { tenant, id: a.id, reason, summary: a.summary, sql: a.sql, params: a.params, rows: plan.rowCount });
      this.deps.notify?.(a);
      const wait = Math.max(0, Math.min(600, Number(args.esperar_segundos) || 0));
      if (wait) return this.waitApproval(c, a.id, wait);
      return { text: tr('Pedido de alteração {0} criado e esperando aprovação humana na sede. A pessoa vai ler:\n{1}\n{2}\nConfira a decisão com sistema_ver_alteracao.', [a.id, a.summary.title, a.summary.lines.map((l) => `- ${l}`).join('\n')]) };
    }

    if (action.startsWith('web_')) {
      if (!this.web) throw new Error(tr('o gateway não tem acesso web configurado'));
      const need: WebLevel = action === 'web_clicar' || action === 'web_preencher' ? 'interact' : 'view';
      if (!hasWebLevel(lv.web, need)) throw new Error(need === 'interact' ? tr('você só pode ver o sistema pela web no tenant {0}, não clicar nem preencher', [tenant]) : tr('sem acesso web ao tenant {0}', [tenant]));
      const s: WebSession = await this.web.session(c.member, c.agentId, c.agentName, tenant, c.memberName);
      this.audit(c, action, { tenant, caminho: args.caminho, alvo: args.alvo ?? args.campo });
      switch (action) {
        case 'web_abrir':
          return { text: await this.web.open(s, typeof args.caminho === 'string' ? args.caminho : undefined) };
        case 'web_ler':
          return { text: await this.web.read(s) };
        case 'web_clicar':
          return { text: await this.web.click(s, String(args.alvo ?? '')) };
        case 'web_preencher':
          return { text: await this.web.fill(s, String(args.campo ?? ''), String(args.valor ?? '')) };
        case 'web_print': {
          const img = await this.web.screenshot(s);
          return { image: img.toString('base64'), text: `${s.title} — ${s.url}` };
        }
      }
    }
    throw new Error(tr('ação desconhecida do gateway: {0}', [action]));
  }

  /** Navegador livre: sites externos, sem login, nunca a rede interna da sede. */
  private async external(c: Caller, action: string, args: Record<string, unknown>): Promise<GatewayReply> {
    if (!this.web) throw new Error(tr('o navegador não está disponível nesta sede'));
    const lv = externalLevelFor(this.deps.config, c.member);
    const need: WebLevel = action === 'livre_clicar' || action === 'livre_preencher' ? 'interact' : 'view';
    if (!hasWebLevel(lv, need)) throw new Error(need === 'interact' && lv === 'view' ? tr('no navegador livre você só pode ver, não clicar nem preencher') : tr('o navegador livre está desligado para você'));
    const s = await this.web.session(c.member, c.agentId, c.agentName, EXTERNAL, c.memberName);
    this.audit(c, action, { url: args.url, alvo: args.alvo ?? args.campo });
    switch (action) {
      case 'livre_abrir':
        return { text: await this.web.openExternal(s, String(args.url ?? '')) };
      case 'livre_ler':
        return { text: await this.web.read(s) };
      case 'livre_clicar':
        return { text: await this.web.click(s, String(args.alvo ?? '')) };
      case 'livre_preencher':
        return { text: await this.web.fill(s, String(args.campo ?? ''), String(args.valor ?? '')) };
      case 'livre_print': {
        const img = await this.web.screenshot(s);
        return { image: img.toString('base64'), text: `${s.title} — ${s.url}` };
      }
    }
    throw new Error(tr('ação desconhecida do gateway: {0}', [action]));
  }

  // ---- Login de cada pessoa no sistema -----------------------------------------------------------------------

  myLogins(member: string): { tenant: string; user: string; updatedAt: number }[] {
    return this.deps.credentials?.list(member) ?? [];
  }

  /** Grava (ou apaga, sem senha) o login da pessoa para um tenant ou para todos ("*"). */
  setMyLogin(member: string, tenant: string, user: string, password: string | undefined): { ok: true } | { error: string } {
    if (!this.deps.credentials) return { error: tr('o gateway web não está configurado nesta sede') };
    if (tenant !== '*' && !isKnownTenant(this.deps.config, tenant)) return { error: tr('tenant inválido: {0}', [tenant]) };
    if (password === undefined) {
      this.deps.credentials.remove(member, tenant);
      return { ok: true };
    }
    if (!user.trim() || !password) return { error: tr('informe o usuário e a senha') };
    this.deps.credentials.set(member, tenant, user.trim(), password);
    return { ok: true };
  }

  /** Entra no sistema com o login da pessoa, para ela saber na hora se está certo. */
  async testMyLogin(member: string, memberName: string, tenant: string): Promise<{ ok: true; text: string } | { error: string }> {
    if (!this.web) return { error: tr('o gateway web não está configurado nesta sede') };
    if (!isKnownTenant(this.deps.config, tenant) || tenant === '*') return { error: tr('diga um tenant para testar (o subdomínio de um cliente)') };
    const id = `teste-login:${member}`;
    try {
      const s = await this.web.session(member, id, tr('Teste de login'), tenant, memberName);
      return { ok: true, text: tr('Entrou: {0}', [s.title || s.url]) };
    } catch (err) {
      return { error: (err as Error).message };
    } finally {
      await this.web.drop(`${id}|${tenant}`);
    }
  }

  // ---- Aprovações -----------------------------------------------------------------------------------------

  /** Pode aprovar: administrador sempre; o dono do agente se approvers = owner. */
  canDecide(a: Approval, who: { id: string; admin?: boolean }): boolean {
    return who.admin === true || (this.deps.config.approvers === 'owner' && a.caller.member === who.id);
  }

  list(who: { id: string; admin?: boolean }): Approval[] {
    this.sweep();
    return [...this.approvals.values()].filter((a) => who.admin || a.caller.member === who.id).sort((x, y) => y.createdAt - x.createdAt);
  }

  get(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  async decide(id: string, who: { id: string; name: string; admin?: boolean }, approve: boolean, note?: string): Promise<Approval | { error: string }> {
    const a = this.approvals.get(id);
    if (!a) return { error: tr('pedido de alteração desconhecido') };
    if (!this.canDecide(a, who)) return { error: tr('você não pode aprovar este pedido') };
    if (a.status !== 'pending') return { error: tr('este pedido já foi decidido') };
    a.decidedBy = who.name;
    a.decidedAt = Date.now();
    a.note = note?.slice(0, 500);
    if (!approve) {
      a.status = 'denied';
      this.audit(a.caller, 'alterar:recusado', { id, by: who.id, note });
    } else {
      a.status = 'approved';
      try {
        const n = await applyChange(this.db!, a.tenant, a.plan);
        a.status = 'done';
        a.result = tr('Gravado: {0} registro(s).', [n]);
        this.audit(a.caller, 'alterar:gravado', { id, by: who.id, tenant: a.tenant, sql: a.sql, params: a.params, rows: n });
      } catch (err) {
        a.status = 'failed';
        a.result = (err as Error).message;
        this.audit(a.caller, 'alterar:falhou', { id, by: who.id, error: a.result });
      }
    }
    for (const w of this.waiters.get(id) ?? []) w(a);
    this.waiters.delete(id);
    return a;
  }

  private describe(a: Approval): string {
    switch (a.status) {
      case 'pending':
        return tr('Pedido {0} ainda esperando aprovação ({1}).', [a.id, a.summary.title]);
      case 'denied':
        return tr('Pedido {0} RECUSADO por {1}{2}. Nada foi gravado.', [a.id, a.decidedBy ?? '?', a.note ? `: ${a.note}` : '']);
      case 'failed':
        return tr('Pedido {0} aprovado por {1}, mas falhou: {2}', [a.id, a.decidedBy ?? '?', a.result ?? '']);
      default:
        return tr('Pedido {0} aprovado por {1}. {2}', [a.id, a.decidedBy ?? '?', a.result ?? '']);
    }
  }

  private async waitApproval(c: Caller, id: string, seconds: number): Promise<GatewayReply> {
    const a = this.approvals.get(id);
    if (!a || a.caller.agentId !== c.agentId) throw new Error(tr('pedido de alteração desconhecido: {0}', [id]));
    if (a.status === 'pending' && seconds > 0) {
      await new Promise<void>((resolve) => {
        const set = this.waiters.get(id) ?? new Set();
        this.waiters.set(id, set);
        const done = () => {
          clearTimeout(t);
          set.delete(done);
          resolve();
        };
        const t = setTimeout(done, Math.min(600, seconds) * 1000);
        t.unref?.();
        set.add(done);
      });
    }
    return { text: this.describe(a) };
  }

  private sweep(): void {
    const cut = Date.now() - KEEP_MS;
    for (const [id, a] of this.approvals) if (a.createdAt < cut && a.status !== 'pending') this.approvals.delete(id);
  }
}
