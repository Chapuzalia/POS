import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const app = (await Promise.all([readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'), readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')])).join('\n')
const panel = await readFile(new URL('../src/features/tables/components/RestaurantOrderPanel.tsx', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/tables/components/RemoveOrderLineModal.tsx', import.meta.url), 'utf8')

test('the delete button remains available for served order lines', () => {
  assert.doesNotMatch(panel, /disabled=\{isBusy \|\| !removable\}/)
  assert.match(panel, /disabled=\{isBusy\}[^>]+onClick=\{\(\) => onRemove\(line\.id\)\}/)
})

test('deleting an order line requires explicit confirmation', () => {
  assert.match(app, /setPendingLineRemoval\(line\)/)
  assert.match(app, /confirmLineRemoval/)
  assert.match(modal, /Este producto ya está marcado como servido/)
  assert.match(modal, /onClick=\{onConfirm\}/)
})

test('the confirmed deletion locks the order and preserves revision safety', () => {
  assert.match(migration, /for update of o/i)
  assert.match(migration, /order_row\.revision <> p_expected_revision/i)
  assert.match(migration, /delete from public\.order_lines/i)
  assert.match(migration, /revision = o\.revision \+ 1/i)
  assert.match(migration, /'removed', true/i)
})
