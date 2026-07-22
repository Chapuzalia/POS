const tenant = { id: 'tenant-a', name: 'Hostelería Demo', slug: 'hosteleria-demo' }

const row = (id, tenantId = tenant.id, venueId) => ({
  id, tenant_id: tenantId, ...(venueId ? { venue_id: venueId } : {}),
  created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-02T00:00:00.000Z',
})

export function barSnapshot() {
  const venue = {
    ...row('venue-bar', tenant.id), tenant_id: tenant.id, name: 'Bar sencillo', address: 'Calle Uno',
    legal_name: 'Bar Demo SL', tax_id: 'B00000001', default_tax_rate: 21,
    currency_code: 'EUR', timezone: 'Europe/Madrid', catalog_profile: 'bar_classic',
  }
  return {
    tenant, venue, sourceWarnings: [], sourceOnly: { productVenueSettings: [] },
    categories: [
      { ...row('cat-spirit'), name: 'Destilados', kind: 'alcohol', icon: 'wine', sort_order: 10, is_active: true },
      { ...row('cat-mixer'), name: 'Refrescos', kind: 'mixer', icon: 'cup-soda', sort_order: 20, is_active: true },
    ],
    saleFormats: [
      { ...row('format-mixed'), key: 'cubata', label: 'Cubata', sort_order: 10, is_active: true },
      { ...row('format-glass'), key: 'copa', label: 'Copa', sort_order: 20, is_active: true },
    ],
    products: [
      { ...row('product-gin', tenant.id, venue.id), category_id: 'cat-spirit', name: 'Ginebra', description: 'London dry', image_path: 'tenant-a/products/gin.webp', product_type: 'standard', kind: 'alcohol', sale_formats: ['cubata', 'copa'], can_sell_standalone: true, can_use_as_mixer: false, is_featured: true, mixer_supplement_cents: 0, tax_rate: null, is_active: true, sort_order: 10 },
      { ...row('product-tonic', tenant.id, venue.id), category_id: 'cat-mixer', name: 'Tónica', description: null, image_path: null, product_type: 'standard', kind: 'mixer', sale_formats: [], can_sell_standalone: false, can_use_as_mixer: true, is_featured: false, mixer_supplement_cents: 100, tax_rate: 10, is_active: true, sort_order: 20 },
      { ...row('product-syrup', tenant.id, venue.id), category_id: 'cat-mixer', name: 'Sirope interno', description: null, image_path: null, product_type: 'standard', kind: 'other', sale_formats: [], can_sell_standalone: false, can_use_as_mixer: false, is_featured: false, mixer_supplement_cents: 0, tax_rate: null, is_active: true, sort_order: 30 },
    ],
    productVariants: [
      { ...row('variant-gin-mixed'), product_id: 'product-gin', name: 'Cubata', price_cents: 800, sku: 'GIN-MIX', sale_format_id: 'format-mixed', is_default: true, is_active: true, sort_order: 10 },
      { ...row('variant-gin-glass'), product_id: 'product-gin', name: 'Copa', price_cents: 600, sku: null, sale_format_id: 'format-glass', is_default: false, is_active: true, sort_order: 20 },
      { ...row('variant-tonic'), product_id: 'product-tonic', name: 'Unidad', price_cents: 250, sku: null, sale_format_id: null, is_default: true, is_active: true, sort_order: 10 },
      { ...row('variant-syrup'), product_id: 'product-syrup', name: 'Dosis', price_cents: 0, sku: null, sale_format_id: null, is_default: true, is_active: true, sort_order: 10 },
    ],
    catalogTabs: [
      { ...row('tab-mixed', tenant.id, venue.id), key: 'bebidas', label: 'Bebidas', icon: 'wine', sort_order: 10, is_active: true },
      { ...row('tab-glass', tenant.id, venue.id), key: 'copas', label: 'Copas', icon: 'glass-water', sort_order: 20, is_active: true },
    ],
    catalogPlacements: [
      { ...row('placement-gin-mixed', tenant.id, venue.id), tab_id: 'tab-mixed', category_id: 'cat-spirit', product_id: 'product-gin', default_variant_id: 'variant-gin-mixed', is_featured: true, sort_order: 10, is_active: true },
      { ...row('placement-gin-glass', tenant.id, venue.id), tab_id: 'tab-glass', category_id: 'cat-spirit', product_id: 'product-gin', default_variant_id: 'variant-gin-glass', is_featured: false, sort_order: 10, is_active: true },
    ],
    selectionGroups: [
      { ...row('group-tonics', tenant.id, venue.id), kind: 'mixer', name: 'Mixer estándar', min_select: 1, max_select: 1, sort_order: 10, is_active: true },
    ],
    selectionGroupItems: [
      { ...row('option-tonic'), group_id: 'group-tonics', product_id: 'product-tonic', variant_id: 'variant-tonic', price_delta_cents: 100, is_default: true, sort_order: 10, is_active: true },
    ],
    variantSelectionGroups: [
      { tenant_id: tenant.id, variant_id: 'variant-gin-mixed', selection_group_id: 'group-tonics', sort_order: 10, created_at: '2026-01-01T00:00:00.000Z' },
    ],
    modifierGroups: [
      { ...row('modifier-group-garnish'), product_id: 'product-gin', name: 'Preparación', min_select: 0, max_select: 1, sort_order: 10, is_active: true },
    ],
    modifiers: [
      { ...row('modifier-lemon'), group_id: 'modifier-group-garnish', name: 'Con limón', price_cents: 50, is_default: false, is_active: true, sort_order: 10 },
    ],
    productModifierGroups: [
      { tenant_id: tenant.id, product_id: 'product-gin', variant_id: null, modifier_group_id: 'modifier-group-garnish', sort_order: 10, created_at: '2026-01-01T00:00:00.000Z' },
    ],
  }
}

export function restaurantSnapshot() {
  const venue = {
    ...row('venue-restaurant', tenant.id), tenant_id: tenant.id, name: 'Restaurante', address: null,
    legal_name: null, tax_id: null, default_tax_rate: 10, currency_code: 'EUR',
    timezone: 'Europe/Madrid', catalog_profile: 'restaurant',
  }
  return {
    tenant, venue, sourceWarnings: [], sourceOnly: { productVenueSettings: [] },
    categories: [{ ...row('cat-food'), name: 'Comida', kind: 'other', icon: 'utensils', sort_order: 10, is_active: true }],
    saleFormats: [],
    products: [
      { ...row('product-menu', tenant.id, venue.id), category_id: 'cat-food', name: 'Menú del día', description: null, image_path: null, product_type: 'menu', kind: 'other', sale_formats: [], can_sell_standalone: true, can_use_as_mixer: false, is_featured: false, mixer_supplement_cents: 0, tax_rate: 10, is_active: true, sort_order: 10 },
      { ...row('product-main', tenant.id, venue.id), category_id: 'cat-food', name: 'Paella', description: null, image_path: null, product_type: 'standard', kind: 'other', sale_formats: [], can_sell_standalone: true, can_use_as_mixer: false, is_featured: false, mixer_supplement_cents: 0, tax_rate: 10, is_active: true, sort_order: 20 },
    ],
    productVariants: [
      { ...row('variant-menu'), product_id: 'product-menu', name: 'Completo', price_cents: 1500, sku: null, sale_format_id: null, is_default: true, is_active: true, sort_order: 10 },
      { ...row('variant-main'), product_id: 'product-main', name: 'Ración', price_cents: 1200, sku: null, sale_format_id: null, is_default: true, is_active: true, sort_order: 10 },
    ],
    catalogTabs: [{ ...row('tab-food', tenant.id, venue.id), key: 'comida', label: 'Comida', icon: 'utensils', sort_order: 10, is_active: true }],
    catalogPlacements: [{ ...row('placement-menu', tenant.id, venue.id), tab_id: 'tab-food', category_id: 'cat-food', product_id: 'product-menu', default_variant_id: null, is_featured: false, sort_order: 10, is_active: true }],
    selectionGroups: [{ ...row('group-mains', tenant.id, venue.id), kind: 'menu_component', name: 'Principal', min_select: 1, max_select: 1, sort_order: 10, is_active: true }],
    selectionGroupItems: [{ ...row('option-main'), group_id: 'group-mains', product_id: 'product-main', variant_id: 'variant-main', price_delta_cents: 0, is_default: true, sort_order: 10, is_active: true }],
    variantSelectionGroups: [{ tenant_id: tenant.id, variant_id: 'variant-menu', selection_group_id: 'group-mains', sort_order: 10, created_at: '2026-01-01T00:00:00.000Z' }],
    modifierGroups: [], modifiers: [], productModifierGroups: [],
  }
}

