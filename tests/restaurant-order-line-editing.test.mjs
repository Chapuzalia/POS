import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const [panel, page, controller, service, migration] = await Promise.all([
  readFile(new URL('../src/features/tables/components/RestaurantOrderPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/app/PosPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/restaurant/hooks/useRestaurantController.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/tables/service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../supabase/migrations/20260831130000_preserve_restaurant_order_line_prices.sql', import.meta.url), 'utf8'),
])

test('las cantidades y los precios de la comanda abren el mismo teclado numerico que la venta rapida', () => {
  assert.match(panel, /aria-label={`Editar cantidad de \$\{line\.productName\}`}/)
  assert.match(panel, /aria-label={`Editar precio unitario de \$\{line\.productName\}`}/)
  assert.match(panel, /<NumericKeypadModal[\s\S]*allowDecimal=\{valueEditor\.kind === 'unitPrice'\}/)
  assert.match(panel, /maxDigits=\{valueEditor\.kind === 'quantity' \? 4 : 8\}/)
  assert.match(panel, /maxFractionDigits=\{valueEditor\.kind === 'unitPrice' \? 2 : undefined\}/)
  assert.match(panel, /title=\{valueEditor\.kind === 'quantity' \? 'Editar cantidad' : 'Editar precio unitario'\}/)
})

test('la pantalla conecta ambos editores con el borrador de la comanda', () => {
  assert.match(page, /onSetQuantity=\{restaurant\.setLineQuantity\}/)
  assert.match(page, /onSetUnitPrice=\{restaurant\.setLineUnitPrice\}/)
  assert.match(controller, /const setLineQuantity = useCallback/)
  assert.match(controller, /quantity < line\.servedQuantity/)
  assert.match(controller, /sentQuantity \?\? 0\) > quantity/)
  assert.match(controller, /const setLineUnitPrice = useCallback/)
  assert.match(controller, /unitPriceCents, updatedAt: nowIso\(\)/)
})

test('el guardado conserva el precio manual con control de revision y permisos', () => {
  assert.match(service, /rpc\('save_catalog_order_lines'/)
  assert.match(migration, /rename to save_catalog_order_lines_canonical/i)
  assert.match(migration, /saved_order := public\.save_catalog_order_lines_canonical\(p_order_id, p_expected_revision, p_lines\)/i)
  assert.match(migration, /set unit_price_cents = \(submitted\.line ->> 'unitPriceCents'\)::integer/i)
  assert.match(migration, /order_line\.order_id = p_order_id/i)
  assert.match(migration, /ORDER_LINE_INVALID_UNIT_PRICE/i)
  assert.match(migration, /grant execute on function public\.save_catalog_order_lines\(uuid, integer, jsonb\) to authenticated/i)
})
