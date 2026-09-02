import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.110.0'
import {
  chooseDefaultWarehouse,
  matchInventoryItem,
  normalizeAlias,
  normalizePurchaseToBase,
  profileMatchesOcr,
  resolveSupplierCandidate,
  runDeterministicParser,
  supplierDocumentExtractionSchema,
  supplierIdentitiesFromExtraction,
  supplierProfileRulesSchema,
  validateExtractionMath,
  validateProposedProfile,
  type InventoryUnitDefinition,
  type SupplierCandidate,
  type SupplierDocumentExtraction,
} from '../_shared/supplier-documents/core.ts'
import { getSupplierDocumentMockFixture } from '../_shared/supplier-documents/fixtures.ts'
import {
  createDocumentOcrProvider,
  MockDocumentOcrProvider,
  MockSupplierDocumentAiProvider,
  NoopNativePdfTextExtractor,
  OpenAiSupplierDocumentProvider,
  ProviderConfigurationError,
  type DocumentBinaryInput,
  type SupplierDocumentAiProvider,
} from '../_shared/supplier-documents/providers.ts'

type UntypedSupabaseClient = ReturnType<typeof createClient<any>>
declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void }

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type DbRow = Record<string, unknown>
type DocumentRow = DbRow & {
  id: string
  tenant_id: string
  venue_id: string
  document_type: 'invoice' | 'delivery_note'
  storage_bucket: string | null
  storage_path: string | null
  original_file_name: string | null
  original_mime_type: string | null
  status: string
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('SUPABASE_FUNCTION_ENV_MISSING')
  return { supabaseUrl, anonKey, serviceRoleKey }
}

function dateValue(value: string | null) {
  if (!value) return null
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const match = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/)
  if (!match) return null
  return `${match[3]}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`
}

function learnedPackageExpression(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const packaging = value as Record<string, unknown>
  const packageCount = Number(packaging.packageCount ?? 1)
  const unitQuantity = Number(packaging.unitQuantity)
  const unitSymbol = typeof packaging.unitSymbol === 'string' ? packaging.unitSymbol.trim() : ''
  if (!(packageCount > 0) || !(unitQuantity > 0) || !unitSymbol) return null
  return `${packageCount}x${unitQuantity}${unitSymbol}`
}

function bytesToDataUrl(bytes: Uint8Array, contentType: string) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)))
  }
  return `data:${contentType};base64,${btoa(binary)}`
}

async function loadBinary(admin: UntypedSupabaseClient, document: DocumentRow): Promise<DocumentBinaryInput> {
  if (!document.storage_bucket || !document.storage_path) throw new Error('SUPPLIER_DOCUMENT_FILE_MISSING')
  const { data, error } = await admin.storage.from(document.storage_bucket).download(document.storage_path)
  if (error || !data) throw error ?? new Error('SUPPLIER_DOCUMENT_DOWNLOAD_FAILED')
  return {
    bytes: new Uint8Array(await data.arrayBuffer()),
    contentType: document.original_mime_type || data.type || 'application/octet-stream',
    fileName: document.original_file_name || 'document',
  }
}

async function loadGlobalKnowledge(admin: UntypedSupabaseClient) {
  const [suppliersResult, profilesResult] = await Promise.all([
    admin.from('global_suppliers').select('id, name, tax_id'),
    admin.from('global_supplier_document_profiles')
      .select('id, global_supplier_id, document_type, rules_json, status, success_count')
      .in('status', ['verified', 'candidate'])
      .order('status', { ascending: false })
      .order('success_count', { ascending: false }),
  ])
  if (suppliersResult.error) throw suppliersResult.error
  if (profilesResult.error) throw profilesResult.error
  return { suppliers: (suppliersResult.data ?? []) as DbRow[], profiles: (profilesResult.data ?? []) as DbRow[] }
}

function tryKnownProfiles(
  ocr: Awaited<ReturnType<MockDocumentOcrProvider['analyze']>>,
  documentType: 'invoice' | 'delivery_note',
  suppliers: DbRow[],
  profiles: DbRow[],
) {
  for (const profile of profiles) {
    if (profile.document_type !== documentType) continue
    try {
      const rules = supplierProfileRulesSchema.parse(profile.rules_json)
      if (!profileMatchesOcr(rules, ocr)) continue
      const supplier = suppliers.find((candidate) => candidate.id === profile.global_supplier_id)
      if (!supplier) continue
      return {
        extraction: runDeterministicParser(rules, ocr, {
          documentType,
          supplierName: String(supplier.name),
          supplierTaxId: supplier.tax_id == null ? null : String(supplier.tax_id),
        }),
        globalProfileId: String(profile.id),
        globalSupplierId: String(supplier.id),
      }
    } catch {
      // A malformed or non-matching candidate must never block later profiles.
    }
  }
  return null
}

async function loadSupplierCandidates(
  admin: UntypedSupabaseClient,
  tenantId: string,
  venueId: string,
) : Promise<SupplierCandidate[]> {
  const [suppliersResult, identitiesResult] = await Promise.all([
    admin.from('suppliers').select('id, name, tax_id, global_supplier_id')
      .eq('tenant_id', tenantId).eq('venue_id', venueId),
    admin.from('supplier_identity_aliases')
      .select('supplier_id, identity_type, normalized_value, source')
      .eq('tenant_id', tenantId).eq('venue_id', venueId),
  ])
  if (suppliersResult.error) throw suppliersResult.error
  if (identitiesResult.error) throw identitiesResult.error
  const identitiesBySupplier = new Map<string, SupplierCandidate['identities']>()
  for (const row of (identitiesResult.data ?? []) as DbRow[]) {
    const supplierId = String(row.supplier_id)
    const identities = identitiesBySupplier.get(supplierId) ?? []
    identities.push({
      type: row.identity_type as NonNullable<SupplierCandidate['identities']>[number]['type'],
      value: String(row.normalized_value),
      source: row.source === 'user_confirmed' ? 'user_confirmed' : 'extracted',
    })
    identitiesBySupplier.set(supplierId, identities)
  }
  return ((suppliersResult.data ?? []) as DbRow[]).map((row) => ({
    supplierId: String(row.id),
    name: String(row.name),
    taxId: row.tax_id == null ? null : String(row.tax_id),
    globalSupplierId: row.global_supplier_id == null ? null : String(row.global_supplier_id),
    identities: identitiesBySupplier.get(String(row.id)) ?? [],
  }))
}

async function loadInventoryContext(
  admin: UntypedSupabaseClient,
  tenantId: string,
  venueId: string,
  supplierId: string | null,
) {
  const aliasesPromise = supplierId
    ? admin.from('supplier_item_aliases').select('alias_type, alias_value, inventory_item_id, packaging_json')
      .eq('tenant_id', tenantId).eq('venue_id', venueId).eq('supplier_id', supplierId)
    : Promise.resolve({ data: [], error: null })
  const [itemsResult, unitsResult, routesResult, warehousesResult, aliasesResult] = await Promise.all([
    admin.from('inventory_items').select('id, name, base_unit_id, reference_cost, is_active').eq('tenant_id', tenantId).eq('venue_id', venueId),
    admin.from('inventory_units').select('id, name, symbol, content_quantity, content_unit_id, is_active').eq('tenant_id', tenantId).eq('venue_id', venueId),
    admin.from('inventory_item_warehouse_routes').select('inventory_item_id, warehouse_id, priority, is_enabled').eq('tenant_id', tenantId).eq('venue_id', venueId),
    admin.from('inventory_warehouses').select('id, is_active, sort_order').eq('tenant_id', tenantId).eq('venue_id', venueId),
    aliasesPromise,
  ])
  for (const result of [itemsResult, unitsResult, routesResult, warehousesResult, aliasesResult]) if (result.error) throw result.error
  return {
    items: ((itemsResult.data ?? []) as DbRow[]).map((row) => ({
      id: String(row.id), name: String(row.name), baseUnitId: String(row.base_unit_id),
      referenceCost: row.reference_cost == null ? null : Number(row.reference_cost), active: Boolean(row.is_active),
    })),
    units: ((unitsResult.data ?? []) as DbRow[]).map<InventoryUnitDefinition>((row) => ({
      id: String(row.id), name: String(row.name), symbol: String(row.symbol),
      contentQuantity: Number(row.content_quantity), contentUnitId: String(row.content_unit_id),
    })),
    routes: ((routesResult.data ?? []) as DbRow[]).map((row) => ({
      inventoryItemId: String(row.inventory_item_id), warehouseId: String(row.warehouse_id),
      priority: Number(row.priority), enabled: Boolean(row.is_enabled),
    })),
    warehouses: ((warehousesResult.data ?? []) as DbRow[]).map((row) => ({
      id: String(row.id), active: Boolean(row.is_active), sortOrder: Number(row.sort_order),
    })),
    aliases: ((aliasesResult.data ?? []) as DbRow[]).map((row) => ({
      aliasType: row.alias_type as 'ean' | 'supplier_reference' | 'description',
      aliasValue: String(row.alias_value), inventoryItemId: String(row.inventory_item_id),
      packageExpression: learnedPackageExpression(row.packaging_json),
    })),
  }
}

async function processSupplierDocumentRequest(request: Request) {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  let documentId = ''
  let authorizedDocumentId = ''
  let admin: UntypedSupabaseClient | null = null
  try {
    const env = requiredEnvironment()
    const authorization = request.headers.get('Authorization')
    if (!authorization) return json({ error: 'Autorización requerida' }, 401)
    const authClient = createClient<any>(env.supabaseUrl, env.anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    admin = createClient<any>(env.supabaseUrl, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Sesión no válida' }, 401)
    const body = await request.json() as Record<string, unknown>
    documentId = String(body.documentId ?? '')
    const fixtureId = typeof body.fixtureId === 'string' ? body.fixtureId : null
    if (!documentId) return json({ error: 'documentId es obligatorio' }, 400)
    const { data: accessibleDocument, error: documentError } = await authClient.from('supplier_documents')
      .select('id, tenant_id, venue_id, document_type, storage_bucket, storage_path, original_file_name, original_mime_type, status')
      .eq('id', documentId).maybeSingle()
    if (documentError) throw documentError
    if (!accessibleDocument) return json({ error: 'Documento no encontrado o sin acceso' }, 404)
    authorizedDocumentId = documentId
    const document = accessibleDocument as DocumentRow
    if (document.status === 'confirmed') return json({ error: 'El documento ya está confirmado' }, 409)
    const mockMode = Deno.env.get('SUPPLIER_DOCUMENT_MOCK_MODE') === 'true'
    if (fixtureId && !mockMode) return json({ error: 'Los fixtures solo están disponibles con SUPPLIER_DOCUMENT_MOCK_MODE=true' }, 403)
    const binary = fixtureId ? { bytes: new Uint8Array(), contentType: 'application/mock', fileName: `${fixtureId}.mock` } : await loadBinary(admin, document)
    const nativePdf = binary.contentType === 'application/pdf'
      ? await new NoopNativePdfTextExtractor().extract(binary)
      : null
    const ocrProvider = createDocumentOcrProvider({
      provider: Deno.env.get('SUPPLIER_DOCUMENT_OCR_PROVIDER') ?? undefined,
      mockFixtureId: fixtureId,
      azure: {
        endpoint: Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT') ?? '',
        apiKey: Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_API_KEY') ?? '',
        apiVersion: Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_API_VERSION') ?? undefined,
        modelId: Deno.env.get('AZURE_DOCUMENT_INTELLIGENCE_MODEL_ID') ?? undefined,
      },
      mistral: {
        apiKey: Deno.env.get('MISTRAL_API_KEY') ?? '',
        model: Deno.env.get('MISTRAL_OCR_MODEL') ?? undefined,
      },
    })
    const ocr = nativePdf ?? await ocrProvider.analyze(binary)
    const [knowledge, supplierCandidates] = await Promise.all([
      loadGlobalKnowledge(admin),
      loadSupplierCandidates(admin, document.tenant_id, document.venue_id),
    ])
    const fixture = fixtureId ? getSupplierDocumentMockFixture(fixtureId) : null
    let extraction: SupplierDocumentExtraction
    let parserMode: 'deterministic' | 'ai'
    let globalProfileId: string | null = null
    let globalSupplierId: string | null = null
    let aiProvider: SupplierDocumentAiProvider | null = null
    if (fixture?.knownProfile) {
      extraction = runDeterministicParser(fixture.knownProfile, ocr, {
        documentType: document.document_type,
        supplierName: fixture.extraction.supplier.name,
        supplierTaxId: fixture.extraction.supplier.taxId,
      })
      parserMode = 'deterministic'
    } else {
      const known = tryKnownProfiles(ocr, document.document_type, knowledge.suppliers, knowledge.profiles)
      if (known) {
        extraction = known.extraction
        globalProfileId = known.globalProfileId
        globalSupplierId = known.globalSupplierId
        parserMode = 'deterministic'
      } else {
        aiProvider = fixtureId
          ? new MockSupplierDocumentAiProvider(fixtureId)
          : new OpenAiSupplierDocumentProvider({
            apiKey: Deno.env.get('OPENAI_API_KEY') ?? '',
            model: Deno.env.get('OPENAI_SUPPLIER_DOCUMENT_MODEL') ?? '',
          })
        const needsImage = !fixtureId
          && binary.contentType.startsWith('image/')
          && Deno.env.get('OPENAI_SUPPLIER_DOCUMENT_IMAGE_FALLBACK') === 'true'
          && (ocr.confidence < 0.65 || ocr.pages.every((page) => page.tables.length === 0))
        extraction = await aiProvider.interpret({
          ocr,
          documentType: document.document_type,
          imageDataUrl: needsImage ? bytesToDataUrl(binary.bytes, binary.contentType) : null,
          supplierCandidates,
        })
        parserMode = 'ai'
      }
    }
    extraction = supplierDocumentExtractionSchema.parse(extraction)
    const requestedDocumentType = document.document_type
    const documentTypeCorrected = extraction.document.type !== requestedDocumentType
    const math = validateExtractionMath(extraction)
    let profileValidation = parserMode === 'ai' ? validateProposedProfile(ocr, extraction) : null
    let profileGenerationRetried = false
    let profileGenerationError: string | null = null
    if (parserMode === 'ai' && aiProvider && math.coherent && !profileValidation?.candidate) {
      profileGenerationRetried = true
      try {
        const proposedProfile = await aiProvider.proposeProfile({
          ocr,
          documentType: extraction.document.type,
          extraction,
        })
        extraction = supplierDocumentExtractionSchema.parse({ ...extraction, proposedProfile })
        profileValidation = validateProposedProfile(ocr, extraction)
      } catch (error) {
        profileGenerationError = error instanceof Error ? error.message : 'PROFILE_GENERATION_FAILED'
      }
    }
    const modelSupplierResolution = extraction.supplierResolution
    const supplierResolution = resolveSupplierCandidate(extraction.supplier, supplierCandidates, {
      preferredGlobalSupplierId: globalSupplierId,
    })
    const supplierId = supplierResolution.confidence === 'high'
      ? supplierResolution.supplierId
      : null
    const resolvedSupplier = supplierId
      ? supplierCandidates.find((candidate) => candidate.supplierId === supplierId) ?? null
      : null
    globalSupplierId ??= resolvedSupplier?.globalSupplierId ?? null
    if (!globalProfileId && profileValidation?.candidate && globalSupplierId && extraction.proposedProfile) {
      const { data, error } = await admin.from('global_supplier_document_profiles').insert({
        global_supplier_id: globalSupplierId,
        document_type: extraction.document.type,
        fingerprint_json: { requiredTexts: extraction.proposedProfile.requiredTexts },
        rules_json: extraction.proposedProfile,
        status: 'candidate',
      }).select('id').single()
      if (error) throw error
      globalProfileId = String(data.id)
    }
    if (supplierId && extraction.document.number) {
      const { data: duplicate, error } = await admin.from('supplier_documents')
        .select('id, status').eq('tenant_id', document.tenant_id).eq('venue_id', document.venue_id)
        .eq('supplier_id', supplierId).eq('document_type', extraction.document.type)
        .ilike('document_number', extraction.document.number.trim()).neq('id', document.id).maybeSingle()
      if (error) throw error
      if (duplicate) {
        await admin.from('supplier_documents').update({
          status: 'error',
          extraction_metadata: { code: 'SUPPLIER_DOCUMENT_DUPLICATE_NUMBER', duplicateDocumentId: duplicate.id },
        }).eq('id', document.id)
        return json({ error: 'Ya existe un documento de este proveedor con el mismo número', duplicateDocumentId: duplicate.id }, 409)
      }
    }
    const inventory = await loadInventoryContext(admin, document.tenant_id, document.venue_id, supplierId)
    const lineRows = extraction.lines.map((line, index) => {
      const match = matchInventoryItem(line, inventory.items, inventory.aliases)
      const item = inventory.items.find((candidate) => candidate.id === match.inventoryItemId) ?? null
      const baseUnit = inventory.units.find((unit) => unit.id === item?.baseUnitId) ?? null
      const normalized = baseUnit ? normalizePurchaseToBase({
        purchaseQuantity: line.quantity,
        purchaseUnit: line.purchaseUnit,
        packageExpression: match.packageExpression ?? line.packageExpression,
        description: line.description,
        baseUnit,
        units: inventory.units,
      }) : null
      const warehouseId = item ? chooseDefaultWarehouse(item.id, inventory.routes, inventory.warehouses) : null
      const netCost = line.netCost ?? line.lineTotal ?? (
        line.unitPrice === null ? null : line.quantity * line.unitPrice - line.discountAmount + line.chargesAmount
      )
      const normalizedUnitCost = normalized && netCost !== null ? Math.round((netCost / normalized.baseQuantity) * 1_000_000) / 1_000_000 : null
      const requiresReview = !item || !normalized || !warehouseId || normalizedUnitCost === null
        || !math.coherent || math.invalidLineIndexes.includes(index)
      return {
        supplier_document_id: document.id,
        tenant_id: document.tenant_id,
        venue_id: document.venue_id,
        line_number: index + 1,
        supplier_reference: line.supplierReference,
        description_raw: line.description,
        description_normalized: normalizeAlias(line.description),
        barcode: line.barcode,
        quantity: line.quantity,
        purchase_unit: line.purchaseUnit,
        package_count: normalized?.packaging?.packageCount ?? null,
        package_unit_quantity: normalized?.packaging?.unitQuantity ?? null,
        package_unit_symbol: normalized?.packaging?.unitSymbol ?? null,
        unit_price: line.unitPrice,
        discount_amount: line.discountAmount,
        charges_amount: line.chargesAmount,
        gross_cost: line.grossCost,
        net_cost: netCost,
        line_total: line.lineTotal,
        tax_rate: line.taxRate,
        inventory_item_id: item?.id ?? null,
        warehouse_id: warehouseId,
        base_quantity: normalized?.baseQuantity ?? null,
        normalized_unit_cost: normalizedUnitCost,
        match_status: requiresReview ? 'needs_review' : match.status,
        extraction_confidence: line.confidence,
        raw_extraction_metadata: {
          matchReason: match.reason,
          matchScore: match.score,
          packageExpression: line.packageExpression,
          learnedPackageExpression: match.packageExpression ?? null,
          originalInventoryItemId: item?.id ?? null,
          originalWarehouseId: warehouseId,
        },
      }
    })
    const { error: deleteError } = await admin.from('supplier_document_lines').delete().eq('supplier_document_id', document.id)
    if (deleteError) throw deleteError
    const { error: insertError } = await admin.from('supplier_document_lines').insert(lineRows)
    if (insertError) throw insertError
    const needsReviewCount = lineRows.filter((line) => line.match_status === 'needs_review').length
    const { error: updateError } = await admin.from('supplier_documents').update({
      supplier_id: supplierId,
      global_supplier_id: globalSupplierId,
      global_profile_id: globalProfileId,
      document_type: extraction.document.type,
      document_number: extraction.document.number,
      document_date: dateValue(extraction.document.date),
      status: 'review',
      extraction_metadata: {
        parserMode,
        ocrProvider: ocr.provider,
        ocrModel: typeof ocr.metadata.model === 'string'
          ? ocr.metadata.model
          : typeof ocr.metadata.modelId === 'string' ? ocr.metadata.modelId : null,
        ocrConfidence: ocr.confidence,
        pageCount: ocr.pages.length,
        tableCount: ocr.pages.reduce((sum, page) => sum + page.tables.length, 0),
        math,
        profileValidation: profileValidation ? { candidate: profileValidation.candidate, reason: profileValidation.reason } : null,
        profileGenerationRetried,
        profileGenerationError,
        profileParsedLineCount: profileValidation?.parsed?.lines.length ?? null,
        rejectedProfile: profileValidation && !profileValidation.candidate ? extraction.proposedProfile : null,
        mockFixtureId: fixtureId,
        requestedDocumentType,
        detectedDocumentType: extraction.document.type,
        documentTypeCorrected,
        supplierExtraction: {
          ...extraction.supplier,
          identities: supplierIdentitiesFromExtraction(extraction.supplier),
        },
        modelSupplierResolution,
        supplierResolution,
        supplierCandidateCount: supplierCandidates.length,
      },
    }).eq('id', document.id)
    if (updateError) throw updateError
    return json({
      documentId: document.id,
      status: 'review',
      parserMode,
      lineCount: lineRows.length,
      needsReviewCount,
      supplierResolution,
      profileCandidateCreated: Boolean(profileValidation?.candidate && globalProfileId),
    })
  } catch (error) {
    console.error('process-supplier-document failed', error)
    if (admin && authorizedDocumentId) {
      await admin.from('supplier_documents').update({
        status: 'error',
        extraction_metadata: {
          code: error instanceof ProviderConfigurationError ? error.code : 'SUPPLIER_DOCUMENT_PROCESSING_FAILED',
          message: error instanceof Error ? error.message : 'Error interno',
        },
      }).eq('id', authorizedDocumentId).neq('status', 'confirmed')
    }
    const status = error instanceof ProviderConfigurationError ? 503 : 500
    return json({
      error: error instanceof Error ? error.message : 'Error interno',
      code: error instanceof ProviderConfigurationError ? error.code : 'SUPPLIER_DOCUMENT_PROCESSING_FAILED',
    }, status)
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Método no permitido' }, 405)
  const backgroundRequest = request.clone()
  try {
    const env = requiredEnvironment()
    const authorization = request.headers.get('Authorization')
    if (!authorization) return json({ error: 'Autorización requerida' }, 401)
    const authClient = createClient<any>(env.supabaseUrl, env.anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Sesión no válida' }, 401)
    const body = await request.json() as Record<string, unknown>
    const documentId = String(body.documentId ?? '')
    const fixtureId = typeof body.fixtureId === 'string' ? body.fixtureId : null
    if (!documentId) return json({ error: 'documentId es obligatorio' }, 400)
    const { data: accessibleDocument, error: documentError } = await authClient.from('supplier_documents')
      .select('id, status').eq('id', documentId).maybeSingle()
    if (documentError) throw documentError
    if (!accessibleDocument) return json({ error: 'Documento no encontrado o sin acceso' }, 404)
    if (accessibleDocument.status === 'confirmed') return json({ error: 'El documento ya está confirmado' }, 409)
    if (fixtureId && Deno.env.get('SUPPLIER_DOCUMENT_MOCK_MODE') !== 'true') {
      return json({ error: 'Los fixtures solo están disponibles con SUPPLIER_DOCUMENT_MOCK_MODE=true' }, 403)
    }
    if (accessibleDocument.status === 'error') {
      const admin = createClient<any>(env.supabaseUrl, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
      const { error } = await admin.from('supplier_documents').update({ status: 'processing' })
        .eq('id', documentId).eq('status', 'error')
      if (error) throw error
    }
    EdgeRuntime.waitUntil(processSupplierDocumentRequest(backgroundRequest).then(async (response) => {
      if (!response.ok) console.error('background supplier document processing failed', response.status, await response.text())
    }))
    return json({ documentId, status: 'processing' }, 202)
  } catch (error) {
    console.error('could not start supplier document processing', error)
    return json({ error: error instanceof Error ? error.message : 'Error interno' }, 500)
  }
})
