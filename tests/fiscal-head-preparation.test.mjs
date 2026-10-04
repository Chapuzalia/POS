import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { compileComponent } from './helpers/component-harness.mjs'
import { canonicalRecordSchema, createAltaRecord } from '../src/features/fiscal/local/canonical.ts'
import { aeatHash } from '../src/features/fiscal/local/verifactu.ts'
import { UserFacingError } from '../src/utils/UserFacingError.ts'

async function harness() {
  const scope = 'tenant:subject:installation'
  const prior = { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-2026-S/1166', issueDate: '03-10-2026', hash: 'A'.repeat(64) }
  const system = { NombreRazon: 'Productor ficticio', NIF: '89890001K', NombreSistemaInformatico: 'Tickit',
    IdSistemaInformatico: 'TK', Version: 'test', NumeroInstalacion: 'installation',
    TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S' }
  const built = await createAltaRecord({ invoice: { issuerNif: prior.issuerNif, seriesAndNumber: 'L1-C1-2026-S/1167', issueDate: prior.issueDate },
    issuerName: 'Emisor ficticio', type: 'F2', description: 'Prueba', system,
    details: [{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00', BaseImponibleOimporteNoSujeto: '10.00', CuotaRepercutida: '2.10' }],
    previous: { IDEmisorFactura: prior.issuerNif, NumSerieFactura: prior.seriesAndNumber, FechaExpedicionFactura: prior.issueDate, Huella: prior.hash },
    generatedAt: '2026-10-03T12:00:00+02:00', environment: 'test' })
  const entry = { id: 'head', scope, record: { deviceId: 'device', environment: 'production', previous: prior,
    hash: built.hash, generatedAt: '2026-10-03T12:00:00+02:00', canonicalRecord: built.canonicalRecord },
    invoice: { series: 'L1-C1-2026-S', number: 1167 } }
  const chain = { scope, position: 1167, recordId: 'head', previous: { ...prior, seriesAndNumber: 'L1-C1-2026-S/1167', hash: built.hash } }
  const rows = { bindings: { deviceId: 'device' }, numbers: { lastNumber: 1167 }, delivery: { state: 'LOCAL_PENDING' } }
  let schemas = 0
  const service = compileComponent(readFileSync(new URL('../src/features/fiscal/local/localIdentity.ts', import.meta.url), 'utf8'), {
    './localLedger.ts': {
      readLocalFiscalHead: async () => ({ entry, chain }),
      openLedger: async () => ({ close() {}, transaction: () => ({ objectStore: name => ({
        get: () => rows[name], getAll() { throw new Error('Historical scan forbidden during emission') },
      }) }) }), request: async x => x, transactionDone: async () => {},
      assertInstallationBinding: (binding, device) => { if (binding?.deviceId !== device) throw new Error('wrong device') },
    }, './canonical.ts': { canonicalRecordSchema: { parse(value) { schemas += 1; return canonicalRecordSchema.parse(value) } } },
    './verifactu.ts': { aeatHash }, '../../../utils/UserFacingError.ts': { UserFacingError },
  })
  return { entry, chain, rows, service, scope, get schemas() { return schemas } }
}

test('preparation validates one head regardless of chain length, without reading history', async () => {
  const h = await harness()
  await h.service.assertFiscalLedgerHeadValid(h.scope, 'device', false, 'installation')
  assert.equal(h.schemas, 1)
})

test('head preparation rejects corrupt canonical hash, number and cursor identity', async () => {
  for (const mutate of [
    h => { h.entry.record.canonicalRecord.RegistroAlta.Huella = '0'.repeat(64) },
    h => { h.rows.numbers.lastNumber = 1166 },
    h => { h.chain.previous.seriesAndNumber = 'another-series/1167' },
    h => { h.rows.delivery = undefined },
  ]) {
    const h = await harness(); mutate(h)
    await assert.rejects(h.service.assertFiscalLedgerHeadValid(h.scope, 'device', false, 'installation'))
  }
})

test('head preparation retains installation and device checks', async () => {
  const h = await harness()
  await assert.rejects(h.service.assertFiscalLedgerHeadValid(h.scope, 'other-device', false, 'installation'), /wrong device/)
  await assert.rejects(h.service.assertFiscalLedgerHeadValid(h.scope, 'device', false, 'another-installation'), /incoherente/)
})
