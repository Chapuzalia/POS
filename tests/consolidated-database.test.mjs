import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import test from 'node:test'

const schemaName = '0.Complete_Database_24-07-26.sql'
const supabaseUrl = new URL('../supabase/', import.meta.url)
const schema = await readFile(new URL(schemaName, supabaseUrl), 'utf8')

test('supabase conserva un único SQL raíz con el esquema completo', async () => {
  const entries = await readdir(supabaseUrl, { withFileTypes: true })
  const rootSqlFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort()

  assert.deepEqual(rootSqlFiles, [schemaName])
  assert.match(schema, /CONSOLIDATED FINAL DATABASE - 24\/07\/2026/)
})

test('el consolidado contiene el estado final de las últimas migraciones', () => {
  assert.match(schema, /CREATE TABLE public\.catalog_sale_formats/i)
  assert.match(schema, /catalog_sale_format_id uuid/)
  assert.match(schema, /day_change_time time without time zone/)
  assert.match(schema, /devices_active_venue_name_key[\s\S]*WHERE is_active/i)

  for (const table of ['catalog_tabs', 'order_groups', 'restaurant_order_equal_splits']) {
    assert.match(schema, new RegExp(`'${table}'`))
  }

  assert.equal(schema.match(/CREATE FUNCTION public\.get_catalog\(/gi)?.length, 1)
  assert.equal(schema.match(/CREATE FUNCTION public\.get_catalog_without_formats\(/gi)?.length, 1)
  assert.doesNotMatch(schema, /ALTER FUNCTION public\.get_catalog[\s\S]*RENAME TO/i)
  assert.doesNotMatch(schema, /devices_tenant_id_venue_id_name_key/)
  assert.equal((schema.match(/\$\$/g)?.length ?? 0) % 2, 0)
})
