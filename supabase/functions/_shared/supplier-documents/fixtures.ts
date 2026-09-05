import type { OcrDocument, SupplierDocumentExtraction, SupplierProfileRules } from './core.ts'

export type SupplierDocumentMockFixture = {
  id: string
  label: string
  description: string
  ocr: OcrDocument
  extraction: SupplierDocumentExtraction
  knownProfile: SupplierProfileRules | null
}

const defaultRules: SupplierProfileRules = {
  version: 1,
  requiredTexts: ['DISTRIBUCIONES DEMO', 'Código', 'Descripción'],
  optionalTexts: ['Albarán', 'Factura'],
  tableStartText: 'Código',
  tableEndText: 'Total',
  decimalSeparator: ',',
  thousandsSeparator: '.',
  documentNumberLabel: 'Nº',
  documentDateLabel: 'Fecha',
  lineGroup: null,
  columns: [
    { field: 'supplierReference', headerAliases: ['Código', 'Referencia'], required: true },
    { field: 'description', headerAliases: ['Descripción', 'Producto'], required: true },
    { field: 'quantity', headerAliases: ['Cantidad', 'Cant.'], required: true },
    { field: 'purchaseUnit', headerAliases: ['Unidad', 'Formato'], required: false },
    { field: 'unitPrice', headerAliases: ['Precio'], required: true },
    { field: 'lineTotal', headerAliases: ['Importe', 'Total línea'], required: true },
  ],
  normalizations: [
    { field: 'supplierReference', operation: 'trim' },
    { field: 'description', operation: 'collapse_spaces' },
  ],
}

type FixtureLine = {
  reference: string
  description: string
  quantity: number
  purchaseUnit: string
  unitPrice: number
  barcode?: string | null
  confidence?: number
}

function money(value: number) {
  return value.toFixed(2).replace('.', ',')
}

function makeFixture(input: {
  id: string
  label: string
  description: string
  supplierName: string
  taxId: string | null
  documentNumber: string
  lines: FixtureLine[]
  knownProfile?: boolean
  proposeProfile?: boolean
}): SupplierDocumentMockFixture {
  const headers = ['Código', 'Descripción', 'Cantidad', 'Unidad', 'Precio', 'Importe']
  const rows = input.lines.map((line) => [
    line.reference,
    line.description,
    String(line.quantity).replace('.', ','),
    line.purchaseUnit,
    money(line.unitPrice),
    money(line.quantity * line.unitPrice),
  ])
  const cellWidth = 100
  const cells = [headers, ...rows].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    text,
    confidence: rowIndex === 0 ? 0.99 : input.lines[rowIndex - 1]?.confidence ?? 0.96,
    polygon: [columnIndex * cellWidth, rowIndex * 30, (columnIndex + 1) * cellWidth, rowIndex * 30, (columnIndex + 1) * cellWidth, (rowIndex + 1) * 30, columnIndex * cellWidth, (rowIndex + 1) * 30],
  })))
  const total = input.lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0)
  const text = [
    input.supplierName,
    input.taxId ? `NIF: ${input.taxId}` : '',
    `Albarán Nº ${input.documentNumber}`,
    'Fecha 01/09/2026',
    headers.join(' | '),
    ...rows.map((row) => row.join(' | ')),
    `Total ${money(total)} €`,
  ].filter(Boolean).join('\n')
  const words = text.split(/\s+/).map((word, index) => ({
    text: word,
    confidence: 0.97,
    polygon: [(index % 8) * 72, Math.floor(index / 8) * 18, (index % 8) * 72 + 68, Math.floor(index / 8) * 18, (index % 8) * 72 + 68, Math.floor(index / 8) * 18 + 14, (index % 8) * 72, Math.floor(index / 8) * 18 + 14],
  }))
  const ocr: OcrDocument = {
    provider: 'mock',
    confidence: Math.min(...input.lines.map((line) => line.confidence ?? 0.96)),
    text,
    metadata: { fixtureId: input.id },
    pages: [{
      pageNumber: 1,
      width: 600,
      height: 850,
      unit: 'pixel',
      text,
      words,
      tables: [{ rowCount: rows.length + 1, columnCount: headers.length, cells }],
      confidence: 0.96,
    }],
  }
  const extraction: SupplierDocumentExtraction = {
    document: { type: 'delivery_note', number: input.documentNumber, date: '2026-09-01', total },
    supplier: {
      name: input.supplierName,
      legalName: null,
      taxId: input.taxId,
      email: null,
      phone: null,
      address: null,
    },
    supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
    lines: input.lines.map((line) => ({
      supplierReference: line.reference,
      description: line.description,
      barcode: line.barcode ?? null,
      quantity: line.quantity,
      purchaseUnit: line.purchaseUnit,
      unitPrice: line.unitPrice,
      discountAmount: 0,
      chargesAmount: 0,
      grossCost: line.quantity * line.unitPrice,
      netCost: line.quantity * line.unitPrice,
      lineTotal: line.quantity * line.unitPrice,
      taxRate: 21,
      packageExpression: line.description.match(/\d+(?:[.,]\d+)?\s*[x×]\s*\d+(?:[.,]\d+)?\s*(?:kg|g|l|cl|ml|uds?)/i)?.[0] ?? null,
      confidence: line.confidence ?? 0.96,
    })),
    proposedProfile: input.proposeProfile === false ? null : {
      ...defaultRules,
      requiredTexts: [input.supplierName, 'Código', 'Descripción'],
    },
    confidence: ocr.confidence,
  }
  return {
    id: input.id,
    label: input.label,
    description: input.description,
    ocr,
    extraction,
    knownProfile: input.knownProfile ? { ...defaultRules, requiredTexts: [input.supplierName, 'Código', 'Descripción'] } : null,
  }
}

function makeMultiRowFixture(): SupplierDocumentMockFixture {
  const headers = ['Código', 'Descripción', 'Cantidad', 'Unidad', 'Precio', 'Importe']
  const rows = [
    ['MP-01', 'PRODUCTO MULTIFILA', '3', 'caja', '58,80', '176,40'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-79,38'],
    ['', 'CARGO LOGÍSTICO', '', '', '', '2,70'],
    ['', 'TASA RECICLAJE', '', '', '', '0,22'],
    ['', 'TOTAL NETO LÍNEA', '', '', '', '99,94'],
  ]
  const profile: SupplierProfileRules = {
    ...defaultRules,
    requiredTexts: ['PROVEEDOR MULTIFILA', 'Código', 'Descripción'],
    tableEndText: null,
    lineGroup: {
      endAliases: ['TOTAL NETO LÍNEA'],
      discountAliases: ['DESCUENTO COMERCIAL'],
      chargeAliases: ['CARGO LOGÍSTICO', 'TASA RECICLAJE'],
      netTotalFromEndRow: true,
      maxContinuationRows: 6,
    },
  }
  const text = [
    'PROVEEDOR MULTIFILA',
    'NIF: B11223344',
    'Albarán Nº MP-1001',
    'Fecha 01/09/2026',
    headers.join(' | '),
    ...rows.map((row) => row.join(' | ')),
    'Total documento 99,94 €',
  ].join('\n')
  const cells = [headers, ...rows].flatMap((row, rowIndex) => row.map((cellText, columnIndex) => ({
    rowIndex,
    columnIndex,
    rowSpan: 1,
    columnSpan: 1,
    text: cellText,
    confidence: 0.98,
  })))
  const ocr: OcrDocument = {
    provider: 'mock',
    confidence: 0.98,
    text,
    metadata: { fixtureId: 'multi-row-product' },
    pages: [{
      pageNumber: 1,
      width: 600,
      height: 850,
      unit: 'pixel',
      text,
      words: text.split(/\s+/).map((word) => ({ text: word, confidence: 0.98 })),
      tables: [{ rowCount: rows.length + 1, columnCount: headers.length, cells }],
      confidence: 0.98,
    }],
  }
  const extraction: SupplierDocumentExtraction = {
    document: { type: 'delivery_note', number: 'MP-1001', date: '2026-09-01', total: 99.94 },
    supplier: {
      name: 'PROVEEDOR MULTIFILA',
      legalName: null,
      taxId: 'B11223344',
      email: null,
      phone: null,
      address: null,
    },
    supplierResolution: { supplierId: null, confidence: 'unresolved', signals: [], reasons: [] },
    lines: [{
      supplierReference: 'MP-01',
      description: 'PRODUCTO MULTIFILA',
      barcode: null,
      quantity: 3,
      purchaseUnit: 'caja',
      unitPrice: 58.8,
      discountAmount: 79.38,
      chargesAmount: 2.92,
      grossCost: 176.4,
      netCost: 99.94,
      lineTotal: 99.94,
      taxRate: null,
      packageExpression: null,
      confidence: 0.98,
    }],
    proposedProfile: profile,
    confidence: 0.98,
  }
  return {
    id: 'multi-row-product',
    label: 'Producto en bloque multipfila',
    description: 'Agrupa descuento, cargos y total neto sin crear líneas auxiliares.',
    ocr,
    extraction,
    knownProfile: profile,
  }
}

export const supplierDocumentMockFixtures: SupplierDocumentMockFixture[] = [
  makeFixture({
    id: 'known-supplier',
    label: 'Proveedor conocido',
    description: 'Perfil determinista conocido, sin fallback de IA.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1001',
    knownProfile: true,
    lines: [{ reference: '18452', description: 'COCA COLA ZERO 24X33CL', quantity: 2, purchaseUnit: 'caja', unitPrice: 14.5, barcode: '5449000131805' }],
  }),
  makeFixture({
    id: 'unknown-supplier',
    label: 'Proveedor desconocido',
    description: 'Crea proveedor local y propone un perfil candidato.',
    supplierName: 'NUEVO MAYORISTA NORTE',
    taxId: 'B87654321',
    documentNumber: 'NM-0001',
    lines: [{ reference: 'N-81', description: 'HARINA TRIGO 4X5KG', quantity: 2, purchaseUnit: 'caja', unitPrice: 17.8 }],
  }),
  makeFixture({
    id: 'known-product',
    label: 'Producto conocido',
    description: 'EAN y referencia diseñados para resolver un alias aprendido.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1002',
    lines: [{ reference: '18452', description: 'COCA COLA ZERO 24X33CL', quantity: 1, purchaseUnit: 'caja', unitPrice: 14.5, barcode: '5449000131805' }],
  }),
  makeFixture({
    id: 'new-product',
    label: 'Producto nuevo',
    description: 'No contiene un nombre que deba emparejarse automáticamente.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1003',
    lines: [{ reference: 'NEW-404', description: 'SIROPE YUZU ARTESANO 6X1L', quantity: 1, purchaseUnit: 'caja', unitPrice: 31.2 }],
  }),
  makeFixture({
    id: 'unit-conversion',
    label: 'Conversión 24x33 cl',
    description: '2 cajas × 24 botellas × 33 cl = 15,84 L.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1004',
    lines: [{ reference: '18452', description: 'COCA COLA ZERO 24X33CL', quantity: 2, purchaseUnit: 'caja', unitPrice: 14.5 }],
  }),
  makeFixture({
    id: 'uncertain-line',
    label: 'Línea dudosa',
    description: 'Abreviatura deliberadamente ambigua que obliga a revisar.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1005',
    lines: [{ reference: 'AMB-01', description: 'PRODUCTO COCINA 12 X 1 U', quantity: 3, purchaseUnit: 'caja', unitPrice: 8.25, confidence: 0.58 }],
  }),
  makeFixture({
    id: 'cost-change',
    label: 'Cambio de coste',
    description: 'Coste normalizado distinto al reference_cost existente.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1006',
    lines: [{ reference: 'Q-600', description: 'QUESO CABRA RULO 6X1KG', quantity: 1, purchaseUnit: 'caja', unitPrice: 58.2 }],
  }),
  makeFixture({
    id: 'multiple-warehouses',
    label: 'Varios almacenes',
    description: 'Permite comprobar la prioridad y el override puntual de almacén.',
    supplierName: 'DISTRIBUCIONES DEMO',
    taxId: 'B12345678',
    documentNumber: 'ALB-1007',
    lines: [{ reference: 'OIL-5', description: 'ACEITE OLIVA 4X5L', quantity: 2, purchaseUnit: 'caja', unitPrice: 89.5 }],
  }),
  makeMultiRowFixture(),
]

export function getSupplierDocumentMockFixture(id: string) {
  return supplierDocumentMockFixtures.find((fixture) => fixture.id === id) ?? null
}
