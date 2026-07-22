/** TEMPORARY PHASE-1 READ-ONLY DATABASE ADAPTER. */
import { createClient } from '@supabase/supabase-js'

const PAGE_SIZE = 1_000

async function readRows(client, table, configure = (query) => query, optional = false, orderColumns = ['id']) {
  const rows = []
  for (let from = 0; ; from += PAGE_SIZE) {
    let query = configure(client.from(table).select('*').range(from, from + PAGE_SIZE - 1))
    for (const column of orderColumns) query = query.order(column, { ascending: true })
    const { data, error } = await query
    if (error) {
      if (optional) return { rows: [], warning: `No se pudo leer la tabla opcional ${table}: ${error.code ?? 'UNKNOWN'} ${error.message}` }
      throw new Error(`No se pudo leer ${table}: ${error.code ?? 'UNKNOWN'} ${error.message}`)
    }
    rows.push(...(data ?? []))
    if ((data ?? []).length < PAGE_SIZE) break
  }
  return { rows, warning: null }
}

const ids = (rows) => new Set(rows.map((row) => row.id))

export async function loadCurrentCatalogSnapshot({ url, key, venueId }) {
  const client = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'X-Client-Info': 'club-pos-catalog-phase-1-exporter' } },
  })
  const venue = (await readRows(client, 'venues', (query) => query.eq('id', venueId))).rows[0]
  if (!venue) throw new Error(`No existe el local ${venueId} o la credencial no puede leerlo.`)
  const tenantId = venue.tenant_id
  const definitions = [
    ['tenants', (query) => query.eq('id', tenantId), false],
    ['categories', (query) => query.eq('tenant_id', tenantId), false],
    ['sale_formats', (query) => query.eq('tenant_id', tenantId), false],
    ['products', (query) => query.eq('tenant_id', tenantId).eq('venue_id', venueId), false],
    ['product_variants', (query) => query.eq('tenant_id', tenantId), false],
    ['modifier_groups', (query) => query.eq('tenant_id', tenantId), false],
    ['modifiers', (query) => query.eq('tenant_id', tenantId), false],
    ['catalog_tabs', (query) => query.eq('tenant_id', tenantId).eq('venue_id', venueId), true],
    ['catalog_placements', (query) => query.eq('tenant_id', tenantId).eq('venue_id', venueId), true],
    ['selection_groups', (query) => query.eq('tenant_id', tenantId).eq('venue_id', venueId), true],
    ['selection_group_items', (query) => query.eq('tenant_id', tenantId), true],
    ['variant_selection_groups', (query) => query.eq('tenant_id', tenantId), true, ['variant_id', 'selection_group_id']],
    ['product_modifier_groups', (query) => query.eq('tenant_id', tenantId), true, ['product_id', 'modifier_group_id', 'variant_id']],
    ['product_venue_settings', (query) => query.eq('tenant_id', tenantId).eq('venue_id', venueId), true, ['product_id']],
  ]
  const results = await Promise.all(definitions.map(([table, configure, optional, orderColumns]) => readRows(client, table, configure, optional, orderColumns)))
  const data = Object.fromEntries(definitions.map(([table], index) => [table, results[index].rows]))
  const sourceWarnings = results.map((result) => result.warning).filter(Boolean)

  const productIds = ids(data.products)
  data.product_variants = data.product_variants.filter((row) => productIds.has(row.product_id))
  const variantIds = ids(data.product_variants)
  const groupIds = ids(data.selection_groups)
  data.selection_group_items = data.selection_group_items.filter((row) => groupIds.has(row.group_id))
  data.variant_selection_groups = data.variant_selection_groups.filter((row) => variantIds.has(row.variant_id) || groupIds.has(row.selection_group_id))
  data.product_modifier_groups = data.product_modifier_groups.filter((row) => productIds.has(row.product_id))
  const assignedModifierGroupIds = new Set(data.product_modifier_groups.map((row) => row.modifier_group_id))
  data.modifier_groups = data.modifier_groups.filter((row) => productIds.has(row.product_id) || assignedModifierGroupIds.has(row.id))
  const modifierGroupIds = ids(data.modifier_groups)
  data.modifiers = data.modifiers.filter((row) => modifierGroupIds.has(row.group_id))

  const usedCategoryIds = new Set([...data.products.map((row) => row.category_id), ...data.catalog_placements.map((row) => row.category_id)].filter(Boolean))
  const unusedCategoryCount = data.categories.filter((row) => !usedCategoryIds.has(row.id)).length
  if (unusedCategoryCount) sourceWarnings.push(`${unusedCategoryCount} categorías globales del tenant no están usadas por este local; se conservan para no perder configuración.`)
  if (data.product_venue_settings.length) sourceWarnings.push(`${data.product_venue_settings.length} registros históricos product_venue_settings se preservan como metadatos de origen.`)

  return {
    venue, tenant: data.tenants[0] ?? { id: tenantId, name: null, slug: null },
    categories: data.categories, saleFormats: data.sale_formats, products: data.products,
    productVariants: data.product_variants, modifierGroups: data.modifier_groups, modifiers: data.modifiers,
    catalogTabs: data.catalog_tabs, catalogPlacements: data.catalog_placements,
    selectionGroups: data.selection_groups, selectionGroupItems: data.selection_group_items,
    variantSelectionGroups: data.variant_selection_groups, productModifierGroups: data.product_modifier_groups,
    sourceOnly: { productVenueSettings: data.product_venue_settings }, sourceWarnings,
  }
}

