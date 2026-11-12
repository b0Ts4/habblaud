// Login na sede: uma sessão por pessoa, num cookie assinado (HMAC) que diz de quem é. A chave de cada membro mistura o
// segredo da sede com o hash da senha dele: trocar a senha derruba as sessões abertas daquela pessoa.
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Member } from './config';

export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export class CentralSessions {
  constructor(
    private readonly secret: Buffer,
    private readonly member: (id: string) => Member | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  private sign(m: Member, payload: string): string {
    const key = createHmac('sha256', this.secret).update(`${m.id}\0${m.passwordHash}`, 'utf8').digest();
    return createHmac('sha256', key).update(payload, 'utf8').digest('base64url');
  }

  issue(m: Member): { token: string; maxAgeS: number } {
    const payload = `c1.${m.id}.${this.now() + SESSION_MS}`;
    return { token: `${payload}.${this.sign(m, payload)}`, maxAgeS: Math.floor(SESSION_MS / 1000) };
  }

  /** O membro dono do cookie, se ele é válido e não venceu. */
  verify(token: string | undefined): Member | undefined {
    const m = /^c1\.([a-z0-9-]{1,32})\.(\d{10,16})\.([A-Za-z0-9_-]{43})$/.exec(token ?? '');
    if (!m) return undefined;
    if (Number(m[2]) <= this.now()) return undefined;
    const member = this.member(m[1]);
    if (!member) return undefined;
    const expected = Buffer.from(this.sign(member, `c1.${m[1]}.${m[2]}`));
    const got = Buffer.from(m[3]);
    return expected.length === got.length && timingSafeEqual(expected, got) ? member : undefined;
  }
}
