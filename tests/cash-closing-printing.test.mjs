import assert from 'node:assert/strict'

import test from 'node:test'

import { createPrintAgentClient } from '../src/features/local-printing/api/printAgentClient.ts'

import { mapCashClosingToPrintRequest } from '../src/features/local-printing/services/cashClosingPrintMapper.ts'
import { checkUnknownClosingJob, nextCashClosingCopyNumber } from '../src/features/cash-registers/services/cashClosingPrintRecovery.ts'
import { pollPrintJob } from '../src/features/local-printing/services/jobPolling.ts'

const snapshot = {
  reportTitle: 'Informe ABCD1234', companyName: 'MESS', registerName: 'Barra principal', shiftLabel: 'ABCD1234',
  openedAt: '2026-07-20T20:00:00+02:00', closedAt: '2026-07-21T01:30:00+02:00',
  timezone: 'Europe/Madrid', currency: 'EUR', locale: 'es-ES', openedBy: 'David', closedBy: 'Paula',
  summary: { totalSalesCents: 100000, salesCount: 100, averageSaleCents: 1000 },
  payments: [
    { code: 'cash', label: 'Efectivo', amountCents: 75000 },
    { code: 'card', label: 'Tarjeta', amountCents: 20000 },
    { code: 'bizum', label: 'Bizum', amountCents: 5000 },
    { code: 'invitation', label: 'Invitación', amountCents: 0 },
  ],
  cashMovements: { cashEntriesCents: 500, cashExitsCents: 200, cardCashbackCents: 300 },
  cashFund: { openingCashFundCents: 5000, finalCashFundCents: 5000 },
  expectedAndCounted: { expectedCashCents: 80300, countedCashCents: 80200, expectedCardCents: 20000, countedCardCents: 20000 },
  differences: { cashDifferenceCents: -100, cardDifferenceCents: 0 },
}

const closing = {
  id: 'closing_123', tenantId: 'tenant', venueId: 'mess', cashRegisterId: 'register',
  closedAt: snapshot.closedAt, closedBy: 'user', notes: '', printSnapshot: snapshot, printStatus: 'not_requested',
  printJobId: null, printRequestId: null, printedAt: null, printErrorCode: null, printAttempts: 0, printCopies: 0,
}

const establishment = { name: 'MESS', legalName: 'MESS EVENTS SL', taxId: 'B12345678', address: 'Carrer Major 1' }

const layout80 = { columns: 48, paperWidth: 80, characterSet: 'CP858' }
const settings = {
  autoOpenCashDrawer: true, alwaysPrintTicket: true, cut: true, copies: 1, footer: '',
  printCashClosingAutomatically: true, includeExpectedAndCountedAmounts: true, includeUserNames: true,
  includeOpeningAndClosingTimes: true, includeZeroPaymentMethods: false, includeTotalPayments: true,
  cashClosingCopies: 1, moneySymbol: 'currency',
}

test('envía exclusivamente instrucciones resueltas y opciones físicas al endpoint idempotente', async () => {
  let sent
  const client = createPrintAgentClient({
    baseUrl: 'https://tpv-printer.local:8443',
    token: 'secret',
    fetchImpl: async (url, init) => {
      sent = { url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) }
      return new Response(JSON.stringify({ ok: true, status: 'printed' }))
    },
  })
  const request = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings })
  await client.printTicket(request)
  assert.equal(new URL(sent.url).pathname, '/api/v1/print')
  assert.equal(sent.method, 'POST')
  assert.deepEqual(sent.body, request)
  assert.deepEqual(Object.keys(sent.body).sort(), ['elements', 'force', 'lines', 'options', 'printerId', 'requestId'])
  for (const legacy of ['ticket', 'items', 'products', 'prices', 'subtotal', 'total', 'payments']) {
    assert.equal(legacy in sent.body, false)
  }
})

test('un cierre incierto solo permite copia manual cuando el trabajo anterior ya no puede imprimir', async () => {
  const uncertain = { ...closing, printStatus: 'unknown', printRequestId: 'cash-closing:closing_123:original', printJobId: 'job-original', printAttempts: 1 }
  const lookup = async (status) => checkUnknownClosingJob(uncertain, async (requestId, jobId) => {
    assert.equal(requestId, uncertain.printRequestId)
    assert.equal(jobId, uncertain.printJobId)
    return status ? { id: jobId, requestId, status } : null
  })
  assert.equal(await lookup('pending'), 'in_progress')
  assert.equal(await lookup('connecting'), 'in_progress')
  assert.equal(await lookup('printing'), 'in_progress')
  assert.equal(await lookup('printed'), 'printed')
  assert.equal(await lookup('failed'), 'ready')
  assert.equal(await lookup('unknown'), 'ready')
  assert.equal(await lookup(null), 'ready')
  const checkedIds = []
  assert.equal(await checkUnknownClosingJob({ ...uncertain, printRequestId: 'cash-closing:closing_123:copy:1' }, async (requestId, jobId) => {
    checkedIds.push(jobId)
    return jobId ? { id: jobId, requestId: uncertain.printRequestId, status: 'failed' } : { requestId, status: 'pending' }
  }), 'in_progress', 'el jobId heredado no autoriza otra copia mientras el intento actual siga pendiente')
  assert.deepEqual(checkedIds, ['job-original', undefined])
  assert.equal(nextCashClosingCopyNumber(uncertain), 1)
  assert.equal(nextCashClosingCopyNumber({ ...uncertain, printAttempts: 2 }), 2, 'un nuevo intento no reutiliza el requestId de la copia fallida')
  const copy = mapCashClosingToPrintRequest({ closing: uncertain, establishment, printerId: 'main', printerLayout: layout80, settings, isReprint: true, copyNumber: nextCashClosingCopyNumber(uncertain) })
  assert.equal(copy.requestId, 'cash-closing:closing_123:copy:1')
  assert.equal(copy.options.openCashDrawer, false)
})

test('el POS consulta por jobId después de la respuesta pending y observa el fallo o la impresión posterior', async () => {
  const jobs = new Map()
  const requests = []
  let poweredOn = false
  const client = createPrintAgentClient({ baseUrl: 'https://agent.local', token: 'secret', fetchImpl: async (url, init) => {
    const path = new URL(url).pathname
    requests.push(path)
    if (path === '/api/v1/print') {
      const request = JSON.parse(String(init.body))
      const jobId = `job-${jobs.size + 1}`
      jobs.set(jobId, { id: jobId, requestId: request.requestId, status: 'pending' })
      queueMicrotask(() => jobs.set(jobId, { ...jobs.get(jobId), status: poweredOn ? 'printed' : 'failed' }))
      return new Response(JSON.stringify({ ok: true, jobId, status: 'pending' }))
    }
    const jobId = path.split('/').at(-1)
    return new Response(JSON.stringify(jobs.get(jobId)))
  } })
  const original = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings })
  const accepted = await client.printTicket(original)
  assert.equal(accepted.status, 'pending')
  assert.equal((await pollPrintJob(client, accepted.jobId, { intervalMs: 1, maxWaitMs: 100 })).status, 'failed')
  poweredOn = true
  const copy = mapCashClosingToPrintRequest({ closing, establishment, printerId: 'main', printerLayout: layout80, settings, isReprint: true, copyNumber: 1 })
  const copyAccepted = await client.printTicket(copy)
  assert.equal((await pollPrintJob(client, copyAccepted.jobId, { intervalMs: 1, maxWaitMs: 100 })).status, 'printed')
  assert.deepEqual(requests, ['/api/v1/print', '/api/v1/jobs/job-1', '/api/v1/print', '/api/v1/jobs/job-2'])
})
