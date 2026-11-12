// Navegador do gateway: os agentes mexem no sistema pela interface web, como uma pessoa faria, num Chromium que roda na
// sede (Playwright). Uma sessão por agente e tenant, já logada com a credencial do tenant (o agente nunca a vê); a
// navegação fica presa aos hosts do sistema. A cada ação a sessão guarda um print, que a página da sede mostra ao vivo
// ("tela do agente").
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { createRequire } from 'node:module';
import { tr } from '../../shared/i18n';
import { hostAllowed, type GatewayConfig, type WebCredential } from './config';

type WebConfig = NonNullable<GatewayConfig['web']>;

/* eslint-disable @typescript-eslint/no-explicit-any */
type Browser = any;
type Page = any;

export interface WebSession {
  id: string;
  member: string;
  memberName: string;
  agentId: string;
  agentName: string;
  tenant: string;
  page: Page;
  url: string;
  title: string;
  /** Último print (JPEG) e quando. */
  shot?: Buffer;
  shotAt?: number;
  lastAction: string;
  lastAt: number;
}

function loadPlaywright(): { chromium: { launch(o?: Record<string, unknown>): Promise<Browser> } } {
  const req = createRequire(import.meta.url);
  for (const name of ['playwright', 'playwright-core']) {
    try {
      return req(name);
    } catch {
      // tenta o próximo
    }
  }
  throw new Error(tr('o gateway web precisa do Playwright na sede: npm install playwright-core e npx playwright install --with-deps chromium'));
}

export function credentialFor(cfg: WebConfig, tenant: string, env: NodeJS.ProcessEnv = process.env): { user: string; password: string } | undefined {
  const c: WebCredential | undefined = cfg.credentials[tenant] ?? cfg.credentials['*'];
  if (!c) return undefined;
  const password = c.passwordEnv ? env[c.passwordEnv] : c.password;
  return password === undefined ? undefined : { user: c.user, password };
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => vars[k] ?? '');
}

/** "Tenant" das sessões do navegador livre (sites externos, sem login). */
export const EXTERNAL = '__externo__';

/** Endereço de rede interna (da própria sede ou da rede dela): o navegador livre nunca vai lá. */
export function privateAddress(ip: string): boolean {
  const v = ip.toLowerCase().replace(/^::ffff:/, '');
  if (isIP(v) === 4) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224;
  }
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') || v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}

/** O navegador livre pode ir a este endereço? Só http(s) público (o nome é resolvido e conferido). */
export async function publicUrl(
  url: string,
  resolve: (host: string) => Promise<string[]> = async (h) => (await lookup(h, { all: true })).map((r) => r.address),
  /** A sede sai para a internet por um proxy (HABBLAUD_GATEWAY_PROXY): quem resolve os nomes é ele. */
  viaProxy = false,
): Promise<boolean> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (isIP(host)) return !privateAddress(host);
  try {
    const ips = await resolve(host);
    return ips.length > 0 && !ips.some(privateAddress);
  } catch {
    // Sem DNS aqui: só pelo proxy (que alcança a internet, não a rede interna); sem proxy, recusa.
    return viaProxy;
  }
}

/** Sessões que ficam paradas por mais que isto fecham sozinhas. */
const IDLE_MS = 20 * 60_000;
const TEXT_MAX = 12_000;

export class GatewayWeb {
  private browser: Promise<Browser> | null = null;
  private sessions = new Map<string, WebSession>();
  private live: ReturnType<typeof setInterval>;
  private refreshing = false;
  private sweeper: ReturnType<typeof setInterval>;
  private listeners = new Set<(s: WebSession) => void>();

  constructor(
    private readonly cfg: WebConfig,
    private readonly env: NodeJS.ProcessEnv = process.env,
    /** Login da própria pessoa no sistema (página "Meu login no sistema"); vale mais que o login comum do gateway.json. */
    private readonly memberCredential?: (member: string, tenant: string) => { user: string; password: string } | undefined,
  ) {
    this.sweeper = setInterval(() => void this.sweep(), 60_000);
    this.sweeper.unref?.();
    // Tela ao vivo: enquanto alguém olha, os navegadores usados nos últimos 2 min mandam um print a cada 2 s.
    this.live = setInterval(() => void this.refresh(), 2_000);
    this.live.unref?.();
  }

  /** Avisado a cada print novo (a página da tela ao vivo). */
  onShot(cb: (s: WebSession) => void): () => void {
    this.listeners.add(cb);
    return () => void this.listeners.delete(cb);
  }

  list(): WebSession[] {
    return [...this.sessions.values()];
  }

  get(id: string): WebSession | undefined {
    return this.sessions.get(id);
  }

  async close(): Promise<void> {
    clearInterval(this.sweeper);
    clearInterval(this.live);
    const b = await this.browser?.catch(() => null);
    await b?.close().catch(() => undefined);
  }

  private launch(): Promise<Browser> {
    this.browser ??= (async () => {
      const pw = loadPlaywright();
      const exe = this.env.HABBLAUD_GATEWAY_CHROMIUM?.trim();
      const proxy = this.env.HABBLAUD_GATEWAY_PROXY?.trim();
      return pw.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}), ...(proxy ? { proxy: { server: proxy } } : {}), args: ['--no-sandbox'] });
    })();
    this.browser.catch(() => (this.browser = null));
    return this.browser;
  }

  allowed(url: string): boolean {
    try {
      const u = new URL(url);
      return (u.protocol === 'http:' || u.protocol === 'https:') && hostAllowed(this.cfg.allowedHosts, u.host);
    } catch {
      return url === 'about:blank';
    }
  }

  /** Cache curto da conferência de endereço público (cada página pede dezenas de recursos do mesmo host). */
  private publicCache = new Map<string, { ok: boolean; at: number }>();
  private async isPublic(url: string): Promise<boolean> {
    let host = '';
    try {
      const u = new URL(url);
      host = `${u.protocol}//${u.host}`;
    } catch {
      return false;
    }
    const hit = this.publicCache.get(host);
    if (hit && Date.now() - hit.at < 60_000) return hit.ok;
    const ok = await publicUrl(url, undefined, !!this.env.HABBLAUD_GATEWAY_PROXY?.trim());
    this.publicCache.set(host, { ok, at: Date.now() });
    return ok;
  }

  /** Navegador livre: abre um site externo (qualquer endereço público). */
  async openExternal(s: WebSession, url: string): Promise<string> {
    const full = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    if (!(await this.isPublic(full))) throw new Error(tr('endereço não permitido no navegador livre (só sites públicos; nada da rede interna): {0}', [full]));
    await s.page.goto(full, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await this.snap(s, tr('abriu {0}', [new URL(full).host]));
    return this.read(s);
  }

  /** Endereço absoluto dentro do sistema; recusa sair dele. */
  resolve(tenant: string, path: string | undefined): string {
    const start = fill(this.cfg.tenantUrl ?? '{base}', { base: this.cfg.baseUrl, tenant });
    const url = !path ? start : /^https?:\/\//i.test(path) ? path : new URL(path.replace(/^\/?/, ''), start.endsWith('/') ? start : `${start}/`).toString();
    if (!this.allowed(url)) throw new Error(tr('endereço fora do sistema: {0}', [url]));
    return url;
  }

  /** Sessão do agente no tenant (abre e faz o login na primeira vez). */
  async session(member: string, agentId: string, agentName: string, tenant: string, memberName = member): Promise<WebSession> {
    const id = `${agentId}|${tenant}`;
    const external = tenant === EXTERNAL;
    const have = this.sessions.get(id);
    if (have && !have.page.isClosed()) return have;
    const browser = await this.launch();
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'pt-BR' });
    // Nada fora do sistema: nem navegação, nem recursos (scripts e imagens de terceiros).
    // Sistema da empresa: nada fora dos hosts dele. Navegador livre: qualquer site público, nunca a rede interna.
    await context.route('**/*', async (route: any) => {
      const url: string = route.request().url();
      const ok = url.startsWith('data:') || url.startsWith('blob:') || (external ? await this.isPublic(url) : this.allowed(url));
      return ok ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    const s: WebSession = { id, member, memberName, agentId, agentName, tenant, page, url: '', title: '', lastAction: tr('abrindo'), lastAt: Date.now() };
    this.sessions.set(id, s);
    if (this.cfg.login && !external) await this.login(s);
    return s;
  }

  /** Endereço da tela de login: relativo ao endereço do tenant (ex.: https://<tenant>.empresa.com/login). */
  loginUrl(tenant: string): string {
    const origin = new URL(fill(this.cfg.tenantUrl ?? '{base}', { base: this.cfg.baseUrl, tenant })).origin;
    const url = new URL(this.cfg.login!.path.replace(/^\/?/, '/'), origin).toString();
    if (!this.allowed(url)) throw new Error(tr('endereço fora do sistema: {0}', [url]));
    return url;
  }

  /** A página atual é a tela de login (a sessão do sistema expirou ou nunca entrou). */
  private onLoginPage(s: WebSession): boolean {
    if (!this.cfg.login || s.tenant === EXTERNAL) return false;
    try {
      return new URL(s.page.url()).pathname.replace(/\/+$/, '') === new URL(this.loginUrl(s.tenant)).pathname.replace(/\/+$/, '');
    } catch {
      return false;
    }
  }

  private async login(s: WebSession): Promise<void> {
    const login = this.cfg.login!;
    const cred = this.memberCredential?.(s.member, s.tenant) ?? credentialFor(this.cfg, s.tenant, this.env);
    if (!cred) throw new Error(tr('{0} ainda não cadastrou o próprio login no sistema: é só abrir "Meu login no sistema" na sede', [s.memberName]));
    await s.page.goto(this.loginUrl(s.tenant), { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const vars = { user: cred.user, password: cred.password, tenant: s.tenant };
    const entries = Object.entries(login.fields);
    for (const [sel, tpl] of entries) await s.page.fill(sel, fill(tpl, vars), { timeout: 10_000 });
    if (login.submit) await s.page.click(login.submit, { timeout: 10_000 });
    else if (entries.length) await s.page.press(entries[entries.length - 1][0], 'Enter');
    await s.page.waitForURL((u: URL) => !u.pathname.replace(/\/+$/, '').endsWith(login.path.replace(/\/+$/, '')), { timeout: 15_000 }).catch(() => undefined);
    if (this.onLoginPage(s)) {
      await this.snap(s, tr('login recusado'));
      throw new Error(tr('o sistema recusou o login de {0} no tenant {1}: confira em "Meu login no sistema" na sede', [s.memberName, s.tenant]));
    }
    await this.snap(s, tr('login'));
  }

  /** Guarda o print e o estado (quem olha a tela ao vivo recebe). */
  async snap(s: WebSession, action: string): Promise<void> {
    s.lastAction = action;
    s.lastAt = Date.now();
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => '');
    s.shot = await s.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => s.shot);
    s.shotAt = Date.now();
    for (const cb of this.listeners) cb(s);
  }

  async open(s: WebSession, path: string | undefined): Promise<string> {
    const url = this.resolve(s.tenant, path);
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    // Caiu no login (sessão do sistema expirou): entra de novo e volta para onde ia.
    if (this.onLoginPage(s) && !(path ?? '').includes(this.cfg.login?.path ?? '\0')) {
      await this.login(s);
      await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    }
    await this.snap(s, tr('abriu {0}', [path || '/']));
    return this.read(s);
  }

  /** O que está na tela: título, endereço, a estrutura acessível (botões, campos, links) e o texto. */
  async read(s: WebSession): Promise<string> {
    const body = s.page.locator('body');
    const aria: string = await body.ariaSnapshot({ timeout: 10_000 }).catch(() => '');
    const text: string = await body.innerText({ timeout: 10_000 }).catch(() => '');
    const out = [`${tr('Página')}: ${await s.page.title().catch(() => '')}`, `URL: ${s.page.url()}`, '', tr('Estrutura (use os nomes para clicar e preencher):'), aria.slice(0, TEXT_MAX / 2)];
    if (text && aria.length < 200) out.push('', tr('Texto:'), text.slice(0, TEXT_MAX / 2));
    return out.join('\n');
  }

  /** Acha o elemento por papel+nome (botão, link), rótulo, placeholder, texto ou seletor CSS. */
  private async target(s: WebSession, alvo: string, field = false): Promise<any> {
    const p = s.page;
    const candidates = field
      ? [p.getByLabel(alvo, { exact: false }), p.getByPlaceholder(alvo, { exact: false }), p.getByRole('textbox', { name: alvo }), p.getByRole('combobox', { name: alvo })]
      : [p.getByRole('button', { name: alvo }), p.getByRole('link', { name: alvo }), p.getByRole('menuitem', { name: alvo }), p.getByRole('tab', { name: alvo }), p.getByText(alvo, { exact: false })];
    if (/^[#.\[]|^[a-z]+[#.\[]/i.test(alvo)) candidates.unshift(p.locator(alvo));
    for (const c of candidates) {
      if ((await c.count().catch(() => 0)) > 0) return c.first();
    }
    throw new Error(tr('não achei "{0}" na página. Use sistema_web_ler para ver os nomes dos botões e campos.', [alvo]));
  }

  async click(s: WebSession, alvo: string): Promise<string> {
    const el = await this.target(s, alvo);
    await el.click({ timeout: 10_000 });
    await s.page.waitForLoadState('domcontentloaded').catch(() => undefined);
    await s.page.waitForTimeout(300);
    if (s.tenant !== EXTERNAL && !this.allowed(s.page.url())) {
      await s.page.goBack().catch(() => undefined);
      throw new Error(tr('o clique levou para fora do sistema; voltei'));
    }
    if (this.onLoginPage(s)) {
      await this.login(s);
      throw new Error(tr('a sessão do sistema tinha expirado: entrei de novo. Abra a página e repita a ação.'));
    }
    await this.snap(s, tr('clicou em {0}', [alvo]));
    return this.read(s);
  }

  async fill(s: WebSession, campo: string, valor: string): Promise<string> {
    const el = await this.target(s, campo, true);
    const tag = await el.evaluate((n: Element) => n.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') await el.selectOption({ label: valor }).catch(() => el.selectOption(valor));
    else await el.fill(valor, { timeout: 10_000 });
    await this.snap(s, tr('preencheu {0}', [campo]));
    return tr('Preenchido.');
  }

  /** Fecha a sessão (ex.: depois de testar o login de alguém). */
  async drop(id: string): Promise<void> {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.page.context().close().catch(() => undefined);
  }

  async screenshot(s: WebSession): Promise<Buffer> {
    await this.snap(s, tr('print'));
    return s.shot ?? Buffer.alloc(0);
  }

  private async refresh(): Promise<void> {
    if (this.refreshing || !this.listeners.size) return;
    this.refreshing = true;
    try {
      const recent = Date.now() - 120_000;
      for (const s of this.sessions.values()) {
        if (s.lastAt < recent || s.page.isClosed()) continue;
        s.shot = await s.page.screenshot({ type: 'jpeg', quality: 60 }).catch(() => s.shot);
        s.shotAt = Date.now();
        s.url = s.page.url();
        for (const cb of this.listeners) cb(s);
      }
    } finally {
      this.refreshing = false;
    }
  }

  private async sweep(): Promise<void> {
    const cut = Date.now() - IDLE_MS;
    for (const [id, s] of this.sessions) {
      if (s.lastAt < cut) {
        this.sessions.delete(id);
        await s.page.context().close().catch(() => undefined);
      }
    }
  }
}
