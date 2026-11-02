import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'

it('defers dependent payment/void events after a failed sale while syncing unrelated sales, then retries in order', async () => {
  const events = [
    { id: 'create-a', kind: 'sale_created', attempts: 0, payload: { sale: { id: 'a' } } },
    { id: 'payment-a', kind: 'sale_payment_changed', attempts: 0, payload: { saleId: 'a' } },
    { id: 'create-b', kind: 'sale_created', attempts: 0, payload: { sale: { id: 'b' } } },
    { id: 'void-a', kind: 'sale_voided', attempts: 0, payload: { saleId: 'a' } },
    { id: 'payment-b', kind: 'sale_payment_changed', attempts: 0, payload: { saleId: 'b' } },
  ]
  let queue = [...events]
  let rejectA = true
  const attempted: string[] = []
  const source = readFileSync(new URL('../../src/hooks/useOfflineSync.ts', import.meta.url), 'utf8')
  const harness = createCompiledHookRunner(source, 'useOfflineSync', {
    '../lib/observability.ts': { reportOperationError() {}, operationBreadcrumb() {}, isTransportError: () => true },
    '../lib/offlineStore': { getOfflineQueue: () => queue,
      forgetOfflineEvent: async (id: string) => { queue = queue.filter(event => event.id !== id) },
      markOfflineEventFailed: async (id: string) => { queue = queue.map(event => event.id === id ? { ...event, attempts: event.attempts + 1 } : event) } },
    '../lib/supabase': { supabaseConfig: { isReady: true } },
    '../services/posService': { syncEvent: async (event: typeof events[number]) => {
      attempted.push(event.id)
      if (rejectA && event.id === 'create-a') throw new Error('Network')
    } },
    '../utils/errors': {}, '../features/offline/services/cashSessionRejection': { isClosedCashSaleRejection: () => false },
    '../lib/durableSales.ts': { loadDurableEvents: async () => [] },
  })
  await harness.render(true, false).syncPendingEvents()
  expect(attempted).toEqual(['create-a', 'create-b', 'payment-b'])
  expect(queue.map(event => [event.id, event.attempts])).toEqual([['create-a', 1], ['payment-a', 0], ['void-a', 0]])
  rejectA = false
  await harness.render(true, false).syncPendingEvents()
  expect(attempted).toEqual(['create-a', 'create-b', 'payment-b', 'create-a', 'payment-a', 'void-a'])
  expect(queue).toEqual([])
  harness.unmount()
})
