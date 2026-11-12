// Configuração da sede: quem são os membros (cada pessoa do escritório) e o que cada um pode fazer com os agentes
// dos outros. Fica num arquivo JSON (HABBLAUD_CENTRAL_CONFIG, padrão ~/.habblaud/central.json), mantido pelo
// `npm run central:member` (scripts/central-member.ts). Segredos nunca ficam em texto puro: a senha é um hash scrypt
// e o token do computador de cada membro, um SHA-256.
import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tr } from '../../shared/i18n';
import { parsePasswordHash, type PasswordHash } from '../remote/password';
import { MEMBER_ID } from './merge';

/** "own": só com os próprios agentes; "all": com os de qualquer membro. */
export type Scope = 'own' | 'all';

export interface CentralPolicy {
  /** Ver o terminal (a conversa) dos agentes. */
  terminal: Scope;
  /** Mandar mensagens aos agentes pela página. */
  messages: Scope;
  /** Responder pedidos de permissão pela página. */
  permissions: Scope;
}

export const DEFAULT_POLICY: CentralPolicy = { terminal: 'all', messages: 'own', permissions: 'own' };

export interface MemberRecord {
  /** Login e prefixo dos ids (ex.: "bruno"). */
  id: string;
  /** Nome exibido nas salas (ex.: "Bruno"). */
  name: string;
  /** Hash scrypt da senha de login (formato de remote/password.ts). */
  passwordHash: string;
  /** SHA-256 (hex) do token que o Habblaud do computador do membro usa para se conectar. */
  tokenHash: string;
  /** Administrador: faz tudo com os agentes de todos, independentemente da política. */
  admin?: boolean;
}

export interface CentralFile {
  /** Nome do escritório (aparece no log). */
  name?: string;
  policy?: Partial<CentralPolicy>;
  members: MemberRecord[];
}

export interface Member extends MemberRecord {
  password: PasswordHash;
}

export interface CentralConfig {
  name: string;
  policy: CentralPolicy;
  members: Map<string, Member>;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function scope(v: unknown, fallback: Scope): Scope {
  return v === 'own' || v === 'all' ? v : fallback;
}

/** Valida o arquivo; erro com a explicação quando algo não serve (a sede não sobe com configuração ruim). */
export function parseCentralFile(data: unknown): CentralConfig {
  if (!data || typeof data !== 'object') throw new Error(tr('configuração da sede inválida: esperava um objeto JSON'));
  const f = data as Partial<CentralFile>;
  if (!Array.isArray(f.members)) throw new Error(tr('configuração da sede inválida: falta a lista "members"'));
  const members = new Map<string, Member>();
  const tokens = new Set<string>();
  for (const raw of f.members as Partial<MemberRecord>[]) {
    const id = typeof raw?.id === 'string' ? raw.id : '';
    if (!MEMBER_ID.test(id)) throw new Error(tr('membro com id inválido: "{0}" (use minúsculas, dígitos e hífen)', [id]));
    if (members.has(id)) throw new Error(tr('membro repetido: {0}', [id]));
    const password = parsePasswordHash(raw.passwordHash);
    if (!password) throw new Error(tr('membro {0}: passwordHash inválido (gere com npm run central:member)', [id]));
    const tokenHash = typeof raw.tokenHash === 'string' ? raw.tokenHash.toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(tokenHash)) throw new Error(tr('membro {0}: tokenHash inválido (gere com npm run central:member)', [id]));
    if (tokens.has(tokenHash)) throw new Error(tr('membro {0}: token repetido', [id]));
    tokens.add(tokenHash);
    const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, 40) : id;
    members.set(id, { id, name, passwordHash: raw.passwordHash as string, tokenHash, admin: raw.admin === true, password });
  }
  const p = f.policy ?? {};
  return {
    name: typeof f.name === 'string' && f.name.trim() ? f.name.trim() : 'Habblaud',
    policy: {
      terminal: scope(p.terminal, DEFAULT_POLICY.terminal),
      messages: scope(p.messages, DEFAULT_POLICY.messages),
      permissions: scope(p.permissions, DEFAULT_POLICY.permissions),
    },
    members,
  };
}

export function readCentralFile(file: string): CentralFile {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as CentralFile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { members: [] };
    throw err;
  }
}

export function writeCentralFile(file: string, data: CentralFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

/** O membro dono do token (Authorization: Bearer do computador dele); comparação em tempo constante. */
export function memberByToken(cfg: CentralConfig, token: string | undefined): Member | undefined {
  if (!token) return undefined;
  const got = Buffer.from(hashToken(token), 'hex');
  let found: Member | undefined;
  for (const m of cfg.members.values()) {
    if (timingSafeEqual(got, Buffer.from(m.tokenHash, 'hex'))) found = m;
  }
  return found;
}

/** O que `who` pode fazer com um agente do membro `owner`. */
export function allowed(cfg: CentralConfig, who: Member, owner: string, what: keyof CentralPolicy): boolean {
  return who.admin === true || who.id === owner || cfg.policy[what] === 'all';
}
