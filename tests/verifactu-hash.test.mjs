import assert from 'node:assert/strict'
import { test } from 'node:test'
import { aeatHash, aeatHashSource, aeatQrUrl } from '../src/features/fiscal/local/verifactu.ts'

const first = {
  kind: 'alta', issuerNif: '89890001K', seriesAndNumber: '12345678/G33',
  issueDate: '01-01-2024', invoiceType: 'F1', taxTotal: '12.35',
  invoiceTotal: '123.45', previousHash: null, generatedAt: '2024-01-01T19:20:30+01:00',
}

test('AEAT 0.1.2 first alta vector', async () => {
  assert.equal(await aeatHash(first), '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60')
  assert.match(aeatHashSource(first), /&Huella=&FechaHoraHusoGenRegistro=/)
})

test('AEAT 0.1.2 chained alta vector', async () => {
  assert.equal(await aeatHash({ ...first, seriesAndNumber: '12345679/G34',
    previousHash: '3C464DAF61ACB827C65FDA19F352A4E3BDC2C640E9E9FC4CC058073F38F12F60',
    generatedAt: '2024-01-01T19:20:35+01:00',
  }), 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97')
})

test('AEAT 0.1.2 chained anulación vector', async () => {
  const input = {
    kind: 'anulacion', issuerNif: '89890001K', seriesAndNumber: '12345679/G34',
    issueDate: '01-01-2024',
    previousHash: 'F7B94CFD8924EDFF273501B01EE5153E4CE8F259766F88CF6ACB8935802A2B97',
    generatedAt: '2024-01-01T19:20:40+01:00',
  }
  assert.equal(await aeatHash(input), '177547C0D57AC74748561D054A9CEC14B4C4EA23D1BEFD6F2E69E3A388F90C68')
  assert.match(aeatHashSource(input), /^IDEmisorFacturaAnulada=/)
})

test('QR encodes only the official invoice fields', () => {
  const url = aeatQrUrl({ ...first, environment: 'test' })
  assert.equal(url, 'https://prewww2.aeat.es/wlpl/TIKE-CONT/ValidarQR?nif=89890001K&numserie=12345678%2FG33&fecha=01-01-2024&importe=123.45')
  assert.doesNotMatch(url, /Huella|hash/)
})
