import { strToU8, zipSync } from 'fflate'
import type { TenantContext } from '../../../../types'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { resolveUnambiguousPurchaseCategories } from '../purchaseCategoryModel'
import type { PurchaseDocument, PurchaseLine } from '../types'

type DbRow = Record<string, unknown>

function safeFilePart(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80) || 'Sin_dato'
}

function csvCell(value: unknown) {
  const text = String(value ?? '')
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

export async function loadPurchaseItemCategories(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
  inventoryItemIds: string[],
) {
  const uniqueItemIds = [...new Set(inventoryItemIds)]
  if (!uniqueItemIds.length) return {}
  const client = requireSupabase()
  const [recipesResult, recipeLinesResult, catalogResult] = await Promise.all([
    client.from('inventory_recipes').select('id, variant_id').eq('tenant_id', context.tenantId).eq('venue_id', venueId).eq('is_active', true),
    client.from('inventory_recipe_lines').select('recipe_id, inventory_item_id').eq('tenant_id', context.tenantId).eq('venue_id', venueId).in('inventory_item_id', uniqueItemIds),
    client.rpc('get_catalog', { p_venue_id: venueId, p_mode: 'admin' }),
  ])
  if (recipesResult.error) throw recipesResult.error
  if (recipeLinesResult.error) throw recipeLinesResult.error
  if (catalogResult.error) throw catalogResult.error
  const catalog = catalogResult.data as Record<string, unknown>
  if (catalog.tenant_id !== context.tenantId || catalog.venue_id !== venueId) throw new Error('CATALOG_CROSS_VENUE')
  const rows = (key: string) => Array.isArray(catalog[key]) ? catalog[key] as DbRow[] : []
  return resolveUnambiguousPurchaseCategories({
    recipes: ((recipesResult.data ?? []) as DbRow[]).map((row) => ({ id: String(row.id), variantId: String(row.variant_id) })),
    recipeLines: ((recipeLinesResult.data ?? []) as DbRow[]).map((row) => ({ recipeId: String(row.recipe_id), inventoryItemId: String(row.inventory_item_id) })),
    products: rows('products').map((row) => ({ id: String(row.id), active: Boolean(row.is_active) })),
    variants: rows('variants').map((row) => ({ id: String(row.id), productId: String(row.product_id), active: Boolean(row.is_active) })),
    placements: rows('placements').map((row) => ({ productId: String(row.product_id), categoryId: row.category_id == null ? null : String(row.category_id), active: Boolean(row.is_active) })),
    categories: rows('categories').map((row) => ({ id: String(row.id), name: String(row.name), active: Boolean(row.is_active) })),
  })
}

export async function loadPurchaseDocuments(
  context: Pick<TenantContext, 'tenantId'>,
  venueId: string,
  startDate: string,
  endDate: string,
  options: { includeUnconfirmed?: boolean; includeLines?: boolean } = {},
): Promise<PurchaseDocument[]> {
  const client = requireSupabase()
  let query = client.from('supplier_documents')
    .select('id, supplier_id, document_type, document_number, document_date, status, processing_mode, affects_stock, storage_bucket, storage_path, original_file_name, original_mime_type')
    .eq('tenant_id', context.tenantId).eq('venue_id', venueId)
  query = options.includeUnconfirmed
    ? query.or(`and(document_date.gte.${startDate},document_date.lte.${endDate}),document_date.is.null`)
    : query.eq('status', 'confirmed').gte('document_date', startDate).lte('document_date', endDate)
  const { data, error } = await query.order('document_date', { ascending: false, nullsFirst: true })
  if (error) throw error
  const documents = (data ?? []) as DbRow[]
  if (!documents.length) return []
  const documentIds = documents.map((row) => String(row.id))
  const supplierIds = [...new Set(documents.map((row) => row.supplier_id == null ? null : String(row.supplier_id)).filter((id): id is string => Boolean(id)))]
  const [linesResult, suppliersResult, linksResult] = await Promise.all([
    options.includeLines === false ? Promise.resolve({ data: [], error: null }) : client.from('supplier_document_lines')
      .select('supplier_document_id, inventory_item_id, description_raw, line_total, net_cost, normalized_unit_cost, inventory_items(name)')
      .in('supplier_document_id', documentIds),
    supplierIds.length ? client.from('suppliers').select('id, name')
      .eq('tenant_id', context.tenantId).eq('venue_id', venueId).in('id', supplierIds) : Promise.resolve({ data: [], error: null }),
    options.includeLines === false ? Promise.resolve({ data: [], error: null }) : client.from('supplier_document_links').select('invoice_document_id, delivery_note_document_id')
      .or(`invoice_document_id.in.(${documentIds.join(',')}),delivery_note_document_id.in.(${documentIds.join(',')})`),
  ])
  if (linesResult.error) throw linesResult.error
  if (suppliersResult.error) throw suppliersResult.error
  if (linksResult.error) throw linksResult.error
  const supplierNames = new Map(((suppliersResult.data ?? []) as DbRow[]).map((row) => [String(row.id), String(row.name)]))
  const linesByDocument = new Map<string, PurchaseLine[]>()
  for (const row of (linesResult.data ?? []) as DbRow[]) {
    const documentId = String(row.supplier_document_id)
    const joinedItem = row.inventory_items as { name?: unknown } | null
    const line: PurchaseLine = {
      documentId,
      inventoryItemId: row.inventory_item_id == null ? null : String(row.inventory_item_id),
      inventoryItemName: joinedItem?.name == null ? null : String(joinedItem.name),
      description: String(row.description_raw ?? ''),
      amount: Number(row.line_total ?? row.net_cost ?? 0),
      normalizedUnitCost: row.normalized_unit_cost == null ? null : Number(row.normalized_unit_cost),
    }
    linesByDocument.set(documentId, [...(linesByDocument.get(documentId) ?? []), line])
  }
  const linkRows = (linksResult.data ?? []) as DbRow[]
  const excludedDeliveryNotes = new Set(linkRows.map((row) => String(row.delivery_note_document_id)))
  const linkCounts = new Map<string, number>()
  for (const row of linkRows) {
    for (const id of [String(row.invoice_document_id), String(row.delivery_note_document_id)]) {
      linkCounts.set(id, (linkCounts.get(id) ?? 0) + 1)
    }
  }
  return documents.map((row) => {
    const id = String(row.id)
    const lines = linesByDocument.get(id) ?? []
    return {
      id,
      supplierId: row.supplier_id == null ? null : String(row.supplier_id),
      supplierName: row.supplier_id == null ? null : supplierNames.get(String(row.supplier_id)) ?? null,
      documentType: row.document_type === 'invoice' ? 'invoice' : 'delivery_note',
      documentNumber: row.document_number == null ? null : String(row.document_number),
      documentDate: row.document_date == null ? null : String(row.document_date), status: row.status as PurchaseDocument['status'],
      processingMode: row.processing_mode === 'archive' ? 'archive' : 'scan',
      affectsStock: row.affects_stock !== false,
      storageBucket: row.storage_bucket == null ? null : String(row.storage_bucket),
      storagePath: row.storage_path == null ? null : String(row.storage_path),
      originalFileName: row.original_file_name == null ? null : String(row.original_file_name),
      originalMimeType: row.original_mime_type == null ? null : String(row.original_mime_type),
      total: lines.reduce((sum, line) => sum + line.amount, 0),
      linkedDocumentCount: linkCounts.get(id) ?? 0,
      excludedFromSpend: excludedDeliveryNotes.has(id), lines,
    }
  })
}

export async function downloadPurchaseOriginal(document: PurchaseDocument) {
  if (!document.storageBucket || !document.storagePath) throw new Error('Este documento no tiene fichero original disponible.')
  const { data, error } = await requireSupabase().storage.from(document.storageBucket).download(document.storagePath)
  if (error) throw error
  const url = URL.createObjectURL(data)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = document.originalFileName ?? `documento-${document.id}`
  anchor.click()
  URL.revokeObjectURL(url)
}

export async function exportPurchaseDocuments(documents: PurchaseDocument[], startDate: string, endDate: string) {
  const client = requireSupabase()
  const files: Record<string, Uint8Array> = {}
  const failures: string[] = []
  await Promise.all(documents.map(async (document) => {
    if (!document.storageBucket || !document.storagePath) {
      failures.push(document.id)
      return
    }
    const { data, error } = await client.storage.from(document.storageBucket).download(document.storagePath)
    if (error || !data) {
      failures.push(document.id)
      return
    }
    const originalExtension = document.originalFileName?.match(/\.[a-zA-Z0-9]{1,8}$/)?.[0]
      ?? (document.originalMimeType === 'application/pdf' ? '.pdf' : '')
    const name = [
      document.documentDate ?? 'Sin_fecha',
      document.documentType === 'invoice' ? 'Factura' : 'Albaran',
      safeFilePart(document.supplierName ?? 'Sin_proveedor'),
      safeFilePart(document.documentNumber ?? document.id.slice(0, 8)),
    ].join('_') + originalExtension
    files[name] = new Uint8Array(await data.arrayBuffer())
  }))
  const csv = [
    ['fecha', 'tipo', 'numero', 'proveedor', 'importe', 'id', 'fichero_disponible'],
    ...documents.map((document) => [
      document.documentDate, document.documentType, document.documentNumber,
      document.supplierName, document.lines.length ? document.total.toFixed(2) : '', document.id,
      failures.includes(document.id) ? 'no' : 'si',
    ]),
  ].map((row) => row.map(csvCell).join(',')).join('\r\n')
  files['resumen.csv'] = strToU8(`\uFEFF${csv}`)
  const blob = new Blob([zipSync(files, { level: 6 })], { type: 'application/zip' })
  const url = URL.createObjectURL(blob)
  const anchor = window.document.createElement('a')
  anchor.href = url
  anchor.download = `compras_${startDate}_${endDate}.zip`
  anchor.click()
  URL.revokeObjectURL(url)
  return { exported: documents.length - failures.length, missing: failures.length }
}
