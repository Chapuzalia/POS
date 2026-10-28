import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSalePayload } from '../src/features/quick-sale/services/salePayload.ts'
import {
  appendFrozenQueueEvent,
  recordQueueEventFailure,
} from '../src/features/offline/services/offlineQueueState.ts'

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
