import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const migration = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const verification = readFileSync(new URL('../supabase/verification/catalog_architecture_verification.sql', import.meta.url), 'utf8')
const quickSale = readFileSync(new URL('../src/features/quick-sale/services/ticketLines.ts', import.meta.url), 'utf8')
const catalogPanel = readFileSync(new URL('../src/components/pos/CatalogPanel.tsx', import.meta.url), 'utf8')

test('el esquema final crea catalogo, componentes, snapshots, indices y RLS', () => {
  for (const table of ['catalog_tabs', 'catalog_placements', 'selection_groups', 'selection_group_options', 'product_selection_group_assignments', 'product_modifier_group_assignments', 'ticket_line_components', 'order_line_components']) {
    assert.match(migration, new RegExp(`create table public\\.${table}`, 'i'))
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`, 'i'))
  }
  for (const column of ['sale_format_id', 'sale_format_name_snapshot', 'category_id_snapshot', 'catalog_tab_id_snapshot']) {
    assert.match(migration, new RegExp(`${column} (?:uuid|text)`))
  }
  assert.match(migration, /product_type text default 'standard'::text not null/i)
  assert.match(migration, /create function public\.save_catalog_order_lines\(/i)
})

test('el esquema final elimina aliases legacy y el flujo principal usa relaciones', () => {
  assert.match(migration, /create table public\.product_selection_group_assignments/i)
  assert.doesNotMatch(migration, /create table public\.(?:selection_group_items|variant_selection_groups|product_modifier_groups)/i)
  assert.doesNotMatch(catalogPanel, /saleFormatVariantAliases|copa larga|alcohol mixer/)
  assert.match(quickSale, /buildSaleLine/)
  assert.doesNotMatch(quickSale, /toQuickSaleModifiers/)
  assert.match(catalogPanel, /resolveSellableCatalog/)
  assert.doesNotMatch(catalogPanel, /category\.kind|productSupportsSaleFormat/)
})

test('la verificacion cubre alcance, orfanos, duplicados, precios, mixers e historico ambiguo', () => {
  for (const check of ['venues_without_profile', 'active_products_without_placements', 'placement_orphans_or_scope_mismatch', 'active_variants_without_format', 'duplicate_product_format_variants', 'legacy_mixers_not_migrated', 'cubata_variants_without_mixer_group', 'contextual_supplement_differs_from_legacy', 'historical_lines_with_approximate_or_missing_snapshots', 'immutable_price_fingerprint']) {
    assert.match(verification, new RegExp(check))
  }
  assert.doesNotMatch(verification, /\b(update|insert|delete|truncate)\b/i)
})

