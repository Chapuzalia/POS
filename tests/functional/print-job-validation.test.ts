import { expect, it, vi } from 'vitest'
import { createPrintAgentClient } from '../../src/features/local-printing/api/printAgentClient'
import { usePrintAgentStore } from '../../src/features/local-printing/store/usePrintAgentStore'

vi.mock('../../src/lib/observability.ts', () => ({ reportOperationError() {} }))

function client(body: unknown) {
  return createPrintAgentClient({ baseUrl: 'https://agent.test', token: 'token', fetchImpl: async () => Response.json(body) })
}

it.each([
  { id: 'another-job', status: 'printed' },
  { id: 'expected', jobId: 'another-job', status: 'printed' },
  { id: 'expected', status: 'invented' },
  { status: 'printed' },
])('rejects untrustworthy job identity or state: %j', async body => {
  await expect(client(body).getJob('expected')).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it.each([
  { ok: false, jobId: 'job', status: 'printed' },
  { ok: true, jobId: 'job', requestId: 'another-request', status: 'printed' },
  { ok: true, jobId: 'job', status: 'invented' },
])('rejects a print acknowledgement that cannot confirm the request: %j', async body => {
  await expect(client(body).printTicket({ requestId: 'expected' })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it('preserves both deployed job ID shapes and optional acknowledgement status', async () => {
  await expect(client({ id: 'expected', status: 'printed' }).getJob('expected')).resolves.toMatchObject({ status: 'printed' })
  await expect(client({ jobId: 'expected', status: 'printed' }).getJob('expected')).resolves.toMatchObject({ status: 'printed' })
  await expect(client({ ok: true, jobId: 'expected' }).printTicket({ requestId: 'request' })).resolves.toMatchObject({ jobId: 'expected' })
})

it('rejects the right job ID when its request belongs to another print', async () => {
  await expect(client({ id: 'job', requestId: 'another', status: 'printed' }).getJob('job', undefined, 'expected'))
    .rejects.toMatchObject({ code: 'INVALID_RESPONSE' })
})

it('keeps an unrelated printed job uncertain without submitting another print', async () => {
  let prints = 0
  vi.stubGlobal('fetch', async (url: string) => {
    if (new URL(url).pathname === '/api/v1/print') {
      prints += 1
      return Response.json({ ok: true, jobId: 'expected', status: 'pending' })
    }
    return Response.json({ id: 'another-job', requestId: 'another-request', status: 'printed' })
  })
  usePrintAgentStore.setState({ baseUrl: 'https://agent.test', token: 'token' })
  try {
    await expect(usePrintAgentStore.getState().printTicket({
      requestId: 'print:expected', printerId: 'printer', force: false, lines: ['Receipt'],
      options: { cut: true, copies: 1, openCashDrawer: false },
    })).rejects.toMatchObject({ code: 'PRINT_STATUS_UNKNOWN' })
    expect(usePrintAgentStore.getState().currentJob?.status).toBe('unknown')
    expect(prints).toBe(1)
  } finally { vi.unstubAllGlobals() }
})
