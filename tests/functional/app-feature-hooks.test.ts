import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createCompiledHookRunner } from '../helpers/component-harness.mjs'
import { createProductSalesStatsRefresh } from '../../src/features/quick-sale/services/productSalesStatsRefresh'
import * as productStats from '../../src/features/quick-sale/services/productSalesStats'
import { createTenantFeatureRefresh } from '../../src/features/platform/tenantFeatureRefresh'

const context = { tenantId: 'tenant', venueId: 'venue', userId: 'user', role: 'cashier', deviceMode: 'checkout', features: [] }
const line = { productId: 'product', quantity: 2, lineTotalCents: 398 }
const stats = [{ productId: 'product', quantity: 2, totalCents: 398 }]
const source = (file: string) => readFileSync(new URL(`../../src/${file}`, import.meta.url), 'utf8')
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(() => { vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

function statsHarness(load = vi.fn(async () => stats)) {
  const cache = vi.fn()
  const harness = createCompiledHookRunner(source('features/quick-sale/hooks/useProductSalesStats.ts'), 'useProductSalesStats', {
    '../services/productSalesStats': productStats,
    '../services/productSalesStatsRefresh': { createProductSalesStatsRefresh, PRODUCT_SALES_STATS_REFRESH_MS: 300_000 },
    '../../../lib/offlineStore': { saveCachedProductSalesStats: cache },
    '../../../services/posService': { loadProductSalesStatsFromSupabase: load },
    '../../../app/app-permissions': { isBackofficeUser: (c: typeof context) => c.role === 'owner' },
  }, { window: { setInterval, clearInterval }, document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} } })
  return { harness, cache }
}

it('preserves confirmed sales and refunds in the cached product ranking', () => {
  const { harness, cache } = statsHarness()
  let result = harness.render(context, false)
  result.addConfirmed({ payload: { lines: [line] } })
  result = harness.render(context, false)
  expect(result.stats).toEqual(stats)
  expect(cache).toHaveBeenLastCalledWith('tenant', stats)
  result.subtract([{ ...line, quantity: 1, lineTotalCents: 199 }])
  expect(harness.render(context, false).stats).toEqual([{ productId: 'product', quantity: 1, totalCents: 199 }])
  harness.unmount()
})

it('does not overwrite a local sale with an older remote ranking', async () => {
  let resolve!: (value: typeof stats) => void
  const load = vi.fn(() => new Promise<typeof stats>((done) => { resolve = done }))
  const { harness } = statsHarness(load)
  const result = harness.render(context, true)
  await vi.advanceTimersByTimeAsync(300_000)
  result.addConfirmed({ payload: { lines: [line] } })
  resolve([])
  await tick()
  expect(harness.render(context, true).stats).toEqual(stats)
  harness.unmount()
})

it('pauses ranking reads during pending economic recovery and resumes afterwards', async () => {
  const load = vi.fn(async () => stats)
  const { harness } = statsHarness(load)
  const result = harness.render(context, true)
  let finish!: () => void
  const recovery = result.trackRefresh(() => new Promise<void>((done) => { finish = done }))
  await vi.advanceTimersByTimeAsync(300_000)
  expect(load).not.toHaveBeenCalled()
  finish()
  await recovery
  await vi.advanceTimersByTimeAsync(300_000)
  expect(harness.render(context, true).stats).toEqual(stats)
  harness.unmount()
})

it('keeps ranking reads blocked during a payment and releases recovery after an error', async () => {
  const load = vi.fn(async () => stats)
  const { harness } = statsHarness(load)
  const result = harness.render(context, true)
  result.setRefreshBlocked(true)
  await vi.advanceTimersByTimeAsync(300_000)
  expect(load).not.toHaveBeenCalled()
  result.setRefreshBlocked(false)
  await expect(result.trackRefresh(async () => { throw new Error('unavailable') })).rejects.toThrow('unavailable')
  await vi.advanceTimersByTimeAsync(300_000)
  expect(harness.render(context, true).stats).toEqual(stats)
  harness.unmount()
})

it('discards a remote ranking for a venue that is no longer active', async () => {
  let resolve!: (value: typeof stats) => void
  const { harness, cache } = statsHarness(vi.fn(() => new Promise<typeof stats>((done) => { resolve = done })))
  harness.render(context, true)
  await vi.advanceTimersByTimeAsync(300_000)
  harness.render({ ...context, venueId: 'other' }, true)
  resolve(stats)
  await tick()
  expect(harness.render({ ...context, venueId: 'other' }, true).stats).toEqual([])
  expect(cache).not.toHaveBeenCalled()
  harness.unmount()
})

it('ignores feature responses from the previous venue after a context switch', async () => {
  let resolve!: (value: string[]) => void
  const load = vi.fn(() => new Promise<string[]>((done) => { resolve = done }))
  let current = { ...context, features: undefined as string[] | undefined }
  const cache = vi.fn()
  const setContext = (update: (value: typeof current) => typeof current) => { current = update(current) }
  const harness = createCompiledHookRunner(source('features/platform/useTenantFeatures.ts'), 'useTenantFeatures', {
    './tenantFeatureRefresh': { createTenantFeatureRefresh, subscribeTenantFeatureRefresh: (refresh: () => Promise<void>) => { void refresh(); return () => {} } },
    '../../services/posService': { loadTenantFeatures: load },
    '../../lib/offlineStore': { saveCachedContext: cache },
    '../../app/app-permissions': { isSuperadmin: () => false },
  })
  harness.render(current, true, setContext)
  await tick()
  const oldResolve = resolve
  current = { ...current, venueId: 'other' }
  harness.render(current, true, setContext)
  oldResolve(['restaurant'])
  await tick()
  expect(current.features).toBeUndefined()
  expect(cache).not.toHaveBeenCalled()
  harness.unmount()
})

it('applies feature refreshes to the active context and caches the same result', async () => {
  let current = { ...context, features: undefined as string[] | undefined }
  const cache = vi.fn()
  const harness = createCompiledHookRunner(source('features/platform/useTenantFeatures.ts'), 'useTenantFeatures', {
    './tenantFeatureRefresh': { createTenantFeatureRefresh, subscribeTenantFeatureRefresh: (refresh: () => Promise<void>) => { void refresh(); return () => {} } },
    '../../services/posService': { loadTenantFeatures: async () => ['restaurant'] },
    '../../lib/offlineStore': { saveCachedContext: cache },
    '../../app/app-permissions': { isSuperadmin: () => false },
  })
  harness.render(current, true, (update: (value: typeof current) => typeof current) => { current = update(current) })
  await tick()
  expect(current.features).toEqual(['restaurant'])
  expect(cache).toHaveBeenLastCalledWith(current)
  harness.unmount()
})
