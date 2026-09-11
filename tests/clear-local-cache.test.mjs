import assert from 'node:assert/strict'
import test from 'node:test'
import { clearLocalStorageExceptPrintCredentials } from '../src/lib/clearLocalCache.ts'

function storage(entries) {
  const data = new Map(entries)
  return {
    get length() { return data.size },
    key: (index) => [...data.keys()][index] ?? null,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  }
}

test('removes local data and copy counters, retaining only credentials for all terminals', () => {
  const key = 'clubpos:v1:print-agent-config:tenant:venue:terminal'
  const other = 'clubpos:v1:print-agent-config:tenant:venue:other'
  const local = storage([
    ['session', 'login'], ['clubpos:v1:queue', '[1]'],
    [key, JSON.stringify({ baseUrl: 'https://agent.local', token: 'secret', selectedPrinterId: 'printer', preferences: { copies: 3 } })],
    [`${key}:copy:sale:123`, '2'],
    [other, JSON.stringify({ baseUrl: 'https://other.local', token: null })],
  ])
  clearLocalStorageExceptPrintCredentials(local)
  assert.equal(local.length, 2)
  assert.deepEqual(JSON.parse(local.getItem(key)), { baseUrl: 'https://agent.local', token: 'secret' })
  assert.deepEqual(JSON.parse(local.getItem(other)), { baseUrl: 'https://other.local', token: null })
})

test('unreadable credentials abort the storage reset without deleting data', () => {
  const key = 'clubpos:v1:print-agent-config:t:v:d'
  const local = storage([['session', 'login'], [key, '{broken']])
  assert.throws(() => clearLocalStorageExceptPrintCredentials(local))
  assert.equal(local.getItem('session'), 'login')
  assert.equal(local.getItem(key), '{broken')
})
