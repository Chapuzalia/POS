import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'
import {
  appendFrozenQueueEvent,
  recordQueueEventFailure,
} from '../src/features/offline/services/offlineQueueState.ts'

const migrationUrl = new URL('../supabase/migrations/20260815130000_freeze_offline_sale_economics.sql', import.meta.url)
const consolidatedUrl = new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url)

const context = {
  tenantId: '00000000-0000-4000-8000-000000000001',
  venueId: '00000000-0000-4000-8000-000000000002',
  deviceId: '00000000-0000-4000-8000-000000000003',
  userId: '00000000-0000-4000-8000-000000000004',
  venueDefaultTaxRate: 21,
}
const cashSession = {
  id: '00000000-0000-4000-8000-000000000005',
  cashRegisterId: '00000000-0000-4000-8000-000000000006',
}

function saleLine(id, unitPriceCents) {
  return {
    id,
    productId: `00000000-0000-4000-8000-0000000000${id}`,
    productName: `Producto ${id}`,
    variantId: `10000000-0000-4000-8000-0000000000${id}`,
    variantName: 'Normal',
    basePriceCents: unitPriceCents,
    componentDeltaCents: 0,
    modifierDeltaCents: 0,
    unitPriceCents,
    quantity: 1,
    modifiers: [],
    components: [],
    catalogSnapshot: {
      placementId: null,
      productType: 'standard',
      productId: `00000000-0000-4000-8000-0000000000${id}`,
      productName: `Producto ${id}`,
      variantId: `10000000-0000-4000-8000-0000000000${id}`,
      variantName: 'Normal',
      basePriceCents: unitPriceCents,
      vatRate: 21,
      categoryId: null,
      categoryName: '',
      catalogTabId: null,
      catalogTabName: '',
      saleFormatId: null,
      saleFormatName: 'Normal',
    },
  }
}

function withBrowserStorage(run) {
  const values = new Map()
  const originalWindow = globalThis.window
  globalThis.window = {
    crypto: globalThis.crypto,
    location: { pathname: '/' },
    localStorage: {
      getItem: (key) => values.get(key) ?? null,
      removeItem: (key) => values.delete(key),
      setItem: (key, value) => values.set(key, String(value)),
    },
  }
  try {
    return run()
  } finally {
    if (originalWindow === undefined) delete globalThis.window
    else globalThis.window = originalWindow
  }
}

function build(discount = null) {
  return withBrowserStorage(() => buildSalePayload(
    context,
    cashSession,
    [saleLine('11', 1000), saleLine('12', 1000)],
    'card',
    null,
    discount,
  ))
}

test('la venta sin descuento congela 2000 = 0 + 2000 por ticket y líneas', () => {
  const payload = build()
  assert.equal(payload.ticket.subtotalCents, 2000)
  assert.equal(payload.ticket.discountAmountCents, 0)
  assert.equal(payload.ticket.totalCents, 2000)
  assert.equal(payload.sale.totalCents, 2000)
  assert.equal(payload.ticket.discount, null)
  assert.deepEqual(payload.lines.map((line) => line.netTotalCents), [1000, 1000])
})

test('la venta promocionada conserva exactamente 2000 - 500 = 1500 y su snapshot completo', () => {
  const payload = build({
    discountId: '20000000-0000-4000-8000-000000000001',
    name: 'Promo cobrada',
    type: 'fixed',
    calculationType: 'fixed',
    value: 500,
    fixedApplication: 'ticket',
    roundingIncrementCents: null,
    color: '#123456',
    ruleKind: 'promotion',
    scope: 'general',
    targets: [],
    activeWeekdays: [5],
    startsAt: '00:30',
    endsAt: '01:30',
    automatic: true,
  })

  assert.equal(payload.ticket.subtotalCents, 2000)
  assert.equal(payload.ticket.discountAmountCents, 500)
  assert.equal(payload.ticket.totalCents, 1500)
  assert.equal(payload.sale.totalCents, 1500)
  assert.equal(payload.ticket.discount.economicSource, 'pos_closed_sale')
  assert.equal(payload.ticket.discount.economicSnapshotVersion, 1)
  assert.equal(payload.ticket.discount.storedValue, 5)
  assert.equal(payload.ticket.discount.eligibleSubtotalCents, 2000)
  assert.equal(payload.ticket.discount.amountCents, 500)
  assert.equal(payload.ticket.discount.ruleKind, 'promotion')
  assert.equal(payload.ticket.discount.automatic, true)
  assert.equal(payload.ticket.discount.lineAllocations.length, 2)
  assert.equal(payload.ticket.discount.lineAllocations.reduce((sum, line) => sum + line.discountAmountCents, 0), 500)
  assert.equal(payload.lines.reduce((sum, line) => sum + line.netTotalCents, 0), 1500)
})

test('la cola reintenta el mismo snapshot aunque después cambie la promoción o pasen horas', () => {
  const payload = build({
    discountId: '20000000-0000-4000-8000-000000000001',
    name: 'Promo original',
    type: 'fixed',
    calculationType: 'fixed',
    value: 500,
    fixedApplication: 'ticket',
    roundingIncrementCents: null,
    color: null,
    ruleKind: 'promotion',
    scope: 'general',
    targets: [],
    activeWeekdays: [5],
    startsAt: '00:30',
    endsAt: '01:30',
    automatic: true,
  })
  const event = {
    id: '30000000-0000-4000-8000-000000000001',
    kind: 'sale_created',
    tenantId: context.tenantId,
    createdAt: payload.sale.createdAt,
    attempts: 0,
    payload,
  }
  const originalSnapshot = structuredClone(payload)
  const queued = appendFrozenQueueEvent([], event)

  payload.ticket.totalCents = 9999
  payload.ticket.discount.name = 'Promo modificada en memoria'
  const retriedQueue = recordQueueEventFailure(queued, event.id, 'Sin conexión durante varias horas')

  const [retried] = retriedQueue
  assert.deepEqual(retried.payload, originalSnapshot)
  assert.equal(retried.attempts, 1)
  assert.equal(retried.lastError, 'Sin conexión durante varias horas')
})

test('sync_sale_created_v2 valida coherencia pero nunca resuelve la regla vigente', async () => {
  const [migration, consolidated] = await Promise.all([
    readFile(migrationUrl, 'utf8'),
    readFile(consolidatedUrl, 'utf8'),
  ])
  const sync = migration.slice(
    migration.indexOf('create or replace function public.sync_sale_created_v2'),
    migration.indexOf('revoke all on function public.sync_sale_created_v2'),
  )

  assert.doesNotMatch(sync, /resolve_ticket_discount|discount_rule_is_active_at/)
  assert.match(sync, /subtotal_cents_value integer := \(ticket_payload ->> 'subtotalCents'\)::integer/)
  assert.match(sync, /subtotal_cents_value - discount_amount_cents_value <> total_cents_value/)
  assert.match(sync, /sale_total_cents_value is null or sale_total_cents_value <> total_cents_value/)
  assert.match(sync, /subtotal_cents_value::bigint <> lines_total/)
  assert.match(sync, /discount_amount_cents_value::bigint <> lines_discount_total/)
  assert.match(sync, /total_cents_value::bigint <> lines_net_total/)
  assert.match(sync, /lineTotalCents'\)::bigint = \(line ->> 'unitPriceCents'\)::bigint \* \(line ->> 'quantity'/)
  assert.match(sync, /user_has_tenant_access/)
  assert.match(sync, /user_has_device_access/)
  assert.match(sync, /cash_sessions where id = cash_session_id_value for update/)
  assert.match(sync, /offline_event_log[\s\S]*client_event_id = p_event_id[\s\S]*then return/)
  assert.match(sync, /on conflict \(tenant_id, client_event_id\) do nothing/)
  assert.match(sync, /'economicSource', 'pos_closed_sale'/)
  assert.match(sync, /discount_snapshot_value -> 'lineAllocations'/)
  assert.match(sync, /discount_id_value is null and exists[\s\S]*discount_id_snapshot/)
  assert.match(consolidated, /Migration: 20260815130000_freeze_offline_sale_economics\.sql/)
})

test('los payloads incoherentes quedan explícitamente rechazados por la RPC', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  assert.match(migration, /subtotal_cents_value < 0 or discount_amount_cents_value < 0 or total_cents_value < 0/)
  assert.match(migration, /subtotal_cents_value - discount_amount_cents_value <> total_cents_value/)
  assert.match(migration, /raise exception 'Los importes enviados no son internamente coherentes'/)
  assert.match(migration, /sale_total_cents_value is null or sale_total_cents_value <> total_cents_value/)
})

test('los triggers preservan el snapshot cerrado y los flujos abiertos siguen usando reglas dinámicas', async () => {
  const migration = await readFile(migrationUrl, 'utf8')
  const consolidated = await readFile(consolidatedUrl, 'utf8')
  assert.match(migration, /if new\.discount_snapshot ->> 'economicSource' = 'pos_closed_sale' then[\s\S]*return new/)
  assert.match(migration, /if ticket_row\.discount_snapshot ->> 'economicSource' = 'pos_closed_sale' then[\s\S]*continue/)
  assert.match(consolidated, /create or replace function public\.resolve_ticket_discount_for_lines/)
  assert.match(consolidated, /create or replace function public\.resolve_ticket_discount\(/)
  assert.match(consolidated, /discount_rule_is_active_at/)
})
