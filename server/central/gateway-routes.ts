// O gateway do sistema dentro da sede (server/gateway/): a rota que o Habblaud de cada computador usa para as
// ferramentas sistema_* dos agentes, e as duas páginas para as pessoas, também boas no celular:
//  - /aprovacoes: alterações no banco esperando aprovação (aprovar ou recusar, com nota);
//  - /tela: a tela ao vivo dos navegadores dos agentes mexendo no sistema.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tr } from '../../shared/i18n';
import type { Approval, GatewayService } from '../gateway/service';
import type { WebSession } from '../gateway/web';
import { allowed, type CentralConfig, type Member } from './config';
import { globalId } from './merge';
import type { Members } from './members';

export interface GatewayRoutesDeps {
  gateway?: GatewayService;
  config: () => CentralConfig;
  members: Members;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: <T>(req: IncomingMessage) => Promise<T>;
}

/** Rota do computador do membro: POST /central/uplink/gateway {from, action, args}. */
export function handleGatewayUplink(deps: GatewayRoutesDeps, m: Member, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  if (url.pathname !== '/central/uplink/gateway' || req.method !== 'POST') return false;
  deps
    .readJson<{ from?: unknown; action?: unknown; args?: unknown }>(req)
    .then(async (b) => {
      if (!deps.gateway) return deps.sendJson(res, 404, { error: tr('a sede não tem o gateway do sistema configurado (gateway.json)') });
      const st = deps.members.state(m.id);
      const agent = typeof b.from === 'string' ? st?.snapshot.agents.find((a) => a.id === b.from) : undefined;
      if (!agent) return deps.sendJson(res, 404, { error: tr('agente de origem desconhecido na sede') });
      const r = await deps.gateway.run({ member: m.id, memberName: m.name, agentId: globalId(m.id, agent.id), agentName: agent.name }, String(b.action ?? ''), (b.args ?? {}) as Record<string, unknown>);
      deps.sendJson(res, 200, r);
    })
    .catch(() => deps.sendJson(res, 400, { error: tr('requisição inválida') }));
  return true;
}

function approvalView(a: Approval, canDecide: boolean) {
  return {
    id: a.id,
    member: a.caller.memberName,
    agent: a.caller.agentName,
    tenant: a.tenantName,
    reason: a.reason,
    title: a.summary.title,
    lines: a.summary.lines,
    sql: a.sql,
    params: a.params,
    status: a.status,
    decidedBy: a.decidedBy,
    note: a.note,
    result: a.result,
    createdAt: a.createdAt,
    canDecide: canDecide && a.status === 'pending',
  };
}

/** Navegadores que a pessoa pode ver: os dos próprios agentes, ou de todos se a política do terminal deixar. */
function visible(deps: GatewayRoutesDeps, who: Member, s: WebSession): boolean {
  return allowed(deps.config(), who, s.member, 'terminal');
}

/** Rotas da página logada; true = respondeu. */
export function handleGatewayPages(deps: GatewayRoutesDeps, who: Member, req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const path = url.pathname;
  const g = deps.gateway;
  if (path === '/aprovacoes' || path === '/tela') {
    req.resume();
    const html = path === '/tela' ? SCREEN_PAGE : APPROVALS_PAGE;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY' });
    res.end(html);
    return true;
  }
  if (path === '/api/central/approvals' && req.method === 'GET') {
    deps.sendJson(res, 200, { enabled: !!g, approvals: g ? g.list(who).map((a) => approvalView(a, g.canDecide(a, who))) : [] });
    return true;
  }
  const dec = /^\/api\/central\/approvals\/([\w-]{1,40})$/.exec(path);
  if (dec && req.method === 'POST') {
    deps
      .readJson<{ approve?: unknown; note?: unknown }>(req)
      .then(async (b) => {
        if (!g) return deps.sendJson(res, 404, { error: tr('gateway desligado') });
        const r = await g.decide(dec[1], who, b.approve === true, typeof b.note === 'string' ? b.note : undefined);
        deps.sendJson(res, 'error' in r ? 409 : 200, 'error' in r ? r : approvalView(r, false));
      })
      .catch(() => deps.sendJson(res, 400, { error: tr('requisição inválida') }));
    return true;
  }
  if (path === '/api/central/screens' && req.method === 'GET') {
    // SSE: cada print novo dos navegadores que a pessoa pode ver.
    req.socket.setTimeout(0);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    const frame = (s: WebSession) =>
      `event: screen\ndata: ${JSON.stringify({ id: s.id, agent: s.agentName, member: s.memberName, tenant: s.tenant, url: s.url, title: s.title, action: s.lastAction, at: s.shotAt, img: s.shot?.toString('base64') })}\n\n`;
    res.write('retry: 2000\n\n');
    for (const s of g?.web?.list() ?? []) if (s.shot && visible(deps, who, s)) res.write(frame(s));
    const off = g?.web?.onShot((s) => {
      if (visible(deps, who, s)) res.write(frame(s));
    });
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    req.on('close', () => {
      off?.();
      clearInterval(ping);
    });
    return true;
  }
  return false;
}

const STYLE = `
:root{color-scheme:dark;--bg:#0f1218;--card:#171b24;--line:#2a3140;--fg:#e6e9ef;--dim:#9aa3b5;--ok:#3fb97a;--no:#e5534b;--acc:#5aa9ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{position:sticky;top:0;display:flex;gap:12px;align-items:center;padding:12px 16px;background:#0b0e13;border-bottom:1px solid var(--line);z-index:2}
header a{color:var(--acc);text-decoration:none}h1{font-size:17px;margin:0;flex:1}
main{padding:16px;max-width:1100px;margin:0 auto;display:grid;gap:14px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;display:grid;gap:8px;min-width:0}
.meta{color:var(--dim);font-size:13px}pre{margin:0;white-space:pre-wrap;word-break:break-word;background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:10px;font:13px/1.4 ui-monospace,Menlo,Consolas,monospace}
.row{display:flex;gap:8px;flex-wrap:wrap}button{font:inherit;border:0;border-radius:8px;padding:9px 16px;cursor:pointer;color:#fff}
.ok{background:var(--ok)}.no{background:var(--no)}input{flex:1;min-width:160px;font:inherit;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:#0b0e13;color:var(--fg)}
.tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;background:#253048}.empty{color:var(--dim);text-align:center;padding:40px 0}
img{width:100%;border-radius:8px;border:1px solid var(--line);background:#fff}
.why{margin:0;font-size:15px}.what{background:#0b0e13;border:1px solid var(--line);border-radius:8px;padding:10px 12px}.what ul{margin:6px 0 0;padding-left:20px}.what li{margin:3px 0}
details summary{cursor:pointer}
.grid{display:grid;gap:14px;grid-template-columns:repeat(auto-fill,minmax(min(100%,460px),1fr))}`;

const APPROVALS_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aprovações · Habblaud</title><style>${STYLE}</style></head>
<body><header><a href="/">← Escritório</a><h1>Alterações no sistema</h1><a href="/tela">Tela dos agentes</a></header><main id="list"><p class="empty">Carregando…</p></main>
<script>
const list=document.getElementById('list');
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!==undefined)e.textContent=txt;return e};
const label={pending:'esperando',approved:'aprovado',done:'gravado',denied:'recusado',failed:'falhou'};
async function load(){
  const r=await fetch('/api/central/approvals',{cache:'no-store'});if(r.status===401){location.href='/login';return}
  const d=await r.json();list.replaceChildren();
  if(!d.enabled){list.append(el('p','empty','O gateway do sistema não está configurado nesta sede.'));return}
  if(!d.approvals.length){list.append(el('p','empty','Nenhum pedido de alteração.'));return}
  for(const a of d.approvals){
    const c=el('section','card');
    const h=el('div','row');h.append(el('strong','',a.agent+' (agente de '+a.member+')'),el('span','tag',a.tenant),el('span','tag',label[a.status]||a.status));
    const why=el('p','why');why.append(el('span','meta','O agente explicou: '),el('span','','“'+a.reason+'”'));
    const what=el('div','what');what.append(el('strong','',a.title+':'));const ul=el('ul');for(const l of a.lines)ul.append(el('li','',l));what.append(ul);
    const det=el('details');det.append(el('summary','meta','Detalhes técnicos'),el('pre','',a.sql+'\\n'+JSON.stringify(a.params)));
    c.append(h,el('div','meta',new Date(a.createdAt).toLocaleString()),why,what,det);
    if(a.result)c.append(el('pre','',a.result));
    if(a.decidedBy)c.append(el('div','meta','Decidido por '+a.decidedBy+(a.note?': '+a.note:'')));
    if(a.canDecide){
      const note=el('input');note.placeholder='Nota (opcional)';
      const row=el('div','row');const ok=el('button','ok','Aprovar e gravar');const no=el('button','no','Recusar');
      const go=async(approve)=>{ok.disabled=no.disabled=true;const r=await fetch('/api/central/approvals/'+encodeURIComponent(a.id),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({approve,note:note.value})});if(!r.ok)alert((await r.json()).error||'erro');load()};
      ok.onclick=()=>go(true);no.onclick=()=>go(false);row.append(note,ok,no);c.append(row);
    }
    list.append(c);
  }
}
load();setInterval(load,5000);
</script></body></html>`;

const SCREEN_PAGE = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Tela dos agentes · Habblaud</title><style>${STYLE}</style></head>
<body><header><a href="/">← Escritório</a><h1>Tela dos agentes no sistema</h1><a href="/aprovacoes">Aprovações</a></header><main><div class="grid" id="grid"><p class="empty" id="empty">Nenhum agente mexendo no sistema pela web agora.</p></div></main>
<script>
const grid=document.getElementById('grid'),empty=document.getElementById('empty'),cards=new Map();
const el=(t,c,txt)=>{const e=document.createElement(t);if(c)e.className=c;if(txt!==undefined)e.textContent=txt;return e};
const es=new EventSource('/api/central/screens');
es.addEventListener('screen',(ev)=>{
  const s=JSON.parse(ev.data);let c=cards.get(s.id);
  if(!c){c={root:el('section','card'),head:el('div','row'),meta:el('div','meta'),img:el('img')};c.img.alt='Tela do navegador do agente';c.root.append(c.head,c.meta,c.img);grid.prepend(c.root);cards.set(s.id,c)}
  empty.hidden=true;
  c.head.replaceChildren(el('strong','',s.agent+' ('+s.member+')'),el('span','tag','tenant '+s.tenant),el('span','tag',s.action));
  c.meta.textContent=(s.title?s.title+' — ':'')+s.url+' · '+new Date(s.at).toLocaleTimeString();
  if(s.img)c.img.src='data:image/jpeg;base64,'+s.img;
});
es.onerror=()=>{};
</script></body></html>`;
