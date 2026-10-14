import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { compileComponent } from './helpers/component-harness.mjs'

const { pendingSync } = compileComponent(readFileSync(new URL('../src/features/offline/services/pendingSync.ts', import.meta.url), 'utf8'), {})

test('shared counters retain cash operations and do not count economic/fiscal tickets twice', () => {
  const result = pendingSync([
    { kind: 'cash_opened', payload: {} },
    { kind: 'sale_created', payload: { ticket: { id: 'sale-1' } } },
    { kind: 'sale_payment_changed', payload: { saleId: 'economic-sale' } },
  ], ['sale-1', 'sale-2', 'sale-2'])
  assert.equal(result.pendingCount, 4)
  assert.deepEqual([...result.pendingTicketIds], ['sale-1', 'sale-2'])
  assert.deepEqual([...result.pendingSaleIds], ['economic-sale'])
  assert.equal(pendingSync([], ['sale-2']).pendingCount, 1)
  assert.equal(pendingSync([], []).pendingCount, 0)
})
