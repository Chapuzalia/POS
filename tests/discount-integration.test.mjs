import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/16.ticket-discounts-migration.sql', import.meta.url), 'utf8')
const roundingMigration = readFileSync(new URL('../supabase/25.discount-total-rounding-migration.sql', import.meta.url), 'utf8')
const posService = readFileSync(new URL('../src/services/posService.ts', import.meta.url), 'utf8')
const crmAnalyticsService = readFileSync(new URL('../src/features/crm/analytics/services/analyticsService.ts', import.meta.url), 'utf8')
const crmDiscountService = readFileSync(new URL('../src/features/crm/discounts/services/discountService.ts', import.meta.url), 'utf8')
const crmDiscountPage = readFileSync(new URL('../src/features/crm/discounts/pages/DiscountsPage.tsx', import.meta.url), 'utf8')
const discountLib = readFileSync(new URL('../src/lib/discounts.ts', import.meta.url), 'utf8')
const paymentPanel = readFileSync(new URL('../src/components/pos/PaymentPanel.tsx', import.meta.url), 'utf8')

test('la migracion conserva snapshots y permite pago nulo sin reescribir el historico', () => {
  assert.match(migration, /add column if not exists discount_name text/)
  assert.match(migration, /add column if not exists discount_amount_cents integer/)
  assert.match(migration, /alter table public\.sales alter column payment_method drop not null/)
  assert.match(migration, /payment_method is null or payment_method in \('cash', 'card'\)\) not valid/)
  assert.match(migration, /sale_payments_method_check/)
  assert.match(migration, /check \(method in \('cash', 'card'\)\) not valid/)
  assert.doesNotMatch(migration, /update\s+public\.sales[\s\S]+payment_method\s*=\s*null/i)
})

test('el servidor recalcula descuentos y rechaza alcance, inactivos y manual deshabilitado', () => {
  assert.match(migration, /resolve_ticket_discount/)
  assert.match(migration, /d\.tenant_id = p_tenant_id/)
  assert.match(migration, /d\.venue_id = p_venue_id/)
  assert.match(migration, /and d\.is_active/)
  assert.match(migration, /El descuento manual esta deshabilitado/)
  assert.match(migration, /Los totales enviados no coinciden con el calculo del servidor/)
  assert.match(migration, /user_has_device_access/)
})

test('los flujos rapido y de mesas usan los RPC nuevos y mantienen eventos offline antiguos', () => {
  assert.match(posService, /'subtotalCents' in event\.payload\.ticket/)
  assert.match(posService, /'sync_sale_created_v2'/)
  assert.match(posService, /'sync_sale_created'/)
  assert.match(migration, /close_order_and_create_sale_v2/)
  assert.match(migration, /close_restaurant_order_checked_v2/)
})

test('estadisticas usan tickets netos y excluyen metodos historicos del desglose', () => {
  assert.match(crmAnalyticsService, /paidTickets\.reduce\(\(total, ticket\) => total \+ ticket\.total_cents, 0\)/)
  assert.match(crmAnalyticsService, /ticket\.discount_amount_cents/)
  assert.match(crmAnalyticsService, /sale\.payment_method !== 'cash' && sale\.payment_method !== 'card'/)
  assert.match(crmAnalyticsService, /discountMap/)
})

test('el owner configura el redondeo y el servidor lo recalcula y conserva en el ticket', () => {
  assert.match(roundingMigration, /add column if not exists rounding_increment_cents integer/)
  assert.match(roundingMigration, /add column if not exists discount_rounding_increment_cents integer/)
  assert.match(roundingMigration, /rounding_increment_cents in \(5, 10, 50, 100\)/)
  assert.match(roundingMigration, /rounding_increment_cents := configured\.rounding_increment_cents/)
  assert.match(roundingMigration, /round\(total_cents::numeric \/ rounding_increment_cents\)/)
  assert.match(roundingMigration, /set_ticket_discount_rounding_snapshot/)
  assert.match(posService, /rounding_increment_cents/)
  assert.match(crmDiscountService, /rounding_increment_cents: input\.roundingIncrementCents/)
  assert.match(crmDiscountPage, /discountRoundingOptions/)
  assert.match(discountLib, /Math\.round\(totalCents \/ roundingIncrementCents\)/)
})

test('oculta el panel de cobro cuando el dispositivo no puede cobrar', () => {
  assert.match(paymentPanel, /if \(disabled\) \{\s*return null\s*\}/)
})
