import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const exportCatalogPermissionMigration = readFileSync(
  new URL('../supabase/migrations/20260724171103_grant_export_catalog_to_authenticated.sql', import.meta.url),
  'utf8',
)

test('el esquema final crea catalogo, componentes, snapshots, indices y RLS', () => {
  for (const table of ['catalog_tabs', 'catalog_placements', 'selection_groups', 'selection_group_options', 'product_selection_group_assignments', 'product_modifier_group_assignments', 'ticket_line_components', 'order_line_components']) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, 'i'))
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  }
  for (const column of ['sale_format_id', 'sale_format_name_snapshot', 'category_id_snapshot', 'catalog_tab_id_snapshot']) {
    assert.match(migration, new RegExp(`${column} (?:uuid|text)`))
  }
  assert.match(migration, /product_type text default 'standard'::text not null/i)
  assert.match(migration, /create function public\.save_catalog_order_lines\(/i)
})


test('el owner puede exportar el catalogo sin abrir acceso entre negocios', () => {
  assert.match(
    exportCatalogPermissionMigration,
    /grant execute on function public\.export_catalog\(uuid\) to authenticated/i,
  )
  assert.match(
    migration,
    /not public\.user_is_tenant_admin\(v_venue\.tenant_id\).*CATALOG_EXPORT_FORBIDDEN/i,
  )
})
