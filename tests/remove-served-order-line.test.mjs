import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const migration = await readFile(new URL('../supabase/migrations/20260819120000_add_remove_served_order_line_rpc.sql', import.meta.url), 'utf8')
const app = (await Promise.all([readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'), readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8')])).join('\n')
const panel = await readFile(new URL('../src/features/tables/components/RestaurantOrderPanel.tsx', import.meta.url), 'utf8')
const modal = await readFile(new URL('../src/features/tables/components/RemoveOrderLineModal.tsx', import.meta.url), 'utf8')

test('the delete button remains available for served order lines', () => {
  assert.doesNotMatch(panel, /disabled=\{isBusy \|\| !removable\}/)
  assert.match(panel, /disabled=\{isBusy\}[^>]+onClick=\{\(\) => onRemove\(line\.id\)\}/)
})

test('only served order lines require explicit confirmation', () => {
  assert.match(app, /requiresConfirmedRestaurantLineRemoval\(line\.servedQuantity\)/)
  assert.match(app, /setPendingLineRemoval\(line\)[\s\S]*return[\s\S]*removeLine\(line\.id, false\)/)
  assert.match(app, /onRemove=\{restaurant\.requestLineRemoval\}/)
  assert.match(app, /restaurant\.pendingLineRemoval && restaurant\.pendingLineRemoval\.servedQuantity > 0/)
  assert.match(app, /confirmLineRemoval/)
  assert.match(modal, /Este producto ya está marcado como servido/)
  assert.match(modal, /onClick=\{onConfirm\}/)
})

test('the served-product confirmation modal is centered', () => {
  assert.match(modal, /placement="center"/)
  assert.doesNotMatch(modal, /placement="bottom"/)
  assert.match(modal, /rounded-\[var\(--radius\)\]/)
})

test('the confirmed deletion locks the order and preserves revision safety', () => {
  assert.match(migration, /create or replace function public\.remove_restaurant_order_line_confirmed\([\s\S]*p_line_id uuid,[\s\S]*p_expected_revision integer/i)
  assert.match(migration, /for update of o/i)
  assert.match(migration, /order_row\.revision <> p_expected_revision/i)
  assert.match(migration, /delete from public\.order_lines/i)
  assert.match(migration, /revision = o\.revision \+ 1/i)
  assert.match(migration, /'removed', true/i)
  assert.match(migration, /grant execute on function public\.remove_restaurant_order_line_confirmed\(uuid, integer\) to authenticated/i)
  assert.match(migration, /notify pgrst, 'reload schema'/i)
})
