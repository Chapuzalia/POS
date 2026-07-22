import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')
const migration = read('supabase/42.catalog-final-legacy-cleanup.sql')
const consolidated = read('supabase/0.complete-database.sql')

function reachableSourceFiles(entrypoint) {
  const pending = [join(root, entrypoint)]
  const visited = new Set()
  const extensions = ['', '.ts', '.tsx', '.js', '.jsx']

  while (pending.length) {
    const file = pending.pop()
    if (!file || visited.has(file) || !existsSync(file)) continue
    visited.add(file)
    const source = readFileSync(file, 'utf8')
    const imports = source.matchAll(/(?:from\s+|import\s*\()(['"])(\.{1,2}\/[^'"]+)\1/g)
    for (const match of imports) {
      const base = resolve(dirname(file), match[2])
      const candidates = extensions.flatMap((extension) => [base + extension, join(base, `index${extension}`)])
      const target = candidates.find((candidate) => existsSync(candidate) && extname(candidate))
      if (target) pending.push(target)
    }
  }
  return [...visited]
}

test('phase 4 migration is one guarded transaction with ordered destructive cleanup', () => {
  assert.match(migration, /^begin;/im)
  assert.match(migration, /pg_advisory_xact_lock/)
  assert.match(migration, /PHASE4_PREFLIGHT_FAILED:/)
  assert.doesNotMatch(migration, /\bcascade\b/i)
  assert.ok(migration.indexOf('do $phase4_preflight$') < migration.indexOf('do $phase4_residual$'))
  assert.match(migration, /invalid\/orphan\/cross-scope legacy selection items/)
  assert.doesNotMatch(migration, /active products neither visible nor final internal options/)
  assert.match(migration, /delete from public[.]products p/)
  assert.match(migration, /delete from public[.]categories c/)
  assert.match(migration, /delete from public[.]catalog_tab_categories tc/)
  assert.match(migration, /delete from public[.]ticket_lines l/)
  assert.ok(migration.indexOf('on conflict(id) do nothing;') < migration.lastIndexOf('delete from public.products p'))
  assert.ok(migration.indexOf('do $phase4_residual$') < migration.indexOf('create or replace function public.catalog_command'))
  assert.ok(migration.indexOf('create or replace function public.export_catalog') < migration.indexOf('drop table public.selection_group_items'))
  assert.ok(migration.indexOf('do $phase4_final$') < migration.lastIndexOf('commit;'))
  assert.match(migration, /PHASE4_CATALOG_FINAL_CLEANUP_OK/)
})

test('phase 4 explicitly removes every confirmed legacy relation, column and RPC', () => {
  for (const relation of ['sale_formats', 'selection_group_items', 'variant_selection_groups', 'product_modifier_groups']) {
    assert.match(migration, new RegExp(`drop table public\\.${relation};`, 'i'))
  }
  for (const column of [
    'categories drop column kind',
    'products drop column category_id',
    'products drop column image_path',
    'products drop column sale_formats',
    'products drop column can_sell_standalone',
    'products drop column can_use_as_mixer',
    'products drop column mixer_supplement_cents',
    'product_variants drop column sale_format_id',
    'catalog_placements drop column default_variant_id',
    'modifier_groups drop column product_id',
    'modifiers drop column price_cents',
  ]) assert.match(migration, new RegExp(`alter table public\\.${column};`, 'i'))
  for (const rpc of ['add_restaurant_order_line', 'add_restaurant_order_line_with_mixer', 'save_restaurant_order_lines', 'save_restaurant_order_lines_v3']) {
    assert.match(migration, new RegExp(`drop function public\\.${rpc}\\(`, 'i'))
  }
})

test('clean install declares only final catalog structures and final RPC bodies', () => {
  for (const relation of ['sale_formats', 'selection_group_items', 'variant_selection_groups', 'product_modifier_groups']) {
    assert.doesNotMatch(consolidated, new RegExp(`create table public\\.${relation}\\b`, 'i'))
  }
  assert.doesNotMatch(consolidated, /\b(default_variant_id|can_sell_standalone|can_use_as_mixer|mixer_supplement_cents)\b/i)
  assert.doesNotMatch(consolidated, /create function public\.(?:add_restaurant_order_line|add_restaurant_order_line_with_mixer|save_restaurant_order_lines_v3?)\b/i)
  assert.match(consolidated, /create function public\.get_catalog\(/i)
  assert.match(consolidated, /create function public\.catalog_command\(/i)
  assert.match(consolidated, /create table public\.product_selection_group_assignments\b/i)
  assert.match(consolidated, /alter table(?: only)? public\.products enable row level security/i)
})

test('the compiled application import graph has no transitional catalog modules or bridge tables', () => {
  const files = reachableSourceFiles('src/main.tsx')
  assert.ok(files.length > 50, 'expected the real application graph, not a synthetic entrypoint')
  const relativeFiles = files.map((file) => file.slice(root.length + 1).replaceAll('\\', '/'))
  for (const removed of ['src/lib/catalogTransfer.ts', 'src/lib/catalogAccess.ts', 'src/lib/load-current-catalog.ts', 'src/lib/project-current-ui.ts']) {
    assert.ok(!relativeFiles.includes(removed), `${removed} remains reachable`)
  }
  const runtime = files.map((file) => readFileSync(file, 'utf8')).join('\n')
  assert.doesNotMatch(runtime, /\b(selection_group_items|variant_selection_groups|product_modifier_groups|default_variant_id)\b/)
  assert.doesNotMatch(runtime, /\b(canSellStandalone|canUseAsMixer|mixerSupplementCents|usesLegacyFallback)\b/)
})

test('active Supabase types and transfer contract expose schema v3 only', () => {
  const supabaseTypes = read('src/types/supabase.ts')
  const domainTypes = read('src/types/domain.ts')
  const schema = JSON.parse(read('scripts/catalog-rebuild/schema/catalog-export.schema.json'))
  assert.doesNotMatch(supabaseTypes, /\b(SaleFormatRow|SelectionGroupItemRow|VariantSelectionGroupRow|ProductModifierGroupRow)\b/)
  assert.doesNotMatch(supabaseTypes, /\b(default_variant_id|can_sell_standalone|can_use_as_mixer|mixer_supplement_cents)\b/)
  assert.match(domainTypes, /type SaleLineCatalogSnapshot/)
  assert.equal(schema.properties.schemaVersion.const, 3)
  assert.ok(!Object.hasOwn(schema.properties, 'saleFormats'))
})

test('isolated fixture and semantic schema comparator cover the final outcome', () => {
  const fixture = read('tests/fixtures/catalog-rebuild/catalog-final-cleanup.sql')
  const comparator = read('scripts/catalog-rebuild/compare-final-schemas.ps1')
  assert.match(fixture, /\\ir \/tmp\/supabase\/42\.catalog-final-legacy-cleanup\.sql/)
  assert.match(fixture, /PHASE4_ISOLATED_OK/)
  assert.match(fixture, /LEGACY_ONLY_INTERNAL_OPTION_NOT_CONVERTED/)
  assert.match(fixture, /UNASSIGNED_RESIDUAL_PRODUCT_NOT_REMOVED/)
  assert.match(fixture, /INVALID_SCOPE_CATEGORY_NOT_REMOVED/)
  for (const kind of ['constraint', 'index', 'function', 'trigger', 'policy', 'table_grant', 'routine_grant']) {
    assert.match(comparator, new RegExp(`'${kind}'`))
  }
  assert.match(comparator, /PHASE4_SCHEMA_EQUIVALENCE_OK/)
})
