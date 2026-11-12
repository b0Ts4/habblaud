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

O gateway abre um Chromium **na sede**, um por agente e tenant, e entra no sistema **com o usuário da pessoa dona do
agente**: o que a pessoa não pode fazer no sistema, os agentes dela também não podem (as permissões do próprio sistema
continuam valendo). A navegação fica presa aos hosts do sistema (`allowedHosts`): links e recursos de fora são
bloqueados.

**Meu login no sistema** (`/meu-login`, ou o botão de cadeado na barra do escritório): cada pessoa cadastra o próprio
usuário e senha do sistema, para todos os clientes (`*`) ou um por cliente, e testa na hora. A senha fica cifrada na
sede (AES-256-GCM, em `gateway-credenciais.json`, com a chave em `gateway-key`), nunca volta para a página e nenhum
agente a vê. Sem login cadastrado, o agente recebe o aviso para a pessoa cadastrar. Se a sessão do sistema expira, o
navegador entra de novo sozinho.

Sistema com **um subdomínio por cliente** (como `<cliente>.freeluxenergia.com.br`):

```json
"tenants": "*",
"web": {
  "baseUrl": "https://app.freeluxenergia.com.br",
  "tenantUrl": "https://{tenant}.freeluxenergia.com.br",
  "allowedHosts": ["*.freeluxenergia.com.br"],
  "login": { "path": "/seguranca/login", "fields": { "#email": "{user}", "#senha": "{password}" }, "submit": "#submeter" }
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
