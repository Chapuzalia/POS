import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  chooseDefaultWarehouse,
  matchInventoryItem,
  normalizePurchaseToBase,
  normalizeSupplierName,
  normalizeSupplierTaxId,
  parsePackagingExpression,
  runDeterministicParser,
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

const units = [
  { id: 'kg', name: 'Kilogramo', symbol: 'kg', contentQuantity: 1, contentUnitId: 'kg' },
  { id: 'l', name: 'Litro', symbol: 'L', contentQuantity: 1, contentUnitId: 'l' },
  { id: 'ud', name: 'Unidad', symbol: 'ud', contentQuantity: 1, contentUnitId: 'ud' },
]

const realOcrSelection = {
  azure: { endpoint: 'https://azure.example.test', apiKey: 'azure-key' },
  mistral: { apiKey: 'mistral-key' },
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

test('los ocho fixtures cubren proveedor desconocido, producto nuevo, coste y almacenes', () => {
  const expected = [
    'known-supplier', 'unknown-supplier', 'known-product', 'new-product',
    'unit-conversion', 'uncertain-line', 'cost-change', 'multiple-warehouses',
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
  assert.equal(supplierDocumentMockFixtures.length, 8)
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

test('los aliases se aprenden al confirmar y siguen aislados por tenant, local y proveedor', () => {
  assert.match(migration, /unique \(tenant_id, venue_id, supplier_id, alias_type, alias_value\)/)
  assert.match(migration, /'ean'[\s\S]*on conflict \(tenant_id, venue_id, supplier_id, alias_type, alias_value\)/i)
  assert.match(migration, /'supplier_reference'[\s\S]*confirmation_count = public\.supplier_item_aliases\.confirmation_count \+ 1/i)
  assert.match(migration, /'description'[\s\S]*inventory_item_id = excluded\.inventory_item_id/i)
  assert.match(edgeFunction, /supplier_item_aliases'[\s\S]*packaging_json/)
  assert.match(edgeFunction, /packageExpression: match\.packageExpression \?\? line\.packageExpression/)
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
  assert.match(page, /confirmSupplierDocument\(detail\.document\.id\)/)
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
  assert.match(edgeFunction, /if \(!globalSupplier\) \{[\s\S]*global_suppliers/)
  assert.match(edgeFunction, /aiProvider\.proposeProfile/)
  assert.match(edgeFunction, /profileGenerationRetried/)
  assert.match(edgeFunction, /rejectedProfile/)
  assert.match(identityBackfillMigration, /insert into public\.global_suppliers/i)
  assert.match(identityBackfillMigration, /update public\.supplier_documents/i)
})

test('la IA distingue al emisor del cliente y no copia el NIF del destinatario', () => {
  assert.match(OpenAiSupplierDocumentProvider.prototype.interpret.toString(), /emisor, vendedor o proveedor/)
  assert.match(OpenAiSupplierDocumentProvider.prototype.interpret.toString(), /no reutilices el NIF\/CIF del destinatario/)
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
