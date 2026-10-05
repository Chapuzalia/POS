import assert from 'node:assert/strict'
import test from 'node:test'
import { addConfirmedProductSalesStats } from '../src/features/quick-sale/services/productSalesStats.ts'
import { createProductSalesStatsRefresh } from '../src/features/quick-sale/services/productSalesStatsRefresh.ts'

test('confirmed ticket totals and fractional allocations update the ranking without recomputing prices', () => {
  const initial = [{ productId: 'p', quantity: 2, totalCents: 1800 }]
  assert.deepEqual(addConfirmedProductSalesStats(initial, [
    { productId: 'p', quantity: 0.5, lineTotalCents: 333 },
    { productId: 'q', quantity: 1, lineTotalCents: 1000 },
    { productId: 'p', quantity: 0.5, lineTotalCents: 334 },
    { productId: '', quantity: 1, lineTotalCents: 999 },
  ]), [{ productId: 'p', quantity: 3, totalCents: 2467 }, { productId: 'q', quantity: 1, totalCents: 1000 }])
  assert.deepEqual(initial, [{ productId: 'p', quantity: 2, totalCents: 1800 }])
})

function harness(load) {
  let time = 0
  let allowed = true
  let revision = 0
  const applied = []
  const controller = createProductSalesStatsRefresh({
    load, apply: (stats) => applied.push(stats), canRefresh: () => allowed,
    revision: () => revision, now: () => time,
  })
  return {
    controller, applied,
    advance: () => { time += 300_000 },
    block: () => { allowed = false },
    unblock: () => { allowed = true },
    mutate: () => { revision++ },
  }
}

test('initial load is reused, refreshes share requests and blocked periods do not consume freshness', async () => {
  let calls = 0
  let finish
  const h = harness(() => { calls++; return new Promise((resolve) => { finish = resolve }) })
  await h.controller.refreshIfStale()
  assert.equal(calls, 0)
  h.advance()
  h.block()
  await h.controller.refreshIfStale()
  assert.equal(calls, 0)
  h.unblock()
  const first = h.controller.refreshIfStale()
  assert.equal(first, h.controller.refreshIfStale())
  await Promise.resolve()
  finish([{ productId: 'other-terminal', quantity: 5, totalCents: 500 }])
  await first
  assert.equal(calls, 1)
  assert.equal(h.applied[0][0].productId, 'other-terminal')
  await h.controller.refreshIfStale()
  assert.equal(calls, 1)
})

test('late remote snapshots cannot overwrite a concurrent sale, blocked operation or switched session', async () => {
  for (const invalidate of ['mutate', 'block', 'dispose']) {
    let finish
    const h = harness(() => new Promise((resolve) => { finish = resolve }))
    h.advance()
    const pending = h.controller.refreshIfStale()
    await Promise.resolve()
    if (invalidate === 'dispose') h.controller.dispose()
    else h[invalidate]()
    finish([])
    await pending
    assert.deepEqual(h.applied, [])
  }
})

test('temporary refresh failure preserves local ranking and permits a later retry', async () => {
  let calls = 0
  const h = harness(async () => { if (++calls === 1) throw new Error('offline'); return [] })
  h.advance()
  await assert.rejects(h.controller.refreshIfStale(), /offline/)
  assert.deepEqual(h.applied, [])
  await h.controller.refreshIfStale()
  assert.equal(calls, 1)
  h.advance()
  await h.controller.refreshIfStale()
  assert.deepEqual(h.applied, [[]])
})

