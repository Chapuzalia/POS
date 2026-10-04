import { createAltaRecord, createAnulacionRecord, canonicalRecordToXml } from '../src/features/fiscal/local/canonical.ts'

const invoice = { issuerNif: '89890001K', seriesAndNumber: 'L1-C1-I1-2026-S/1', issueDate: '28-09-2026' }
const system = {
  NombreRazon: 'Productor ficticio', NIF: '89890001K', NombreSistemaInformatico: 'Tickit',
  IdSistemaInformatico: 'TK', Version: '0.0.0-test', NumeroInstalacion: 'install-test',
  TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
}
const details = [{ Impuesto: '01', ClaveRegimen: '01', CalificacionOperacion: 'S1', TipoImpositivo: '21.00', BaseImponibleOimporteNoSujeto: '10.00', CuotaRepercutida: '2.10' }]
const base = { invoice, issuerName: 'Emisor ficticio', description: 'Servicio ficticio', details, system, previous: null, generatedAt: '2026-09-28T12:00:00+02:00', environment: 'test' }
const f2 = await createAltaRecord({ ...base, type: 'F2' })
const f1 = await createAltaRecord({ ...base, type: 'F1', recipient: { name: 'Destinatario ficticio', nif: '89890002E' } })
const annulment = await createAnulacionRecord({ invoice, system, previous: {
  IDEmisorFactura: invoice.issuerNif, NumSerieFactura: invoice.seriesAndNumber,
  FechaExpedicionFactura: invoice.issueDate, Huella: f2.hash,
}, generatedAt: '2026-09-28T12:01:00+02:00' })
process.stdout.write(JSON.stringify([
  { name: 'F2', xml: canonicalRecordToXml(f2.canonicalRecord) },
  { name: 'F1', xml: canonicalRecordToXml(f1.canonicalRecord) },
  { name: 'Anulacion', xml: canonicalRecordToXml(annulment.canonicalRecord) },
]))
