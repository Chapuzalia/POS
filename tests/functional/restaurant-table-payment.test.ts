import { expect, it } from 'vitest'
import { createRestaurantControllerHarness, flush } from '../helpers/restaurant-controller-harness.mjs'

it.each([
  { isVirtual: true, areaId: 'area', visible: true },
  { isVirtual: false, areaId: 'area', visible: true },
  { isVirtual: true, areaId: 'virtual:venue', visible: false },
])('after payment, table visibility matches its lifetime ($isVirtual, $areaId)', async ({ isVirtual, areaId, visible }) => {
  const table = {
    id: 'table', name: 'Mesa extra 1', isVirtual, areaId, nextReservation: null,
    status: 'occupied', orderId: 'order', orderOpenedAt: '2026-11-02T10:00:00Z',
    guestCount: 2, totalCents: 600, pendingUnits: 0, readyUnits: 0, groupTableIds: ['table'],
  }
  const otherTable = { ...table, id: 'other-table', orderId: 'other-order' }
  const h = createRestaurantControllerHarness({
    currentOrder: {
      order: { id: 'order', revision: 1, status: 'open' },
      lines: [{ id: 'line', productId: 'product', variantId: 'variant', unitPriceCents: 600, quantity: 1, servedQuantity: 1 }],
      tables: [table],
    },
  })
  h.realtime.setMap({ areas: [{ id: areaId }], tables: [table, otherTable] })

  await h.render().completePayment('card', null)
  h.print.resolve()
  h.queueSync.resolve()
  await flush()

  expect(h.calls.close).toBe(1)
  expect(h.calls.errors.filter(Boolean)).toEqual([])
  expect(h.order).toBeNull()
  expect(h.realtime.map.tables.find(item => item.id === 'other-table')).toEqual(otherTable)
  const paidTable = h.realtime.map.tables.find(item => item.id === table.id)
  if (visible) {
    expect(paidTable).toEqual({
      ...table, status: 'free', orderId: null, orderOpenedAt: null, guestCount: null,
      totalCents: 0, pendingUnits: 0, readyUnits: 0, groupTableIds: [],
    })
  } else {
    expect(paidTable).toBeUndefined()
  }
})
