// Conversa entre agentes pela sede: este computador só repassa (com o token dele) e a sede roteia para o agente de
// qualquer computador do time (server/central/talk.ts). Ids de agente que vão e voltam são os locais; a sede põe e
// tira o prefixo do membro.
import { tr } from '../../shared/i18n';
import type { AgentInfo } from '../../shared/types';
import { errMsg } from '../log';
import type { TalkTarget } from './registry';
import type { AskView, TalkBackend } from './local';

export class CentralTalk implements TalkBackend {
  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<T | { error: string }> {
    try {
      const res = await this.fetchImpl(`${this.url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      const data = (await res.json().catch(() => ({}))) as T & { error?: string };
      if (!res.ok && !(data && typeof data === 'object' && 'id' in data)) return { error: data?.error ?? tr('a sede respondeu {0}', [res.status]) };
      return data;
    } catch (err) {
      return { error: tr('sem conexão com a sede: {0}', [errMsg(err)]) };
    }
  }

  async agents(): Promise<TalkTarget[]> {
    const r = await this.call<{ agents: TalkTarget[] }>('GET', '/central/uplink/office');
    if ('error' in r) throw new Error(r.error);
    return r.agents;
  }

  ask(from: AgentInfo, to: string, text: string, expectReply: boolean): Promise<AskView | { error: string }> {
    return this.call<AskView>('POST', '/central/uplink/ask', { from: from.id, to, text, reply: expectReply });
  }

  wait(from: AgentInfo, id: string, ms: number): Promise<AskView | { error: string }> {
    const q = new URLSearchParams({ from: from.id, wait: String(Math.round(ms / 1000)) });
    return this.call<AskView>('GET', `/central/uplink/ask/${encodeURIComponent(id)}?${q}`, undefined, ms + 20_000);
  }

  async reply(from: AgentInfo, id: string, text: string): Promise<{ ok: true } | { error: string }> {
    const r = await this.call<{ ok: true }>('POST', '/central/uplink/reply', { from: from.id, id, text });
    return 'error' in r ? r : { ok: true };
  }

  /** Ação do gateway do sistema na sede (espera longa só ao esperar uma aprovação). */
  gateway(from: AgentInfo, action: string, args: Record<string, unknown>): Promise<unknown> {
    const wait = Math.max(0, Math.min(600, Number(args.esperar_segundos) || 0));
    return this.call('POST', '/central/uplink/gateway', { from: from.id, action, args }, (wait + 90) * 1000);
  }

  async inbox(from: AgentInfo): Promise<AskView[]> {
    const r = await this.call<{ asks: AskView[] }>('GET', `/central/uplink/inbox?${new URLSearchParams({ from: from.id })}`);
    return 'error' in r ? [] : r.asks;
  }
}
