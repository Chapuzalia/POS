import { readFileSync, readdirSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

export const exportSql = readFileSync(new URL('../../supabase/migrations/20261113151204_tenant_data_export.sql', import.meta.url), 'utf8')
// Real column names/types from the baseline and subsequent migrations. Other
// business triggers are outside this read-only API's focused integration fixture.
export function exportSourceTables() {
  const root = new URL('../../supabase/', import.meta.url)
  const sources = [readFileSync(new URL('0.Complete_Database_24-07-26.sql', root), 'utf8'),
    ...readdirSync(new URL('migrations/', root)).filter(name => name.endsWith('.sql') && !name.endsWith('_tenant_data_export.sql')).sort().map(name => readFileSync(new URL(`migrations/${name}`, root), 'utf8'))]
  const tables = new Map()
  const type = '(uuid(?:\\[\\])?|text(?:\\[\\])?|timestamp(?: with(?:out)? time zone)?|timestamptz|time(?: without time zone)?|numeric(?:\\([\\d, ]+\\))?|bigint|smallint(?:\\[\\])?|integer|boolean|jsonb|date|double precision)'
  for (const source of sources) {
    for (const [, name, body] of source.matchAll(/create table (?:if not exists )?public\.(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
      if (tables.has(name)) continue
      const columns = new Map()
      for (const [, column, sqlType] of body.matchAll(new RegExp(`(?:^|,)\\s*(\\w+)\\s+${type}(?=\\s|,|$)`, 'gmi'))) columns.set(column, sqlType)
      tables.set(name, columns)
    }
    for (const [, name, body] of source.matchAll(/alter table\s+(?:only\s+)?(?:if exists\s+)?public\.(\w+)\s+([^;]+);/gi)) {
      const columns = tables.get(name)
      if (!columns) continue
      for (const [, column, sqlType] of body.matchAll(new RegExp(`add\\s+(?:column\\s+)?(?:if not exists\\s+)?(\\w+)\\s+${type}(?=\\s|,|$)`, 'gi'))) columns.set(column, sqlType)
      for (const [, column] of body.matchAll(/drop\s+column\s+(?:if exists\s+)?(\w+)/gi)) columns.delete(column)
    }
  }
  return tables
}

export async function createExportDb(after) {
  const db = new PGlite()
  after(() => db.close())
  await db.exec(`create role anon; create role authenticated;
    create schema auth; create schema storage;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table auth.users(id uuid primary key,email text);
    create table storage.objects(bucket_id text,name text);
    alter table storage.objects enable row level security;
    grant usage on schema auth,storage to authenticated;
    grant select on storage.objects to authenticated;`)
  // Only tables selected by the export API are needed; their columns come from
  // independent source DDL, so misspelled and obsolete allowlist fields surface.
  const names = [...exportSql.matchAll(/^  \('([a-z_]+)','/gm)].map(match => match[1])
  const composite = {
    manager_venue_assignments: ['tenant_id','manager_user_id','venue_id'],
    product_modifier_group_assignment_variants: ['assignment_id','variant_id'],
    product_selection_group_assignment_variants: ['assignment_id','variant_id'],
    production_category_routes: ['tenant_id','venue_id','category_id','destination_id'],
    production_product_routes: ['tenant_id','venue_id','product_id','destination_id'],
    production_category_pass_routes: ['tenant_id','venue_id','category_id','pass_id'],
    production_product_pass_routes: ['tenant_id','venue_id','product_id','pass_id'],
    inventory_stock_levels: ['warehouse_id','inventory_item_id'],
    inventory_product_settings: ['product_id'], inventory_product_format_consumptions: ['product_id','sale_format_id'],
    inventory_device_warehouses: ['device_id','warehouse_id'], inventory_item_warehouse_routes: ['inventory_item_id','warehouse_id'],
    fiscal_invoice_sequences: ['tenant_id','series'], cash_session_table_layouts: ['cash_session_id'], venue_table_layouts: ['venue_id'],
    production_agent_printers: ['agent_id','printer_id'], tickit_assist_feedback: ['situation_id','user_id'],
  }
  const tables = exportSourceTables()
  for (const name of names) {
    const columns = tables.get(name)
    if (!columns?.size) throw new Error(`No source schema for ${name}`)
    const keys = columns.has('id') ? ['id'] : composite[name]
    if (!keys) throw new Error(`No fixture primary key for ${name}`)
    await db.exec(`create table public.${name} (${[...columns].map(([key, type]) => `${key} ${type}`).join(',')}, primary key(${keys.join(',')}))`)
  }
  await db.exec(`alter table tickets add foreign key(user_id) references profiles(id);
    alter table tenant_memberships add foreign key(user_id) references profiles(id);`)
  await db.exec(exportSql)
  return db
}
