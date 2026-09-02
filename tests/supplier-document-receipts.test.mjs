import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  chooseDefaultWarehouse,
  groundSupplierExtractionInOcr,
  matchInventoryItem,
  normalizePurchaseToBase,
  normalizeSupplierName,
  normalizeSupplierTaxId,
  parseSupplierDocumentExtraction,
  parsePackagingExpression,
  resolveSupplierCandidate,
  runDeterministicParser,
  sanitizeSupplierDocumentExtraction,
  supplierIdentityMatches,
  supplierProfileRulesSchema,
  validateExtractionMath,
  validateProposedProfile,
} from '../supabase/functions/_shared/supplier-documents/core.ts'
import { getSupplierDocumentMockFixture, supplierDocumentMockFixtures } from '../supabase/functions/_shared/supplier-documents/fixtures.ts'
import {
  createDocumentOcrProvider,
  MistralDocumentOcrProvider,
  MockDocumentOcrProvider,
  MockSupplierDocumentAiProvider,
  normalizeMistralOcrResponse,
  ProviderConfigurationError,
  AzureDocumentOcrProvider,
  OpenAiSupplierDocumentProvider,
} from '../supabase/functions/_shared/supplier-documents/providers.ts'

const migration = await readFile(new URL('../supabase/migrations/20260901120000_add_supplier_document_receipts.sql', import.meta.url), 'utf8')
const page = await readFile(new URL('../src/features/crm/supplier-documents/pages/SupplierReceiptsPage.tsx', import.meta.url), 'utf8')
const service = await readFile(new URL('../src/features/crm/supplier-documents/services/supplierDocumentService.ts', import.meta.url), 'utf8')
const edgeFunction = await readFile(new URL('../supabase/functions/process-supplier-document/index.ts', import.meta.url), 'utf8')
const ocrProviders = await readFile(new URL('../supabase/functions/_shared/supplier-documents/providers.ts', import.meta.url), 'utf8')
const supabaseConfig = await readFile(new URL('../supabase/config.toml', import.meta.url), 'utf8')
const identityBackfillMigration = await readFile(new URL('../supabase/migrations/20260901152330_backfill_supplier_global_identity.sql', import.meta.url), 'utf8')
const lineChargesMigration = await readFile(new URL('../supabase/migrations/20260902002359_add_supplier_document_line_charges.sql', import.meta.url), 'utf8')
const supplierIdentityMigration = await readFile(new URL('../supabase/migrations/20260902005509_improve_supplier_identity_resolution.sql', import.meta.url), 'utf8')

const units = [
  { id: 'kg', name: 'Kilogramo', symbol: 'kg', contentQuantity: 1, contentUnitId: 'kg' },
  { id: 'l', name: 'Litro', symbol: 'L', contentQuantity: 1, contentUnitId: 'l' },
  { id: 'ud', name: 'Unidad', symbol: 'ud', contentQuantity: 1, contentUnitId: 'ud' },
]

const realOcrSelection = {
  azure: { endpoint: 'https://azure.example.test', apiKey: 'azure-key' },
  mistral: { apiKey: 'mistral-key' },
}

function groupedParserInput(rows, lineGroup = {}) {
  const fixture = getSupplierDocumentMockFixture('multi-row-product')
  assert.ok(fixture?.knownProfile)
  const ocr = structuredClone(fixture.ocr)
  const headers = ['Código', 'Descripción', 'Cantidad', 'Unidad', 'Precio', 'Importe']
  ocr.text = ['PROVEEDOR MULTIFILA', headers.join(' | '), ...rows.map((row) => row.join(' | '))].join('\n')
  ocr.pages[0].text = ocr.text
  ocr.pages[0].tables = [{
    rowCount: rows.length + 1,
    columnCount: headers.length,
    cells: [headers, ...rows].flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
      rowIndex, columnIndex, rowSpan: 1, columnSpan: 1, text, confidence: 0.98,
    }))),
  }]
  return {
    ocr,
    rules: {
      ...fixture.knownProfile,
      lineGroup: { ...fixture.knownProfile.lineGroup, ...lineGroup },
    },
    defaults: {
      documentType: 'delivery_note',
      supplierName: fixture.extraction.supplier.name,
      supplierTaxId: fixture.extraction.supplier.taxId,
    },
  }
}

function parseGroupedRows(rows, lineGroup = {}) {
  const input = groupedParserInput(rows, lineGroup)
  return runDeterministicParser(input.rules, input.ocr, input.defaults)
}

function modelLine(description, overrides = {}) {
  return {
    supplierReference: null,
    description,
    barcode: null,
    quantity: 1,
    purchaseUnit: null,
    unitPrice: null,
    discountAmount: 0,
    chargesAmount: 0,
    grossCost: null,
    netCost: null,
    lineTotal: null,
    taxRate: null,
    packageExpression: null,
    confidence: 0.9,
    ...overrides,
  }
}

function modelExtraction(lines) {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  return {
    ...structuredClone(fixture.extraction),
    lines,
    proposedProfile: null,
  }
}

function ocrWithSupplierText(text) {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const ocr = structuredClone(fixture.ocr)
  ocr.text = text
  ocr.pages[0].text = text
  ocr.pages[0].words = []
  ocr.pages[0].tables = []
  return ocr
}

const mistralOcrFixture = {
  model: 'mistral-ocr-latest',
  usage_info: { pages_processed: 1 },
  pages: [{
    index: 0,
    markdown: 'Proveedor Uno\n\n[tbl-0.md](tbl-0.md)',
    dimensions: { dpi: 200, width: 1200, height: 1600 },
    confidence_scores: {
      average_page_confidence_score: 0.94,
      minimum_page_confidence_score: 0.82,
      word_confidence_scores: [
        { text: 'Proveedor', confidence: 0.96, start_index: 0 },
        { text: 'Uno', confidence: 0.92, start_index: 10 },
      ],
    },
    blocks: [
      { type: 'text', content: 'Proveedor Uno', top_left_x: 20, top_left_y: 30, bottom_right_x: 310, bottom_right_y: 80 },
      { type: 'table', content: 'Código | Descripción | Cantidad', table_id: 'tbl-0.md', top_left_x: 40, top_left_y: 200, bottom_right_x: 1160, bottom_right_y: 520 },
    ],
    tables: [{
      id: 'tbl-0.md',
      format: 'markdown',
      content: '| Código | Descripción | Cantidad |\n| --- | --- | ---: |\n| A-1 | Agua 1L | 2 |',
      word_confidence_scores: [{ text: 'Agua', confidence: 0.91, start_index: 80 }],
    }],
  }],
}

test('normaliza la identidad del proveedor sin confundir NIF distintos', () => {
  assert.equal(normalizeSupplierTaxId(' ES B-123.456-78 '), 'ESB12345678')
  assert.equal(normalizeSupplierTaxId(' - '), null)
  assert.equal(normalizeSupplierName('Coca-Cola Europacific Partners Iberia, S.L.U.'), 'coca cola europacific partners iberia')
  assert.equal(supplierIdentityMatches(
    { name: 'Coca-Cola Europacific Partners' },
    { name: 'COCA COLA EUROPACIFIC PARTNERS IBERIA, S.L.U.' },
  ), true)
  assert.equal(supplierIdentityMatches(
    { name: 'Proveedor Uno, S.L.', taxId: 'B12345678' },
    { name: 'Proveedor Uno SL', taxId: 'B87654321' },
  ), false)
})

const extractedSupplier = (overrides = {}) => ({
  name: 'Emisor no identificado',
  legalName: null,
  taxId: null,
  email: null,
  phone: null,
  address: null,
  ...overrides,
})

test('resuelve por NIF exacto aunque la razón social sea distinta', () => {
  const resolution = resolveSupplierCandidate(
    extractedSupplier({
      name: 'COCA-COLA EUROPACIFIC PARTNERS IBERIA, S.L.U.',
      taxId: 'ES B-123.456-78',
    }),
    [
      { supplierId: 'coca-cola', name: 'Coca-Cola', taxId: 'ESB12345678' },
      { supplierId: 'otro', name: 'Distribuidor Coca-Cola', taxId: 'B87654321' },
    ],
  )
  assert.deepEqual(resolution, {
    supplierId: 'coca-cola',
    confidence: 'high',
    signals: ['tax_id'],
    reasons: ['exact_tax_id'],
  })
})

test('un nombre solo parecido no fuerza asociación y varios nombres iguales quedan ambiguos', () => {
  assert.equal(resolveSupplierCandidate(
    extractedSupplier({ name: 'Coca-Cola Iberia Distribución' }),
    [{ supplierId: 'coca-cola', name: 'Coca-Cola' }],
  ).supplierId, null)

  const ambiguous = resolveSupplierCandidate(
    extractedSupplier({ name: 'Distribuciones Norte, S.L.' }),
    [
      { supplierId: 'norte-1', name: 'Distribuciones Norte SL' },
      { supplierId: 'norte-2', name: 'Distribuciones Norte, S.L.U.' },
    ],
  )
  assert.equal(ambiguous.supplierId, null)
  assert.deepEqual(ambiguous.reasons, ['ambiguous_name'])

  const exactNameOnly = resolveSupplierCandidate(
    extractedSupplier({ name: 'Distribuciones Norte, S.L.' }),
    [{ supplierId: 'norte', name: 'Distribuciones Norte SL' }],
  )
  assert.equal(exactNameOnly.supplierId, 'norte')
  assert.equal(exactNameOnly.confidence, 'probable')
})

test('un alias confirmado por usuario tiene prioridad sobre el nombre registrado', () => {
  const resolution = resolveSupplierCandidate(
    extractedSupplier({ name: 'Distribuciones Norte, S.L.' }),
    [
      { supplierId: 'nombre-directo', name: 'Distribuciones Norte' },
      {
        supplierId: 'corregido',
        name: 'Proveedor confirmado',
        identities: [{ type: 'name', value: 'distribuciones norte', source: 'user_confirmed' }],
      },
    ],
  )
  assert.equal(resolution.supplierId, 'corregido')
  assert.equal(resolution.confidence, 'high')
  assert.deepEqual(resolution.reasons, ['user_confirmed_alias'])
})

test('normaliza formatos de compra seguros y rechaza abreviaturas ambiguas', () => {
  assert.deepEqual(parsePackagingExpression('6x1L'), {
    packageCount: 6, unitQuantity: 1, unitSymbol: 'l', canonicalQuantity: 6, canonicalSymbol: 'L', dimension: 'volume',
  })
  assert.equal(parsePackagingExpression('24x33cl')?.canonicalQuantity, 7.92)
  assert.equal(parsePackagingExpression('4x5kg')?.canonicalQuantity, 20)
  assert.equal(parsePackagingExpression('12 uds')?.canonicalQuantity, 12)
  assert.equal(parsePackagingExpression('12 x 1 U'), null)
  assert.equal(normalizePurchaseToBase({
    purchaseQuantity: 2,
    purchaseUnit: 'caja',
    packageExpression: '24x33cl',
    description: 'COCA COLA ZERO 24X33CL',
    baseUnit: units[1],
    units,
  })?.baseQuantity, 15.84)
  const bottleUnit = { id: 'b', name: 'Botellín', symbol: 'b', contentQuantity: 1, contentUnitId: 'b' }
  assert.equal(parsePackagingExpression('24x1b'), null)
  assert.equal(normalizePurchaseToBase({
    purchaseQuantity: 3,
    purchaseUnit: 'C24',
    packageExpression: null,
    description: 'BURN LATA25 C24',
    baseUnit: bottleUnit,
    units: [bottleUnit],
    packageCount: 24,
    packageUnitQuantity: 1,
    packageUnitId: bottleUnit.id,
  })?.baseQuantity, 72)
  assert.equal(normalizePurchaseToBase({
    purchaseQuantity: 3,
    purchaseUnit: 'C24',
    packageExpression: '24x1b',
    description: 'BURN LATA25 C24',
    baseUnit: bottleUnit,
    units: [bottleUnit],
  })?.baseQuantity, 72)
})

test('el parser determinista usa la tabla OCR y el schema declarativo', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  assert.ok(fixture?.knownProfile)
  const parsed = runDeterministicParser(fixture.knownProfile, fixture.ocr, {
    documentType: 'delivery_note', supplierName: fixture.extraction.supplier.name, supplierTaxId: fixture.extraction.supplier.taxId,
  })
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].supplierReference, '18452')
  assert.equal(parsed.lines[0].quantity, 2)
  assert.equal(parsed.lines[0].lineTotal, 29)
  assert.equal(validateExtractionMath(parsed).coherent, true)
})

test('headerAliases con un string vacío se sanea a un array vacío válido', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const profile = structuredClone(fixture.knownProfile)
  profile.columns[0].headerAliases = ['']
  const parsed = supplierProfileRulesSchema.parse(profile)
  assert.deepEqual(parsed.columns[0].headerAliases, [])
})

test('headerAliases elimina espacios, vacíos y duplicados antes de validar', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const profile = structuredClone(fixture.knownProfile)
  profile.columns[1].headerAliases = ['', 'DESCRIPCIÓN', '  ', ' descripción ']
  const parsed = supplierProfileRulesSchema.parse(profile)
  assert.deepEqual(parsed.columns[1].headerAliases, ['DESCRIPCIÓN'])
})

test('varias columnas sin aliases no invalidan el perfil completo', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const profile = structuredClone(fixture.knownProfile)
  for (const index of [0, 1, 3, 4]) profile.columns[index].headerAliases = ['', '  ']
  const parsed = supplierProfileRulesSchema.parse(profile)
  assert.deepEqual(parsed.columns.map((column) => column.headerAliases.length), [0, 0, 2, 0, 0, 2])
})

test('un campo realmente obligatorio vacío sigue fallando', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  assert.throws(() => supplierProfileRulesSchema.parse({
    ...structuredClone(fixture.knownProfile),
    requiredTexts: ['   '],
  }))
})

test('la extracción de una marca conocida elimina teléfono, dirección y razón social no presentes en OCR', () => {
  const ocr = ocrWithSupplierText('Coca-Cola Europacific Partners\nAlbarán 123')
  const extraction = modelExtraction([modelLine('COCACOLA VR237 C24.')])
  extraction.supplier = {
    name: 'Coca-Cola Europacific Partners',
    legalName: 'Coca-Cola Corporation',
    taxId: null,
    email: null,
    phone: '(415) 661-1001',
    address: 'San Francisco, California',
  }
  const parsed = parseSupplierDocumentExtraction(groundSupplierExtractionInOcr(extraction, ocr))
  assert.deepEqual(parsed.supplier, {
    name: 'Coca-Cola Europacific Partners',
    legalName: null,
    taxId: null,
    email: null,
    phone: null,
    address: null,
  })
})

test('un teléfono explícito del proveedor se conserva en la extracción', () => {
  const ocr = ocrWithSupplierText('Coca-Cola Europacific Partners\nAtención al cliente: 900 246 500')
  const extraction = modelExtraction([modelLine('COCACOLA VR237 C24.')])
  extraction.supplier = {
    name: 'Coca-Cola Europacific Partners',
    legalName: null,
    taxId: null,
    email: null,
    phone: '900 246 500',
    address: null,
  }
  const parsed = parseSupplierDocumentExtraction(groundSupplierExtractionInOcr(extraction, ocr))
  assert.equal(parsed.supplier.phone, '900 246 500')
})

test('los datos objetivos extraídos siguen resolviendo un candidato existente', () => {
  const ocr = ocrWithSupplierText('Coca-Cola Europacific Partners Iberia, S.L.U.\nNIF: ES B-123.456-78')
  const extraction = modelExtraction([modelLine('COCACOLA VR237 C24.')])
  extraction.supplier = {
    name: 'Coca-Cola Europacific Partners Iberia, S.L.U.',
    legalName: null,
    taxId: 'ES B-123.456-78',
    email: null,
    phone: null,
    address: null,
  }
  const parsed = parseSupplierDocumentExtraction(groundSupplierExtractionInOcr(extraction, ocr))
  const resolution = resolveSupplierCandidate(parsed.supplier, [
    { supplierId: 'coca-cola', name: 'Coca-Cola', taxId: 'ESB12345678' },
  ])
  assert.equal(resolution.supplierId, 'coca-cola')
  assert.equal(resolution.confidence, 'high')
  assert.deepEqual(resolution.signals, ['tax_id'])
})

test('un perfil Coca-Cola con aliases saneados llega al parser y extrae cinco productos', () => {
  const products = [
    'RBLISS SIG TON WTR VR20 C24',
    'RBLISS LEM MIXER VR20 C24 HT',
    'COCACOLA VR237 C24',
    'MINUTE MAID PIN VNR20 C24',
    'AQUABONA PET35 C24',
  ]
  const rows = products.flatMap((description, index) => [
    [`CC-${index + 1}`, description, '2', 'C24', '25,44', '50,88'],
    ['', 'Dto. Fijo', '', '', '', '11,45-'],
    ['', 'IBEE', '', '', '', '1,71'],
    ['', 'Punto Verde', '', '', '', '0,05'],
    ['', 'SUBUNIDADES/NETO 48', '', '', '', '41,19'],
  ])
  const input = groupedParserInput(rows, {
    discountAliases: ['Dto. Fijo'],
    chargeAliases: ['IBEE', 'Punto Verde'],
    endAliases: ['SUBUNIDADES/NETO'],
    netTotalFromEndRow: true,
  })
  for (const column of input.rules.columns) column.headerAliases = ['', '  ']
  const parsed = runDeterministicParser(input.rules, input.ocr, input.defaults)
  assert.deepEqual(parsed.lines.map((line) => line.description), products)
  assert.equal(parsed.lines.every((line) => line.discountAmount === 11.45), true)
  assert.equal(parsed.lines.every((line) => line.chargesAmount === 1.76), true)
})

test('filtra description vacía antes de ejecutar la validación final de Zod', () => {
  const sanitized = sanitizeSupplierDocumentExtraction(modelExtraction([
    modelLine('   ', { quantity: 2, lineTotal: 10 }),
  ]))
  assert.deepEqual(sanitized.lines, [])
})

test('varias líneas válidas y una vacía mantienen procesable el documento', () => {
  const parsed = parseSupplierDocumentExtraction(modelExtraction([
    modelLine('Agua mineral', { supplierReference: 'A-1', quantity: 2, unitPrice: 3, grossCost: 6, netCost: 6, lineTotal: 6 }),
    modelLine('   ', { lineTotal: 999 }),
    modelLine('Zumo de naranja', { supplierReference: 'Z-1', quantity: 1, unitPrice: 4, grossCost: 4, netCost: 4, lineTotal: 4 }),
  ]))
  assert.deepEqual(parsed.lines.map((line) => line.description), ['Agua mineral', 'Zumo de naranja'])
})

test('agrupa producto, Dto. Fijo, IBEE, Punto Verde y SUBUNIDADES/NETO en un único producto', () => {
  const parsed = parseSupplierDocumentExtraction(modelExtraction([
    modelLine('COCACOLA VR237 C24.', {
      supplierReference: 'CC-237', quantity: 2, purchaseUnit: 'caja', unitPrice: 25.44,
      grossCost: 50.88, netCost: 50.88, lineTotal: 50.88,
    }),
    modelLine('Dto. Fijo', { supplierReference: 'CC-237', lineTotal: 11.45 }),
    modelLine('IBEE', { lineTotal: 1.71 }),
    modelLine('Punto Verde', { lineTotal: 0.05 }),
    modelLine('SUBUNIDADES/NETO 48', { netCost: 41.19, lineTotal: 41.19 }),
  ]))
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].description, 'COCACOLA VR237 C24.')
  assert.equal(parsed.lines[0].quantity, 2)
  assert.equal(parsed.lines[0].grossCost, 50.88)
  assert.equal(parsed.lines[0].discountAmount, 11.45)
  assert.equal(parsed.lines[0].chargesAmount, 1.76)
  assert.equal(parsed.lines[0].netCost, 41.19)
  assert.equal(parsed.lines[0].lineTotal, 41.19)
})

test('una factura sencilla de una fila conserva exactamente su producto', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  const parsed = parseSupplierDocumentExtraction(structuredClone(fixture.extraction))
  assert.deepEqual(parsed.lines, fixture.extraction.lines)
})

test('todas las líneas inválidas producen un error global controlado y entendible', () => {
  assert.throws(
    () => parseSupplierDocumentExtraction(modelExtraction([
      modelLine(''),
      modelLine('Dto. Fijo', { lineTotal: 4 }),
      modelLine('SUBTOTAL', { lineTotal: 100 }),
    ])),
    /SUPPLIER_DOCUMENT_LINES_NOT_FOUND: No se encontraron líneas de producto válidas/,
  )
})

test('el parser determinista admite descuento con signo contable final', () => {
  const parsed = parseGroupedRows([
    ['CC-237', 'COCACOLA VR237 C24.', '2', 'caja', '25,44', '50,88'],
    ['', 'Dto. Fijo', '', '', '', '11,45-'],
    ['', 'IBEE', '', '', '', '1,71'],
    ['', 'Punto Verde', '', '', '', '0,05'],
    ['', 'SUBUNIDADES/NETO 48', '', '', '', '41,19'],
  ], {
    discountAliases: ['Dto. Fijo'],
    chargeAliases: ['IBEE', 'Punto Verde'],
    endAliases: ['SUBUNIDADES/NETO'],
    netTotalFromEndRow: true,
  })
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].discountAmount, 11.45)
  assert.equal(parsed.lines[0].chargesAmount, 1.76)
  assert.equal(parsed.lines[0].lineTotal, 41.19)
})

test('agrupa un producto multipfila y calcula 3×58,80−79,38+2,70+0,22=99,94', () => {
  const fixture = getSupplierDocumentMockFixture('multi-row-product')
  assert.ok(fixture?.knownProfile)
  const parsed = runDeterministicParser(fixture.knownProfile, fixture.ocr, {
    documentType: 'delivery_note',
    supplierName: fixture.extraction.supplier.name,
    supplierTaxId: fixture.extraction.supplier.taxId,
  })
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].description, 'PRODUCTO MULTIFILA')
  assert.equal(parsed.lines[0].quantity, 3)
  assert.equal(parsed.lines[0].unitPrice, 58.8)
  assert.equal(parsed.lines[0].grossCost, 176.4)
  assert.equal(parsed.lines[0].discountAmount, 79.38)
  assert.equal(parsed.lines[0].chargesAmount, 2.92)
  assert.equal(parsed.lines[0].netCost, 99.94)
  assert.equal(parsed.lines[0].lineTotal, 99.94)
  assert.equal(validateExtractionMath(parsed).coherent, true)
})

test('separa productos consecutivos y no convierte descuentos, cargos, cierres o auxiliares en productos', () => {
  const parsed = parseGroupedRows([
    ['A-1', 'PRODUCTO A', '2', 'caja', '10,00', '20,00'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-2,00'],
    ['', 'TEXTO AUXILIAR DESCONOCIDO', '', '', '', '777,00'],
    ['', 'CARGO LOGÍSTICO', '', '', '', '1,00'],
    ['', 'TOTAL NETO LÍNEA', '', '', '', '19,00'],
    ['B-1', 'PRODUCTO B', '1', 'unidad', '5,00', '5,00'],
    ['', 'TOTAL NETO LÍNEA', '', '', '', '5,00'],
  ])
  assert.deepEqual(parsed.lines.map((line) => line.description), ['PRODUCTO A', 'PRODUCTO B'])
  assert.deepEqual(parsed.lines.map((line) => line.lineTotal), [19, 5])
  assert.equal(parsed.lines[0].discountAmount, 2)
  assert.equal(parsed.lines[0].chargesAmount, 1)
  assert.equal(parsed.lines[1].discountAmount, 0)
  assert.equal(parsed.lines[1].chargesAmount, 0)
})

test('acumula varios descuentos y cargos y deriva el neto cuando falta la fila final', () => {
  const parsed = parseGroupedRows([
    ['A-1', 'PRODUCTO A', '1', 'caja', '100,00', '100,00'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-10,00'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-5,00'],
    ['', 'CARGO LOGÍSTICO', '', '', '', '2,00'],
    ['', 'TASA RECICLAJE', '', '', '', '3,00'],
  ])
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].discountAmount, 15)
  assert.equal(parsed.lines[0].chargesAmount, 5)
  assert.equal(parsed.lines[0].lineTotal, 90)
  assert.equal(validateExtractionMath(parsed).coherent, true)
})

test('detiene un bloque ante el producto siguiente y respeta maxContinuationRows', () => {
  const nextProduct = parseGroupedRows([
    ['A-1', 'PRODUCTO A', '2', 'caja', '10,00', '20,00'],
    ['B-1', 'PRODUCTO B', '1', 'unidad', '5,00', '5,00'],
    ['', 'TOTAL NETO LÍNEA', '', '', '', '5,00'],
  ])
  assert.deepEqual(nextProduct.lines.map((line) => line.lineTotal), [20, 5])

  const limited = parseGroupedRows([
    ['A-1', 'PRODUCTO A', '1', 'caja', '100,00', '100,00'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-10,00'],
    ['', 'CARGO LOGÍSTICO', '', '', '', '2,00'],
    ['', 'DESCUENTO COMERCIAL', '', '', '', '-20,00'],
    ['', 'TOTAL NETO LÍNEA', '', '', '', '72,00'],
  ], { maxContinuationRows: 2 })
  assert.equal(limited.lines.length, 1)
  assert.equal(limited.lines[0].discountAmount, 10)
  assert.equal(limited.lines[0].chargesAmount, 2)
  assert.equal(limited.lines[0].lineTotal, 92)
})

test('sin lineGroup mantiene el parser de una fila y chargesAmount=0 por compatibilidad', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  assert.ok(fixture?.knownProfile)
  const legacyRules = structuredClone(fixture.knownProfile)
  delete legacyRules.lineGroup
  const parsed = runDeterministicParser(legacyRules, fixture.ocr, {
    documentType: 'delivery_note',
    supplierName: fixture.extraction.supplier.name,
    supplierTaxId: fixture.extraction.supplier.taxId,
  })
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].lineTotal, 29)
  assert.equal(parsed.lines[0].chargesAmount, 0)

  const legacyExtraction = structuredClone(parsed)
  delete legacyExtraction.lines[0].chargesAmount
  assert.equal(validateExtractionMath(legacyExtraction).coherent, true)
})

test('el perfil exige descripción y cantidad, y el parser elige una tabla con líneas reales', () => {
  const fixture = getSupplierDocumentMockFixture('known-supplier')
  assert.ok(fixture?.knownProfile)
  const invalidColumns = fixture.knownProfile.columns.map((column) => (
    column.field === 'quantity' ? { ...column, required: false } : column
  ))
  assert.throws(
    () => supplierProfileRulesSchema.parse({ ...fixture.knownProfile, columns: invalidColumns }),
    /PROFILE_REQUIRED_COLUMN_MISSING:quantity/,
  )
  assert.throws(
    () => supplierProfileRulesSchema.parse({
      ...fixture.knownProfile,
      columns: [...fixture.knownProfile.columns, fixture.knownProfile.columns[0]],
    }),
    /PROFILE_DUPLICATE_COLUMN:supplierReference/,
  )

  const ocr = structuredClone(fixture.ocr)
  const sourceTable = ocr.pages[0].tables[0]
  const headerOnly = {
    ...sourceTable,
    rowCount: 1,
    cells: sourceTable.cells.filter((cell) => cell.rowIndex === 0),
  }
  const shiftedTable = {
    ...sourceTable,
    rowCount: sourceTable.rowCount + 1,
    cells: [
      { ...sourceTable.cells[0], rowIndex: 0, columnIndex: 0, text: 'DETALLE DE PRODUCTOS' },
      ...sourceTable.cells.map((cell) => ({ ...cell, rowIndex: cell.rowIndex + 1 })),
    ],
  }
  ocr.pages[0].tables = [headerOnly, shiftedTable]
  const parsed = runDeterministicParser(fixture.knownProfile, ocr, {
    documentType: 'delivery_note', supplierName: fixture.extraction.supplier.name, supplierTaxId: fixture.extraction.supplier.taxId,
  })
  assert.equal(parsed.lines.length, 1)
  assert.equal(parsed.lines[0].supplierReference, '18452')
})

test('matching respeta EAN, referencia, alias, nombre y revisión manual', () => {
  const items = [
    { id: 'coke', name: 'Coca-Cola Zero', baseUnitId: 'l', referenceCost: 1.8, active: true },
    { id: 'flour', name: 'Harina de trigo', baseUnitId: 'kg', referenceCost: 1, active: true },
  ]
  const aliases = [
    { aliasType: 'ean', aliasValue: '5449000131805', inventoryItemId: 'coke' },
    { aliasType: 'supplier_reference', aliasValue: 'h-44', inventoryItemId: 'flour' },
    { aliasType: 'description', aliasValue: 'harina especial fuerza', inventoryItemId: 'flour' },
  ]
  assert.equal(matchInventoryItem({ barcode: '5449000131805', supplierReference: null, description: 'otro', packageExpression: null }, items, aliases).reason, 'ean')
  assert.equal(matchInventoryItem({ barcode: null, supplierReference: 'H-44', description: 'otro', packageExpression: null }, items, aliases).reason, 'supplier_reference')
  assert.equal(matchInventoryItem({ barcode: null, supplierReference: null, description: 'Harina especial fuerza', packageExpression: null }, items, aliases).reason, 'alias')
  assert.equal(matchInventoryItem({ barcode: null, supplierReference: null, description: 'COCA COLA ZERO 24X33CL', packageExpression: '24x33cl' }, items, []).inventoryItemId, 'coke')
  assert.deepEqual(matchInventoryItem({ barcode: null, supplierReference: 'NEW', description: 'Sirope yuzu artesano', packageExpression: '6x1L' }, items, []), {
    inventoryItemId: null, status: 'needs_review', reason: 'none', score: 0,
  })
})

test('el alias recupera la conversión de formato aprendida', () => {
  const match = matchInventoryItem(
    { barcode: null, supplierReference: 'WGBRU', description: 'Ron Brugal', packageExpression: null },
    [{ id: 'brugal', name: 'Ron Brugal', baseUnitId: 'l', referenceCost: 0.3, active: true }],
    [{
      aliasType: 'supplier_reference', aliasValue: 'wgbru', inventoryItemId: 'brugal',
      packageExpression: '1x70cl',
    }],
  )
  assert.equal(match.inventoryItemId, 'brugal')
  assert.equal(match.packageExpression, '1x70cl')
  const normalized = normalizePurchaseToBase({
    purchaseQuantity: 2,
    purchaseUnit: 'caja',
    packageExpression: match.packageExpression ?? null,
    description: 'Ron Brugal',
    baseUnit: units[1],
    units,
  })
  assert.equal(normalized?.baseQuantity, 1.4)
})

test('elige el almacén activo de menor prioridad', () => {
  assert.equal(chooseDefaultWarehouse('item', [
    { inventoryItemId: 'item', warehouseId: 'secondary', priority: 2, enabled: true },
    { inventoryItemId: 'item', warehouseId: 'primary', priority: 1, enabled: true },
    { inventoryItemId: 'item', warehouseId: 'disabled', priority: 0, enabled: false },
  ], [
    { id: 'primary', active: true, sortOrder: 9 },
    { id: 'secondary', active: true, sortOrder: 1 },
    { id: 'disabled', active: true, sortOrder: 0 },
  ]), 'primary')
  assert.equal(chooseDefaultWarehouse('missing', [], []), null)
})

test('solo acepta un perfil candidato si reproduce la interpretación y las matemáticas', () => {
  const fixture = getSupplierDocumentMockFixture('unknown-supplier')
  assert.ok(fixture)
  const validation = validateProposedProfile(fixture.ocr, fixture.extraction)
  assert.equal(validation.candidate, true)
  assert.equal(validateExtractionMath({ ...fixture.extraction, lines: [{ ...fixture.extraction.lines[0], lineTotal: 999 }] }).coherent, false)
  const subtotal = fixture.extraction.lines.reduce((sum, line) => sum + (line.lineTotal ?? 0), 0)
  assert.equal(validateExtractionMath({
    ...fixture.extraction,
    document: { ...fixture.extraction.document, total: subtotal * 1.21 },
  }).coherent, true)
  assert.throws(() => supplierProfileRulesSchema.parse({ ...fixture.extraction.proposedProfile, columns: [] }))
})

test('valida perfiles multipfila por aliases OCR, descuentos, cargos, netos y matemáticas', () => {
  const fixture = getSupplierDocumentMockFixture('multi-row-product')
  assert.ok(fixture)
  assert.equal(validateProposedProfile(fixture.ocr, fixture.extraction).candidate, true)

  const wrongCharges = structuredClone(fixture.extraction)
  wrongCharges.lines[0].chargesAmount = 0
  assert.equal(validateProposedProfile(fixture.ocr, wrongCharges).candidate, false)

  const inventedAlias = structuredClone(fixture.extraction)
  inventedAlias.proposedProfile.lineGroup.chargeAliases.push('CARGO QUE NO EXISTE')
  const rejected = validateProposedProfile(fixture.ocr, inventedAlias)
  assert.equal(rejected.candidate, false)
  assert.equal(rejected.reason, 'PROFILE_LINE_GROUP_ALIAS_NOT_IN_OCR')
})

test('los nueve fixtures incluyen el bloque multipfila junto a los casos previos', () => {
  const expected = [
    'known-supplier', 'unknown-supplier', 'known-product', 'new-product',
    'unit-conversion', 'uncertain-line', 'cost-change', 'multiple-warehouses', 'multi-row-product',
  ]
  assert.deepEqual(supplierDocumentMockFixtures.map((fixture) => fixture.id), expected)
  assert.notEqual(getSupplierDocumentMockFixture('unknown-supplier')?.extraction.supplier.name, '')
  const newProduct = getSupplierDocumentMockFixture('new-product')
  assert.ok(newProduct)
  assert.equal(matchInventoryItem(newProduct.extraction.lines[0], [], []).status, 'needs_review')
  assert.ok(getSupplierDocumentMockFixture('cost-change')?.extraction.lines[0].netCost)
  assert.ok(getSupplierDocumentMockFixture('multiple-warehouses'))
})

test('los providers mock cubren OCR e IA sin secretos y los reales fallan de forma controlada', async () => {
  assert.equal(supplierDocumentMockFixtures.length, 9)
  for (const fixture of supplierDocumentMockFixtures) {
    const ocr = await new MockDocumentOcrProvider(fixture.id).analyze({ bytes: new Uint8Array(), contentType: 'application/mock', fileName: 'mock' })
    const extraction = await new MockSupplierDocumentAiProvider(fixture.id).interpret({ ocr, documentType: 'delivery_note' })
    assert.equal(ocr.provider, 'mock')
    assert.ok(extraction.lines.length > 0)
  }
  const conversion = await new MockSupplierDocumentAiProvider('unit-conversion').interpret({
    ocr: getSupplierDocumentMockFixture('unit-conversion').ocr,
    documentType: 'delivery_note',
  })
  assert.equal(conversion.lines[0].packageExpression?.toLowerCase(), '24x33cl')
  const proposedProfile = await new MockSupplierDocumentAiProvider('unknown-supplier').proposeProfile({
    ocr: getSupplierDocumentMockFixture('unknown-supplier').ocr,
    documentType: 'delivery_note',
    extraction: getSupplierDocumentMockFixture('unknown-supplier').extraction,
  })
  assert.equal(proposedProfile.columns.find((column) => column.field === 'description')?.required, true)
  assert.equal(proposedProfile.columns.find((column) => column.field === 'quantity')?.required, true)
  assert.throws(() => new AzureDocumentOcrProvider({ endpoint: '', apiKey: '' }), ProviderConfigurationError)
  assert.throws(() => new MistralDocumentOcrProvider({ apiKey: '' }), /MISTRAL_API_KEY/)
  assert.throws(() => new OpenAiSupplierDocumentProvider({ apiKey: '', model: '' }), ProviderConfigurationError)
})

test('selecciona azure, mistral y mock desde una única factoría y mantiene azure por defecto', () => {
  assert.ok(createDocumentOcrProvider({ ...realOcrSelection, provider: 'azure' }) instanceof AzureDocumentOcrProvider)
  assert.ok(createDocumentOcrProvider({ ...realOcrSelection, provider: 'mistral' }) instanceof MistralDocumentOcrProvider)
  assert.ok(createDocumentOcrProvider({ ...realOcrSelection }) instanceof AzureDocumentOcrProvider)
  assert.ok(createDocumentOcrProvider({
    ...realOcrSelection,
    provider: 'mistral',
    mockFixtureId: 'known-supplier',
  }) instanceof MockDocumentOcrProvider)
})

test('mistral sin API key produce un error de configuración controlado', () => {
  assert.throws(
    () => createDocumentOcrProvider({ ...realOcrSelection, provider: 'mistral', mistral: { apiKey: '' } }),
    (error) => error instanceof ProviderConfigurationError
      && error.code === 'PROVIDER_NOT_CONFIGURED'
      && error.message.includes('MISTRAL_API_KEY'),
  )
})

test('normaliza una respuesta Mistral conservando páginas, bloques, geometría, tabla y confidence', () => {
  const normalized = normalizeMistralOcrResponse(mistralOcrFixture)
  assert.equal(normalized.provider, 'mistral')
  assert.equal(normalized.metadata.model, 'mistral-ocr-latest')
  assert.equal(normalized.confidence, 0.94)
  assert.equal(normalized.pages[0].pageNumber, 1)
  assert.equal(normalized.pages[0].width, 1200)
  assert.equal(normalized.pages[0].words[0].confidence, 0.96)
  assert.equal(normalized.pages[0].words[0].polygon, undefined)
  assert.deepEqual(normalized.pages[0].blocks[0].polygon, [20, 30, 310, 30, 310, 80, 20, 80])
  assert.equal(normalized.pages[0].tables[0].rowCount, 2)
  assert.equal(normalized.pages[0].tables[0].columnCount, 3)
  assert.equal(normalized.pages[0].tables[0].cells[4].text, 'Agua 1L')
  assert.equal(normalized.pages[0].tables[0].cells[4].confidence, undefined)
  assert.deepEqual(normalized.pages[0].tables[0].polygon, [40, 200, 1160, 200, 1160, 520, 40, 520])
})

test('la migración crea aislamiento, histórico e idempotencia transaccional', () => {
  for (const table of [
    'global_suppliers', 'global_supplier_document_profiles', 'suppliers',
    'supplier_documents', 'supplier_document_lines', 'supplier_item_aliases',
    'inventory_reference_cost_history',
  ]) assert.match(migration, new RegExp(`create table public\\.${table}`))
  for (const table of ['suppliers', 'supplier_documents', 'supplier_document_lines', 'supplier_item_aliases', 'inventory_reference_cost_history']) {
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`))
  }
  assert.match(migration, /supplier_documents_file_hash_unique/)
  assert.match(migration, /supplier_documents_number_unique/)
  assert.match(migration, /for update;[\s\S]*status = 'confirmed'[\s\S]*'duplicate', true/i)
  assert.match(migration, /create or replace function public\.confirm_supplier_document/)
  assert.match(migration, /perform public\.increment_inventory_item_stock/)
  assert.match(migration, /set quantity = quantity \+ v_quantity/)
  assert.match(migration, /insert into public\.inventory_stock_movements/)
  assert.doesNotMatch(migration.match(/create or replace function public\.confirm_supplier_document[\s\S]*?end;\s*\$\$;/i)?.[0] ?? '', /set_inventory_item_stock/)
  assert.match(migration, /SUPPLIER_DOCUMENT_LINE_UNRESOLVED/)
  assert.match(migration, /SUPPLIER_DOCUMENT_COST_DECISION_REQUIRED/)
  assert.match(migration, /inventory_reference_cost_history[\s\S]*previous_cost[\s\S]*new_cost/)
  assert.match(migration, /if v_line\.update_reference_cost[\s\S]*update public\.inventory_items[\s\S]*reference_cost = v_line\.normalized_unit_cost/i)
  assert.match(migration, /status = 'confirmed'[\s\S]*confirmed_by = auth\.uid\(\)/)
})

test('duplicado, doble confirmación y fallo de línea no pueden duplicar ni dejar stock parcial', () => {
  const confirmation = migration.match(/create or replace function public\.confirm_supplier_document[\s\S]*?end;\s*\$\$;/i)?.[0] ?? ''
  assert.match(migration, /unique index supplier_documents_file_hash_unique/)
  assert.match(migration, /unique index supplier_documents_number_unique/)
  assert.ok(confirmation.indexOf("v_document.status = 'confirmed'") < confirmation.indexOf('perform public.increment_inventory_item_stock'))
  assert.ok(confirmation.indexOf('SUPPLIER_DOCUMENT_LINE_UNRESOLVED') < confirmation.indexOf('perform public.increment_inventory_item_stock'))
  assert.ok(confirmation.indexOf('perform public.increment_inventory_item_stock') < confirmation.indexOf("set status = 'confirmed'"))
  assert.doesNotMatch(confirmation, /\bcommit\b|exception\s+when/i)
})

test('guardar coste real, mantener referencia y actualizarla con histórico son caminos separados', () => {
  assert.match(migration, /normalized_unit_cost numeric\(18, 6\)/)
  assert.match(migration, /reference_cost_decided boolean not null default false/)
  assert.match(migration, /if v_line\.update_reference_cost[\s\S]*insert into public\.inventory_reference_cost_history[\s\S]*previous_cost, new_cost, changed_by/i)
  assert.match(migration, /if v_line\.update_reference_cost[\s\S]*set reference_cost = v_line\.normalized_unit_cost/i)
  assert.doesNotMatch(migration, /else[\s\S]{0,120}set reference_cost/i)
})

test('persiste cargos de línea de forma incremental sin alterar las migraciones aplicadas', () => {
  assert.match(lineChargesMigration, /add column if not exists charges_amount numeric\(18, 6\) not null default 0/i)
  assert.match(lineChargesMigration, /check \(charges_amount >= 0\) not valid/i)
  assert.match(lineChargesMigration, /validate constraint supplier_document_lines_charges_amount_check/i)
  assert.match(edgeFunction, /charges_amount: line\.chargesAmount/)
  assert.match(ocrProviders, /chargesAmount/)
  assert.match(ocrProviders, /lineGroup solo cuando el OCR muestre bloques multipfila/i)
})

test('los aliases se aprenden al confirmar y siguen aislados por tenant, local y proveedor', () => {
  assert.match(migration, /unique \(tenant_id, venue_id, supplier_id, alias_type, alias_value\)/)
  assert.match(migration, /'ean'[\s\S]*on conflict \(tenant_id, venue_id, supplier_id, alias_type, alias_value\)/i)
  assert.match(migration, /'supplier_reference'[\s\S]*confirmation_count = public\.supplier_item_aliases\.confirmation_count \+ 1/i)
  assert.match(migration, /'description'[\s\S]*inventory_item_id = excluded\.inventory_item_id/i)
  assert.match(edgeFunction, /supplier_item_aliases'[\s\S]*packaging_json/)
  assert.match(edgeFunction, /packageExpression: match\.packageExpression \?\? line\.packageExpression/)
})

test('las correcciones manuales de proveedor crean identidades reutilizables sin reparsear', () => {
  assert.match(supplierIdentityMigration, /create table public\.supplier_identity_aliases/i)
  assert.match(supplierIdentityMigration, /unique \(tenant_id, identity_type, normalized_value\)/i)
  assert.match(supplierIdentityMigration, /source in \('user_confirmed', 'extracted'\)/i)
  assert.match(supplierIdentityMigration, /create function public\.update_supplier_document_supplier/i)
  assert.match(supplierIdentityMigration, /supplierExtraction,identities/i)
  assert.match(supplierIdentityMigration, /v_existing_alias\.source = 'user_confirmed'[\s\S]*v_existing_alias\.supplier_id <> v_supplier\.id[\s\S]*delete from public\.supplier_identity_aliases/i)
  assert.match(service, /updateSupplierDocumentSupplier[\s\S]*update_supplier_document_supplier/)
  const manualUpdate = service.match(/export async function updateSupplierDocumentSupplier[\s\S]*?\n}/)?.[0] ?? ''
  assert.doesNotMatch(manualUpdate, /processDocument|process-supplier-document|functions\.invoke/)
  assert.match(page, /changeSupplier[\s\S]*updateSupplierDocumentSupplier[\s\S]*setDetail/)
})

test('el documento sin proveedor resuelto sigue en revisión con selector vacío', () => {
  assert.match(edgeFunction, /supplier_id: supplierId[\s\S]*status: 'review'/)
  assert.match(page, /placeholder="Selecciona un proveedor"/)
  assert.match(page, /value=\{detail\.document\.supplierId \?\? ""\}/)
  assert.match(page, /!detail\.document\.supplierId[\s\S]*Selecciona un proveedor/)
})

test('el bucket privado exige el path exacto reservado para un documento accesible', () => {
  assert.match(migration, /'supplier-documents'[\s\S]*false,[\s\S]*20971520/)
  assert.match(migration, /array_length\(v_parts, 1\), 0\) <> 3/)
  assert.match(migration, /document\.storage_path = p_name/)
  assert.match(migration, /supplier_documents_storage_insert[\s\S]*can_access_supplier_document_object\(name\)/)
  assert.match(migration, /grant execute on function public\.can_access_supplier_document_object\(text\)[\s\S]*to authenticated/)
})

test('la UI es mobile-first, revisa incidencias y confirma solo por la RPC global', () => {
  assert.match(page, /capture="environment"/)
  assert.match(page, /Subir foto o PDF/)
  assert.match(page, /Revisar \{needsReviewCount\}/)
  assert.match(page, /rounded-3xl/)
  assert.match(page, /fixed inset-x-0 bottom-0/)
  assert.match(page, /result\.duplicate[\s\S]*setScreen\("duplicate"\)[\s\S]*return/)
  assert.match(page, /Documento duplicado/)
  assert.match(page, /No[\s\S]{0,120}se ha creado una nueva entrada ni se ha modificado el stock/)
  assert.match(page, /Cambios de coste/)
  assert.match(page, /options=\{packageUnitOptions\}/)
  assert.match(page, /packageUnitId: draft\.packageUnitId/)
  assert.doesNotMatch(page, /packageUnitSymbol: event\.target\.value/)
  assert.match(page, /Mantener \{formatCost\(previous\)\}/)
  assert.match(page, /Actualizar a \{formatCost\(line\.normalizedUnitCost\)\}/)
  assert.match(page, /confirmSupplierDocument\(\{[\s\S]*documentId: detail\.document\.id[\s\S]*documentDate[\s\S]*affectsStock/)
  assert.doesNotMatch(page, /saveInventoryItemStock/)
})

test('la Edge Function mantiene IA y OCR sin autoridad sobre stock', () => {
  assert.match(ocrProviders, /class AzureDocumentOcrProvider/)
  assert.match(ocrProviders, /class MistralDocumentOcrProvider/)
  assert.match(edgeFunction, /createDocumentOcrProvider/)
  assert.match(edgeFunction, /SUPPLIER_DOCUMENT_OCR_PROVIDER/)
  assert.match(edgeFunction, /MISTRAL_API_KEY/)
  assert.match(edgeFunction, /ocrModel/)
  assert.match(edgeFunction, /OpenAiSupplierDocumentProvider/)
  assert.match(edgeFunction, /MockDocumentOcrProvider/)
  assert.match(edgeFunction, /validateProposedProfile/)
  assert.match(edgeFunction, /documentTypeCorrected/)
  assert.doesNotMatch(edgeFunction, /SUPPLIER_DOCUMENT_TYPE_MISMATCH/)
  assert.match(edgeFunction, /status: 'review'/)
  assert.doesNotMatch(edgeFunction, /confirm_supplier_document/)
  assert.doesNotMatch(edgeFunction, /inventory_stock_levels.*(?:insert|update)/i)
  assert.doesNotMatch(edgeFunction, /allowGlobalCreation/)
  assert.doesNotMatch(edgeFunction, /from\('global_suppliers'\)\.insert/)
  assert.match(edgeFunction, /loadSupplierCandidates[\s\S]*supplier_identity_aliases/)
  assert.match(edgeFunction, /supplierCandidates,/)
  assert.match(edgeFunction, /resolveSupplierCandidate/)
  assert.match(edgeFunction, /supplierResolution\.confidence === 'high'[\s\S]*supplierResolution\.supplierId[\s\S]*: null/)
  assert.match(edgeFunction, /aiProvider\.proposeProfile/)
  assert.match(edgeFunction, /profileGenerationRetried/)
  assert.match(edgeFunction, /rejectedProfile/)
  assert.match(identityBackfillMigration, /insert into public\.global_suppliers/i)
  assert.match(identityBackfillMigration, /update public\.supplier_documents/i)
})

test('la IA distingue al emisor del cliente y no copia el NIF del destinatario', () => {
  const instructions = OpenAiSupplierDocumentProvider.prototype.interpret.toString()
  assert.match(instructions, /emisor, vendedor o proveedor/)
  assert.match(instructions, /no reutilices el NIF\/CIF del destinatario/)
  assert.match(instructions, /fuente exclusiva para todos los valores de supplier/)
  assert.match(instructions, /No uses conocimiento previo sobre marcas o empresas/)
  assert.match(instructions, /No recibes candidatos durante la extracción/)
  assert.match(instructions, /groundSupplierExtractionInOcr/)
  assert.match(instructions, /lines\[\] debe contener exclusivamente productos reales comprados/)
  assert.match(instructions, /Nunca crees productos independientes.*IBEE.*Punto Verde.*SUBUNIDADES\/NETO/)
  assert.match(instructions, /consolida todo el bloque en la línea principal/)
})

test('la UI muestra el error de la Edge Function y la función valida la sesión internamente', () => {
  assert.match(service, /getFunctionInvokeErrorMessage/)
  assert.match(service, /No se pudo procesar el documento/)
  assert.match(service, /created\.duplicate[\s\S]*created\.status === 'error'[\s\S]*processDocument\(created\.documentId\)/)
  assert.match(page, /workspace\.document\.status === "error"[\s\S]*extractionMetadata\.message/)
  assert.match(supabaseConfig, /\[functions\.process-supplier-document\][\s\S]*?verify_jwt = false/)
  assert.match(edgeFunction, /request\.headers\.get\('Authorization'\)/)
  assert.match(edgeFunction, /authClient\.auth\.getUser\(\)/)
})
