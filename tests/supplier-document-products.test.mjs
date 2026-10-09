import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { stripTypeScriptTypes } from 'node:module'
import { compileFunction } from 'node:vm'
import * as core from '../supabase/functions/_shared/supplier-documents/core.ts'
import { productNetCost, runDeterministicParser, validateProductExtraction, validateProposedProfile } from '../supabase/functions/_shared/supplier-documents/core.ts'
import { extractGenericDocumentMetadata, normalizeMetadataValue, resolveDocumentMetadata } from '../supabase/functions/_shared/supplier-documents/documentMetadata.ts'
import { diagnoseParser } from '../supabase/functions/_shared/supplier-documents/profileRepair.ts'

// Sanitized layouts; do not store real fiscal documents or customer OCR.
const table = rows => ({ rowCount: rows.length, columnCount: rows[0].length,
  cells: rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({ text, rowIndex, columnIndex }))) })
const ocr = (tables = [], text = 'PROVEEDOR DE PRUEBAS\nDocumento de prueba para recepción de productos') => ({ provider: 'mock', confidence: 0.99, text, metadata: {},
  pages: [{ pageNumber: 1, width: 600, height: 850, unit: 'pixel', text,
    words: [{ text: 'PROVEEDOR DE PRUEBAS', confidence: 0.99 }], tables, confidence: 0.99 }] })
const column = (field, alias, required = false) => ({ field, headerAliases: [alias], required })
const profile = columns => ({ version: 1, requiredTexts: ['PROVEEDOR DE PRUEBAS'], optionalTexts: [],
  tableStartText: null, tableEndText: null, decimalSeparator: ',', thousandsSeparator: 'none',
  documentNumberLabel: null, documentDateLabel: null, lineGroup: null, columns, normalizations: [] })
const defaults = { documentType: 'invoice', supplierName: 'PROVEEDOR DE PRUEBAS' }
const edgeSource = await readFile(new URL('../supabase/functions/process-supplier-document/index.ts', import.meta.url), 'utf8')
function edgeFunction(name, next, dependencies) {
  // Execute the real pure flow boundary with its real shared helpers; importing
  // the entrypoint would start Deno.serve and require an external Supabase client.
  const start = edgeSource.indexOf(`function ${name}(`), end = edgeSource.indexOf(next, start)
  assert.ok(start >= 0 && end > start)
  const body = `${stripTypeScriptTypes(edgeSource.slice(start, end))}\nreturn ${name}`
  return compileFunction(body, Object.keys(dependencies))(...Object.values(dependencies))
}
const groupedProfile = () => ({ ...profile([
  column('supplierReference', 'ART.'), column('description', 'DESCRIPCIÓN', true), column('quantity', 'CANTIDAD', true),
  column('unitPrice', 'PRECIO'), column('discountAmount', 'BASE DTO.'), column('lineTotal', 'IMPORTE'),
]), documentDateLabel: 'DATA / FECHA', documentNumberLabel: 'NÚMERO',
lineGroup: { endAliases: ['SUBUNIDADES/NETO'], discountAliases: ['Dto. Fijo'], chargeAliases: ['IBEE', 'Punto Verde'],
  netTotalFromEndRow: true, maxContinuationRows: 4 } })
const groupedRows = () => [
  ['ART.', 'DESCRIPCIÓN', 'CANTIDAD', 'PRECIO', 'BASE DTO.', 'IMPORTE', 'T'],
  ['A-1', 'Producto A', '1,00', '31,92', '', '', '31,92'],
  ['', 'Dto. Fijo', '', '', '31,92', '', '10,09-'],
  ['', 'IBEE', '', '0,72', '', '', '0,72'],
  ['', 'Punto Verde', '', '0,02', '', '', '0,02'],
  ['', 'SUBUNIDADES/NETO', '24', '0,940', '', '', '22,57'],
  ['B-2', 'Producto B', '2,00', '25,44', '', '', '50,88'],
  ['', 'Dto. Fijo', '', '', '50,88', '', '11,45-'],
  ['', 'IBEE', '', '0,86', '', '', '1,71'],
  ['', 'Punto Verde', '', '0,03', '', '', '0,05'],
  ['', 'SUBUNIDADES/NETO', '48', '0,858', '', '', '41,19'],
  ['', '', 'TOTAL PRODUCTOS', '', '', '62,00', '*'],
]

test('coste de inventario excluye cargos y netos impresos, conservando el descuento del producto', () => {
  const rules = profile([column('description', 'PRODUCTO', true), column('quantity', 'QUANT', true),
    column('unitPrice', 'PREU TARIFA'), column('discountAmount', 'IMP. DTE.'), column('lineTotal', 'IMPORT FINAL')])
  const input = ocr([table([['PRODUCTO', 'QUANT', 'PREU TARIFA', 'IMP. DTE.', 'IMPORT FINAL'],
    ['Producto A', '2', '36,20', '25,34', '47,06']])], 'PROVEEDOR DE PRUEBAS\nDISTR. 4,27\nTOTAL A PAGAR 62,11')
  const parsed = runDeterministicParser(rules, input, defaults)
  const ai = structuredClone(parsed)
  Object.assign(ai.lines[0], { chargesAmount: 4.27, lineTotal: 51.33, netCost: 51.33, taxRate: 21 })
  ai.proposedProfile = rules
  assert.equal(productNetCost(ai.lines[0]), 47.06)
  assert.equal(Math.round(productNetCost(ai.lines[0]) / 48 * 1e6) / 1e6, 0.980417)
  assert.deepEqual(validateProductExtraction(ai), { coherent: true, documentDifference: null, invalidLineIndexes: [], scope: 'products' })
  assert.equal(validateProposedProfile(input, ai).candidate, true)
  ai.document.total = 999
  ai.lines[0].chargesAmount = 999
  ai.lines[0].lineTotal = 999
  ai.lines[0].netCost = 999
  ai.lines[0].taxRate = 10
  assert.equal(validateProductExtraction(ai).coherent, true)
  assert.equal(validateProposedProfile(input, ai).candidate, true)
})

test('cantidad, precio, unidad, descuento y filas siguen condicionando la validez de un perfil', () => {
  const rules = groupedProfile()
  const input = ocr([table(groupedRows())])
  const parsed = runDeterministicParser(rules, input, defaults)
  for (const change of [{ quantity: 2 }, { unitPrice: 45 }, { purchaseUnit: 'kg' }, { discountAmount: 0 }]) {
    const ai = structuredClone(parsed)
    ai.proposedProfile = rules
    Object.assign(ai.lines[0], change)
    assert.equal(validateProposedProfile(input, ai).candidate, false, JSON.stringify(change))
  }
  assert.equal(validateProposedProfile(input, { ...parsed, lines: parsed.lines.slice(1), proposedProfile: rules }).candidate, false)
  const negative = structuredClone(parsed)
  negative.lines[0].discountAmount = 100
  assert.equal(productNetCost(negative.lines[0]), null)
  assert.deepEqual(validateProductExtraction(negative).invalidLineIndexes, [0])
  const missing = structuredClone(parsed)
  missing.lines[0].unitPrice = null
  assert.equal(productNetCost(missing.lines[0]), null)
  assert.equal(validateProductExtraction(missing).coherent, false)
})

test('reutiliza el perfil ante importes desplazados con evidencia de cantidad por precio', () => {
  const rules = groupedProfile()
  const input = ocr([table(groupedRows())])
  const trace = { headers: [], headerCount: 0, headersTruncated: false, tableCount: 0, partialLines: [] }
  const parsed = runDeterministicParser(rules, input, defaults, trace)
  assert.deepEqual(parsed.lines.map(line => [line.quantity, line.unitPrice, line.discountAmount, productNetCost(line)]),
    [[1, 31.92, 10.09, 21.83], [2, 25.44, 11.45, 39.43]])
  assert.deepEqual(parsed.lines.map(line => line.lineTotal), [22.57, 41.19])
  const amount = trace.headers.find(header => header.selected).columns.find(column => column.field === 'lineTotal')
  assert.equal(amount.index, 6)
  assert.equal(amount.relocatedFrom, 5)
  assert.equal(validateProposedProfile(input, { ...parsed, proposedProfile: rules }).candidate, true)
  const alignedRows = groupedRows().map((row, index) => index > 0 && row[1] ? [...row.slice(0, 5), row[6], ''] : row)
  const aligned = runDeterministicParser(rules, ocr([table(alignedRows)]), defaults)
  assert.deepEqual(aligned.lines, parsed.lines)
})

test('no desplaza importes ante columnas ambiguas, indicadores IVA o precios que no concilian', () => {
  const wrong = groupedRows()
  wrong[1][6] = '99,00'
  assert.throws(() => runDeterministicParser(groupedProfile(), ocr([table(wrong)]), defaults), /PROFILE_DISCOUNT_UNREADABLE/)
  const taxes = groupedRows().map((row, index) => index > 0 && row[1] ? [...row.slice(0, 6), '21'] : row)
  assert.throws(() => runDeterministicParser(groupedProfile(), ocr([table(taxes)]), defaults), /PROFILE_DISCOUNT_UNREADABLE/)
  const rules = profile([column('description', 'PRODUCTO', true), column('quantity', 'QUANT', true),
    column('unitPrice', 'PRECIO'), column('lineTotal', 'IMPORTE')])
  rules.lineGroup = groupedProfile().lineGroup
  const ambiguous = ocr([table([
    ['PRODUCTO', 'QUANT', 'PRECIO', 'X', 'IMPORTE', 'Y'],
    ['Producto A', '1', '10,00', '10,00', '', '10,00'],
    ['Dto. Fijo', '', '', '1,00-', '', '1,00-'],
  ])])
  assert.throws(() => runDeterministicParser(rules, ambiguous, defaults), /PROFILE_DISCOUNT_UNREADABLE/)
})

test('un perfil guardado se reutiliza aunque falten sus filas opcionales de cargos y cierre', () => {
  const rules = groupedProfile()
  const rows = groupedRows().filter(row => !['IBEE', 'Punto Verde', 'SUBUNIDADES/NETO'].includes(row[1]))
  const input = ocr([table(rows)])
  const parsed = runDeterministicParser(rules, input, defaults)
  assert.deepEqual(parsed.lines.map(productNetCost), [21.83, 39.43])
  const interpreted = { ...parsed, proposedProfile: rules }
  assert.equal(validateProposedProfile(input, interpreted, { existingProfile: true }).candidate, true)
  assert.equal(validateProposedProfile(input, interpreted).reason, 'PROFILE_LINE_GROUP_ALIAS_NOT_IN_OCR')
})

test('la ausencia del neto impreso no bloquea cantidades y precios disponibles', () => {
  const rules = profile([column('description', 'PRODUCTO', true), column('quantity', 'QUANT', true), column('unitPrice', 'PRECIO')])
  const input = ocr([table([['PRODUCTO', 'QUANT', 'PRECIO'], ['Producto A', '2', '10,00']])])
  const parsed = runDeterministicParser(rules, input, defaults)
  assert.equal(parsed.lines[0].lineTotal, null)
  assert.equal(productNetCost(parsed.lines[0]), 20)
  assert.equal(validateProductExtraction(parsed).coherent, true)
  assert.equal(diagnoseParser({ id: 'existing', status: 'verified', rules_json: rules }, input, 'invoice').failedFields.includes('lines'), false)
})

test('extrae fecha corta y factura, excluyendo vencimiento, trazabilidad, dirección y total', async () => {
  const input = ocr([table([
    ['Núm Doc FACTURA', 'NÚM. DOC. TRAÇABILITAT', 'DATA FACTURA', 'DATA VENCIMENT'],
    ['INV26-123456', 'C26-54321', '08/10/26', '15/10/26'],
  ])], 'PROVEEDOR DE PRUEBAS\nC/ Calle de Pruebas, Nº 2\nIMPORT FACTURA 62,11')
  let calls = 0
  const result = await resolveDocumentMetadata({ ocr: input, rules: null, extract: async () => { calls++; return {} } })
  assert.equal(calls, 0)
  assert.equal(normalizeMetadataValue('date', result.metadata.date.value), '2026-10-08')
  assert.equal(result.metadata.number.value, 'INV26-123456')
  const coke = extractGenericDocumentMetadata(ocr([table([
    ['NÚMERO', 'DATA / FECHA', 'DATA VENT/FECHA'], ['1234567890', '08.10.2026', '15.10.2026'],
  ])]))
  assert.equal(coke.metadata.date.value, '08.10.2026')
  const delivery = extractGenericDocumentMetadata(ocr([], 'PROVEEDOR DE PRUEBAS\nRg.Merc.Bcn.Tom 11111, Foli 0000\nALBARÁN: 26/ 9.001'))
  assert.equal(normalizeMetadataValue('number', delivery.metadata.number.value), '26/9.001')
})

test('las fechas inválidas y dos facturas diferentes siguen sin resolverse automáticamente', () => {
  assert.equal(normalizeMetadataValue('date', '29/02/26'), null)
  assert.equal(normalizeMetadataValue('date', '31/04/26'), null)
  assert.equal(normalizeMetadataValue('date', '29/02/24'), '2024-02-29')
  assert.equal(normalizeMetadataValue('date', '08/10/2026'), '2026-10-08')
  assert.equal(normalizeMetadataValue('date', '2026-10-08'), '2026-10-08')
  const result = extractGenericDocumentMetadata(ocr([], 'FACTURA: INV26-123456\nFACTURA: INV26-234567'))
  assert.equal(result.metadata.number.value, null)
  assert.equal(result.metadata.number.ambiguous, true)
})

test('las filas para stock persisten coste sin transporte y conservan cantidades y ámbito', () => {
  const buildRows = edgeFunction('buildLineRows', 'async function reparseLinesWithSelectedSupplier', core)
  const input = ocr([table([['PRODUCTO', 'QUANT', 'PRECIO'], ['Producto A', '2', '36,20']])])
  const parsed = runDeterministicParser(profile([column('description', 'PRODUCTO', true), column('quantity', 'QUANT', true), column('unitPrice', 'PRECIO')]), input, defaults)
  Object.assign(parsed.lines[0], { supplierReference: 'A-1', purchaseUnit: 'CAJA', discountAmount: 25.34,
    chargesAmount: 4.27, netCost: 51.33, lineTotal: 51.33 })
  parsed.document.total = 999
  const inventory = {
    items: [{ id: 'product', name: 'Producto A', baseUnitId: 'ud', referenceCost: 1, active: true }],
    units: [{ id: 'ud', name: 'Unidad', symbol: 'ud', contentQuantity: 1, contentUnitId: 'ud' }],
    aliases: [{ aliasType: 'supplier_reference', aliasValue: 'a-1', inventoryItemId: 'product', packageExpression: '24x1ud' }],
    routes: [{ inventoryItemId: 'product', warehouseId: 'warehouse', priority: 1, enabled: true }],
    warehouses: [{ id: 'warehouse', active: true, sortOrder: 1 }],
  }
  const [row] = buildRows(parsed, { id: 'document', tenant_id: 'tenant', venue_id: 'venue' }, inventory)
  assert.equal(row.match_status, 'recognized')
  assert.equal(row.quantity, 2)
  assert.equal(row.base_quantity, 48)
  assert.equal(row.net_cost, 47.06)
  assert.equal(row.normalized_unit_cost, 0.980417)
  assert.equal(row.raw_extraction_metadata.originalExtraction.net_cost, 47.06)
  assert.equal(row.line_total, 51.33)
  assert.equal(row.tenant_id, 'tenant')
  assert.equal(row.venue_id, 'venue')
  parsed.lines[0].unitPrice = null
  const [missingPrice] = buildRows(parsed, { id: 'document', tenant_id: 'tenant', venue_id: 'venue' }, inventory)
  assert.equal(missingPrice.match_status, 'needs_review')
  assert.equal(missingPrice.normalized_unit_cost, null)
})

test('a igualdad de datos y confianza reutiliza el perfil con más muestras exitosas, respetando proveedor y tipo', () => {
  const select = edgeFunction('tryKnownProfiles', 'async function loadSupplierCandidates', { ...core, diagnoseParser })
  const rules = groupedProfile()
  const input = ocr([table(groupedRows())])
  const supplier = { id: 'supplier', name: 'PROVEEDOR DE PRUEBAS', tax_id: null }
  const candidate = { status: 'candidate', global_supplier_id: supplier.id, document_type: 'invoice', rules_json: rules }
  const profiles = [
    { ...candidate, id: 'new', success_count: 1, correction_count: 0 },
    { ...candidate, id: 'other-supplier', global_supplier_id: 'other', success_count: 100 },
    { ...candidate, id: 'other-type', document_type: 'delivery_note', success_count: 100 },
    { ...candidate, id: 'old', success_count: 3, correction_count: 1 },
  ]
  const result = select(input, 'invoice', [supplier], profiles, { globalSupplierId: supplier.id, taxId: null })
  assert.equal(result.selected, null)
  assert.ok(result.candidate, JSON.stringify(result.diagnostics.map(diagnosis => ({ failures: diagnosis.failures, details: diagnosis.failureDetails }))))
  assert.equal(result.candidate.globalProfileId, 'old')
  assert.equal(validateProposedProfile(input, { ...result.candidate.extraction, proposedProfile: rules }).candidate, true)
  const trusted = select(input, 'invoice', [supplier], [...profiles, { ...candidate, status: 'verified', id: 'verified', success_count: 1 }], { globalSupplierId: supplier.id, taxId: null })
  assert.equal(trusted.selected.globalProfileId, 'verified')
})
