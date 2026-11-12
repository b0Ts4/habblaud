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
  // ---- Sistema da empresa (gateway da sede): banco e web, com regras por pessoa e tenant ------------------------
  {
    name: 'sistema_tenants',
    description: 'Lista os tenants do sistema da empresa que você pode acessar e o que pode fazer em cada um (banco: leitura ou alteração com aprovação; web: ver ou interagir). / Tenants you can access.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'sistema_consultar',
    description:
      'Consulta o banco do sistema (Postgres) num tenant, só leitura: um SELECT por vez. O tenant é aplicado pelo gateway (RLS); você vê só os dados dele. / Read-only SQL query in one tenant.',
    inputSchema: {
      type: 'object',
      properties: { tenant: { type: 'string' }, sql: { type: 'string', description: 'Um SELECT (ou WITH ... SELECT).' } },
      required: ['tenant', 'sql'],
      additionalProperties: false,
    },
  },
  {
    name: 'sistema_alterar',
    description:
      'Pede para criar, atualizar ou apagar registros no banco do sistema num tenant. Não use SQL: diga a tabela, quais registros (onde) e os novos valores. Nada é gravado sem aprovação humana: o gateway ensaia a alteração e mostra a quem aprova, em português, o que muda em cada registro (ex.: "Pedido 3: status de aberto para pago"). Escreva a explicacao em português simples, para alguém que não entende de banco. / Ask for a DB change (structured, needs human approval).',
    inputSchema: {
      type: 'object',
      properties: {
        tenant: { type: 'string' },
        acao: { type: 'string', enum: ['criar', 'atualizar', 'apagar'] },
        tabela: { type: 'string', description: 'Nome da tabela (ex.: pedidos). Veja as colunas com sistema_consultar se precisar.' },
        onde: {
          type: 'array',
          description: 'Quais registros (obrigatório para atualizar e apagar). Todas as condições valem juntas.',
          items: {
            type: 'object',
            properties: {
              coluna: { type: 'string' },
              operador: { type: 'string', enum: ['=', '!=', '>', '>=', '<', '<=', 'contem', 'vazio', 'nao_vazio'] },
              valor: { type: ['string', 'number', 'boolean', 'null'] },
            },
            required: ['coluna'],
          },
        },
        valores: { type: 'object', description: 'Coluna -> novo valor (para criar e atualizar). A coluna do tenant é preenchida pelo gateway.', additionalProperties: { type: ['string', 'number', 'boolean', 'null'] } },
        explicacao: { type: 'string', description: 'Em português simples: o que muda e por quê (ex.: "Marcar o pedido 3 como pago: o cliente pagou por PIX, comprovante no chamado 123").' },
        esperar_segundos: { type: 'number', description: 'Quanto esperar a aprovação agora (0 a 600; padrão 0).' },
      },
      required: ['tenant', 'acao', 'tabela', 'explicacao'],
      additionalProperties: false,
    },
  },
  {
    name: 'sistema_ver_alteracao',
    description: 'Confere (e espera) a decisão de um pedido de alteração feito com sistema_alterar. / Check a change request.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, esperar_segundos: { type: 'number' } }, required: ['id'], additionalProperties: false },
  },
  {
    name: 'sistema_web_abrir',
    description: 'Abre uma página do sistema da empresa num navegador já logado no tenant (a pessoa acompanha a tela ao vivo na sede). Devolve a estrutura da página. / Open a page of the company system.',
    inputSchema: { type: 'object', properties: { tenant: { type: 'string' }, caminho: { type: 'string', description: 'Caminho no sistema (ex.: /pedidos). Vazio = página inicial.' } }, required: ['tenant'], additionalProperties: false },
  },
  {
    name: 'sistema_web_ler',
    description: 'Lê a página atual do navegador do sistema: título, endereço, botões, campos e texto. / Read the current page.',
    inputSchema: { type: 'object', properties: { tenant: { type: 'string' } }, required: ['tenant'], additionalProperties: false },
  },
  {
    name: 'sistema_web_clicar',
    description: 'Clica num botão, link ou texto da página do sistema (pelo nome visível ou um seletor CSS). / Click an element.',
    inputSchema: { type: 'object', properties: { tenant: { type: 'string' }, alvo: { type: 'string' } }, required: ['tenant', 'alvo'], additionalProperties: false },
  },
  {
    name: 'sistema_web_preencher',
    description: 'Preenche um campo da página do sistema (pelo rótulo, placeholder ou seletor CSS). / Fill a field.',
    inputSchema: { type: 'object', properties: { tenant: { type: 'string' }, campo: { type: 'string' }, valor: { type: 'string' } }, required: ['tenant', 'campo', 'valor'], additionalProperties: false },
  },
  {
    name: 'sistema_web_print',
    description: 'Tira um print da página atual do sistema. / Screenshot of the current page.',
    inputSchema: { type: 'object', properties: { tenant: { type: 'string' } }, required: ['tenant'], additionalProperties: false },
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
    default: {
      if (!name?.startsWith('sistema_')) throw new Error(`ferramenta desconhecida: ${name}`);
      const action = name === 'sistema_ver_alteracao' ? 'alteracao' : name.slice('sistema_'.length);
      const wait = Number(args.esperar_segundos) || 0;
      const r = await api('POST', '/api/office/gateway', { who: WHO, action, args }, (Math.min(600, wait) + 120) * 1000);
      if (r.error) throw new Error(r.error);
      if (r.image) return { content: [{ type: 'image', data: r.image, mimeType: 'image/jpeg' }, { type: 'text', text: r.text ?? '' }] };
      return r.text ?? '';
    }
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
            'Você está no escritório do time (Habblaud). Com as ferramentas escritorio_* você conversa com os agentes das outras pessoas e dos outros projetos; quando uma mensagem chegar marcada [Escritório] com um id, responda com escritorio_responder. Com as ferramentas sistema_* você acessa o sistema da empresa (banco e web) pelo gateway da sede, só nos tenants liberados (veja sistema_tenants); alterações no banco esperam aprovação humana.',
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
      try {
        const out = await call(params?.name, params?.arguments ?? {});
        return send({ jsonrpc: '2.0', id, result: typeof out === 'string' ? { content: [{ type: 'text', text: out }] } : out });
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
