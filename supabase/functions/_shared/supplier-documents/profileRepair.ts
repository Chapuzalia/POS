import {
  ocrDocumentSchema, supplierDocumentExtractionSchema, supplierProfileRulesSchema,
  validateExtractionMath, validateProposedProfile,
  type SupplierDocumentExtraction, type SupplierProfileRules,
} from './core.ts'

type Row = Record<string, any>

// Only confirmed purchase fields are targets. Inventory mappings stay tenant-private.
export function confirmedProfileTarget(document: Row, lines: Row[], supplier: Row) {
  return supplierDocumentExtractionSchema.parse({
    document: { type: document.document_type, number: document.document_number,
      date: document.document_date, total: null },
    supplier: { name: supplier.name, legalName: supplier.legal_name, taxId: supplier.tax_id,
      email: null, phone: null, address: null },
    supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
    lines: lines.map((line) => ({
      supplierReference: line.supplier_reference, description: line.description_raw,
      barcode: line.barcode, quantity: Number(line.quantity), purchaseUnit: line.purchase_unit,
      unitPrice: line.unit_price === null ? null : Number(line.unit_price),
      discountAmount: Number(line.discount_amount ?? 0), chargesAmount: Number(line.charges_amount ?? 0),
      grossCost: line.gross_cost === null ? null : Number(line.gross_cost),
      netCost: line.net_cost === null ? null : Number(line.net_cost),
      lineTotal: line.line_total === null ? null : Number(line.line_total),
      taxRate: line.tax_rate === null ? null : Number(line.tax_rate),
      packageExpression: null, confidence: 1,
    })), proposedProfile: null, confidence: 1,
  })
}

export async function proposeConfirmedProfileRepair(input: {
  document: Row; lines: Row[]; supplier: Row
  propose: (input: { ocr: ReturnType<typeof ocrDocumentSchema.parse>;
    documentType: 'invoice' | 'delivery_note'; extraction: SupplierDocumentExtraction }) => Promise<SupplierProfileRules>
}) {
  const metadata = input.document.extraction_metadata ?? {}
  if (input.document.status !== 'confirmed' || metadata.learningExcluded === true
    || metadata.linesReparsedAt || metadata.supplierSelection?.manual === true
    || metadata.supplierSelection?.source === 'manual') throw new Error('PROFILE_REPAIR_NOT_ELIGIBLE')
  const ocr = ocrDocumentSchema.parse(input.document.ocr_snapshot)
  const target = confirmedProfileTarget(input.document, input.lines, input.supplier)
  if (!validateExtractionMath(target).coherent) throw new Error('CONFIRMED_EXTRACTION_MATH_INVALID')
  const rules = supplierProfileRulesSchema.parse(await input.propose({ ocr,
    documentType: target.document.type, extraction: target }))
  const validation = validateProposedProfile(ocr, { ...target, proposedProfile: rules })
  if (!validation.candidate || !validation.parsed) throw new Error(validation.reason ?? 'PROFILE_REPAIR_INVALID')
  // The general validator compares amounts/units/descriptions. Repairs also must
  // reproduce identifiers and tax rates; otherwise a correction could be ignored.
  if (validation.parsed.lines.some((line, index) => {
    const expected = target.lines[index]
    return line.supplierReference !== expected.supplierReference || line.barcode !== expected.barcode
      || line.taxRate !== expected.taxRate
  })) throw new Error('PROFILE_REPAIR_IDENTITY_OR_TAX_MISMATCH')
  return rules
}
