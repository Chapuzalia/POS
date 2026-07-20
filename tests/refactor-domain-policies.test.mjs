import assert from 'node:assert/strict'
import test from 'node:test'
import { getClosedCashState } from '../src/features/cash-registers/services/cashState.ts'
import { applyPrintFailure } from '../src/features/local-printing/services/printFailure.ts'
import { getRejectedSaleRecovery } from '../src/features/offline/services/rejectedSaleRecovery.ts'
import {
  isRestaurantRevisionConflict,
  requiresConfirmedRestaurantLineRemoval,
  shouldFlushRestaurantDraft,
  shouldSaveBeforeLeavingOrder,
} from '../src/features/restaurant/draft-policy.ts'
import { shouldResetTenantState } from '../src/features/session/session-state.ts'

test('changing tenant or user resets tenant-scoped state', () => {
  const current = { tenantId: 'tenant-a', userId: 'user-a' }
  assert.equal(shouldResetTenantState(current, { tenantId: 'tenant-a', userId: 'user-a' }), false)
  assert.equal(shouldResetTenantState(current, { tenantId: 'tenant-a', userId: 'user-b' }), true)
  assert.equal(shouldResetTenantState(current, { tenantId: 'tenant-b', userId: 'user-a' }), true)
})

test('rejected offline sale restores its ticket and discount without overwriting another ticket', () => {
  const event = {
    kind: 'sale_created',
    payload: {
      sale: { id: 'sale-1' },
      ticket: {
        cashSessionId: 'closed-session',
        discount: { id: 'discount-1', name: 'Promo', type: 'fixed', amountCents: 100 },
      },
      lines: [{
        id: 'line-1',
        modifiers: [],
        productId: 'product-1',
        productName: 'Café',
        quantity: 2,
        unitPriceCents: 150,
        variantId: 'variant-1',
        variantName: 'Solo',
      }],
    },
  }
  const recovery = getRejectedSaleRecovery(event, false)
  assert.equal(recovery.closedSessionId, 'closed-session')
  assert.equal(recovery.rejectedSaleId, 'sale-1')
  assert.equal(recovery.linesToRestore[0].quantity, 2)
  assert.equal(recovery.discount.amountCents, 100)
  assert.equal(getRejectedSaleRecovery(event, true).linesToRestore, null)
})

test('closed cash cleanup removes session, ledger, and ticket history', () => {
  assert.deepEqual(getClosedCashState(), { session: null, ledger: [], tickets: [] })
})

test('restaurant draft policy covers dirty state, revision conflicts, and save-before-leave', () => {
  assert.equal(shouldFlushRestaurantDraft('dirty'), true)
  assert.equal(shouldFlushRestaurantDraft('error'), true)
  assert.equal(shouldFlushRestaurantDraft('saved'), false)
  assert.equal(isRestaurantRevisionConflict({ code: '40001' }), true)
  assert.equal(isRestaurantRevisionConflict({ code: 'PGRST116' }), false)
  assert.equal(requiresConfirmedRestaurantLineRemoval(0), false)
  assert.equal(requiresConfirmedRestaurantLineRemoval(1), true)
  assert.equal(shouldSaveBeforeLeavingOrder({ type: 'table_order', orderId: 'order-1' }, 'dirty'), true)
  assert.equal(shouldSaveBeforeLeavingOrder({ type: 'table_order', orderId: 'order-1' }, 'saving'), true)
  assert.equal(shouldSaveBeforeLeavingOrder({ type: 'table_order', orderId: 'order-1' }, 'saved'), false)
  assert.equal(shouldSaveBeforeLeavingOrder({ type: 'table_map' }, 'dirty'), false)
})

test('print failure changes only print metadata and never rolls back the sale', () => {
  const ticket = {
    id: 'sale-1',
    status: 'active',
    paymentMethod: 'card',
    payload: { sale: { id: 'sale-1', totalCents: 500 }, payment: { method: 'card' } },
    printStatus: 'pending',
    printAttempts: 1,
  }
  const failed = applyPrintFailure(ticket, 'PRINT_FAILED', 'print:sale-1:original')
  assert.equal(failed.status, 'active')
  assert.equal(failed.paymentMethod, 'card')
  assert.equal(failed.payload, ticket.payload)
  assert.equal(failed.printStatus, 'failed')
  assert.equal(failed.printErrorCode, 'PRINT_FAILED')
})
