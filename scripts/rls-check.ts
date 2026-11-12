// Relatório da separação por tenant (RLS) de um banco Postgres, em português, só lendo o catálogo (nada é alterado):
//   npm run gateway:verificar-rls -- "postgres://usuario:senha@host:5432/banco" [--coluna tenant_id]
// Mostra: as tabelas que têm a coluna do tenant e se o RLS está ligado nelas (e forçado), as políticas de cada uma com
// a variável de sessão que elas leem (o `tenantSetting` do gateway.json), tabelas com RLS ligado e nenhuma política, e
// os usuários que passam por cima do RLS (superusuário ou BYPASSRLS). Use um usuário que enxergue o catálogo (o dono do
// banco, por exemplo); a senha não é guardada.
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const url = args.find((a) => /^postgres(ql)?:\/\//.test(a));
const ci = args.indexOf('--coluna');
const column = ci >= 0 ? args[ci + 1] : 'tenant_id';

interface Row {
  [k: string]: unknown;
}

/** Variáveis de sessão lidas pelas políticas: current_setting('app.tenant_id'[, true]). */
export function settingsIn(expr: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of (expr ?? '').matchAll(/current_setting\(\s*'([^']+)'/gi)) out.add(m[1]);
  return [...out];
}

async function main(): Promise<void> {
  if (!url) {
    console.error('use: npm run gateway:verificar-rls -- "postgres://usuario:senha@host:5432/banco" [--coluna tenant_id]');
    process.exit(1);
  }
  const req = createRequire(import.meta.url);
  const { Client } = req('pg') as { Client: new (o: { connectionString: string }) => { connect(): Promise<void>; query(q: string, v?: unknown[]): Promise<{ rows: Row[] }>; end(): Promise<void> } };
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const me = (await c.query('select current_user, current_database(), version()')).rows[0];
    console.log(`Banco ${me.current_database} (usuário ${me.current_user})\n${String(me.version).split(',')[0]}\n`);

    const tables = (
      await c.query(
        `select n.nspname as schema, c.relname as tabela, c.relrowsecurity as rls, c.relforcerowsecurity as forcado, pg_get_userbyid(c.relowner) as dono
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where c.relkind in ('r','p') and n.nspname not in ('pg_catalog','information_schema') and n.nspname not like 'pg_toast%'
           and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = $1 and not a.attisdropped)
         order by 1, 2`,
        [column],
      )
    ).rows;
    const policies = (await c.query(`select schemaname as schema, tablename as tabela, policyname as nome, cmd, roles, qual, with_check from pg_policies order by 1, 2, 3`)).rows;
    const byTable = new Map<string, Row[]>();
    for (const p of policies) byTable.set(`${p.schema}.${p.tabela}`, [...(byTable.get(`${p.schema}.${p.tabela}`) ?? []), p]);

    const settings = new Map<string, number>();
    const semRls: string[] = [];
    const semPolitica: string[] = [];
    const naoForcado: string[] = [];
    console.log(`Tabelas com a coluna "${column}": ${tables.length}\n`);
    for (const t of tables) {
      const key = `${t.schema}.${t.tabela}`;
      const pols = byTable.get(key) ?? [];
      const mark = !t.rls ? '✗ RLS DESLIGADO' : pols.length ? '✓ RLS ligado' : '! RLS ligado, mas SEM política (ninguém além do dono vê nada)';
      console.log(`${mark}  ${key}  (dono: ${t.dono}${t.forcado ? ', forçado também para o dono' : ''})`);
      if (!t.rls) semRls.push(key);
      else if (!pols.length) semPolitica.push(key);
      if (t.rls && !t.forcado) naoForcado.push(`${key} (dono ${t.dono})`);
      for (const p of pols) {
        const s = [...settingsIn(p.qual as string), ...settingsIn(p.with_check as string)];
        for (const x of s) settings.set(x, (settings.get(x) ?? 0) + 1);
        console.log(`    política "${p.nome}" [${p.cmd}] para ${String(p.roles)}`);
        if (p.qual) console.log(`      vê/altera quando: ${p.qual}`);
        if (p.with_check) console.log(`      grava quando:     ${p.with_check}`);
      }
    }

    const bypass = (await c.query(`select rolname, rolsuper, rolbypassrls from pg_roles where (rolsuper or rolbypassrls) and rolname not like 'pg\\_%' order by 1`)).rows;

    console.log('\n===== Resumo =====');
    if (settings.size) {
      const best = [...settings.entries()].sort((a, b) => b[1] - a[1]);
      console.log(`Variável de sessão que as políticas leem: ${best.map(([k, n]) => `${k} (${n} política(s))`).join(', ')}`);
      console.log(`→ no gateway.json use: "tenantSetting": "${best[0][0]}"`);
    } else console.log('Nenhuma política lê current_setting(...): o RLS de vocês não usa variável de sessão (o gateway precisa de outro jeito; me mostre as políticas).');
    if (semRls.length) console.log(`✗ Tabelas com "${column}" e RLS DESLIGADO (os agentes veriam todos os tenants): ${semRls.join(', ')}`);
    if (semPolitica.length) console.log(`! RLS ligado sem política: ${semPolitica.join(', ')}`);
    if (naoForcado.length) console.log(`i RLS não forçado para o dono (só importa se o gateway usar o usuário dono): ${naoForcado.join(', ')}`);
    console.log(
      bypass.length
        ? `! Usuários que passam por cima do RLS (NÃO use nenhum deles no gateway): ${bypass.map((r) => `${r.rolname}${r.rolsuper ? ' (superusuário)' : ''}${r.rolbypassrls ? ' (BYPASSRLS)' : ''}`).join(', ')}`
        : '✓ Nenhum usuário além do sistema passa por cima do RLS.',
    );
    const fn = (await c.query(`select has_function_privilege('public', 'pg_catalog.set_config(text,text,boolean)', 'execute') as publico`)).rows[0];
    console.log(fn.publico ? 'i set_config ainda pode ser executada por todos (o gateway já recusa; a defesa extra é revogar: veja docs/gateway.md).' : '✓ set_config revogada de PUBLIC.');
  } finally {
    await c.end();
  }
}

if (!process.env.VITEST) main().catch((err: Error) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
