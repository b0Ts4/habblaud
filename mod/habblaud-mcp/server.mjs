#!/usr/bin/env node
// MCP do escritório: dá a um agente (Claude Code ou Codex) ferramentas para conversar com os outros agentes do time,
// em qualquer computador ligado à mesma sede (ou, sem sede, com os deste computador). Fala MCP por stdio (JSON-RPC,
// uma mensagem por linha) e repassa tudo ao Habblaud deste computador (HABBLAUD_URL, padrão http://127.0.0.1:4747),
// que sabe quem é o agente pela chave HABBLAUD_AGENT_KEY (agentes abertos pelo Habblaud) ou pelo processo pai (uma
// sessão do Claude Code aberta à mão, com este MCP registrado: claude mcp add escritorio -- node <este arquivo>).
// Node puro, sem dependências.
import { createInterface } from 'node:readline';

const BASE = (process.env.HABBLAUD_URL || 'http://127.0.0.1:4747').replace(/\/+$/, '');
const WHO = { key: process.env.HABBLAUD_AGENT_KEY || undefined, ppid: process.ppid };
const VERSION = '1.0.0';

const TOOLS = [
  {
    name: 'escritorio_agentes',
    description:
      'Lista os agentes do escritório (do time inteiro, em todos os computadores): nome, pessoa dona, projeto, ferramenta e o que estão fazendo. Use antes de falar com alguém. / Lists the office agents.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'escritorio_perguntar',
    description:
      'Pergunta algo a outro agente (de qualquer pessoa do time) e espera a resposta. A mensagem entra na sessão dele; ele responde com escritorio_responder. Chame pelo nome ("Cecília"), por "Nome @ Pessoa" ou pelo id. Se a resposta demorar, devolve o id para você checar depois com escritorio_ver_resposta. / Ask another agent and wait for the answer.',
    inputSchema: {
      type: 'object',
      properties: {
        agente: { type: 'string', description: 'Nome, "Nome @ Pessoa" ou id do agente.' },
        mensagem: { type: 'string', description: 'A pergunta ou o pedido, com o contexto que o outro agente precisa (ele não vê a sua conversa).' },
        esperar_segundos: { type: 'number', description: 'Quanto esperar a resposta agora (padrão 120, máximo 600).' },
      },
      required: ['agente', 'mensagem'],
      additionalProperties: false,
    },
  },
  {
    name: 'escritorio_enviar',
    description: 'Manda um aviso a outro agente, sem esperar resposta (ex.: "terminei a API, pode integrar"). / Send a note without waiting for an answer.',
    inputSchema: {
      type: 'object',
      properties: { agente: { type: 'string' }, mensagem: { type: 'string' } },
      required: ['agente', 'mensagem'],
      additionalProperties: false,
    },
  },
  {
    name: 'escritorio_ver_resposta',
    description: 'Confere (e espera) a resposta de uma pergunta feita antes com escritorio_perguntar. / Check an earlier question.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, esperar_segundos: { type: 'number' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'escritorio_responder',
    description:
      'Responde uma mensagem que outro agente mandou para você pelo escritório (a mensagem traz o id). Responda completo: quem perguntou só vê esta resposta. / Answer a question another agent sent you.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string' }, resposta: { type: 'string' } },
      required: ['id', 'resposta'],
      additionalProperties: false,
    },
  },
  {
    name: 'escritorio_pendentes',
    description: 'Lista as perguntas que outros agentes fizeram a você e ainda esperam resposta (com o id de cada uma). / Questions waiting for your answer.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

async function api(method, path, body, timeoutMs = 30_000) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new Error(`sem conexão com o Habblaud em ${BASE} (${err?.message ?? err}). O Habblaud está rodando neste computador?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok && !(data && data.id)) throw new Error(data?.error || `o Habblaud respondeu ${res.status}`);
  return data;
}

const whoQuery = () => new URLSearchParams({ ...(WHO.key ? { key: WHO.key } : {}), ppid: String(WHO.ppid) }).toString();
const clampWait = (v, d) => Math.max(0, Math.min(600, Number.isFinite(v) ? v : d));

function describeAsk(a) {
  if (a.status === 'answered' && a.reply !== undefined) return `Resposta de ${a.to}:\n${a.reply}`;
  if (a.status === 'answered') return `Aviso entregue a ${a.to}.`;
  if (a.status === 'failed') return `Não deu para entregar a ${a.to}: ${a.error ?? 'erro desconhecido'}`;
  return `${a.to} ainda não respondeu (id: ${a.id}). Continue o seu trabalho e confira depois com escritorio_ver_resposta.`;
}

async function call(name, args) {
  switch (name) {
    case 'escritorio_agentes': {
      const { agents } = await api('GET', '/api/office/agents');
      if (!agents?.length) return 'Ninguém no escritório agora.';
      return agents
        .map((a) => `- ${a.name}${a.owner ? ` @ ${a.owner}` : ''} [${a.provider ?? 'claude'}, ${a.status ?? '?'}]${a.room ? ` · projeto ${a.room}` : ''}${a.title ? ` · ${a.title}` : ''} (id: ${a.id})`)
        .join('\n');
    }
    case 'escritorio_perguntar':
    case 'escritorio_enviar': {
      const reply = name === 'escritorio_perguntar';
      const a = await api('POST', '/api/office/ask', { who: WHO, to: String(args.agente ?? ''), text: String(args.mensagem ?? ''), reply });
      if (!reply || a.status !== 'delivered') return describeAsk(a);
      const s = clampWait(args.esperar_segundos, 120);
      const r = await api('GET', `/api/office/ask/${encodeURIComponent(a.id)}?${whoQuery()}&wait=${s}`, undefined, (s + 30) * 1000);
      return describeAsk(r);
    }
    case 'escritorio_ver_resposta': {
      const s = clampWait(args.esperar_segundos, 30);
      const r = await api('GET', `/api/office/ask/${encodeURIComponent(String(args.id ?? ''))}?${whoQuery()}&wait=${s}`, undefined, (s + 30) * 1000);
      return describeAsk(r);
    }
    case 'escritorio_responder': {
      await api('POST', '/api/office/reply', { who: WHO, id: String(args.id ?? ''), text: String(args.resposta ?? '') });
      return 'Resposta entregue.';
    }
    case 'escritorio_pendentes': {
      const { asks } = await api('GET', `/api/office/inbox?${whoQuery()}`);
      if (!asks?.length) return 'Nenhuma pergunta esperando a sua resposta.';
      return asks.map((a) => `- id ${a.id}, de ${a.from}: ${a.text}`).join('\n');
    }
    default:
      throw new Error(`ferramenta desconhecida: ${name}`);
  }
}

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined || id === null) return; // notificação (ex.: notifications/initialized)
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'habblaud-escritorio', version: VERSION },
          instructions:
            'Você está no escritório do time (Habblaud). Com estas ferramentas você conversa com os agentes das outras pessoas e dos outros projetos. Quando uma mensagem chegar marcada [Escritório] com um id, responda com escritorio_responder.',
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const text = await call(params?.name, params?.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
      } catch (err) {
        return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: String(err?.message ?? err) }], isError: true } });
      }
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `método desconhecido: ${method}` } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err?.message ?? err) } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON inválido' } });
  }
  void handle(msg);
});
rl.on('close', () => process.exit(0));
