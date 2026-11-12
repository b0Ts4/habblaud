// Liga o Habblaud deste computador à sede do time, de uma vez:
//   npm run membro:configurar -- --sede https://habblaud.suaempresa.com --token hbs_... [--iniciar-com-o-computador]
// 1. grava no .env desta pasta o endereço da sede, o token, o terminal interativo ligado e o Habblaud World desligado;
// 2. confere o que o computador precisa: Node, node-pty (terminal interativo), Claude Code e/ou Codex;
// 3. com --iniciar-com-o-computador, registra o Habblaud para subir no login (Windows: Agendador de Tarefas; Linux:
//    serviço do systemd do usuário; macOS: LaunchAgent).
// Depois: npm run build (uma vez) e npm run membro.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runnableClaudeBin } from '../server/claude-bin';
import { findCodexBin } from '../server/messages/codex';
import { loadPty } from '../server/pty/manager';

const ROOT = join(import.meta.dirname, '..');
const ENV_FILE = join(ROOT, '.env');
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

function die(msg: string): never {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

/** Troca (ou acrescenta) as chaves no .env, mantendo o resto do arquivo. */
export function mergeEnv(text: string, values: Record<string, string>): string {
  const lines = text ? text.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n') : [];
  const done = new Set<string>();
  const out = lines.map((l) => {
    const m = /^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/.exec(l);
    if (m && m[1] in values) {
      done.add(m[1]);
      return `${m[1]}=${values[m[1]]}`;
    }
    return l;
  });
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) out.push(`${k}=${v}`);
  return `${out.join('\n')}\n`;
}

async function main(): Promise<void> {
  const sede = opt('--sede');
  const token = opt('--token');
  if (!sede || !token) die('use: npm run membro:configurar -- --sede https://<endereço da sede> --token <token que o administrador passou>');
  let url: URL;
  try {
    url = new URL(sede);
  } catch {
    die(`endereço inválido: ${sede}`);
  }
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(url.hostname)) die('use https:// no endereço da sede');

  // 1. .env
  const before = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8') : '';
  const values: Record<string, string> = { HABBLAUD_CENTRAL_URL: url.origin, HABBLAUD_CENTRAL_TOKEN: token, HABBLAUD_PTY: '1', HABBLAUD_WORLD: '0' };
  const allow = opt('--liberar');
  if (allow) values.HABBLAUD_CENTRAL_ALLOW = allow;
  writeFileSync(ENV_FILE, mergeEnv(before, values), { mode: 0o600 });
  console.log(`✓ ${ENV_FILE} atualizado (sede ${url.origin}).`);

  // 2. O que o computador precisa.
  try {
    const res = await fetch(`${url.origin}/central/uplink/office`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) });
    console.log(res.status === 401 ? '✗ a sede recusou o token: confira com quem administra a sede.' : res.ok ? '✓ a sede aceitou o token.' : `! a sede respondeu ${res.status}.`);
  } catch (err) {
    console.log(`! não consegui falar com a sede agora (${(err as Error).message}); o Habblaud tenta sozinho depois.`);
  }
  const pty = await loadPty();
  console.log(pty.spawn ? '✓ terminal interativo (node-pty) funciona.' : `✗ terminal interativo indisponível: ${pty.reason ?? '?'} (rode npm install de novo).`);
  const claude = runnableClaudeBin(process.env);
  const codex = findCodexBin(process.env);
  console.log(claude ? `✓ Claude Code: ${claude}` : '- Claude Code não encontrado (opcional): npm install -g @anthropic-ai/claude-code');
  console.log(codex ? `✓ Codex: ${codex}` : '- Codex não encontrado (opcional): npm install -g @openai/codex');
  if (!claude && !codex) console.log('! instale pelo menos um dos dois para abrir agentes pela sede.');

  // 3. Subir junto com o computador.
  if (args.includes('--iniciar-com-o-computador')) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    try {
      if (process.platform === 'win32') {
        const cmd = `cmd /c "cd /d ""${ROOT}"" && ${npm} run membro"`;
        execFileSync('schtasks', ['/Create', '/F', '/SC', 'ONLOGON', '/TN', 'Habblaud', '/TR', cmd], { stdio: 'inherit' });
        console.log('✓ tarefa "Habblaud" criada no Agendador de Tarefas (sobe no login).');
      } else if (process.platform === 'linux') {
        const dir = join(homedir(), '.config', 'systemd', 'user');
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, 'habblaud.service'),
          `[Unit]\nDescription=Habblaud (ligado à sede)\nAfter=network-online.target\n\n[Service]\nWorkingDirectory=${ROOT}\nExecStart=${process.execPath} --env-file-if-exists=.env dist/server/index.js\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`,
        );
        execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'inherit' });
        execFileSync('systemctl', ['--user', 'enable', '--now', 'habblaud.service'], { stdio: 'inherit' });
        console.log('✓ serviço habblaud.service ligado (systemctl --user status habblaud).');
      } else if (process.platform === 'darwin') {
        const plist = join(homedir(), 'Library', 'LaunchAgents', 'com.habblaud.membro.plist');
        writeFileSync(
          plist,
          `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>com.habblaud.membro</string>\n<key>WorkingDirectory</key><string>${ROOT}</string>\n<key>ProgramArguments</key><array><string>${process.execPath}</string><string>--env-file-if-exists=.env</string><string>dist/server/index.js</string></array>\n<key>RunAtLoad</key><true/><key>KeepAlive</key><true/>\n</dict></plist>\n`,
        );
        execFileSync('launchctl', ['load', '-w', plist], { stdio: 'inherit' });
        console.log(`✓ LaunchAgent criado (${plist}).`);
      }
    } catch (err) {
      console.log(`! não consegui registrar a subida automática: ${(err as Error).message}`);
    }
  }
  console.log('\nPróximos passos: npm run build (uma vez, ou depois de atualizar) e npm run membro.');
  console.log('Depois, entre na sede pelo navegador (ou celular), clique em Novo agente e use "Conectar conta" para o Claude e/ou o Codex.');
}

if (!process.env.VITEST) void main();
