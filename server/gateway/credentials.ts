// Login de cada pessoa no sistema da empresa, para o navegador do gateway entrar como ela (as permissões do próprio
// sistema continuam valendo). A pessoa cadastra na página "Meu login no sistema" da sede; a senha fica cifrada
// (AES-256-GCM) neste arquivo, com a chave noutro arquivo (gateway-key, permissão 600), e nunca volta para página nem
// para agente nenhum. Um login para todos os tenants ("*") ou um por tenant.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

interface Entry {
  user: string;
  /** iv.tag.dados, em base64url. */
  secret: string;
  updatedAt: number;
}

type Data = Record<string, Record<string, Entry>>;

function loadKey(file: string): Buffer {
  try {
    const k = readFileSync(file);
    if (k.length === 32) return k;
  } catch {
    // ainda não existe
  }
  const k = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, k, { mode: 0o600 });
  return k;
}

export class CredentialStore {
  private data: Data = {};
  private readonly key: Buffer;

  constructor(
    private readonly file: string,
    keyFile: string,
  ) {
    this.key = loadKey(keyFile);
    try {
      this.data = JSON.parse(readFileSync(file, 'utf8')) as Data;
    } catch {
      this.data = {};
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  private seal(text: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
  }

  private open(secret: string): string | undefined {
    try {
      const [iv, tag, enc] = secret.split('.').map((p) => Buffer.from(p, 'base64url'));
      const d = createDecipheriv('aes-256-gcm', this.key, iv);
      d.setAuthTag(tag);
      return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
    } catch {
      return undefined;
    }
  }

  set(member: string, tenant: string, user: string, password: string): void {
    (this.data[member] ??= {})[tenant] = { user, secret: this.seal(password), updatedAt: Date.now() };
    this.save();
  }

  remove(member: string, tenant: string): void {
    if (this.data[member]) delete this.data[member][tenant];
    this.save();
  }

  /** O login da pessoa no tenant (o específico vale mais que o "*"). */
  get(member: string, tenant: string): { user: string; password: string } | undefined {
    const e = this.data[member]?.[tenant] ?? this.data[member]?.['*'];
    const password = e && this.open(e.secret);
    return e && password !== undefined ? { user: e.user, password } : undefined;
  }

  /** O que a página mostra: tenant, usuário e quando, nunca a senha. */
  list(member: string): { tenant: string; user: string; updatedAt: number }[] {
    return Object.entries(this.data[member] ?? {}).map(([tenant, e]) => ({ tenant, user: e.user, updatedAt: e.updatedAt }));
  }
}
