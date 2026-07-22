import { barSnapshot } from './current-catalog-snapshots.mjs'

/** Representative recoverable source corruption used by phase-1 validation tests. */
export function inconsistentCurrentCatalogSnapshot() {
  const snapshot = barSnapshot()
  snapshot.products.push({
    id: 'product-broken', tenant_id: 'tenant-a', venue_id: 'venue-bar', category_id: 'missing-category',
    name: 'Producto inconsistente', description: null, image_path: null, product_type: 'standard',
    kind: 'other', sale_formats: ['missing-format'], can_sell_standalone: true,
    can_use_as_mixer: true, is_featured: true, mixer_supplement_cents: -50,
    tax_rate: 130, is_active: true, sort_order: -1,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  })
  snapshot.productVariants.push({
    id: 'variant-broken', tenant_id: 'tenant-a', product_id: 'missing-product', name: 'Huérfana',
    price_cents: -100, sku: null, sale_format_id: null, is_default: false, is_active: true,
    sort_order: 0, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  })
  snapshot.catalogPlacements.push({
    id: 'placement-broken', tenant_id: 'tenant-a', venue_id: 'another-venue', tab_id: 'missing-tab',
    category_id: 'missing-category', product_id: 'product-broken', default_variant_id: 'variant-broken',
    is_featured: true, sort_order: -1, is_active: true,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
  })
  return snapshot
}

