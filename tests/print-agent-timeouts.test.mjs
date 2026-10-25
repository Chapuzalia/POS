import assert from 'node:assert/strict'
import test from 'node:test'
import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'

function pendingClient(options = {}) {
  const calls = []
  let respond
  const client = createPrintAgentClient({
    baseUrl: 'https://agent.local', token: 'test-token', ...options,
    fetchImpl: (url, init) => new Promise((resolve, reject) => {
      calls.push({ url, ...init })
      respond = () => resolve(new Response('{"ok":true}'))
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    }),
  })
  return { client, calls, respond: () => respond() }
}

test('dispense vence exactamente a los 30 s sin reintentar, incluso con default personalizado', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, calls } = pendingClient({ defaultTimeoutMs: 100 })
  const result = client.dispenseCashlogyGiveChange('operation', [])
  const rejected = assert.rejects(result, { code: 'TIMEOUT' })
  t.mock.timers.tick(29_999)
  assert.equal(calls[0].signal.aborted, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(calls.length, 1)
})

test('dispense sigue respetando la cancelación externa sin reintentar', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, calls } = pendingClient()
  const controller = new AbortController()
  const rejected = assert.rejects(client.dispenseCashlogyGiveChange('operation', [], controller.signal), { code: 'ABORTED' })
  controller.abort()
  await rejected
  assert.equal(calls.length, 1)
})
