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
| `sistema_alterar` | pede um `INSERT`/`UPDATE` (e `DELETE`, se ligado): o gateway **ensaia** (roda e desfaz, para contar as linhas), e **nada é gravado** até uma pessoa aprovar |
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

O gateway abre um Chromium **na sede**, um por agente e tenant, já logado com a credencial do tenant (`web.credentials`;
use `passwordEnv` para a senha ficar numa variável de ambiente, não no arquivo). A navegação fica presa aos hosts do
sistema (`allowedHosts`, padrão: o host de `baseUrl`): links e recursos de fora são bloqueados.

Na VPS da sede, uma vez:

```bash
npm install playwright-core
npx playwright install --with-deps chromium
```

**Tela dos agentes** (`/tela`, ou o botão na barra do escritório): a tela de cada navegador de agente, ao vivo, com o que
ele acabou de fazer. Cada pessoa vê os navegadores dos próprios agentes (de todos, se a política `terminal` da sede for
`all`).

## Aprovações

Quando um agente pede uma alteração, o dono dele recebe um aviso no escritório, e o pedido aparece em **Aprovações**
(`/aprovacoes`, ou o botão na barra), também pelo celular: o agente, a pessoa, o tenant, o motivo, o SQL exato e o
ensaio ("mexeria em 3 linhas", com as linhas quando o SQL tem `RETURNING`). **Aprovar e gravar** roda de verdade e o
agente recebe o resultado; **Recusar** (com nota) avisa o agente que nada foi gravado.
