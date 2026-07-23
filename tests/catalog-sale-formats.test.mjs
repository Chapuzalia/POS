import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateVariantDrafts } from '../src/features/crm/catalog/services/catalogAdminModel.ts'

const [migration, navigation, routing, formatsPage, productEditor, mapper] = await Promise.all([
  readFile(new URL('../supabase/43.catalog-sale-formats.sql', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/routing/crmNavigation.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/routing/CrmSectionContent.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/catalog/pages/CatalogFormatsPage.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/crm/catalog/forms/CatalogProductEditor.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/features/catalog/data/mapper.ts', import.meta.url), 'utf8'),
])

test('el CRM incorpora Formatos dentro del menú de Productos y carga su página', () => {
  assert.match(navigation, /id: 'formats', label: 'Formatos'/)
  assert.match(routing, /case 'formats'/)
  assert.match(routing, /<CatalogFormatsCrm/)
  assert.match(formatsPage, /Formatos de venta/)
  assert.match(formatsPage, /saveSaleFormat/)
})

test('las variantes del editor seleccionan formatos reutilizables y rechazan duplicados', () => {
  assert.match(productEditor, /ariaLabel="Formato de venta"/)
  assert.match(productEditor, /batchWithVariantFormats/)
  assert.match(productEditor, /formatId: variant\.formatId/)
  assert.match(validateVariantDrafts([
    { formatId: '', name: '', priceCents: 100, active: true, isDefault: true },
  ], true), /Selecciona un formato/)
  assert.match(validateVariantDrafts([
    { formatId: 'copa', name: 'Copa', priceCents: 100, active: true, isDefault: true },
    { formatId: 'copa', name: 'Copa', priceCents: 200, active: true, isDefault: false },
  ], true), /repetir un formato/)
})

test('la migración conserva variantes existentes y expone la relación en el catálogo agregado', () => {
  assert.match(migration, /create table public\.catalog_sale_formats/)
  assert.match(migration, /add column catalog_sale_format_id/)
  assert.match(migration, /update public\.product_variants v[\s\S]*set catalog_sale_format_id = f\.id/)
  assert.match(migration, /catalog_command_batch_with_formats/)
  assert.match(migration, /'variant_formats'/)
  assert.match(mapper, /variantFormats\.get\(row\.id\) \?\? null/)
})

test('el editor hereda el IVA, compacta acciones y persiste destacados por aparición', () => {
  assert.match(productEditor, /IVA predeterminado del local/)
  assert.match(productEditor, /IVA personalizado/)
  assert.match(productEditor, /vatMode === 'default' \? null/)
  assert.doesNotMatch(productEditor, /Producto activo/)
  assert.doesNotMatch(productEditor, /moveVariant|movePlacement|ArrowUp|ArrowDown/)
  assert.match(productEditor, /'Editar variante'/)
  assert.match(productEditor, /aria-label="Editar aparición"/)
  assert.match(productEditor, /checked=\{placement\.featured\}/)
  assert.match(productEditor, /featured: placementFeatured/)
})
