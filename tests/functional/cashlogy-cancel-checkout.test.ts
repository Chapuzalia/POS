import { readFileSync } from 'node:fs'
import { expect, it, vi } from 'vitest'
import { compileComponent } from '../helpers/component-harness.mjs'

const source = readFileSync(new URL('../../src/features/restaurant/services/checkout.ts', import.meta.url), 'utf8')
const context = { tenantId: 'tenant', venueId: 'venue', deviceId: 'device', userId: 'user' }
const session = { id: 'session' }
const cancelled = { key: 'archive', originalKey: 'original', eventId: 'event', state: 'cancelled',
  checkoutCancellationPending: true, params: { orderId: 'order' } }

function harness({ recorded = false, fiscal = false, unavailable = false } = {}) {
  const calls: string[] = []
  const filters: Array<[string, unknown]> = []
  const finish = vi.fn(async () => {})
  const commit = vi.fn(async () => {})
  const query = { select() { return this }, eq(key: string, value: unknown) { filters.push([key, value]); return this },
    abortSignal() { return this }, maybeSingle: async () => ({ data: recorded ? { operation_id: 'event' } : null, error: null }) }
  const service = compileComponent(source, {
    '../../../lib/supabase': { supabase: {
      rpc: async () => { calls.push('cancel'); return { error: unavailable ? new Error('offline') : null } },
      from: () => { calls.push('read'); return query },
    } },
    '../../../lib/durableSales.ts': { loadPaymentOperations: async () => [cancelled],
      finishPaymentOperationCancellation: finish, commitPaymentOperation: commit },
    '../../fiscal/local/restaurantInvoice.ts': { reconcileCancelledRestaurantInvoice: async () => {
      calls.push('fiscal'); return fiscal ? { payload: { sale: { id: 'existing-sale' } }, result: {} } : null
    } },
  }, { Error, AbortSignal })
  return { service, calls, filters, finish, commit }
}

it('releases a cancelled restaurant checkout before allowing a fresh payment, preserving all scope filters', async () => {
  const h = harness()
  await h.service.reconcileCancelledRestaurantCheckouts(context, session, 'order')
  expect(h.calls).toEqual(['cancel', 'fiscal', 'read'])
  expect(h.finish).toHaveBeenCalledOnce()
  expect(h.filters).toEqual([['operation_id', 'event'], ['tenant_id', 'tenant'], ['venue_id', 'venue'], ['device_id', 'device'], ['user_id', 'user']])
})

it('retains pending cancellation on network failure and does not touch a different order', async () => {
  const h = harness({ unavailable: true })
  await h.service.reconcileCancelledRestaurantCheckouts(context, session, 'another-order')
  expect(h.calls).toEqual([])
  await expect(h.service.reconcileCancelledRestaurantCheckouts(context, session, 'order')).rejects.toThrow('offline')
  expect(h.finish).not.toHaveBeenCalled()
})

it('does not collect a new payment when a lost reply actually committed the original fiscal sale', async () => {
  const h = harness({ fiscal: true })
  await expect(h.service.reconcileCancelledRestaurantCheckouts(context, session, 'order')).rejects.toThrow('ya está registrada')
  expect(h.commit).toHaveBeenCalledOnce()
  expect(h.calls).toEqual(['cancel', 'fiscal'])
})

it('also recognises a previously committed non-fiscal restaurant sale', async () => {
  const h = harness({ recorded: true })
  await expect(h.service.reconcileCancelledRestaurantCheckouts(context, session, 'order')).rejects.toThrow('ya está registrada')
  expect(h.finish).toHaveBeenCalledOnce()
})
