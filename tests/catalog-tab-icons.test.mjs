import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { catalogIconOptions } from '../src/features/catalog/ui/catalogIcons.ts'

test('catalog tabs offer the icons supported by the POS', () => {
  const keys = catalogIconOptions.map(({ key }) => key)
  assert.deepEqual(keys.slice(0, 7), [
    'receipt',
    'beer_bottle',
    'cocktail',
    'copa',
    'cubata',
    'shot',
    'soft_bottle',
  ])
  assert.ok(keys.length >= 40)
  assert.equal(new Set(keys).size, keys.length)
  assert.ok(keys.includes('pizza'))
  assert.ok(keys.includes('coffee'))
  assert.ok(keys.includes('star'))
})

test('the CRM tab editor persists both its label and visible icon', async () => {
  const [structure, panel, app, realtime, migration] = await Promise.all([
    readFile(new URL('../src/features/crm/catalog/pages/CatalogStructurePage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/pos/CatalogPanel.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/app/AppShell.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/catalog/data/catalog-realtime.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  assert.match(structure, /CrmModal label="Editar pestaña del TPV"/)
  assert.match(structure, /Icono visible/)
  assert.match(structure, /Buscar iconos/)
  assert.match(structure, /visibleIconOptions/)
  assert.match(structure, /icon: editingTabIcon/)
  assert.match(structure, /label: editingTabLabel\.trim\(\)/)
  assert.match(panel, /getCatalogIconComponent/)
  assert.match(panel, /getCatalogIcon\(tab\.icon \|\| tab\.key/)
  assert.match(app, /subscribeToCatalogTabChanges\(context, scheduleRefresh\)/)
  assert.match(realtime, /table: 'catalog_tabs'/)
  assert.match(realtime, /filter: `venue_id=eq\.\$\{context\.venueId\}`/)
  assert.match(migration, /'catalog_tabs'/)
  assert.match(migration, /alter publication supabase_realtime add table public\.%I/i)
})
