import { expect, it } from 'vitest'
import { createCashTicketActionsHarness } from '../helpers/cash-ticket-actions-harness.mjs'
import { createRestaurantControllerHarness } from '../helpers/restaurant-controller-harness.mjs'
import { employeeSnapshot, personalContext } from '../helpers/personal'
import { withPersonalStaff } from '../../src/features/personal/permissions'

it('blocks ticket mutations and history before side effects, including an otherwise privileged device account', async () => {
  const harness = createCashTicketActionsHarness()
  harness.options.context = withPersonalStaff({ ...personalContext, role: 'owner' }, employeeSnapshot)
  const actions = harness.render()
  actions.openHistory()
  await expect(actions.loadHistoryPage(1, '')).rejects.toThrow('permiso')
  await actions.changePayment(harness.ticket, 'cash')
  await actions.refund(harness.ticket, [{ lineId: 'line', quantity: 1 }], 'card')
  await actions.voidTicket(harness.ticket)
  await actions.reprint(harness.ticket)
  expect(harness.calls.errors).toHaveLength(5)
  expect(harness.calls.enqueued).toEqual([])
  expect(harness.calls.ledgers).toEqual([])
  expect(harness.calls.tickets).toEqual([])
  expect(harness.calls.remoteHistory).toBe(0)
  expect(harness.calls.historyOpen).toEqual([])
})

it('rejects restaurant price and quantity changes when the worker only has permission to create orders', () => {
  const harness = createRestaurantControllerHarness()
  harness.options.context = withPersonalStaff(personalContext, employeeSnapshot)
  const actions = harness.render()
  const original = structuredClone(harness.order)
  actions.changeLineQuantity('line', 1)
  actions.changeLineQuantity('line', -1)
  actions.setLineQuantity('line', 3)
  actions.setLineUnitPrice('line', 100)
  expect(harness.order).toEqual(original)
  expect(harness.calls.drafts).toEqual([])
})
