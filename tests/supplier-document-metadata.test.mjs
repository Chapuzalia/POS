import assert from 'node:assert/strict'
import test from 'node:test'
import { extractGenericDocumentMetadata, extractProfileMetadata, groundAiDocumentMetadata, normalizeMetadataValue, resolveDocumentMetadata } from '../supabase/functions/_shared/supplier-documents/documentMetadata.ts'
import { runDeterministicParser } from '../supabase/functions/_shared/supplier-documents/core.ts'
import { getSupplierDocumentMockFixture } from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import { OpenAiSupplierDocumentProvider } from '../supabase/functions/_shared/supplier-documents/providers.ts'

const ocr = (text) => ({ provider: 'mock', text, confidence: 1, metadata: {}, pages: [{ pageNumber: 1, text, words: [], tables: [] }] })

test('sin etiqueta de fecha el parser de líneas sigue determinista, sin regenerar reglas', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const rules = { ...fixture.knownProfile, documentDateLabel: null }
  const parsed = runDeterministicParser(rules, fixture.ocr, { documentType: 'delivery_note', supplierName: 'Proveedor' })
  assert.ok(parsed.lines.length > 0)
  assert.equal(parsed.document.date, null)
  assert.deepEqual(rules, { ...fixture.knownProfile, documentDateLabel: null })
})

test('generic reconoce formatos de fecha, conserva valor literal y etiqueta cercana sin lista cerrada', () => {
  for (const date of ['03/09/2026', '03-09-2026', '03.09.2026', '3/9/2026']) {
    for (const label of ['Fecha', 'Fecha factura', 'Fecha albarán', 'F. factura', 'F. albarán', 'Fecha emisión', 'Expedición documental']) {
      const text = `${label}: ${date}`
      const result = extractGenericDocumentMetadata(ocr(text)).metadata.date
      assert.equal(result.value, date, text)
      assert.equal(result.labelCandidate, label)
      assert.equal(result.evidence, text)
      assert.equal(result.source, 'generic')
      assert.equal(normalizeMetadataValue('date', result.value), '2026-09-03')
    }
  }
  assert.equal(normalizeMetadataValue('date', '31/02/2026'), null)
})

test('generic ignora vencimiento, entrega, pedido y pago; varias fechas documentales son ambiguas', () => {
  const text = 'Fecha vencimiento 05/09/2026\nFecha entrega 06/09/2026\nFecha pedido 01/09/2026\nFecha de pago 20/09/2026'
  assert.equal(extractGenericDocumentMetadata(ocr(text)).metadata.date.value, null)
  const ambiguous = extractGenericDocumentMetadata(ocr('FECHA FACTURA 03/09/2026\nFECHA EMISIÓN 04/09/2026')).metadata.date
  assert.equal(ambiguous.value, null)
  assert.equal(ambiguous.ambiguous, true)
})

test('número: etiquetas usuales, prefijos y varios identificadores sin confundir CIF/pedido', () => {
  for (const label of ['Factura nº', 'Nº factura', 'Número factura', 'Albarán', 'Nº albarán', 'Documento']) {
    const result = extractGenericDocumentMetadata(ocr(`${label}: ALB-4532690066`)).metadata.number
    assert.equal(result.value, 'ALB-4532690066', label)
    assert.equal(result.labelCandidate, label)
  }
  const result = extractGenericDocumentMetadata(ocr('CIF B12345678\nPedido 45678\nNº albarán 4532690066'))
  assert.equal(result.metadata.number.value, '4532690066')
  assert.equal(extractGenericDocumentMetadata(ocr('Factura 12345\nDocumento 67890')).metadata.number.value, null)
})

test('etiqueta cercana en siguiente línea o celda conserva evidencia literal, también con CRLF', () => {
  for (const separator of ['\n', '\r\n', '|', ' | ']) {
    const input = ocr(`FECHA ALBARÁN${separator}03/09/2026`)
    const result = extractGenericDocumentMetadata(input).metadata.date
    assert.equal(result.value, '03/09/2026', separator)
    assert.equal(result.labelCandidate, 'FECHA ALBARÁN')
    assert.ok(input.text.includes(result.evidence))
  }
  const input = ocr('')
  input.pages[0].tables = [{ rowCount: 1, columnCount: 2, cells: [
    { rowIndex: 0, columnIndex: 0, text: 'FECHA ALBARÁN' }, { rowIndex: 0, columnIndex: 1, text: '03/09/2026' },
  ] }]
  assert.equal(extractGenericDocumentMetadata(input).metadata.date.value, '03/09/2026')
})

test('profile correcto tiene prioridad y no llama al fallback ni sobrescribe la etiqueta', async () => {
  let calls = 0
  const result = await resolveDocumentMetadata({ ocr: ocr('FECHA FACTURA 03/09/2026\nFECHA EMISIÓN 04/09/2026\nDocumento 12345'),
    rules: { documentDateLabel: 'FECHA FACTURA', documentNumberLabel: 'Documento' }, extract: async () => { calls++; return {} } })
  assert.equal(result.metadata.date.value, '03/09/2026')
  assert.equal(result.metadata.date.source, 'profile')
  assert.equal(result.metadata.date.profileFailed, false)
  assert.equal(calls, 0)
})

test('IA solo recibe metadata ambigua pendiente, valida evidencia, y su fallo no afecta a líneas', async () => {
  const input = ocr('FECHA FACTURA 03/09/2026\nFECHA EMISIÓN 04/09/2026\nDocumento 12345')
  let requested
  const result = await resolveDocumentMetadata({ ocr: input, rules: null, extract: async ({ fields }) => {
    requested = fields
    return { date: { value: '03/09/2026', labelCandidate: 'FECHA FACTURA', evidence: 'FECHA FACTURA 03/09/2026', confidence: 0.99 } }
  } })
  assert.deepEqual(requested, ['date'])
  assert.equal(result.metadata.date.source, 'ai')
  assert.equal(result.metadata.number.source, 'generic')
  const failed = await resolveDocumentMetadata({ ocr: input, rules: null, extract: async () => { throw Error('provider failed') } })
  assert.equal(failed.metadata.date.value, null)
  assert.equal(failed.aiError, true)
})

test('IA no puede inventar etiqueta/valor/evidencia ni resolver dos valores bajo la misma etiqueta', () => {
  const input = ocr('FECHA FACTURA 03/09/2026')
  const valid = { value: '03/09/2026', evidence: input.text, labelCandidate: 'FECHA FACTURA' }
  assert.ok(groundAiDocumentMetadata(input, valid, 'date'))
  for (const override of [{ value: '04/09/2026' }, { evidence: 'otra evidencia' }, { labelCandidate: 'FECHA ALBARÁN' }]) {
    assert.equal(groundAiDocumentMetadata(input, { ...valid, ...override }, 'date'), null)
  }
  assert.equal(groundAiDocumentMetadata(ocr(`${input.text}\nFECHA FACTURA 04/09/2026`), valid, 'date'), null)
})

test('etiquetas aprendidas extraen fecha y número por profile sin cambiar reglas de líneas', () => {
  const rules = { documentDateLabel: 'FECHA ALBARÁN', documentNumberLabel: 'Nº ALBARÁN' }
  const result = extractProfileMetadata(ocr('FECHA ALBARÁN 14/05/2026\nNº ALBARÁN 4532690066'), rules)
  assert.equal(result.date.source, 'profile')
  assert.equal(result.number.source, 'profile')
  assert.equal(result.date.value, '14/05/2026')
  assert.equal(result.number.value, '4532690066')
})

test('adapter de metadata usa el modelo actual, schema acotado y ninguna imagen/producto/perfil', async (t) => {
  const oldFetch = globalThis.fetch
  t.after(() => { globalThis.fetch = oldFetch })
  let body
  globalThis.fetch = async (_url, request) => {
    body = JSON.parse(request.body)
    return new Response(JSON.stringify({ output_text: JSON.stringify({ date: null, number: null }) }))
  }
  const provider = new OpenAiSupplierDocumentProvider({ apiKey: 'test', model: 'configured-model' })
  await provider.extractDocumentMetadata({ ocr: ocr('FECHA 03/09/2026'), fields: ['date'] })
  assert.equal(body.model, 'configured-model')
  assert.equal(body.store, false)
  assert.equal(body.text.format.strict, true)
  assert.deepEqual(Object.keys(body.text.format.schema.properties), ['date', 'number'])
  assert.deepEqual(JSON.parse(body.input[0].content[0].text).fields, ['date'])
  assert.equal(body.input[0].content.length, 1)
})
