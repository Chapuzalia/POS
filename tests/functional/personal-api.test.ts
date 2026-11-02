import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHmac } from 'node:crypto'
import type { Server } from 'node:http'
import { createApp } from '../../apps/api/src/app'
import { employeeSnapshot, personalIds as ids } from '../helpers/personal'

const secret = 'a'.repeat(64)
const rpc = vi.fn()
let server: Server
let base: string
beforeEach(async () => {
  rpc.mockImplementation(async (name: string) => ({ data: name === 'tickit_personal_credentials' ? { secret } : ids.tenant, error: null }))
  server = createApp({ rpc }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Missing test server')
  base = `http://127.0.0.1:${address.port}/personal`
})
afterEach(async () => { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) })
function signed(body: unknown, timestamp = String(Math.floor(Date.now() / 1000))) {
  const raw = JSON.stringify(body)
  return { method: 'POST', body: raw, headers: { 'content-type': 'application/json', 'x-tickit-connection': ids.connection, 'x-tickit-timestamp': timestamp, 'x-tickit-signature': createHmac('sha256', secret).update(`${timestamp}.${raw}`).digest('hex') } }
}
it('links on the existing API through a separate signed module and signs the challenge response', async () => {
  const result = await fetch(`${base}/link`, signed({ contract_version: 1, connection_id: ids.connection, organization_id: ids.personalOrg, external_organization_id: ids.tenant, challenge: ids.employee }))
  expect(result.status).toBe(200)
  const raw = await result.text()
  expect(result.headers.get('x-tickit-signature')).toBe(createHmac('sha256', secret).update(`${result.headers.get('x-tickit-timestamp')}.${raw}`).digest('hex'))
  expect(JSON.parse(raw).capabilities).toContain('staff.snapshot.v1')
  expect(rpc).toHaveBeenCalledWith('tickit_personal_ingest', expect.objectContaining({ p_kind: 'link' }))
})
it('rejects bad and stale signatures before ingesting any workers', async () => {
  for (const init of [signed({}, '1000000000'), { ...signed({}), body: '{"tampered":true}' }]) expect((await fetch(`${base}/events`, init)).status).toBe(401)
  expect(rpc.mock.calls.some(([name]) => name === 'tickit_personal_ingest')).toBe(false)
})
it('acknowledges valid snapshots and rejects malformed payloads without persistence', async () => {
  const event = { contract_version: 1, event_id: ids.employee, event_type: 'staff.updated', occurred_at: new Date().toISOString(), organization_id: ids.personalOrg, target_organization_id: ids.tenant, payload: employeeSnapshot }
  const result = await fetch(`${base}/events`, signed(event))
  expect(await result.json()).toEqual({ event_id: ids.employee })
  expect(result.status).toBe(200)
  rpc.mockClear()
  expect((await fetch(`${base}/events`, signed({ ...event, payload: { ...employeeSnapshot, pin: '123456' } }))).status).toBe(422)
  expect(rpc.mock.calls.some(([name]) => name === 'tickit_personal_ingest')).toBe(false)
})
it('fails closed when the connector is unavailable and does not leak service errors', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'private diagnostic secret' } })
  const result = await fetch(`${base}/events`, signed({}))
  expect(result.status).toBe(503)
  expect(await result.text()).not.toContain('private diagnostic')
})
