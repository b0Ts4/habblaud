// Cadastro dos membros da sede (server/central.ts), no arquivo HABBLAUD_CENTRAL_CONFIG (padrão ~/.habblaud/central.json).
//   npm run central:member -- add <id> "<Nome>" [--admin] [--senha <senha>]   cria o membro e mostra o token dele
//   npm run central:member -- token <id>                                       gera um token novo (o antigo para)
//   npm run central:member -- senha <id> [--senha <senha>]                     troca a senha
//   npm run central:member -- remove <id>
//   npm run central:member -- list
//   npm run central:member -- policy terminal=all messages=own permissions=own
// Depois de mudar, a sede relê com `kill -HUP <pid>` (ou reinicie). A senha e o token nunca ficam no arquivo em texto
// puro; o token só aparece aqui, uma vez: copie para o HABBLAUD_CENTRAL_TOKEN do computador do membro.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { hashToken, readCentralFile, writeCentralFile, type CentralFile, type MemberRecord, type Scope } from '../server/central/config';
import { MEMBER_ID } from '../server/central/merge';
import { hashPassword } from '../server/remote/password';

const file = process.env.HABBLAUD_CENTRAL_CONFIG?.trim() || join(process.env.HABBLAUD_DATA_DIR?.trim() || join(homedir(), '.habblaud'), 'central.json');
const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const admin = args.includes('--admin');
if (admin) args.splice(args.indexOf('--admin'), 1);
const givenPassword = flag('--senha') ?? flag('--password');
const [cmd, id, ...rest] = args;

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

async function askPassword(): Promise<string> {
  if (givenPassword) return givenPassword;
  if (!process.stdin.isTTY) die('sem terminal para perguntar a senha: use --senha <senha>');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const p = await rl.question('Senha do membro (12+ caracteres): ');
  rl.close();
  return p;
}

async function password(): Promise<string> {
  const p = await askPassword();
  if (p.length < 12) die('a senha precisa ter 12 caracteres ou mais');
  return hashPassword(p);
}

function newToken(): string {
  return `hbs_${randomBytes(32).toString('base64url')}`;
}

function find(data: CentralFile, mid: string | undefined): MemberRecord {
  const m = data.members.find((x) => x.id === mid);
  if (!m) die(`membro desconhecido: ${mid ?? '(faltou o id)'}`);
  return m;
}

function showToken(mid: string, token: string): void {
  console.log(`\nToken do computador de ${mid} (aparece só agora):\n\n  ${token}\n`);
  console.log('No computador dele, no .env do Habblaud (ou no ambiente):');
  console.log('  HABBLAUD_CENTRAL_URL=https://<endereço da sede>');
  console.log(`  HABBLAUD_CENTRAL_TOKEN=${token}`);
  console.log('  # opcional: o que a sede pode fazer neste computador (padrão terminal,messages)');
  console.log('  HABBLAUD_CENTRAL_ALLOW=terminal,messages\n');
}

const data = readCentralFile(file);
switch (cmd) {
  case 'add': {
    if (!id || !MEMBER_ID.test(id)) die('id inválido: use minúsculas, dígitos e hífen (ex.: bruno)');
    if (data.members.some((m) => m.id === id)) die(`já existe o membro ${id}`);
    const token = newToken();
    data.members.push({ id, name: rest.join(' ').trim() || id, passwordHash: await password(), tokenHash: hashToken(token), ...(admin ? { admin: true } : {}) });
    writeCentralFile(file, data);
    console.log(`✓ ${id} cadastrado em ${file}${admin ? ' (administrador)' : ''}.`);
    showToken(id, token);
    break;
  }
  case 'token': {
    const m = find(data, id);
    const token = newToken();
    m.tokenHash = hashToken(token);
    writeCentralFile(file, data);
    console.log(`✓ token novo para ${m.id}; o anterior deixa de valer quando a sede reler a configuração.`);
    showToken(m.id, token);
    break;
  }
  case 'senha':
  case 'password': {
    const m = find(data, id);
    m.passwordHash = await password();
    writeCentralFile(file, data);
    console.log(`✓ senha de ${m.id} trocada (as sessões abertas dele caem).`);
    break;
  }
  case 'remove': {
    find(data, id);
    data.members = data.members.filter((m) => m.id !== id);
    writeCentralFile(file, data);
    console.log(`✓ ${id} removido.`);
    break;
  }
  case 'policy': {
    const policy = { ...(data.policy ?? {}) };
    for (const kv of [id, ...rest].filter(Boolean)) {
      const [k, v] = kv.split('=');
      if (!['terminal', 'messages', 'permissions', 'agents'].includes(k) || (v !== 'own' && v !== 'all')) die(`regra inválida: ${kv} (ex.: terminal=all)`);
      policy[k as 'terminal'] = v as Scope;
    }
    data.policy = policy;
    writeCentralFile(file, data);
    console.log(`✓ política: ${JSON.stringify(policy)}`);
    break;
  }
  case 'list':
  case undefined: {
    console.log(`${file}`);
    console.log(`política: ${JSON.stringify(data.policy ?? {})} (padrão: terminal=all messages=own permissions=own agents=all)`);
    for (const m of data.members) console.log(`  ${m.id.padEnd(16)} ${m.name}${m.admin ? '  [admin]' : ''}`);
    if (!data.members.length) console.log('  (nenhum membro)');
    break;
  }
  default:
    die(`comando desconhecido: ${cmd} (add, token, senha, remove, policy, list)`);
}
