import type { TenantContext } from '../../../../types'
import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { loadInventorySnapshot } from '../../inventory/services/inventoryService'
import type { InventorySnapshot } from '../../inventory/types'
import { loadPurchaseDocuments } from './purchaseService'
import { loadVenueSuppliers } from './supplierService'
import type { VenueSupplier } from '../types'

export type ReplenishmentSupplier = VenueSupplier & { estimatedUnitCost: number | null; packageCount: number | null }
export type ReplenishmentRow = {
  itemId: string
  name: string
  unitId: string
  stock: number
  target: number
  shortage: number
  suppliers: ReplenishmentSupplier[]
}

export type ReplenishmentData = { snapshot: InventorySnapshot; rows: ReplenishmentRow[] }

export async function loadReplenishmentData(context: Pick<TenantContext, 'tenantId'>, venueId: string): Promise<ReplenishmentData> {
  const [snapshot, suppliers, documents] = await Promise.all([
    loadInventorySnapshot(context, venueId),
    loadVenueSuppliers(context, venueId),
    loadPurchaseDocuments(context, venueId, '2000-01-01', '2100-01-01'),
  ])
  const supplierById = new Map(suppliers.map((supplier) => [supplier.id, supplier]))
  const itemSupplierCosts = new Map<string, Map<string, { sum: number; count: number }>>()
  const packagingResult = await requireSupabase().from('supplier_item_aliases')
    .select('supplier_id, inventory_item_id, packaging_json, confirmation_count, updated_at')
    .eq('tenant_id', context.tenantId).eq('venue_id', venueId)
  if (packagingResult.error) throw packagingResult.error
  const packagingByItemSupplier = new Map<string, { packageCount: number; confirmationCount: number; updatedAt: string }>()
  for (const row of (packagingResult.data ?? []) as Array<Record<string, unknown>>) {
    const packaging = row.packaging_json as Record<string, unknown> | null
    const packageCount = Number(packaging?.packageCount)
    if (!Number.isFinite(packageCount) || packageCount <= 0) continue
    const key = `${String(row.inventory_item_id)}:${String(row.supplier_id)}`
    const current = packagingByItemSupplier.get(key)
    const confirmationCount = Number(row.confirmation_count ?? 0)
    if (!current || confirmationCount > current.confirmationCount || (confirmationCount === current.confirmationCount && String(row.updated_at) > current.updatedAt)) {
      packagingByItemSupplier.set(key, { packageCount, confirmationCount, updatedAt: String(row.updated_at) })
    }
  }
  const documentSuppliers = new Map(documents.map((document) => [document.id, document.supplierId]))
  for (const document of documents) for (const line of document.lines) {
    const supplierId = documentSuppliers.get(line.documentId)
    if (!supplierId || line.inventoryItemId === null) continue
    const bySupplier = itemSupplierCosts.get(line.inventoryItemId) ?? new Map<string, { sum: number; count: number }>()
    const current = bySupplier.get(supplierId) ?? { sum: 0, count: 0 }
    bySupplier.set(supplierId, line.normalizedUnitCost === null
      ? current
      : { sum: current.sum + line.normalizedUnitCost, count: current.count + 1 })
    itemSupplierCosts.set(line.inventoryItemId, bySupplier)
  }
  const rows = snapshot.items.filter((item) => item.active).flatMap((item) => {
    const levels = snapshot.levels.filter((level) => level.inventoryItemId === item.id && level.enabled)
    const targets = levels.filter((level) => level.targetQuantity !== null)
    if (!targets.length) return []
    const stock = levels.reduce((sum, level) => sum + level.quantity, 0)
    const target = targets.reduce((sum, level) => sum + (level.targetQuantity ?? 0), 0)
    const shortage = Math.max(target - stock, 0)
    if (shortage <= 0) return []
    const costs = itemSupplierCosts.get(item.id) ?? new Map()
    const itemSuppliers: ReplenishmentSupplier[] = [...costs].flatMap(([id, value]) => {
      const supplier = supplierById.get(id)
      const packaging = packagingByItemSupplier.get(`${item.id}:${id}`)
      return supplier ? [{ ...supplier, estimatedUnitCost: value.count ? value.sum / value.count : null, packageCount: packaging?.packageCount ?? null }] : []
    })
    return [{ itemId: item.id, name: item.name, unitId: item.baseUnitId, stock, target, shortage, suppliers: itemSuppliers }]
  })
  return { snapshot, rows: rows.toSorted((a, b) => a.name.localeCompare(b.name, 'es')) }
}
