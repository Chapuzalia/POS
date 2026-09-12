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

test('dispense acepta una respuesta posterior a 5 s y conserva el payload', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const { client, calls, respond } = pendingClient()
  const denominations = [{ valueCents: 200, quantity: 3 }]
  const result = client.dispenseCashlogyGiveChange('operation/1', denominations)
  t.mock.timers.tick(6_000)
  assert.equal(calls[0].signal.aborted, false)
  assert.ok(calls[0].url.endsWith('/give-change/operation%2F1/dispense'))
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].body), { denominations })
  respond()
  assert.deepEqual(await result, { ok: true })
  t.mock.timers.tick(30_000)
  assert.equal(calls[0].signal.aborted, false, 'se limpia el timer tras completar')
  assert.equal(calls.length, 1)
})

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

for (const defaultTimeoutMs of [undefined, 1234]) {
  test(`las otras requests conservan sus timeouts (default ${defaultTimeoutMs ?? 5000})`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const { client, calls, respond } = pendingClient({ defaultTimeoutMs })
    const normal = defaultTimeoutMs ?? 5_000
    const requests = [
      [() => client.printTicket({}), normal],
      [() => client.getPrinters(), normal],
      [() => client.getCashlogyHealth(), normal],
      [() => client.startCashlogyGiveChange('request'), normal],
      [() => client.getCashlogyGiveChange('operation'), normal],
      [() => client.finalizeCashlogyGiveChangeAdmission('operation'), normal],
      [() => client.finalizeCashlogyRefill('operation'), normal],
      [() => client.withdrawCashlogyCash('request', []), normal],
      [() => client.emptyCashlogy('request'), normal],
      [() => client.cancelActiveCashlogyOperation(), normal],
      [() => client.initializeCashlogyConnector('connector'), normal],
      [() => client.resetCashlogy(), normal],
      [() => client.recoverCashlogyTransaction('transaction'), normal],
      [() => client.getCashlogyCashManagementOperationByRequestId('request'), normal],
      [() => client.health(), 2_500],
      [() => client.collectCashlogyStacker('request'), 910_000],
      [() => client.recoverCashlogy(), 240_000],
    ]
    for (const [request, timeout] of requests) {
      const initialCalls = calls.length
      const result = request()
      const call = calls.at(-1)
      t.mock.timers.tick(timeout - 1)
      assert.equal(call.signal.aborted, false, call.url)
      t.mock.timers.tick(1)
      assert.equal(call.signal.aborted, true, call.url)
      // Resolve the retry, if this GET retries after its existing 250 ms delay.
      await Promise.resolve()
      const outcome = result.catch((error) => error)
      t.mock.timers.tick(250)
      await Promise.resolve()
      respond()
      const value = await outcome
      if (call.method === 'GET') {
        assert.deepEqual(value, { ok: true })
        assert.equal(calls.length - initialCalls, 2, 'GET conserva su reintento')
      } else {
        assert.equal(value.code, 'TIMEOUT')
        assert.equal(calls.length - initialCalls, 1, 'POST no se reenvía')
      }
    }
  })
}
