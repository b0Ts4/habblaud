// Conversa entre agentes: um agente pergunta (ou só avisa) outro, de qualquer computador do time. Quem pergunta
// recebe um id e espera a resposta (long-poll); quem recebe vê a mensagem entrar na sessão dele, como se alguém
// tivesse digitado, com o id para responder (ferramenta escritorio_responder do MCP, mod/habblaud-mcp).
// Este registro vive onde a conversa é roteada: na sede (agentes de computadores diferentes) ou no Habblaud local,
// quando ele não está ligado a uma sede (agentes do mesmo computador).
import { randomBytes } from 'node:crypto';
import { tr } from '../../shared/i18n';

/** Mensagens e respostas maiores que isto são cortadas. */
export const TALK_TEXT_MAX = 16_000;
/** Quanto tempo uma pergunta fica guardada (respondida ou não). */
export const ASK_KEEP_MS = 6 * 60 * 60_000;
/** Maior espera de uma chamada (o agente pode chamar de novo para esperar mais). */
export const WAIT_MAX_MS = 10 * 60_000;
/** Perguntas abertas por agente que pergunta (contra laço de agentes perguntando sem parar). */
export const OPEN_MAX = 20;

export interface TalkParty {
  /** Id do agente (na sede, com o prefixo do membro). */
  id: string;
  name: string;
  /** Pessoa dona do agente (na sede) e projeto, para quem lê saber de onde veio. */
  owner?: string;
  room?: string;
}

export type AskStatus = 'delivered' | 'answered' | 'failed';

export interface Ask {
  id: string;
  from: TalkParty;
  to: TalkParty;
  text: string;
  /** Espera resposta (perguntar) ou é só um aviso (enviar). */
  expectReply: boolean;
  status: AskStatus;
  reply?: string;
  error?: string;
  createdAt: number;
  answeredAt?: number;
}

/** O que a mensagem que entra na sessão de quem recebe diz. */
export function deliveryText(a: Pick<Ask, 'id' | 'from' | 'text' | 'expectReply'>): string {
  const where = [a.from.owner, a.from.room].filter(Boolean).join(' · ');
  const head = where ? tr('[Escritório] Mensagem de {0} ({1})', [a.from.name, where]) : tr('[Escritório] Mensagem de {0}', [a.from.name]);
  const tail = a.expectReply
    ? tr('Responda com a ferramenta escritorio_responder (id: {0}). Se precisar de mais tempo, responda quando terminar.', [a.id])
    : tr('É só um aviso: não precisa responder. Para falar com {0}, use escritorio_perguntar ou escritorio_enviar.', [a.from.name]);
  return `${head}:\n${a.text}\n\n${tail}`;
}

interface Waiter {
  resolve: (a: Ask) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class AskRegistry {
  private asks = new Map<string, Ask>();
  private waiters = new Map<string, Set<Waiter>>();

  constructor(private readonly now: () => number = Date.now) {}

  open(fromId: string): number {
    let n = 0;
    for (const a of this.asks.values()) if (a.from.id === fromId && a.expectReply && a.status === 'delivered') n++;
    return n;
  }

  create(from: TalkParty, to: TalkParty, text: string, expectReply: boolean): Ask {
    this.sweep();
    const a: Ask = { id: `q-${randomBytes(6).toString('base64url')}`, from, to, text: text.slice(0, TALK_TEXT_MAX), expectReply, status: 'delivered', createdAt: this.now() };
    this.asks.set(a.id, a);
    return a;
  }

  get(id: string): Ask | undefined {
    return this.asks.get(id);
  }

  fail(id: string, error: string): void {
    const a = this.asks.get(id);
    if (!a || a.status !== 'delivered') return;
    a.status = 'failed';
    a.error = error;
    this.wake(a);
  }

  /** Resposta de quem recebeu. `by` precisa ser o destinatário (ninguém responde no lugar dele). */
  reply(id: string, by: string, text: string): { ok: true; ask: Ask } | { error: string } {
    const a = this.asks.get(id);
    if (!a) return { error: tr('pedido desconhecido (expirou ou o id está errado): {0}', [id]) };
    if (a.to.id !== by) return { error: tr('este pedido foi feito a outro agente ({0})', [a.to.name]) };
    if (a.status === 'answered') return { error: tr('este pedido já foi respondido') };
    a.status = 'answered';
    a.reply = text.slice(0, TALK_TEXT_MAX);
    a.answeredAt = this.now();
    this.wake(a);
    return { ok: true, ask: a };
  }

  /** Espera a resposta (ou a falha) por até `ms`; devolve o pedido como estiver. */
  wait(id: string, ms: number): Promise<Ask | undefined> {
    const a = this.asks.get(id);
    if (!a || a.status !== 'delivered' || ms <= 0) return Promise.resolve(a);
    return new Promise((resolve) => {
      const set = this.waiters.get(id) ?? new Set<Waiter>();
      this.waiters.set(id, set);
      const w: Waiter = {
        resolve,
        timer: setTimeout(() => {
          set.delete(w);
          resolve(this.asks.get(id));
        }, Math.min(ms, WAIT_MAX_MS)),
      };
      w.timer.unref?.();
      set.add(w);
    });
  }

  /** Perguntas feitas a um agente que ainda esperam resposta (para ele achar o id, se perdeu). */
  pendingFor(agentId: string): Ask[] {
    return [...this.asks.values()].filter((a) => a.to.id === agentId && a.expectReply && a.status === 'delivered');
  }

  private wake(a: Ask): void {
    const set = this.waiters.get(a.id);
    if (!set) return;
    this.waiters.delete(a.id);
    for (const w of set) {
      clearTimeout(w.timer);
      w.resolve(a);
    }
  }

  private sweep(): void {
    const cut = this.now() - ASK_KEEP_MS;
    for (const [id, a] of this.asks) if (a.createdAt < cut && !this.waiters.has(id)) this.asks.delete(id);
  }
}

/** Agente que dá para chamar pelo nome. */
export interface TalkTarget {
  id: string;
  name: string;
  owner?: string;
  ownerId?: string;
  room?: string;
  status?: string;
  provider?: string;
  title?: string;
  kind?: string;
}

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .trim()
    .toLowerCase();
}

/**
 * Acha o agente por id, por nome ("Cecília") ou por nome e pessoa ("Cecília @ Ana", "Cecília da Ana"). Mais de um com o
 * mesmo nome: erro com as opções, para o agente escolher. Só agentes principais (subagentes não recebem mensagens).
 */
export function resolveTarget(list: readonly TalkTarget[], query: string): { target: TalkTarget } | { error: string } {
  const mains = list.filter((a) => a.kind === undefined || a.kind === 'main');
  const exact = mains.find((a) => a.id === query);
  if (exact) return { target: exact };
  const m = /^(.+?)\s*(?:@|\bd[aoe]\b)\s*(.+)$/i.exec(query.trim());
  const name = norm(m ? m[1] : query);
  const owner = m ? norm(m[2]) : undefined;
  const hits = mains.filter((a) => norm(a.name) === name && (!owner || norm(a.owner ?? '').startsWith(owner) || norm(a.ownerId ?? '') === owner));
  if (hits.length === 1) return { target: hits[0] };
  if (!hits.length) return { error: tr('nenhum agente chamado "{0}". Use escritorio_agentes para ver quem está no escritório.', [query]) };
  return { error: tr('há mais de um agente chamado "{0}": {1}. Use o id ou "Nome @ Pessoa".', [query, hits.map((a) => `${a.name} @ ${a.owner ?? '?'} (${a.id})`).join('; ')]) };
}
