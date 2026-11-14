import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'
import { quantityAmountCents } from '../../src/lib/format'
import { isTransportError } from '../../src/lib/observability'
import { getReadableError } from '../../src/utils/errors'
import * as policy from '../../src/features/restaurant/draft-policy'
import { buildRestaurantOrderLinesPayload } from '../../src/features/tables/order-line-payload'
import type { RestaurantOrderDetail, RestaurantOrderLine } from '../../src/features/tables/types'
import type { useRestaurantDraft } from '../../src/features/restaurant/hooks/useRestaurantDraft'

vi.mock('@sentry/react', () => ({ captureException: vi.fn(), addBreadcrumb: vi.fn() }))

const source = readFileSync(new URL('../../src/features/restaurant/hooks/useRestaurantDraft.ts', import.meta.url), 'utf8')
const line: RestaurantOrderLine = {
  id: 'line', tenantId: 'tenant', venueId: 'venue', orderId: 'order', productId: 'product', variantId: 'variant',
  productName: 'Producto', variantName: '', unitPriceCents: 199, quantity: 1.5, servedQuantity: 0, fullyServedAt: null,
  modifiers: [], components: [], mixerProductId: null, mixer: null, note: null,
  createdAt: '2026-11-13T20:00:00Z', updatedAt: '2026-11-13T20:00:00Z',
  catalogSnapshot: { placementId: null, productType: 'standard', productId: 'product', productName: 'Producto', variantId: 'variant',
    variantName: '', basePriceCents: 199, vatRate: 10, categoryId: null, categoryName: '', catalogTabId: null, catalogTabName: '', saleFormatId: null, saleFormatName: '' },
}
const detail: RestaurantOrderDetail = {
  order: { id: 'order', tenantId: 'tenant', venueId: 'venue', cashSessionId: 'session', cashRegisterId: 'register',
    openedByUserId: 'user', openedByDeviceId: 'device', guestCount: 2, status: 'open', revision: 1, orderGroupId: 'group',
    splitSequence: 0, draftDiscount: null, openedAt: line.createdAt, updatedAt: line.updatedAt, closedAt: null },
  cashRegisterName: 'Caja', lines: [line], tables: [], totalCents: 299,
}
const conflict = { code: '40001', message: 'CATALOG_ORDER_REVISION_CONFLICT' }

function harness() {
  vi.useFakeTimers()
  const save = vi.fn(async (_draft: RestaurantOrderDetail) => ({ revision: 2, lines: [line] }))
  const load = vi.fn(async () => ({ ...detail, order: { ...detail.order, revision: 3 } }))
  const onError = vi.fn()
  const runner = createCompiledHookRunner(source, 'useRestaurantDraft', {
    '../../tables/service': { loadRestaurantOrder: load, saveRestaurantOrderLines: save },
    '../../../lib/format': { quantityAmountCents },
    '../../../lib/observability.ts': { isTransportError },
    '../../../utils/errors': { getReadableError },
    '../draft-policy': policy,
  }, { Error, window: { setTimeout, clearTimeout }, document: new EventTarget() })
  const options = {
    context: { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user' },
    isOnline: true, onError,
  }
  const render = (): ReturnType<typeof useRestaurantDraft> => runner.render(options)
  render().replaceOrder(detail)
  render().updateDraft(current => ({ ...current, lines: [{ ...line, quantity: 2 }] }))
  return { render, save, load, onError, options, unmount: runner.unmount }
}

afterEach(() => { vi.useRealTimers() })

it('sends each line id once with the last complete snapshot and its own price', () => {
  const other = { ...line, id: 'other', unitPriceCents: 500 }
  const latest = { ...line, quantity: 3, unitPriceCents: 250, note: 'Sin sal' }
  const lines = [line, other, latest, other]
  const payload = buildRestaurantOrderLinesPayload({ ...detail, lines })
  expect(payload.map(item => [item.id, item.quantity, item.unitPriceCents, item.note])).toEqual([
    ['line', 3, 250, 'Sin sal'], ['other', 1.5, 500, null],
  ])
  expect(lines).toEqual([line, other, latest, other])
})

it('retains distinct ids with identical selections and validates modifiers', () => {
  expect(buildRestaurantOrderLinesPayload({ ...detail, lines: [line, { ...line, id: 'other' }] })).toHaveLength(2)
  expect(() => buildRestaurantOrderLinesPayload({ ...detail, lines: [{ ...line,
    modifiers: [{ id: 'invalid', groupId: 'group', name: 'Extra', priceCents: 50 }],
  }] })).toThrow('La comanda contiene un modificador no válido.')
})

it('maps the Postgres exception message without treating every P0001 error as a duplicate', () => {
  expect(getReadableError({ code: 'P0001', message: 'CATALOG_DUPLICATE_ORDER_LINE' })).toMatch(/líneas duplicadas/)
  expect(getReadableError(new Error('CATALOG_DUPLICATE_ORDER_LINE'))).toMatch(/líneas duplicadas/)
  expect(getReadableError({ code: 'P0001', message: 'OTHER_ERROR' })).toMatch(/No se ha podido completar/)
})

it('autosaves a dirty draft and reconciles server lines and integer totals', async () => {
  const h = harness()
  h.render()
  await vi.advanceTimersByTimeAsync(800)
  expect(h.save).toHaveBeenCalledOnce()
  expect(h.render().saveState).toBe('saved')
  expect(h.render().order).toMatchObject({ order: { revision: 2 }, lines: [line], totalCents: 299 })
  expect(h.onError).not.toHaveBeenCalled()
  h.unmount()
})

it('keeps edits made during a save for the next revision', async () => {
  const h = harness()
  let finish = (_value: { revision: number; lines: RestaurantOrderLine[] }) => {}
  h.save.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  const pending = h.render().flush()
  h.render().updateDraft(current => ({ ...current, lines: [{ ...line, quantity: 3 }] }))
  finish({ revision: 2, lines: [line] })
  await pending
  expect(h.render().saveState).toBe('dirty')
  expect(h.render().order).toMatchObject({ order: { revision: 2 }, lines: [{ quantity: 3 }], totalCents: 597 })
  h.unmount()
})

it.each([new TypeError('Load failed'), { message: 'TypeError: Failed to fetch', code: '' }])(
  'retries a transport failure once when reloading a revision conflict: %s', async error => {
    const h = harness()
    h.save.mockRejectedValue(conflict)
    h.load.mockRejectedValueOnce(error)
    const pending = h.render().flush()
    await vi.advanceTimersByTimeAsync(299)
    expect(h.load).toHaveBeenCalledOnce()
    expect(h.render().saveState).toBe('saving')
    await vi.advanceTimersByTimeAsync(1)
    expect(await pending).toBeNull()
    expect(h.load).toHaveBeenCalledTimes(2)
    expect(h.load).toHaveBeenLastCalledWith(h.options.context, detail.order.id)
    expect(h.save).toHaveBeenCalledOnce()
    expect(h.render().order?.order.revision).toBe(3)
    expect(h.render().saveState).toBe('saved')
    expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Se ha recargado'))
    h.unmount()
  },
)

it('keeps the draft and a clear connection error after both reload attempts fail, then allows retry', async () => {
  const h = harness()
  h.save.mockRejectedValue(conflict)
  h.load.mockRejectedValue(new TypeError('Load failed'))
  const draft = h.render().getCurrentOrder()
  const pending = h.render().flush()
  await vi.advanceTimersByTimeAsync(300)
  expect(await pending).toBeNull()
  expect(h.load).toHaveBeenCalledTimes(2)
  expect(h.render().getCurrentOrder()).toBe(draft)
  expect(h.render().saveState).toBe('error')
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/recargar.*conexión.*borrador sigue pendiente/))
  await vi.advanceTimersByTimeAsync(5000)
  expect(h.load).toHaveBeenCalledTimes(2)
  h.load.mockResolvedValue({ ...detail, order: { ...detail.order, revision: 3 } })
  await h.render().flush()
  expect(h.render().saveState).toBe('saved')
  expect(h.render().order?.order.revision).toBe(3)
  h.unmount()
})

it('does not retry a business error while reloading', async () => {
  const h = harness()
  h.save.mockRejectedValue(conflict)
  h.load.mockRejectedValue({ code: '42501', message: 'permission denied' })
  expect(await h.render().flush()).toBeNull()
  expect(h.load).toHaveBeenCalledOnce()
  expect(h.render().saveState).toBe('error')
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('No se ha podido completar'))
  h.unmount()
})

it.each([true, false])('does not change another table after a delayed reload (success: %s)', async success => {
  const h = harness()
  h.save.mockRejectedValue(conflict)
  h.load.mockRejectedValueOnce(new TypeError('Load failed'))
  if (!success) h.load.mockRejectedValue(new TypeError('Load failed'))
  const pending = h.render().flush()
  await vi.advanceTimersByTimeAsync(1)
  const other = { ...detail, order: { ...detail.order, id: 'other-order' } }
  h.render().replaceOrder(other)
  await vi.advanceTimersByTimeAsync(300)
  await pending
  expect(h.render().order).toBe(other)
  expect(h.render().saveState).toBe('saved')
  expect(h.onError).not.toHaveBeenCalled()
  h.unmount()
})

it('keeps a failed save pending with a connection message without replaying the write', async () => {
  const h = harness()
  h.save.mockRejectedValue(new TypeError('Failed to fetch'))
  const draft = h.render().getCurrentOrder()
  expect(await h.render().flush()).toBeNull()
  expect(h.save).toHaveBeenCalledOnce()
  expect(h.load).not.toHaveBeenCalled()
  expect(h.render().saveState).toBe('error')
  expect(h.render().getCurrentOrder()).toBe(draft)
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/guardar.*conexión.*borrador sigue pendiente/))
  h.unmount()
})

it('shows the duplicate-line message and retains the rejected draft', async () => {
  const h = harness()
  h.save.mockRejectedValue({ code: 'P0001', message: 'CATALOG_DUPLICATE_ORDER_LINE' })
  const draft = h.render().getCurrentOrder()
  expect(await h.render().flush()).toBeNull()
  expect(h.render().getCurrentOrder()).toBe(draft)
  expect(h.render().saveState).toBe('error')
  expect(h.load).not.toHaveBeenCalled()
  expect(h.onError).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('líneas duplicadas'))
  h.unmount()
})
