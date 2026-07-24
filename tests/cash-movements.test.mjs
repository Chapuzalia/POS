import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { summarizeSales } from '../src/features/cash-registers/services/cashSummary.ts'

const movement = (type, amountCents, id = `${type}-${amountCents}`) => ({
  id, tenantId: 'tenant', venueId: 'venue', cashSessionId: 'session', createdBy: 'user', type,
  direction: type === 'cash_in' ? 'entry' : 'exit', amountCents, notes: 'Motivo',
  requestId: `request-${id}`, createdAt: '2026-07-21T10:00:00Z',
})

test('fondo de 100 euros y entrada de 50 dejan 150 euros esperados', () => {
  const summary = summarizeSales(10000, [], [movement('cash_in', 5000)])
  assert.equal(summary.cashCents, 15000)
  assert.equal(summary.cashEntriesCents, 5000)
})

test('fondo de 100 euros y salida de 20 dejan 80 euros esperados', () => {
  const summary = summarizeSales(10000, [], [movement('cash_out', 2000)])
  assert.equal(summary.cashCents, 8000)
  assert.equal(summary.cashExitsCents, 2000)
})

test('efectivo por tarjeta resta caja y aumenta tarjeta por el mismo importe', () => {
  const summary = summarizeSales(10000, [], [movement('card_cashback', 3000)])
  assert.equal(summary.cashCents, 7000)
  assert.equal(summary.cardCents, 3000)
  assert.equal(summary.cardCashbackCents, 3000)
})

test('combina ventas y movimientos sin convertir movimientos en facturacion', () => {
  const sales = [
    { id: 'cash', cashSessionId: 'session', paymentMethod: 'cash', totalCents: 4000, createdAt: '' },
    { id: 'card', cashSessionId: 'session', paymentMethod: 'card', totalCents: 6000, createdAt: '' },
    { id: 'invitation', cashSessionId: 'session', paymentMethod: 'invitation', totalCents: 1000, createdAt: '' },
    { id: 'other', cashSessionId: 'session', paymentMethod: 'other', totalCents: 500, createdAt: '' },
  ]
  const movements = [movement('cash_in', 2000), movement('cash_out', 500), movement('card_cashback', 1500)]
  const summary = summarizeSales(10000, sales, movements)
  assert.equal(summary.cashCents, 14000)
  assert.equal(summary.cardCents, 7500)
  assert.equal(summary.totalSalesCents, 11500)
})

const migration = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

test('el RPC deriva identidad y direccion, y la escritura directa queda revocada', () => {
  assert.match(migration, /security definer/i)
  assert.match(migration, /created_by[\s\S]*auth\.uid\(\)/i)
  assert.match(migration, /movement_direction := case p_movement_type/i)
  assert.match(migration, /grant select on table public\.cash_movements to authenticated/i)
  assert.doesNotMatch(migration, /grant (?:insert|update|delete)[\s\S]*public\.cash_movements/i)
})

test('request_id hace la creacion idempotente y devuelve el movimiento existente', () => {
  assert.match(migration, /unique index[\s\S]*cash_session_id, request_id/i)
  assert.match(migration, /on conflict \(cash_session_id, request_id\)[\s\S]*do nothing/i)
  assert.match(migration, /where cm\.cash_session_id = session_row\.id[\s\S]*cm\.request_id = p_request_id/i)
})

test('el RPC bloquea movimientos sobre sesiones cerradas', () => {
  assert.match(migration, /session_row\.status <> 'open'[\s\S]*caja cerrada/i)
})

test('el cierre recalcula importes esperados desde pagos y movimientos reales', () => {
  assert.match(migration, /from public\.sale_payments sp[\s\S]*where s\.cash_session_id = session_row\.id/i)
  assert.match(migration, /from public\.cash_movements cm[\s\S]*where cm\.cash_session_id = session_row\.id/i)
  assert.match(migration, /expected_cash_total := session_row\.opening_float_cents[\s\S]*\+ cash_entries_total[\s\S]*- cash_exits_total[\s\S]*- card_cashback_total/i)
  assert.match(migration, /expected_card_total := card_payments_total \+ card_cashback_total/i)
  assert.match(migration, /expected_cash_cents = expected_cash_total/i)
})

test('el snapshot separa entradas, salidas y efectivo por tarjeta', () => {
  assert.match(migration, /'cashEntriesCents', cash_entries_total/i)
  assert.match(migration, /'cashExitsCents', cash_exits_total/i)
  assert.match(migration, /'cardCashbackCents', card_cashback_total/i)
})
