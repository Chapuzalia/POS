import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const migration = read('supabase/migrations/20260902135457_scope_suppliers_by_venue.sql')
const parser = read('supabase/functions/process-supplier-document/index.ts')
const service = read('src/features/crm/purchases/services/supplierService.ts')
const page = read('src/features/crm/purchases/pages/PurchasesSuppliersPage.tsx')
const navigation = read('src/features/crm/routing/crmNavigation.ts')

test('los proveedores quedan aislados por local con integridad referencial', () => {
  assert.match(migration, /alter table public\.suppliers[\s\S]*add column if not exists venue_id uuid/i)
  assert.match(migration, /suppliers_venue_scope_unique unique \(id, tenant_id, venue_id\)/i)
  assert.match(migration, /foreign key \(supplier_id, tenant_id, venue_id\)[\s\S]*references public\.suppliers\(id, tenant_id, venue_id\)/i)
  assert.match(migration, /suppliers_venue_tax_id_unique[\s\S]*\(tenant_id, venue_id, upper\(btrim\(tax_id\)\)\)/i)
  assert.match(migration, /supplier_identity_aliases_identity_unique[\s\S]*unique \(tenant_id, venue_id, identity_type, normalized_value\)/i)
})

test('el alta y la edición se realizan por una RPC autenticada y no exponen escritura directa', () => {
  const rpc = migration.match(/create function public\.save_venue_supplier[\s\S]*?end;\s*\$\$;/i)?.[0] ?? ''
  assert.match(rpc, /auth\.uid\(\)/)
  assert.match(rpc, /user_is_tenant_admin\(v_tenant_id\)/)
  assert.match(rpc, /where supplier\.id = p_supplier_id[\s\S]*supplier\.venue_id = p_venue_id/i)
  assert.match(rpc, /from public\.global_suppliers[\s\S]*v_normalized_tax_id/i)
  assert.match(migration, /revoke all on public\.suppliers from public, anon, authenticated;[\s\S]*grant select on public\.suppliers to authenticated/i)
  assert.match(migration, /grant execute on function public\.save_venue_supplier[\s\S]*to authenticated/i)
})

test('el parser solo recibe proveedores e identidades del local del documento', () => {
  const loader = parser.match(/async function loadSupplierCandidates[\s\S]*?^}/m)?.[0] ?? ''
  assert.match(loader, /tenantId: string,[\s\S]*venueId: string/)
  assert.match(loader, /from\('suppliers'\)[\s\S]*\.eq\('tenant_id', tenantId\)\.eq\('venue_id', venueId\)/)
  assert.match(loader, /from\('supplier_identity_aliases'\)[\s\S]*\.eq\('tenant_id', tenantId\)\.eq\('venue_id', venueId\)/)
  assert.match(parser, /loadSupplierCandidates\(admin, document\.tenant_id, document\.venue_id\)/)
})

test('la corrección manual vincula proveedor local e identidad global sin cruzar locales', () => {
  const update = migration.match(/create or replace function public\.update_supplier_document_supplier[\s\S]*?end;\s*\$\$;/i)?.[0] ?? ''
  assert.match(update, /supplier\.venue_id = v_document\.venue_id/)
  assert.match(update, /v_supplier\.global_supplier_id is null[\s\S]*v_document\.global_supplier_id is not null[\s\S]*set global_supplier_id = v_document\.global_supplier_id/i)
  assert.match(update, /from public\.global_suppliers[\s\S]*regexp_replace\(coalesce\(global_supplier\.tax_id[\s\S]*regexp_replace\(v_supplier\.tax_id/i)
  assert.match(update, /on conflict \(tenant_id, venue_id, identity_type, normalized_value\)/i)
})

test('la sección muestra una tabla simple con alta y edición', () => {
  assert.match(navigation, /purchases-suppliers[\s\S]*Proveedores/)
  assert.match(page, /<table/)
  assert.match(page, /Añadir proveedor/)
  assert.match(page, /Editar proveedor/)
  assert.match(page, /CIF \/ NIF/)
  assert.match(service, /\.eq\('tenant_id', context\.tenantId\)[\s\S]*\.eq\('venue_id', venueId\)/)
  assert.match(service, /rpc\('save_venue_supplier'/)
})
