import type { TenantContext } from '../../../../types'
import { getFunctionInvokeErrorMessage, requireSupabase } from '../../shared/services/crmServiceSupport'
import { loadInventorySnapshot } from '../../inventory/services/inventoryService'
import { loadVenueSuppliers } from '../../purchases/services/supplierService'
import type {
  SupplierDocument,
  SupplierDocumentDetail,
  SupplierDocumentLine,
  SupplierDocumentLineDraft,
  SupplierDocumentLinkCandidate,
  SupplierDocumentMockFixtureOption,
  SupplierDocumentStatus,
  SupplierDocumentType,
  SupplierOption,
} from '../types'

type DbRow = Record<string, unknown>
const text = (value: unknown) => value == null ? null : String(value)
const number = (value: unknown) => value == null ? null : Number(value)

export const supplierDocumentMockEnabled = import.meta.env.DEV
  && import.meta.env.VITE_SUPPLIER_DOCUMENT_MOCK_MODE === 'true'

export const supplierDocumentMockFixtures: SupplierDocumentMockFixtureOption[] = [
  { id: 'known-supplier', label: 'Proveedor conocido', description: 'Parser determinista sin IA.' },
  { id: 'unknown-supplier', label: 'Proveedor desconocido', description: 'Procesa el documento sin forzar una vinculación.' },
  { id: 'known-product', label: 'Producto conocido', description: 'Prioriza EAN y alias aprendido.' },
  { id: 'new-product', label: 'Producto nuevo', description: 'Obliga a seleccionar o crear artículo.' },
  { id: 'unit-conversion', label: 'Conversión 24x33 cl', description: '2 cajas se normalizan a 15,84 L.' },
  { id: 'uncertain-line', label: 'Línea dudosa', description: 'Abreviatura ambigua; requiere revisión.' },
  { id: 'cost-change', label: 'Cambio de coste', description: 'Activa la decisión de reference_cost.' },
  { id: 'multiple-warehouses', label: 'Varios almacenes', description: 'Comprueba prioridad y override puntual.' },
]

function mapDocument(row: DbRow, supplierName: string | null): SupplierDocument {
  return {
    id: String(row.id), tenantId: String(row.tenant_id), venueId: String(row.venue_id),
    supplierId: text(row.supplier_id), supplierName,
    documentType: row.document_type === 'invoice' ? 'invoice' : 'delivery_note',
    documentNumber: text(row.document_number), documentDate: text(row.document_date),
    affectsStock: row.affects_stock !== false, stockAppliedAt: text(row.stock_applied_at),
    storageBucket: text(row.storage_bucket), storagePath: text(row.storage_path),
    originalFileName: text(row.original_file_name),
    status: row.status as SupplierDocumentStatus,
    extractionMetadata: (row.extraction_metadata ?? {}) as Record<string, unknown>,
    createdAt: String(row.created_at), confirmedAt: text(row.confirmed_at),
  }
}

function mapLine(row: DbRow): SupplierDocumentLine {
  return {
    id: String(row.id), lineNumber: Number(row.line_number),
    supplierReference: text(row.supplier_reference), descriptionRaw: String(row.description_raw),
    descriptionNormalized: String(row.description_normalized), barcode: text(row.barcode),
    quantity: number(row.quantity), purchaseUnit: text(row.purchase_unit),
    packageCount: number(row.package_count), packageUnitQuantity: number(row.package_unit_quantity),
    packageUnitSymbol: text(row.package_unit_symbol), unitPrice: number(row.unit_price),
    discountAmount: Number(row.discount_amount), grossCost: number(row.gross_cost),
    chargesAmount: Number(row.charges_amount ?? 0),
    netCost: number(row.net_cost), lineTotal: number(row.line_total), taxRate: number(row.tax_rate),
    inventoryItemId: text(row.inventory_item_id), warehouseId: text(row.warehouse_id),
    baseQuantity: number(row.base_quantity), normalizedUnitCost: number(row.normalized_unit_cost),
    matchStatus: row.match_status as SupplierDocumentLine['matchStatus'],
    extractionConfidence: number(row.extraction_confidence),
    updateReferenceCost: Boolean(row.update_reference_cost), referenceCostDecided: Boolean(row.reference_cost_decided),
    wasCorrected: Boolean(row.was_corrected),
  }
}

async function sha256(file: File) {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('')
}

async function processDocument(documentId: string, fixtureId?: string) {
  const { data, error } = await requireSupabase().functions.invoke('process-supplier-document', {
    body: { documentId, ...(fixtureId ? { fixtureId } : {}) },
  })
  if (error) {
    throw new Error(await getFunctionInvokeErrorMessage(
      data,
      error,
      'No se pudo procesar el documento.',
    ))
  }
  return data as { documentId: string; status: SupplierDocumentStatus; lineCount?: number; needsReviewCount?: number }
}

export function retrySupplierDocumentProcessing(documentId: string) {
  return processDocument(documentId)
}

export async function uploadSupplierDocument(
  venueId: string,
  documentType: SupplierDocumentType,
  file: File,
  affectsStock: boolean,
) {
  const client = requireSupabase()
  const fileHash = await sha256(file)
  const { data, error } = await client.rpc('create_supplier_document', {
    p_venue_id: venueId,
    p_document_type: documentType,
    p_affects_stock: affectsStock,
    p_original_file_name: file.name,
    p_original_mime_type: file.type || 'application/octet-stream',
    p_file_hash: fileHash,
    p_mock_fixture_id: null,
  })
  if (error) throw error
  const created = data as { documentId: string; storageBucket: string; storagePath: string; status: string; duplicate: boolean }
  if (created.duplicate) {
    if (created.status === 'error') await processDocument(created.documentId)
    return created
  }
  const { error: uploadError } = await client.storage.from(created.storageBucket).upload(created.storagePath, file, {
    contentType: file.type || undefined,
    upsert: false,
  })
  if (uploadError) throw uploadError
  await processDocument(created.documentId)
  return created
}

export async function createMockSupplierDocument(venueId: string, fixtureId: string, affectsStock: boolean) {
  if (!supplierDocumentMockEnabled) throw new Error('El modo mock no está habilitado en este entorno.')
  if (!supplierDocumentMockFixtures.some((fixture) => fixture.id === fixtureId)) throw new Error('Fixture no válido.')
  const { data, error } = await requireSupabase().rpc('create_supplier_document', {
    p_venue_id: venueId,
    p_document_type: 'delivery_note',
    p_affects_stock: affectsStock,
    p_original_file_name: null,
    p_original_mime_type: null,
    p_file_hash: null,
    p_mock_fixture_id: fixtureId,
  })
  if (error) throw error
  const created = data as { documentId: string; duplicate: boolean }
  await processDocument(created.documentId, fixtureId)
  return created
}

export async function loadSupplierDocument(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
  documentId: string,
): Promise<SupplierDocumentDetail> {
  const client = requireSupabase()
  const [documentResult, linesResult] = await Promise.all([
    client.from('supplier_documents').select('id, tenant_id, venue_id, supplier_id, document_type, document_number, document_date, affects_stock, stock_applied_at, storage_bucket, storage_path, original_file_name, status, extraction_metadata, created_at, confirmed_at')
      .eq('tenant_id', context.tenantId).eq('venue_id', venueId).eq('id', documentId).single(),
    client.from('supplier_document_lines').select('*').eq('tenant_id', context.tenantId).eq('venue_id', venueId)
      .eq('supplier_document_id', documentId).order('line_number'),
  ])
  if (documentResult.error) throw documentResult.error
  if (linesResult.error) throw linesResult.error
  const documentRow = documentResult.data as DbRow
  let supplierName: string | null = null
  if (documentRow.supplier_id) {
    const { data, error } = await client.from('suppliers').select('name').eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId).eq('id', documentRow.supplier_id).single()
    if (error) throw error
    supplierName = String(data.name)
  }
  return { document: mapDocument(documentRow, supplierName), lines: ((linesResult.data ?? []) as DbRow[]).map(mapLine) }
}

export async function loadSupplierReceiptWorkspace(context: TenantContext, venueId: string, documentId: string) {
  const [detail, inventory, suppliers] = await Promise.all([
    loadSupplierDocument(context, venueId, documentId),
    loadInventorySnapshot(context, venueId),
    loadSupplierOptions(context, venueId),
  ])
  return { ...detail, inventory, suppliers }
}

export async function loadSupplierOptions(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
): Promise<SupplierOption[]> {
  return loadVenueSuppliers(context, venueId)
}

export async function updateSupplierDocumentSupplier(documentId: string, supplierId: string) {
  const { data, error } = await requireSupabase().rpc('update_supplier_document_supplier', {
    p_document_id: documentId,
    p_supplier_id: supplierId,
  })
  if (error) throw error
  return data as { documentId: string; supplierId: string; supplierName: string }
}

export async function saveSupplierDocumentLine(documentId: string, lineId: string, draft: SupplierDocumentLineDraft) {
  const { error } = await requireSupabase().rpc('save_supplier_document_line', {
    p_document_id: documentId,
    p_line_id: lineId,
    p_inventory_item_id: draft.inventoryItemId,
    p_warehouse_id: draft.warehouseId,
    p_quantity: draft.quantity,
    p_purchase_unit: draft.purchaseUnit,
    p_package_count: draft.packageCount,
    p_package_unit_quantity: draft.packageUnitQuantity,
    p_package_unit_symbol: draft.packageUnitSymbol,
    p_unit_price: draft.unitPrice,
    p_discount_amount: draft.discountAmount,
    p_base_quantity: draft.baseQuantity,
    p_normalized_unit_cost: draft.normalizedUnitCost,
    p_update_reference_cost: draft.updateReferenceCost,
    p_reference_cost_decided: draft.referenceCostDecided,
  })
  if (error) throw error
}

export async function createInventoryItemFromSupplierDocument(input: {
  documentId: string
  name: string
  baseUnitId: string
  warehouseId: string
  referenceCost: number | null
}) {
  const { data, error } = await requireSupabase().rpc('create_inventory_item_from_supplier_document', {
    p_document_id: input.documentId,
    p_name: input.name,
    p_base_unit_id: input.baseUnitId,
    p_warehouse_id: input.warehouseId,
    p_reference_cost: input.referenceCost,
  })
  if (error) throw error
  return String(data)
}

export async function loadDeliveryNoteCandidates(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
): Promise<SupplierDocumentLinkCandidate[]> {
  const client = requireSupabase()
  const { data: documents, error } = await client.from('supplier_documents')
    .select('id, supplier_id, document_number, document_date')
    .eq('tenant_id', context.tenantId).eq('venue_id', venueId)
    .eq('document_type', 'delivery_note').eq('status', 'confirmed')
    .not('document_date', 'is', null).order('document_date', { ascending: false })
  if (error) throw error
  const rows = (documents ?? []) as DbRow[]
  if (!rows.length) return []
  const ids = rows.map((row) => String(row.id))
  const supplierIds = [...new Set(rows.map((row) => text(row.supplier_id)).filter((id): id is string => Boolean(id)))]
  const [lineResult, supplierResult, linkResult] = await Promise.all([
    client.from('supplier_document_lines').select('supplier_document_id, line_total, net_cost').in('supplier_document_id', ids),
    supplierIds.length ? client.from('suppliers').select('id, name')
      .eq('tenant_id', context.tenantId).eq('venue_id', venueId).in('id', supplierIds) : Promise.resolve({ data: [], error: null }),
    client.from('supplier_document_links').select('delivery_note_document_id').in('delivery_note_document_id', ids),
  ])
  if (lineResult.error) throw lineResult.error
  if (supplierResult.error) throw supplierResult.error
  if (linkResult.error) throw linkResult.error
  const linked = new Set(((linkResult.data ?? []) as DbRow[]).map((row) => String(row.delivery_note_document_id)))
  const names = new Map(((supplierResult.data ?? []) as DbRow[]).map((row) => [String(row.id), String(row.name)]))
  const totals = new Map<string, number>()
  for (const line of (lineResult.data ?? []) as DbRow[]) {
    const id = String(line.supplier_document_id)
    totals.set(id, (totals.get(id) ?? 0) + Number(line.line_total ?? line.net_cost ?? 0))
  }
  return rows.filter((row) => !linked.has(String(row.id))).map((row) => ({
    id: String(row.id), supplierName: names.get(String(row.supplier_id)) ?? null,
    documentNumber: text(row.document_number), documentDate: String(row.document_date),
    total: totals.get(String(row.id)) ?? 0,
  }))
}

export async function confirmSupplierDocument(input: {
  documentId: string
  documentDate: string
  affectsStock: boolean
  deliveryNoteIds?: string[]
}) {
  const { data, error } = await requireSupabase().rpc('confirm_supplier_document', {
    p_document_id: input.documentId,
    p_document_date: input.documentDate,
    p_affects_stock: input.affectsStock,
    p_delivery_note_ids: input.deliveryNoteIds ?? [],
  })
  if (error) throw error
  return data as { documentId: string; confirmedAt: string; lineCount?: number; affectsStock: boolean; duplicate: boolean }
}
