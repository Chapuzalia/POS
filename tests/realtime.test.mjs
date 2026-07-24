import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

const root = new URL('../', import.meta.url)

test('la migracion publica todas las tablas escuchadas por TPV y CRM', async () => {
  const migration = await readFile(new URL('supabase/0.Complete_Database_24-07-26.sql', root), 'utf8')
  for (const table of ['cash_registers', 'cash_session_table_layouts', 'cash_sessions', 'catalog_tabs', 'order_events', 'order_lines', 'order_tables', 'orders', 'sales', 'tickets']) {
    assert.match(migration, new RegExp(`'${table}'`))
  }
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/i)
})

test('las comandas no fallan silenciosamente si el canal realtime no conecta', async () => {
  const service = await readFile(new URL('src/features/tables/service.ts', root), 'utf8')
  const app = await readFile(new URL('src/features/restaurant/hooks/useRestaurantRealtime.ts', root), 'utf8')
  assert.match(service, /channel\.subscribe\(\(status, error\) => onStatus\?\.\(status, error\)\)/)
  assert.match(app, /status === 'CHANNEL_ERROR' \|\| status === 'TIMED_OUT'/)
  assert.match(app, /window\.setInterval\(scheduleRefresh, 3000\)/)
  assert.match(app, /status === 'SUBSCRIBED'/)
})
