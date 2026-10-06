import assert from 'node:assert/strict'
import test from 'node:test'
import { createTenantFeatureRefresh, subscribeTenantFeatureRefresh } from '../src/features/platform/tenantFeatureRefresh.ts'

test('loaded session features avoid another request until 60 seconds have passed', async () => {
  let time = 0
  let calls = 0
  const controller = createTenantFeatureRefresh(async () => { calls++; return ['restaurant'] }, true, () => time)
  assert.equal(await controller.refreshIfStale(), undefined)
  time = 59_999
  assert.equal(await controller.refreshIfStale(), undefined)
  time = 60_000
  assert.deepEqual(await controller.refreshIfStale(), ['restaurant'])
  assert.equal(calls, 1)
  assert.equal(await controller.refreshIfStale(), undefined)
})

test('overlapping focus, visibility and polling share one request', async () => {
  let calls = 0
  let finish
  const controller = createTenantFeatureRefresh(() => {
    calls++
    return new Promise((resolve) => { finish = resolve })
  }, false)
  const first = controller.refreshIfStale()
  const second = controller.refreshIfStale()
  const third = controller.refreshIfStale()
  assert.equal(first, second)
  assert.equal(second, third)
  await Promise.resolve()
  assert.equal(calls, 1)
  finish(['inventory'])
  assert.deepEqual(await first, ['inventory'])
})

test('failed refresh can retry later without a focus request storm; scopes remain independent', async () => {
  let time = 0
  let calls = 0
  const controller = createTenantFeatureRefresh(async () => {
    calls++
    if (calls === 1) throw new Error('backend unavailable')
    return []
  }, false, () => time)
  await assert.rejects(controller.refreshIfStale(), /backend unavailable/)
  assert.equal(await controller.refreshIfStale(), undefined)
  time = 60_000
  assert.deepEqual(await controller.refreshIfStale(), [])
  assert.equal(calls, 2)
  const anotherScope = createTenantFeatureRefresh(async () => ['cashlogy'], false, () => time)
  assert.deepEqual(await anotherScope.refreshIfStale(), ['cashlogy'])
})

test('hidden tabs stop polling; visibility resumes it and cleanup removes all listeners', async () => {
  const browserWindow = new EventTarget()
  const browserDocument = new EventTarget()
  browserDocument.visibilityState = 'visible'
  const intervals = new Map()
  let nextId = 0
  browserWindow.setInterval = (callback, delay) => {
    assert.equal(delay, 60_000)
    intervals.set(++nextId, callback)
    return nextId
  }
  browserWindow.clearInterval = (id) => { intervals.delete(id) }
  let calls = 0
  const cleanup = subscribeTenantFeatureRefresh(async () => { calls++ }, browserWindow, browserDocument)
  assert.equal(calls, 1)
  assert.equal(intervals.size, 1)
  browserWindow.dispatchEvent(new Event('focus'))
  assert.equal(calls, 2)
  browserDocument.visibilityState = 'hidden'
  browserDocument.dispatchEvent(new Event('visibilitychange'))
  browserWindow.dispatchEvent(new Event('focus'))
  assert.equal(calls, 2)
  assert.equal(intervals.size, 0)
  browserDocument.visibilityState = 'visible'
  browserDocument.dispatchEvent(new Event('visibilitychange'))
  assert.equal(calls, 3)
  assert.equal(intervals.size, 1)
  cleanup()
  browserWindow.dispatchEvent(new Event('focus'))
  browserDocument.dispatchEvent(new Event('visibilitychange'))
  assert.equal(calls, 3)
  assert.equal(intervals.size, 0)
})
