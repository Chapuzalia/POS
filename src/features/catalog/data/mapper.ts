import { CatalogDomainError } from '../domain/errors.ts'
import type { CatalogData, CatalogImage, CatalogReadMode } from '../domain/types.ts'
import type { CatalogRpcPayload } from './database.ts'

const collections = [
  'products', 'variants', 'placements', 'tabs', 'categories', 'tab_categories',
  'selection_groups', 'selection_options', 'selection_assignments', 'modifier_groups',
  'modifiers', 'modifier_assignments', 'images',
] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertPayload(value: unknown, venueId: string, mode: CatalogReadMode): asserts value is CatalogRpcPayload {
  if (!isRecord(value) || value.venue_id !== venueId || value.mode !== mode || typeof value.tenant_id !== 'string') {
    throw new CatalogDomainError('CATALOG_INCONSISTENT', 'La respuesta agregada del catálogo no tiene el alcance esperado.', { venueId, mode })
  }
  for (const collection of collections) {
    if (!Array.isArray(value[collection])) {
      throw new CatalogDomainError('CATALOG_INCONSISTENT', `Falta la colección ${collection} en la respuesta de catálogo.`, { collection })
    }
  }
}

const numberValue = (value: number | string | null) => value === null ? null : Number(value)
const order = <T extends { id: string; sortOrder: number }>(rows: T[]) => rows.sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))

export function mapCatalogPayload(
  payload: unknown,
  venueId: string,
  mode: CatalogReadMode,
  publicImageUrl: (storagePath: string) => string | null,
): CatalogData {
  assertPayload(payload, venueId, mode)
  const images = new Map<string, CatalogImage>(payload.images.map((row) => [row.product_id, {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    productId: row.product_id,
    storagePath: row.storage_path,
    publicUrl: publicImageUrl(row.storage_path),
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }]))
  const assignments = (rows: CatalogRpcPayload['selection_assignments']) => order(rows.map((row) => ({
    id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, productId: row.product_id, groupId: row.group_id,
    displayName: row.display_name, minSelection: row.min_selection, maxSelection: row.max_selection,
    appliesToAllVariants: row.applies_to_all_variants, variantIds: [...row.variant_ids].sort(), active: row.is_active,
    sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
  })))
  return {
    tenantId: payload.tenant_id,
    venueId,
    mode,
    products: order(payload.products.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, type: row.product_type, name: row.name,
      description: row.description, image: images.get(row.id) ?? null, vatRate: numberValue(row.tax_rate), active: row.is_active,
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    variants: order(payload.variants.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, productId: row.product_id, name: row.name,
      priceCents: row.price_cents, sku: row.sku, isDefault: row.is_default, active: row.is_active,
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    placements: order(payload.placements.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, productId: row.product_id, tabId: row.tab_id,
      categoryId: row.category_id, pinnedVariantId: row.variant_id, featured: row.is_featured, active: row.is_active,
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    tabs: order(payload.tabs.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, key: row.key, label: row.label, icon: row.icon,
      active: row.is_active, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    categories: order(payload.categories.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, icon: row.icon, unused: row.unused,
      active: row.is_active, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    tabCategories: order(payload.tab_categories.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, tabId: row.tab_id, categoryId: row.category_id,
      active: row.is_active, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    selectionGroups: order(payload.selection_groups.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, type: row.kind,
      active: row.is_active, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    selectionOptions: order(payload.selection_options.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, groupId: row.group_id, productId: row.product_id,
      variantId: row.variant_id, supplementCents: row.supplement_cents, defaultQuantity: row.default_quantity,
      maxQuantity: row.max_quantity, active: row.is_active, sortOrder: row.sort_order,
      createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    selectionAssignments: assignments(payload.selection_assignments),
    modifierGroups: order(payload.modifier_groups.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, active: row.is_active,
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    modifiers: order(payload.modifiers.map((row) => ({
      id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, groupId: row.group_id, name: row.name,
      supplementCents: row.supplement_cents, isDefault: row.is_default, active: row.is_active,
      sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at,
    }))),
    modifierAssignments: assignments(payload.modifier_assignments),
    loadedAt: new Date().toISOString(),
  }
}
