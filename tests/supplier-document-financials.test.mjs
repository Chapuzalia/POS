import assert from 'node:assert/strict'
import test from 'node:test'
import { inspectProfileHeader, profileRequiredTextsMeetConfidence, runDeterministicParser, validateExtractionMath, validateProposedProfile } from '../supabase/functions/_shared/supplier-documents/core.ts'
import { enrichDocumentFinancials, extractDocumentFinancialSummary } from '../supabase/functions/_shared/supplier-documents/documentFinancials.ts'
import { analyzeOcrWithQuality, OcrQualityError } from '../supabase/functions/_shared/supplier-documents/ocrQuality.ts'

// Reproduce the audited layouts/amounts without storing customer identity,
// fiscal documents, OCR dumps or provider output in the repository.
function table(rows) {
  return { rowCount: rows.length, columnCount: rows[0].length,
    cells: rows.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({ rowIndex, columnIndex, text }))) }
}
function ocr(tables = [], text = 'PROVEEDOR DE PRUEBAS') {
  return { provider: 'mock', confidence: 0.99, text, metadata: {}, pages: [{ pageNumber: 1,
    width: 600, height: 850, unit: 'pixel', text, words: [{ text: 'PROVEEDOR DE PRUEBAS', confidence: 0.99 }],
    tables, confidence: 0.99 }] }
}
function line(total, overrides = {}) {
  return { supplierReference: null, description: 'Producto', barcode: null, quantity: 1,
    purchaseUnit: null, unitPrice: total, discountAmount: 0, chargesAmount: 0, grossCost: total,
    netCost: total, lineTotal: total, taxRate: null, packageExpression: null, confidence: 0.99, ...overrides }
}
function extraction(lines, total = null, proposedProfile = null) {
  return { document: { type: 'invoice', number: 'PRUEBA', date: null, total },
    supplier: { name: 'PROVEEDOR DE PRUEBAS', legalName: null, taxId: null, email: null, phone: null, address: null },
    supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
    lines, proposedProfile, confidence: 0.99 }
}
function rules(columns) {
  return { version: 1, requiredTexts: ['PROVEEDOR DE PRUEBAS'], optionalTexts: [], tableStartText: null,
    tableEndText: null, decimalSeparator: ',', thousandsSeparator: 'none', documentNumberLabel: null,
    documentDateLabel: null, lineGroup: null, columns, normalizations: [] }
}
const column = (field, alias, required = false) => ({ field, headerAliases: [alias], required })
const taxTable = (base, rate, tax, total) => table([
  ['Importe Base', '% IVA', 'Importe IVA', 'Total Factura'], [base, rate, tax, total],
])

test('Coaliment: Precio exacto gana frente a Precio+Imp y los cinco precios se reproducen', () => {
  const profile = rules([column('description', 'Descripción del artículo', true), column('quantity', 'Udx./Peso', true),
    column('unitPrice', 'Precio'), column('lineTotal', 'Importe Línea')])
  const products = table([
    ['Descripción del artículo', 'Udx./Peso', 'Precio', 'Importe Línea', 'Precio+Imp'],
    ['Producto A', '1', '10,99', '10,99', '13,30'], ['Producto B', '3', '1,39', '4,17', '1,68'],
    ['Producto C', '3', '1,39', '4,17', '1,68'], ['Producto D', '2', '2,99', '5,98', '3,62'],
    ['Producto E', '12', '4,79', '57,48', '5,80'],
  ])
  const input = ocr([products, taxTable('82,79', '21', '17,39', '100,18')])
  const parsed = runDeterministicParser(profile, input, { documentType: 'invoice', supplierName: 'PROVEEDOR DE PRUEBAS' })
  assert.deepEqual(parsed.lines.map((item) => item.unitPrice), [10.99, 1.39, 1.39, 2.99, 4.79])
  assert.deepEqual(parsed.lines.map((item) => item.taxRate), [21, 21, 21, 21, 21])
  assert.equal(parsed.document.total, 100.18)
  assert.equal(validateExtractionMath(parsed).coherent, true)
  assert.equal(validateProposedProfile(input, { ...parsed, proposedProfile: profile }).candidate, true)
  assert.equal(inspectProfileHeader(['Precio', 'Precio'], profile).columns.find((item) => item.field === 'unitPrice').ambiguous, true)
})

test('Coca-Cola: PRECIO identifica la cabecera bilingüe con una variante OCR diferente', () => {
  const profile = rules([column('description', 'DESCRIPCIÓN', true), column('quantity', 'CANTIDAD', true), column('unitPrice', 'PREG/PRECIO')])
  const header = inspectProfileHeader(['DESCRIPCIÓN', 'CANTIDAD', 'PEEU/PRECIO'], profile)
  assert.equal(header.columns.find((item) => item.field === 'unitPrice').index, 2)
  assert.equal(inspectProfileHeader(['DESCRIPCIÓN', 'CANTIDAD', 'PEEU/PRECIO', 'PRXX/PRECIO'], profile)
    .columns.find((item) => item.field === 'unitPrice').ambiguous, true)
  assert.equal(inspectProfileHeader(['DESCRIPCIÓN', 'CANTIDAD', 'PEEU/PRECIO', 'PREU/PRECIO'], profile)
    .columns.find((item) => item.field === 'unitPrice').index, 3)
})

test('Coca-Cola: IVA del resumen completa las líneas solo cuando su base concilia', () => {
  const input = ocr([table([['BASE IMPOSABLE/BASE IMPOSIBLE', '% IMPOST / % IMPUESTOS', 'IMPORT/IMPORTS'],
    ['122,31', 'IVA 21 %', '25,69'], ['TOTAL BASES: 122,31', 'TOTAL IMPUESTOS: 25,69', 'TOTAL: 148,00 EUROS']])])
  const original = extraction([line(15.92), line(45.16), line(20.04), line(41.19)], 148)
  const enriched = enrichDocumentFinancials(original, input)
  assert.deepEqual(enriched.lines.map((item) => item.taxRate), [21, 21, 21, 21])
  assert.equal(validateExtractionMath(enriched).documentDifference, 0)
  assert.equal(validateExtractionMath(enriched).coherent, true)
  assert.ok(original.lines.every((item) => item.taxRate === null))
  const missing = enrichDocumentFinancials(extraction(original.lines.slice(1), 148), input)
  assert.ok(missing.lines.every((item) => item.taxRate === null))
  assert.equal(validateExtractionMath(missing).coherent, false)
})

test('Bages: DISTR. 4,27 se conserva como cargo de documento y concilia 62,11 sin alterar productos', () => {
  const input = ocr([], 'DISTR. 4,27\nTOTAL VENDA PRODUCTES 51,33\nIVA 21,00 % DE 51,33 10,78\nIMPORT FACTURA 62,11\nTOTAL A PAGAR 62,11')
  const original = extraction([line(47.06, { quantity: 2, unitPrice: 36.2, discountAmount: 25.34, grossCost: 72.4 })], 62.11)
  const enriched = enrichDocumentFinancials(original, input)
  assert.deepEqual(enriched.document.financialSummary.charges, [{ label: 'DISTR', amountCents: 427 }])
  assert.equal(enriched.lines[0].chargesAmount, 0)
  assert.equal(enriched.lines[0].lineTotal, 47.06)
  assert.equal(enriched.lines[0].taxRate, 21)
  assert.equal(validateExtractionMath(enriched).coherent, true)
  assert.deepEqual(enrichDocumentFinancials(enriched, input), enriched)
})

test('Coca-Cola: el resumen IMPORT/IMPORTE también proporciona el IVA explícito', () => {
  const input = ocr([table([['TIPUS/TIPO', 'BASE IMPOSABLE/BASE IMPONIBLE', '% IMPOST / % IMPUESTOS', 'IMPORT/IMPORTE'],
    ['', '161,17', 'IVA 21 %', '33,85'], ['TOTAL BASES: 161,17', '', 'TOTAL IMPUESTOS: 33,85', 'TOTAL: 195,02 EUROS']])])
  const enriched = enrichDocumentFinancials(extraction([line(161.17)]), input)
  assert.equal(enriched.lines[0].taxRate, 21)
  assert.equal(enriched.document.total, 195.02)
  assert.equal(validateExtractionMath(enriched).coherent, true)
})

test('Bages: IBEE nunca se interpreta como el porcentaje de IVA, ni por posición', () => {
  const profile = rules([column('description', 'DESCRIPCIÓ PRODUCTE', true), column('quantity', 'QUANT', true),
    column('unitPrice', 'PREU TARIFA'), column('discountAmount', 'IMP. DTE.'),
    column('lineTotal', 'IMPORT FINAL'), column('taxRate', 'IBEE')])
  const products = table([['DESCRIPCIÓ PRODUCTE', 'QUANT', 'PREU TARIFA', 'IMP. DTE.', 'IMPORT FINAL', 'IBEE'],
    ['Producto A', '2', '36,20', '25,34', '47,06', '0,00']])
  const input = ocr([products], 'PROVEEDOR DE PRUEBAS\nDISTR. 4,27\nTOTAL VENDA PRODUCTES 51,33\nIVA 21,00 % DE 51,33 10,78\nTOTAL A PAGAR 62,11')
  const parsed = runDeterministicParser(profile, input, { documentType: 'invoice', supplierName: 'PROVEEDOR DE PRUEBAS' })
  assert.equal(parsed.lines[0].taxRate, 21)
  assert.equal(validateExtractionMath(parsed).coherent, true)
  const positional = { ...profile, columns: profile.columns.map((item) => item.field === 'taxRate' ? { ...item, headerAliases: [] } : item) }
  assert.equal(inspectProfileHeader(products.cells.filter((cell) => cell.rowIndex === 0).map((cell) => cell.text), positional)
    .columns.find((item) => item.field === 'taxRate').index, null)
})

test('ANOIADIS: cargos explícitos y residuo de 5 céntimos; no tolera 3% de importes omitidos', () => {
  const input = ocr([table([['LOG.:', '3,05', 'I.S.P.V.:', '1,00']]),
    table([['Base imposable', 'I.V.A.%', 'Import IVA'], ['351,90', '21,00', '73,90']])], 'TOTAL EUROS: 425,80')
  const enriched = enrichDocumentFinancials(extraction([line(347.8)], 425.8), input)
  assert.equal(enriched.document.financialSummary.charges.reduce((sum, charge) => sum + charge.amountCents, 0), 405)
  assert.equal(validateExtractionMath(enriched).documentDifference, 0.05)
  assert.equal(validateExtractionMath(enriched).coherent, true)
  assert.equal(validateExtractionMath(extraction([line(347.8, { taxRate: 21 })], 425.8)).coherent, false)
  assert.equal(validateExtractionMath(enrichDocumentFinancials(extraction([line(343.8)]), input)).coherent, false)
})

test('varios tipos IVA no se convierten en un tipo único y un tipo explícito contradictorio se rechaza', () => {
  const input = ocr([table([['Importe Base', '% IVA', 'Importe IVA'], ['100,00', '21', '21,00'], ['50,00', '10', '5,00']])], 'TOTAL FACTURA 176,00')
  const enriched = enrichDocumentFinancials(extraction([line(100), line(50)], 176), input)
  assert.ok(enriched.lines.every((item) => item.taxRate === null))
  assert.equal(enriched.document.financialSummary.taxes.length, 2)
  assert.equal(validateExtractionMath(enriched).coherent, true)
  const conflicting = enrichDocumentFinancials(extraction([line(100, { taxRate: 10 })], 121), ocr([taxTable('100,00', '21', '21,00', '121,00')]))
  assert.equal(validateExtractionMath(conflicting).coherent, false)
})

test('totales ambiguos, IVA mal calculado y recargos no soportados quedan para revisión', () => {
  const ambiguous = enrichDocumentFinancials(extraction([line(100)], 121), ocr([], 'TOTAL FACTURA 121,00\nTOTAL A PAGAR 999,00'))
  assert.ok(ambiguous.document.financialSummary.issues.includes('AMBIGUOUS_DOCUMENT_TOTAL'))
  assert.equal(validateExtractionMath(ambiguous).coherent, false)
  const invalidTax = enrichDocumentFinancials(extraction([line(100)], 120), ocr([taxTable('100,00', '21', '20,00', '120,00')]))
  assert.equal(validateExtractionMath(invalidTax).coherent, false)
  const surcharge = ocr([table([['Importe Base', '% IVA', 'Importe IVA', 'Importe Recargo', 'Total Factura'],
    ['100,00', '21', '21,00', '5,00', '126,00']])])
  assert.ok(extractDocumentFinancialSummary(surcharge).issues.includes('UNSUPPORTED_TAX_SURCHARGE'))
})

test('solo usa confianza de la celda; la media OCR no valida un marcador sin confianza propia', () => {
  const input = ocr([table([['LOG.:']])])
  const profile = { requiredTexts: ['LOG.:'] }
  assert.equal(profileRequiredTextsMeetConfidence(profile, input), false)
  input.pages[0].tables[0].cells[0].confidence = 0.89
  assert.equal(profileRequiredTextsMeetConfidence(profile, input), false)
  input.pages[0].tables[0].cells[0].confidence = 0.90
  assert.equal(profileRequiredTextsMeetConfidence(profile, input), true)
})

test('Azure guarda estado HTTP sin conservar respuesta, URL ni secretos del proveedor', async () => {
  const input = ocr([], 'PROVEEDOR DE PRUEBAS\nDocumento legible con suficiente texto y datos de ejemplo para la prueba de calidad')
  input.confidence = 0.88
  await assert.rejects(analyzeOcrWithQuality({ bytes: new Uint8Array(), contentType: 'image/webp', fileName: 'test.webp' },
    { name: 'mistral', create: () => ({ analyze: async () => input }) },
    () => ({ analyze: async () => { throw new Error('AZURE_OCR_START_FAILED:401:secret-response') } })), (error) => {
    assert.ok(error instanceof OcrQualityError)
    assert.equal(error.attempts.at(-1).providerHttpStatus, 401)
    assert.equal(error.attempts.at(-1).providerErrorCode, 'AZURE_OCR_START_FAILED')
    assert.doesNotMatch(JSON.stringify(error.attempts), /secret-response/)
    return true
  })
})
