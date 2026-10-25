import assert from 'node:assert/strict'
import test from 'node:test'
import { validateExtractionMath } from '../supabase/functions/_shared/supplier-documents/core.ts'
import { enrichDocumentFinancials, extractDocumentFinancialSummary } from '../supabase/functions/_shared/supplier-documents/documentFinancials.ts'

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

const taxTable = (base, rate, tax, total) => table([
  ['Importe Base', '% IVA', 'Importe IVA', 'Total Factura'], [base, rate, tax, total],
])

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
