# Gateway do sistema: agentes no banco e na web, com regras

O gateway roda **na sede** e é o único caminho dos agentes até o sistema da empresa. Os agentes nunca recebem a senha
do banco nem o login do sistema: pedem ao gateway pelas ferramentas `sistema_*` do MCP do escritório, e ele confere a
regra da pessoa no tenant, aplica o tenant, executa e registra tudo.

```
agente (PC da pessoa) ──MCP──▶ Habblaud local ──▶ sede ──▶ gateway ──┬──▶ Postgres (SET LOCAL app.tenant_id + RLS)
                                                                     └──▶ navegador (Playwright, já logado no tenant)
                                         pessoas ◀── /aprovacoes e /tela (web e celular)
```

## Ferramentas dos agentes

| Ferramenta | O que faz |
| --- | --- |
| `sistema_tenants` | lista os tenants liberados para a pessoa e o que pode em cada um |
| `sistema_consultar` | um `SELECT` num tenant, só leitura |
| `sistema_alterar` | pede para **criar, atualizar ou apagar** registros (apagar só se ligado), **sem SQL**: tabela, quais registros (`onde`), novos valores (`valores`) e uma `explicacao` em português simples. O gateway monta o SQL com parâmetros, **ensaia** (roda e desfaz) e **nada é gravado** até uma pessoa aprovar |
| `sistema_ver_alteracao` | confere e espera a decisão de um pedido |
| `sistema_web_abrir` / `ler` / `clicar` / `preencher` / `print` | usa o sistema pela interface web, num navegador já logado no tenant |

## Regras

Em `gateway.json` (exemplo completo em [`deploy/gateway.example.json`](../deploy/gateway.example.json)):

```json
"rules": [
  { "members": ["*"],     "tenants": ["*"],    "db": "read",  "web": "view" },
  { "members": ["bruno"], "tenants": ["acme"], "db": "write", "web": "interact" }
]
```

- `db`: `none`, `read` (consultas) ou `write` (consultas e alterações com aprovação).
- `web`: `none`, `view` (abrir, ler e print) ou `interact` (também clicar e preencher).
- Vale a regra mais permissiva entre as que casam com a pessoa e o tenant. Sem regra, nada.
- `approvers`: `owner` (padrão: o dono do agente aprova as alterações dele; administradores aprovam todas) ou `admins`.

## Navegador livre (sites externos)

Além do sistema da empresa, os agentes usam **qualquer site público** pelas ferramentas `navegador_abrir`, `ler`,
`clicar`, `preencher` e `print`: um navegador da sede **sem login nenhum** (separado do navegador do sistema, para os
logins das pessoas nunca irem para outros sites), que aparece na **Tela dos agentes** como "site externo".

- **Nunca a rede interna:** endereços de rede local, da própria VPS (`127.0.0.1`, `10.x`, `192.168.x`, `172.16-31.x`),
  de metadados da nuvem (`169.254.169.254`) e nomes `localhost`/`.local` são recusados, inclusive quando um site tenta
  carregar algo de lá.
- Ligado para todos por padrão; `"externo": false` (ou `"view"`) no `gateway.json` desliga (ou só deixa ver), e uma
  regra com `"externo": "interact"` libera para pessoas específicas.
- Sede que sai para a internet por um proxy: `HABBLAUD_GATEWAY_PROXY=http://proxy:porta` (aí quem resolve os nomes é o
  proxy). Um `gateway.json` com só `{}` já liga o navegador livre, sem banco nem sistema.
- Sozinhos, no computador da pessoa, os agentes também navegam como sempre (pelas ferramentas do próprio Claude Code ou
  Codex); o navegador livre da sede é o que dá a tela ao vivo e o registro na auditoria.

## Verificar o RLS do banco

Rode na pasta do Habblaud da sede (ou em qualquer computador com o Habblaud instalado), com um usuário que enxergue o
catálogo, como o dono do banco (só lê; nada é alterado e a senha não é guardada):

```bash
npm run gateway:verificar-rls -- "postgres://usuario:senha@host:5432/banco"
```

O relatório mostra, em português: cada tabela com a coluna `tenant_id` (outra: `--coluna empresa_id`) e se o RLS está
ligado nela; as políticas e a condição de cada uma; **a variável de sessão que elas leem**, já no formato do
`gateway.json` (`"tenantSetting": "app.tenant_id"`); tabelas com `tenant_id` e **RLS desligado** (os agentes veriam
todos os tenants nelas); e os usuários que passam por cima do RLS (superusuário ou `BYPASSRLS`), que o gateway não deve
usar. Sem o Habblaud, o mesmo no psql ou no DBeaver/pgAdmin:

```sql
-- tabelas com tenant_id e se o RLS está ligado (relrowsecurity) e forçado (relforcerowsecurity)
SELECT n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind IN ('r','p') AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'tenant_id');
-- as políticas (a condição está em qual / with_check: procure current_setting('...'))
SELECT schemaname, tablename, policyname, cmd, roles, qual, with_check FROM pg_policies;
-- quem passa por cima do RLS
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolsuper OR rolbypassrls;
```

## Banco: como preparar o Postgres

O gateway aplica o tenant com `SET LOCAL <tenantSetting> = '<tenant>'` (padrão `app.tenant_id`) em cada transação, e as
políticas de RLS de vocês leem essa variável. Crie usuários só para os agentes:

```sql
-- leitura
CREATE ROLE agente_leitura LOGIN PASSWORD '...' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO agente_leitura;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO agente_leitura;
-- escrita (opcional; só depois de aprovação humana)
CREATE ROLE agente_escrita LOGIN PASSWORD '...' NOBYPASSRLS;
GRANT USAGE ON SCHEMA public TO agente_escrita;
GRANT SELECT, INSERT, UPDATE ON <tabelas que podem mudar> TO agente_escrita;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO agente_escrita;
-- defesa extra: ninguém troca o tenant por dentro de uma consulta
REVOKE EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pg_catalog.set_config(text, text, boolean) TO <usuários da aplicação que precisam>;
```

- Os usuários dos agentes **não** podem ser donos das tabelas, superusuário nem ter `BYPASSRLS` (o RLS não vale para
  eles). Se a aplicação é dona das tabelas, use `ALTER TABLE ... FORCE ROW LEVEL SECURITY`.
- **Tenant UUID e subdomínio** (ex.: as políticas leem `app.current_tenant` como UUID, e o sistema web usa um
  subdomínio por cliente): use `"tenantSetting": "app.current_tenant"` e `"tenantQuery": "select id from <tabela> where
  <coluna do subdomínio> = $1"`. Os agentes falam o subdomínio (o mesmo do sistema web) e o gateway traduz para o UUID
  (com cache de 10 min); um UUID também é aceito direto. Subdomínio que a consulta não acha é recusado.
- Confira a política: `\d+ pedidos` no psql mostra o `USING (tenant_id = current_setting('app.tenant_id'))`. Se a de
  vocês usar outro nome de variável, ponha em `db.tenantSetting`.

O que o gateway garante, além do RLS:

- **Um comando por vez** (protocolo estendido do Postgres: `select 1; update ...` é recusado pelo próprio banco).
- **Consultas em transação `READ ONLY`**, desfeitas no fim, com limite de linhas (`maxRows`) e de tempo (`timeoutMs`).
- **SQL com `set_config`, `COPY`, `pg_read_file`, `dblink`** é recusado antes de chegar ao banco.
- **Alterações** só `INSERT`/`UPDATE` (`DELETE` com `allowDelete: true`), nunca DDL; ensaio antes, aprovação humana,
  limite de linhas (`maxWriteRows`, desfaz tudo se passar).
- **Auditoria** de tudo (quem, qual agente, tenant, SQL, linhas, quem aprovou) em `gateway-audit.jsonl`, ao lado da
  configuração da sede.

## Web: o sistema pela interface, com a tela ao vivo

O gateway abre um Chromium **na sede**, um por agente e tenant, e entra no sistema **com o usuário da pessoa dona do
agente**: o que a pessoa não pode fazer no sistema, os agentes dela também não podem (as permissões do próprio sistema
continuam valendo). A navegação fica presa aos hosts do sistema (`allowedHosts`): links e recursos de fora são
bloqueados.

**Meu login no sistema** (`/meu-login`, ou o botão de cadeado na barra do escritório): cada pessoa cadastra o próprio
usuário e senha do sistema, para todos os clientes (`*`) ou um por cliente, e testa na hora. A senha fica cifrada na
sede (AES-256-GCM, em `gateway-credenciais.json`, com a chave em `gateway-key`), nunca volta para a página e nenhum
agente a vê. Sem login cadastrado, o agente recebe o aviso para a pessoa cadastrar. Se a sessão do sistema expira, o
navegador entra de novo sozinho.

Sistema com **um subdomínio por cliente** (como `<cliente>.suaempresa.com.br`):

```json
"tenants": "*",
"web": {
  "baseUrl": "https://app.suaempresa.com.br",
  "tenantUrl": "https://{tenant}.suaempresa.com.br",
  "allowedHosts": ["*.suaempresa.com.br"],
  "login": { "path": "/login", "fields": { "#email": "{user}", "#senha": "{password}" }, "submit": "button[type=submit]" }
}
```

Com `"tenants": "*"`, o tenant é o próprio subdomínio (só letras, números e hífen), sem precisar listar os clientes; as
regras continuam decidindo quem acessa o quê. `web.credentials` (um login comum, com `passwordEnv`) só serve de reserva
para quem não cadastrou o próprio.

Na VPS da sede, uma vez:

```bash
npm install playwright-core
npx playwright install --with-deps chromium
```

**Tela dos agentes** (`/tela`, ou o botão na barra do escritório): a tela de cada navegador de agente, ao vivo, com o que
ele acabou de fazer. Cada pessoa vê os navegadores dos próprios agentes (de todos, se a política `terminal` da sede for
`all`).

## Aprovações (em português, sem SQL)

Quando um agente pede uma alteração, o dono dele recebe um aviso no escritório, e o pedido aparece em **Aprovações**
(`/aprovacoes`, ou o botão na barra), também pelo celular, escrito para quem não entende de banco:

> **Giovana (agente de Ana Souza)** · ACME Ltda
> O agente explicou: “O João pagou o pedido 1 por PIX com o frete incluído (R$ 120). Comprovante no chamado 123.”
> **Vai alterar 1 pedido em Pedidos (ACME Ltda):**
> - Pedido 1: Situação de “aberto” para “pago”; Valor (R$) de “100.00” para “120.00”

- O "o que vai mudar" sai do **ensaio com os dados reais** (antes e depois de cada registro), não do que o agente
  disse: se a explicação e a alteração não batem, quem aprova vê.
- O SQL fica escondido em **Detalhes técnicos**, para quem quiser conferir.
- **Aprovar e gravar** roda de novo e só grava se mexer no mesmo número de registros do ensaio (se os dados mudaram no
  meio, nada é gravado e o agente é avisado); **Recusar** (com nota) avisa o agente que nada foi gravado.
- O gateway não altera nem apaga a tabela inteira (o filtro `onde` é obrigatório), preenche sozinho a coluna do tenant
  ao criar (`tenantColumn`, padrão `tenant_id`) e não deixa trocá-la.

### Nomes amigáveis

Para o texto falar a língua do time, dê nomes às tabelas e colunas em `db.labels` (sem eles, usa os nomes do banco):

```json
"labels": {
  "pedidos":  { "nome": "Pedidos", "singular": "pedido", "registro": "Pedido {id}", "colunas": { "status": "Situação", "valor": "Valor (R$)" } },
  "clientes": { "nome": "Clientes", "singular": "cliente", "registro": "{nome}", "colunas": { "email": "E-mail" } }
}
```
