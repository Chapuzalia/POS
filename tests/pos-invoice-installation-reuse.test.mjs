import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { compileComponent } from './helpers/component-harness.mjs'

const context = {
  tenantId: 'tenant', tenantName: 'Bar', tenantSlug: 'bar', venueId: 'venue', venueName: 'Sala',
  venueAddress: 'Calle Mayor 1', venueTimeZone: 'Europe/Madrid', deviceId: 'ipad', deviceName: 'iPad',
  userId: 'user', userName: 'Cajero', role: 'cashier',
}
const cashSession = {
  id: 'cash-1', tenantId: 'tenant', venueId: 'venue', deviceId: 'ipad', cashRegisterId: 'register',
  cashRegisterName: 'Caja 1', userId: 'user', openedAt: '2026-09-19T10:00:00.000Z',
  openingFloatCents: 0, status: 'open',
}

function salePayload(saleId, totalCents = 2100) {
  return {
    ticket: { id: `ticket-${saleId}`, ticketNumber: 1, invoice: null },
    sale: { id: saleId, totalCents },
    payment: { id: `payment-${saleId}` },
    lines: [{
      productName: 'Cerveza', variantName: null, lineTotalCents: totalCents, discountAmountCents: 0,
      fiscalSnapshot: { taxRate: 21, taxableBaseCents: 1735, taxAmountCents: 365 },
    }],
  }
}

function createPosInvoiceHarness({ transportUnavailable = false } = {}) {
  const calls = { reads: 0, leases: 0, recoveries: 0, drafts: [] }
  const installation = {
    tenantId: 'tenant', fiscalSubjectId: 'subject', issuerName: 'Bar SL', issuerNif: 'B12345678',
    venueId: 'venue', cashRegisterId: 'register', deviceId: 'ipad', installationId: 'installation',
    installationNumber: '1', venueCode: 'V001', registerCode: 'R001', installationCode: 'I001',
    timezone: 'Europe/Madrid', bridgeUrl: null, aeatEnvironment: 'test',
    system: {
      NombreRazon: 'Bar SL', NIF: 'B12345678', NombreSistemaInformatico: 'Tickit',
      IdSistemaInformatico: 'TICKIT', Version: '1', NumeroInstalacion: '1',
      TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
    },
  }
  let monotonic = 1_000
  const source = readFileSync(new URL('../src/features/fiscal/local/posInvoice.ts', import.meta.url), 'utf8')
  const service = compileComponent(source, {
    './localLedger.ts': {
      issueLocalInvoice: async (draft) => {
        calls.drafts.push(draft)
        return { id: 'fiscal-record', invoice: { ticketId: draft.ticketId, saleId: draft.saleId }, record: { id: 'fiscal-record' } }
      },
    },
    './installation.ts': {
      loadFiscalInstallation: async () => { calls.reads += 1; return installation },
      getFiscalInstallationLease: async (value) => {
        calls.leases += 1
        return {
          leaseId: `lease-${calls.leases}`, installationId: value.installationId, deviceId: value.deviceId,
          fencingToken: calls.leases, expiresAt: '2026-09-19T12:00:00.000Z',
          clock: { serverUtcAtReceipt: '2026-09-19T12:00:00.000Z', wallUtcAtReceipt: 1, monotonicAtReceipt: 1 },
        }
      },
    },
    './availability.ts': { isFiscalTransportUnavailable: () => transportUnavailable },
    './serverRecovery.ts': {
      recoverServerConfirmedFiscalChain: async () => {
        calls.recoveries += 1
        if (transportUnavailable) throw new Error('Puente fiscal no disponible')
      },
    },
  }, { crypto: globalThis.crypto, performance: { now: () => monotonic } })

  return { calls, installation, service, advance: (milliseconds) => { monotonic += milliseconds } }
}

test('el preflight y la emisión del mismo cobro leen la instalación fiscal una sola vez', async () => {
  const harness = createPosInvoiceHarness()
  const payload = salePayload('sale-1')

  const prepared = await harness.service.preflightPosInvoice(context, cashSession, payload)
  await harness.service.issuePosInvoice(context, cashSession, payload, false, undefined, undefined, prepared)

  assert.equal(harness.calls.reads, 1)
  assert.equal(harness.calls.drafts.length, 1)
  assert.equal(harness.calls.drafts[0].installationId, 'installation')
  assert.equal(harness.calls.drafts[0].lease.leaseId, 'lease-2')
})

test('la emisión vuelve a pedir el alquiler y la cadena fiscal aunque reutilice la instalación', async () => {
  const harness = createPosInvoiceHarness()
  const payload = salePayload('sale-1')

  const prepared = await harness.service.preflightPosInvoice(context, cashSession, payload)
  await harness.service.issuePosInvoice(context, cashSession, payload, false, undefined, undefined, prepared)

  assert.equal(harness.calls.leases, 2)
  assert.equal(harness.calls.recoveries, 2)
})

test('sin instalación preparada la emisión conserva la lectura completa de la instalación', async () => {
  const harness = createPosInvoiceHarness()
  const payload = salePayload('sale-1')

  await harness.service.issuePosInvoice(context, cashSession, payload)

  assert.equal(harness.calls.reads, 1)
  assert.equal(harness.calls.leases, 1)
  assert.equal(harness.calls.recoveries, 1)
})

test('una instalación preparada de otra venta, sesión, caja, dispositivo o tenant no se reutiliza', async () => {
  const scenarios = [
    ['otra venta', () => salePayload('sale-2'), cashSession, context],
    ['otra sesión de caja', () => salePayload('sale-1'), { ...cashSession, id: 'cash-2' }, context],
    ['otra caja', () => salePayload('sale-1'), { ...cashSession, cashRegisterId: 'register-2' }, context],
    ['otro dispositivo', () => salePayload('sale-1'), cashSession, { ...context, deviceId: 'ipad-2' }],
    ['otro local', () => salePayload('sale-1'), cashSession, { ...context, tenantId: 'tenant-2' }],
    ['otra sede', () => salePayload('sale-1'), cashSession, { ...context, venueId: 'venue-2' }],
  ]
  for (const [name, payloadFor, session, tenantContext] of scenarios) {
    const harness = createPosInvoiceHarness()
    const prepared = await harness.service.preflightPosInvoice(context, cashSession, salePayload('sale-1'))
    await harness.service.issuePosInvoice(tenantContext, session, payloadFor(), false, undefined, undefined, prepared)
    assert.equal(harness.calls.reads, 2, name)
  }
})

test('una instalación preparada deja de reutilizarse cuando el cobro se retrasa', async () => {
  const harness = createPosInvoiceHarness()
  const payload = salePayload('sale-1')

  const prepared = await harness.service.preflightPosInvoice(context, cashSession, payload)
  harness.advance(59_000)
  await harness.service.issuePosInvoice(context, cashSession, payload, false, undefined, undefined, prepared)
  assert.equal(harness.calls.reads, 1)

  const delayed = createPosInvoiceHarness()
  const stalePrepared = await delayed.service.preflightPosInvoice(context, cashSession, payload)
  delayed.advance(61_000)
  await delayed.service.issuePosInvoice(context, cashSession, payload, false, undefined, undefined, stalePrepared)
  assert.equal(delayed.calls.reads, 2)
})

test('el puente fiscal no disponible no impide preparar ni reutilizar la instalación fiscal', async () => {
  const harness = createPosInvoiceHarness({ transportUnavailable: true })
  const payload = salePayload('sale-1')

  const prepared = await harness.service.preflightPosInvoice(context, cashSession, payload)
  await harness.service.issuePosInvoice(context, cashSession, payload, false, undefined, undefined, prepared)

  assert.equal(harness.calls.reads, 1)
  assert.equal(harness.calls.recoveries, 2)
})

test('el preflight de instalación resuelve los datos de instalación que ya consumía el restaurante', async () => {
  const harness = createPosInvoiceHarness()

  const installation = await harness.service.preflightFiscalInstallation(context, cashSession)

  assert.equal(installation, harness.installation)
  assert.equal(harness.calls.reads, 1)
  assert.equal(harness.calls.leases, 1)
  assert.equal(harness.calls.recoveries, 1)
})