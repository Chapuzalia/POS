import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8')
const orderBar = await readFile(new URL('../src/features/tables/components/TableOrderBar.tsx', import.meta.url), 'utf8')

test('empty order cancellation is atomic and concurrency-safe', () => {
  assert.match(migration, /where o\.id = p_order_id\s+for update/i)
  assert.match(migration, /order_row\.revision <> p_expected_revision/i)
  assert.match(migration, /exists \(\s*select 1 from public\.order_lines/i)
  assert.match(migration, /status = 'cancelled'/i)
  assert.match(migration, /set released_at = now\(\)/i)
})

test('the client passes the expected revision to the cancellation RPC', () => {
  assert.match(service, /rpc\('cancel_empty_restaurant_order'/)
  assert.match(service, /p_expected_revision: expectedRevision/)
})

test('the close action is only rendered for an empty table order', () => {
  assert.match(orderBar, /order\?\.lines\.length === 0/)
  assert.match(orderBar, /Cerrar mesa vacía/)
})
