import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aeatToCents, canonicalRecordSchema, canonicalRecordToXml, createAltaRecord, createAnulacionRecord } from '../src/features/fiscal/local/canonical.ts'
import { classifyFiscalOperation, fiscalSeries } from '../src/features/fiscal/local/fiscalPolicy.ts'
import { deliveryFromResult, resolvePendingBridgeRecord, summarizeLocalFiscalQueue } from '../src/features/fiscal/local/sync.ts'
import { BridgeHttpError } from '../src/features/fiscal/local/bridgeClient.ts'
import { assertInstallationBinding, localDateParts } from '../src/features/fiscal/local/localLedger.ts'
import { assertFiscalClock, assertFiscalLease, createLocalFallbackLease } from '../src/features/fiscal/local/clock.ts'
import { isFiscalTransportUnavailable } from '../src/features/fiscal/local/availability.ts'
import { assertRealSaleAllowedForMode } from '../src/features/fiscal/local/mode.ts'

const system = {
  NombreRazon: 'Productor ficticio', NIF: '89890001K', NombreSistemaInformatico: 'Tickit',
  IdSistemaInformatico: 'TK', Version: '0.0.0-test', NumeroInstalacion: 'install-test',
  TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
}
const invoice = { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-2026-S/1', issueDate: '28-09-2026' }
const generatedAt = '2026-09-28T12:00:00+02:00'
const details = [{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00', BaseImponibleOimporteNoSujeto: '10.00', CuotaRepercutida: '2.10' }]

test('series separate tenant-controlled installation, document kind and year', () => {
  const base = { venueCode: 'L1', registerCode: 'C1', exercise: 2026 }
  assert.equal(fiscalSeries({ ...base, kind: 'simplified' }), 'L1-C1-2026-S')
  assert.notEqual(fiscalSeries({ ...base, kind: 'complete' }), fiscalSeries({ ...base, kind: 'simplified' }))
  assert.notEqual(fiscalSeries({ ...base, exercise: 2027, kind: 'simplified' }), fiscalSeries({ ...base, kind: 'simplified' }))
  assert.throws(() => fiscalSeries({ ...base, venueCode: 'L-1', kind: 'simplified' }), /inválido/)
})

test('local installation binding rejects a different device identity', () => {
  assert.doesNotThrow(() => assertInstallationBinding({ scope: 't:s:i', deviceId: 'ipad-1' }, 'ipad-1'))
  assert.throws(() => assertInstallationBinding({ scope: 't:s:i', deviceId: 'ipad-1' }, 'ipad-2'), /otro dispositivo/)
})

test('test blocks real charges; production proceeds to fiscal preflight', () => {
  assert.doesNotThrow(() => assertRealSaleAllowedForMode('disabled'))
  assert.throws(() => assertRealSaleAllowedForMode('test'), /cobros reales están bloqueados/)
  assert.doesNotThrow(() => assertRealSaleAllowedForMode('production'))
  assert.throws(() => assertRealSaleAllowedForMode('invalid'), /mal configurado/)
})

test('refund correction, substitution and annulment remain distinct', () => {
  assert.deepEqual(classifyFiscalOperation({ kind: 'replacement', replacedInvoiceIds: ['old'], originalSaleId: 'sale', previouslyDeclared: true, originalTotalCents: 1210, replacementTotalCents: 1210 }), { documentKind: 'complete', aeatType: 'F3', accountingDeltaCents: 0 })
  assert.throws(() => classifyFiscalOperation({ kind: 'replacement', replacedInvoiceIds: ['a', 'b'], originalSaleId: 'sale', previouslyDeclared: true, originalTotalCents: 1210, replacementTotalCents: 1210 }), /exactamente una/)
  assert.throws(() => classifyFiscalOperation({ kind: 'replacement', replacedInvoiceIds: ['old'], originalSaleId: 'sale', previouslyDeclared: true, originalTotalCents: 1210, replacementTotalCents: 1211 }), /importe/)
  assert.equal(classifyFiscalOperation({ kind: 'correction', correctedInvoiceIds: ['old'], originalDocument: 'simplified', aeatType: 'R5', reason: 'Devolución parcial', method: 'difference' }).aeatType, 'R5')
  assert.throws(() => classifyFiscalOperation({ kind: 'correction', correctedInvoiceIds: ['old'], originalDocument: 'complete', aeatType: 'R5', reason: 'Error', method: 'difference' }), /R5/)
  assert.equal(classifyFiscalOperation({ kind: 'annulment', invoiceId: 'old', reason: 'Expedida indebidamente' }).recordKind, 'anulacion')
})

test('supported alta maps losslessly to ordered AEAT XML fields and QR', async () => {
  const built = await createAltaRecord({ invoice, issuerName: 'Emisor ficticio', type: 'F2', description: 'Servicio ficticio', details, system, previous: null, generatedAt, environment: 'test' })
  assert.equal(built.canonicalRecord.RegistroAlta.ImporteTotal, '12.10')
  assert.equal(built.canonicalRecord.RegistroAlta.CuotaTotal, '2.10')
  assert.match(built.qrUrl, /importe=12.10/)
  const xml = canonicalRecordToXml(built.canonicalRecord)
  assert.ok(xml.indexOf('<sf:IDFactura>') < xml.indexOf('<sf:Desglose>'))
  assert.ok(xml.indexOf('<sf:Desglose>') < xml.indexOf('<sf:SistemaInformatico>'))
  assert.match(xml, /<sf:TipoHuella>01<\/sf:TipoHuella>/)
  assert.throws(() => canonicalRecordSchema.parse({ RegistroAlta: { ...built.canonicalRecord.RegistroAlta, ImporteTotal: '12.11' } }), /custom|desglose/i)
  assert.equal(aeatToCents('12.10'), 1210)
})

test('anulacion uses its own identity and previous hash without changing the original', async () => {
  const previous = { IDEmisorFactura: invoice.issuerNif, NumSerieFactura: invoice.seriesAndNumber, FechaExpedicionFactura: invoice.issueDate, Huella: 'A'.repeat(64) }
  const built = await createAnulacionRecord({ invoice, system, previous, generatedAt })
  assert.equal(built.canonicalRecord.RegistroAnulacion.IDFactura.IDEmisorFacturaAnulada, invoice.issuerNif)
  assert.equal(built.canonicalRecord.RegistroAnulacion.Encadenamiento.RegistroAnterior.Huella, previous.Huella)
  assert.match(canonicalRecordToXml(built.canonicalRecord), /<sf:RegistroAnulacion xmlns:sf=/)
})

test('Madrid daylight saving offset changes without resetting identity or chain', () => {
  const winter = localDateParts(new Date('2026-03-29T00:30:00Z'), 'Europe/Madrid')
  const summer = localDateParts(new Date('2026-03-29T01:30:00Z'), 'Europe/Madrid')
  assert.equal(winter.generatedAt, '2026-03-29T01:30:00+01:00')
  assert.equal(summer.generatedAt, '2026-03-29T03:30:00+02:00')
  assert.equal(winter.exercise, summer.exercise)
})

test('clock reference rejects future drift, rollback and stale samples', () => {
  const sample = { serverUtcAtReceipt: '2026-09-28T10:00:00Z', wallUtcAtReceipt: Date.parse('2026-09-28T10:00:00Z'), monotonicAtReceipt: 1000 }
  assert.doesNotThrow(() => assertFiscalClock(sample, Date.parse('2026-09-28T10:01:00Z'), 61000))
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-28T10:10:00Z'), 61000), /reloj/)
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-28T09:50:00Z'), 61000), /reloj/)
  assert.throws(() => assertFiscalClock(sample, Date.parse('2026-09-29T11:00:00Z'), 90001000), /referencia horaria/)
})

test('exclusive lease is bound to device and expires using monotonic time', () => {
  const clock = { serverUtcAtReceipt: '2026-09-28T10:00:00Z', wallUtcAtReceipt: Date.parse('2026-09-28T10:00:00Z'), monotonicAtReceipt: 1000 }
  const lease = { leaseId: 'lease-1', installationId: 'install-1', deviceId: 'ipad-1', fencingToken: 1, expiresAt: '2026-09-28T10:05:00Z', clock }
  assert.doesNotThrow(() => assertFiscalLease(lease, 'install-1', 'ipad-1', Date.parse('2026-09-28T10:04:00Z'), 241000))
  assert.throws(() => assertFiscalLease(lease, 'install-1', 'ipad-2', Date.parse('2026-09-28T10:04:00Z'), 241000), /dispositivo/)
  assert.throws(() => assertFiscalLease(lease, 'install-1', 'ipad-1', Date.parse('2026-09-28T10:05:00Z'), 301000), /expirado/)
})

test('an unavailable bridge uses a short local lease but authorization and conflicts still block', () => {
  const lease = createLocalFallbackLease('install-1', 'ipad-1')
  assert.equal(lease.source, 'local-fallback')
  assert.match(lease.leaseId, /^local-/)
  assert.doesNotThrow(() => assertFiscalLease(lease, 'install-1', 'ipad-1', Date.now(), performance.now()))
  assert.equal(isFiscalTransportUnavailable(new TypeError('NetworkError when attempting to fetch resource')), true)
  assert.equal(isFiscalTransportUnavailable(new BridgeHttpError(503)), true)
  assert.equal(isFiscalTransportUnavailable(new BridgeHttpError(429)), true)
  assert.equal(isFiscalTransportUnavailable(new BridgeHttpError(401)), false)
  assert.equal(isFiscalTransportUnavailable(new BridgeHttpError(409)), false)
})

test('pending summary preserves acceptance with errors as a separate status', () => {
  const entry = (state, generatedAt) => ({ delivery: { state }, record: { generatedAt } })
  const summary = summarizeLocalFiscalQueue([entry('LOCAL_PENDING', '2026-09-28T10:00:00Z'), entry('AEAT_ACCEPTED_WITH_ERRORS', '2026-09-28T10:00:00Z')], Date.parse('2026-09-28T11:01:00Z'))
  assert.equal(summary.states.LOCAL_PENDING, 1)
  assert.equal(summary.states.AEAT_ACCEPTED_WITH_ERRORS, 1)
  assert.equal(summary.oldestPendingMinutes, 61)
})

test('AEAT rejection and acceptance with errors change only delivery metadata', () => {
  const entry = { id: 'record-1', record: Object.freeze({ hash: 'A'.repeat(64), canonicalRecord: Object.freeze({ RegistroAlta: { Huella: 'A'.repeat(64) } }) }),
    delivery: { state: 'VPS_STORED', attempts: 1, lastError: null, result: null } }
  const common = { idempotencyKey: entry.id, csv: null, responseRef: 'response', vpsStoredAt: '2026-09-28T10:01:00Z', aeatRespondedAt: '2026-09-28T10:02:00Z' }
  const rejected = deliveryFromResult(entry, { ...common, state: 'AEAT_REJECTED', code: '123', description: 'Error fiscal' })
  assert.equal(rejected.state, 'AEAT_REJECTED')
  assert.equal(entry.record.hash, 'A'.repeat(64))
  assert.equal(entry.record.canonicalRecord.RegistroAlta.Huella, 'A'.repeat(64))
  const withErrors = deliveryFromResult(entry, { ...common, state: 'AEAT_ACCEPTED_WITH_ERRORS', code: '456', description: 'Advertencia' })
  assert.equal(withErrors.state, 'AEAT_ACCEPTED_WITH_ERRORS')
  assert.throws(() => deliveryFromResult(entry, { ...common, state: 'AEAT_ACCEPTED_WITH_ERRORS', code: null, description: null }), /código/)
})

test('pending record is delivered only after an explicit 404, never after a bridge outage', async () => {
  const record = { idempotencyKey: 'record-1' }
  let deliveries = 0
  const client = {
    status: async () => { throw new BridgeHttpError(404) },
    deliver: async () => { deliveries += 1; return [{ idempotencyKey: 'record-1', state: 'VPS_STORED' }] },
  }
  assert.equal((await resolvePendingBridgeRecord(client, record)).state, 'VPS_STORED')
  assert.equal(deliveries, 1)
  client.status = async () => { throw new BridgeHttpError(503) }
  await assert.rejects(resolvePendingBridgeRecord(client, record), error => error instanceof BridgeHttpError && error.status === 503)
  assert.equal(deliveries, 1)
})
