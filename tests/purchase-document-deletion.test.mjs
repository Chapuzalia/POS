import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { z } from 'zod'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { compileComponent, createHookHarness, jsxRuntime, nodes } from './helpers/component-harness.mjs'

const migration = await readFile(new URL('../supabase/migrations/20261006161932_add_supplier_document_deletion.sql', import.meta.url), 'utf8')
const triggerPermissions = await readFile(new URL('../supabase/migrations/20261006164238_restrict_supplier_document_deletion_trigger.sql', import.meta.url), 'utf8')
const purchases = await readFile(new URL('../supabase/migrations/20260901234356_add_purchase_management_v1.sql', import.meta.url), 'utf8')
const modalSource = await readFile(new URL('../src/features/crm/purchases/components/DeletePurchaseDocumentModal.tsx', import.meta.url), 'utf8')
const edgeSource = await readFile(new URL('../supabase/functions/delete-supplier-document/index.ts', import.meta.url), 'utf8')
const stockAdjustment = purchases.replace(/\r/g, '').match(/create or replace function public\.adjust_inventory_item_stock\([\s\S]*?\n\$\$;/i)[0]
const id = (value) => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const tenant = id(10), venue = id(20), documentId = id(30), noteId = id(31), lineId = id(40), itemId = id(50), warehouseId = id(60)

// Isolated database: the real signed stock adjustment and new migration run
// against small tables that preserve the production FK and RLS boundaries.
async function fixture(t, stock = true) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.user_id', true), '')::uuid $$;
    create function public.supplier_documents_feature_enabled(uuid, boolean default false) returns boolean language sql as $$
      select coalesce(current_setting('test.purchases', true), 'true') <> 'false'
        and (not $2 or coalesce(current_setting('test.scanning', true), 'true') <> 'false') $$;
    create function public.assert_supplier_document_venue(uuid, boolean) returns uuid language plpgsql as $$ begin
      if auth.uid() is distinct from '${id(1)}'::uuid or $1 <> '${venue}'::uuid then
        raise exception 'SUPPLIER_DOCUMENT_FORBIDDEN' using errcode = '42501'; end if;
      if not public.supplier_documents_feature_enabled('${tenant}', $2) then raise exception 'SUPPLIER_DOCUMENT_ADDON_DISABLED' using errcode = '42501'; end if;
      return '${tenant}'::uuid; end $$;
    create function public.assert_supplier_document_scanning(uuid) returns void language sql as $$ select $$;
    create function public.can_access_supplier_document_object_without_addon(text) returns boolean language sql as $$ select true $$;
    create function public.guard_supplier_document_addon_write() returns trigger language plpgsql as $$ begin return new; end $$;
    create table public.supplier_documents (
      id uuid primary key, tenant_id uuid not null, venue_id uuid not null, document_type text default 'invoice',
      document_number text, document_date date, status text default 'confirmed', processing_mode text default 'scan',
      stock_applied_at timestamptz, affects_stock boolean default true, storage_bucket text, storage_path text,
      file_hash text, extraction_metadata jsonb default '{}'::jsonb, updated_at timestamptz default now(),
      unique(id, tenant_id, venue_id));
    create unique index documents_hash_unique on public.supplier_documents(tenant_id, venue_id, file_hash) where file_hash is not null;
    create unique index documents_number_unique on public.supplier_documents(tenant_id, venue_id, document_number) where document_number is not null;
    create table public.supplier_document_lines (id uuid primary key, supplier_document_id uuid not null references public.supplier_documents(id),
      tenant_id uuid not null, venue_id uuid not null, quantity numeric, inventory_item_id uuid, warehouse_id uuid);
    create table public.supplier_document_links (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid,
      invoice_document_id uuid references public.supplier_documents(id), delivery_note_document_id uuid references public.supplier_documents(id));
    create table public.inventory_reference_cost_history (id uuid primary key, supplier_document_id uuid not null references public.supplier_documents(id),
      supplier_document_line_id uuid not null references public.supplier_document_lines(id), new_cost numeric);
    create table public.inventory_items (id uuid primary key, tenant_id uuid, venue_id uuid, is_active boolean default true,
      base_unit_id uuid, average_cost numeric default 7, last_purchase_cost numeric default 8, reference_cost numeric default 9);
    create table public.inventory_warehouses (id uuid primary key, tenant_id uuid, venue_id uuid, is_active boolean default true);
    create table public.inventory_stock_levels (warehouse_id uuid, inventory_item_id uuid, tenant_id uuid, venue_id uuid,
      quantity numeric, is_enabled boolean default true, updated_at timestamptz default now(), primary key(warehouse_id, inventory_item_id));
    create table public.inventory_stock_movements (id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid,
      warehouse_id uuid, inventory_item_id uuid, source_type text, source_id uuid, stock_quantity_delta numeric,
      stock_quantity_before numeric, stock_quantity_after numeric, unit_id uuid, metadata jsonb default '{}'::jsonb);
    alter table public.supplier_documents enable row level security;
    alter table public.supplier_document_lines enable row level security;
    create policy documents_read on public.supplier_documents for select to authenticated using (tenant_id = '${tenant}');
    create policy lines_read on public.supplier_document_lines for select to authenticated using (tenant_id = '${tenant}');
    grant usage on schema auth to authenticated;
    grant select on public.supplier_documents, public.supplier_document_lines to authenticated;
    create trigger guard_supplier_document_addon before insert or update on public.supplier_documents for each row execute function public.guard_supplier_document_addon_write();
    create trigger guard_supplier_document_lines_addon before insert or update on public.supplier_document_lines for each row execute function public.guard_supplier_document_addon_write();
    select set_config('test.user_id', '${id(1)}', false);
  `)
  await db.exec(stockAdjustment)
  await db.exec(migration)
  await db.exec(triggerPermissions)
  await db.exec(`
    insert into public.supplier_documents(id, tenant_id, venue_id, document_number, file_hash, stock_applied_at, storage_bucket, storage_path)
      values ('${documentId}', '${tenant}', '${venue}', 'DOC-1', '${'a'.repeat(64)}', ${stock ? 'now()' : 'null'}, 'supplier-documents', '${tenant}/${venue}/${documentId}/original.pdf');
    insert into public.supplier_documents(id, tenant_id, venue_id, document_type, document_number) values ('${noteId}', '${tenant}', '${venue}', 'delivery_note', 'NOTE-1');
    insert into public.supplier_document_lines values ('${lineId}', '${documentId}', '${tenant}', '${venue}', 999, '${itemId}', '${warehouseId}');
    insert into public.supplier_document_links(tenant_id, venue_id, invoice_document_id, delivery_note_document_id) values ('${tenant}', '${venue}', '${documentId}', '${noteId}');
    insert into public.inventory_reference_cost_history values ('${id(70)}', '${documentId}', '${lineId}', 9);
    insert into public.inventory_items(id, tenant_id, venue_id, base_unit_id) values ('${itemId}', '${tenant}', '${venue}', '${id(80)}');
    insert into public.inventory_warehouses(id, tenant_id, venue_id) values ('${warehouseId}', '${tenant}', '${venue}');
    insert into public.inventory_stock_levels(warehouse_id, inventory_item_id, tenant_id, venue_id, quantity) values ('${warehouseId}', '${itemId}', '${tenant}', '${venue}', 17);
    insert into public.inventory_stock_movements(tenant_id, venue_id, warehouse_id, inventory_item_id, source_type, source_id, stock_quantity_delta)
      values ('${tenant}', '${venue}', '${warehouseId}', '${itemId}', 'supplier_document_receipt', '${lineId}', 4),
             ('${tenant}', '${venue}', '${warehouseId}', '${itemId}', 'supplier_document_correction', '${lineId}', 1),
             ('${tenant}', '${venue}', '${warehouseId}', '${itemId}', 'supplier_document_receipt', '${id(99)}', 12);
  `)
  return db
}
const remove = async (db, choice) => (await db.query('select public.delete_supplier_document($1, $2, $3, $4) as result', [documentId, venue, tenant, choice])).rows[0].result
const quantity = async (db) => Number((await db.query('select quantity from public.inventory_stock_levels')).rows[0].quantity)

test('la migración es expand compatible y pasa las reglas de seguridad', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  assert.deepEqual(analyzeMigration(triggerPermissions), [])
})

test('conservar stock elimina de la vista, libera identidad y mantiene costes, líneas e historial', async (t) => {
  const db = await fixture(t)
  const result = await remove(db, false)
  assert.equal(result.stockReversed, false)
  assert.equal(await quantity(db), 17)
  assert.equal((await db.query('select * from public.inventory_reference_cost_history')).rows.length, 1)
  assert.equal((await db.query('select * from public.supplier_document_lines')).rows.length, 1)
  assert.deepEqual((await db.query('select average_cost, last_purchase_cost, reference_cost from public.inventory_items')).rows[0],
    { average_cost: '7', last_purchase_cost: '8', reference_cost: '9' })
  const deleted = (await db.query('select * from public.supplier_documents where id = $1', [documentId])).rows[0]
  assert.ok(deleted.deleted_at)
  assert.equal(deleted.file_hash, null)
  assert.equal(deleted.document_number, null)
  assert.equal(deleted.extraction_metadata.deletion.documentNumber, 'DOC-1')
  assert.equal(deleted.extraction_metadata.deletion.links.length, 1)
  assert.equal((await db.query('select * from public.supplier_document_links')).rows.length, 0)
  await db.exec('set role authenticated')
  assert.equal((await db.query('select id from public.supplier_documents where id = $1', [documentId])).rows.length, 0)
  assert.equal((await db.query('select id from public.supplier_document_lines')).rows.length, 0)
  await db.exec('reset role')
  await db.query('insert into public.supplier_documents(id,tenant_id,venue_id,document_number,file_hash) values ($1,$2,$3,$4,$5)',
    [id(32), tenant, venue, 'DOC-1', 'a'.repeat(64)])
})

test('anular stock invierte el neto real corregido, mantiene compras ajenas y es idempotente', async (t) => {
  const db = await fixture(t)
  const originalMovements = (await db.query('select * from public.inventory_stock_movements order by id')).rows
  assert.equal((await remove(db, true)).stockReversed, true)
  assert.equal(await quantity(db), 12)
  const movements = (await db.query('select * from public.inventory_stock_movements')).rows
  for (const original of originalMovements) assert.deepEqual(movements.find((row) => row.id === original.id), original)
  assert.equal(movements.length, 4)
  assert.equal(movements.find((row) => row.metadata.reason === 'document_deletion').stock_quantity_delta, '-5.000000')
  assert.equal((await remove(db, false)).stockReversed, true)
  assert.equal(await quantity(db), 12)
  assert.equal((await db.query('select * from public.inventory_stock_movements')).rows.length, 4)
})

test('anular stock respeta una corrección que reasignó el artículo y almacén', async (t) => {
  const db = await fixture(t)
  const nextItem = id(51), nextWarehouse = id(61)
  await db.exec(`
    insert into public.inventory_items(id, tenant_id, venue_id, base_unit_id)
      values ('${nextItem}', '${tenant}', '${venue}', '${id(80)}');
    insert into public.inventory_warehouses(id, tenant_id, venue_id)
      values ('${nextWarehouse}', '${tenant}', '${venue}');
    insert into public.inventory_stock_levels(warehouse_id, inventory_item_id, tenant_id, venue_id, quantity)
      values ('${nextWarehouse}', '${nextItem}', '${tenant}', '${venue}', 8);
    update public.inventory_stock_levels set quantity = 12 where inventory_item_id = '${itemId}';
    insert into public.inventory_stock_movements(tenant_id, venue_id, warehouse_id, inventory_item_id, source_type, source_id, stock_quantity_delta)
      values ('${tenant}', '${venue}', '${warehouseId}', '${itemId}', 'supplier_document_correction', '${lineId}', -5),
             ('${tenant}', '${venue}', '${nextWarehouse}', '${nextItem}', 'supplier_document_correction', '${lineId}', 5);
    update public.supplier_document_lines set inventory_item_id = '${nextItem}', warehouse_id = '${nextWarehouse}' where id = '${lineId}';
  `)
  assert.equal((await remove(db, true)).stockReversed, true)
  const levels = (await db.query('select inventory_item_id, quantity from public.inventory_stock_levels order by inventory_item_id')).rows
  assert.deepEqual(levels.map((row) => [row.inventory_item_id, Number(row.quantity)]), [[itemId, 12], [nextItem, 3]])
  const reversals = (await db.query("select inventory_item_id, warehouse_id, stock_quantity_delta from public.inventory_stock_movements where metadata->>'reason' = 'document_deletion'")).rows
  assert.equal(reversals.length, 1)
  assert.equal(reversals[0].inventory_item_id, nextItem)
  assert.equal(reversals[0].warehouse_id, nextWarehouse)
  assert.equal(Number(reversals[0].stock_quantity_delta), -5)
})

test('la elección es obligatoria si hay stock y no se toca nada hasta elegir', async (t) => {
  const db = await fixture(t)
  await assert.rejects(remove(db, null), /SUPPLIER_DOCUMENT_STOCK_CHOICE_REQUIRED/)
  assert.equal(await quantity(db), 17)
  assert.equal((await db.query('select deleted_at from public.supplier_documents where id = $1', [documentId])).rows[0].deleted_at, null)
  assert.equal((await db.query('select * from public.supplier_document_links')).rows.length, 1)
})

test('sin entrada de stock no pregunta ni revierte cantidades', async (t) => {
  const db = await fixture(t, false)
  assert.equal((await remove(db, null)).stockReversed, false)
  assert.equal(await quantity(db), 17)
})

test('tenant, local, usuario, addon y limpieza privilegiada están protegidos', async (t) => {
  const db = await fixture(t)
  assert.equal((await db.query("select has_function_privilege('anon', 'public.guard_supplier_document_link_deletion()', 'execute') as allowed")).rows[0].allowed, false)
  await assert.rejects(db.query('select public.delete_supplier_document($1,$2,$3,false)', [documentId, venue, id(11)]), /SUPPLIER_DOCUMENT_FORBIDDEN/)
  await assert.rejects(db.query('select public.delete_supplier_document($1,$2,$3,false)', [documentId, id(21), tenant]), /SUPPLIER_DOCUMENT_FORBIDDEN/)
  await db.exec("select set_config('test.user_id', '', false)")
  await assert.rejects(remove(db, false), /SUPPLIER_DOCUMENT_FORBIDDEN/)
  await db.exec(`select set_config('test.user_id', '${id(1)}', false); select set_config('test.purchases', 'false', false)`)
  await assert.rejects(remove(db, false), /SUPPLIER_DOCUMENT_ADDON_DISABLED/)
  await db.exec("select set_config('test.purchases', 'true', false); select set_config('test.scanning', 'false', false)")
  await remove(db, false)
  await db.exec('set role authenticated')
  await assert.rejects(db.query('select public.finish_supplier_document_deletion($1)', [documentId]), /permission denied/)
  await db.exec('reset role; set role anon')
  await assert.rejects(remove(db, false), /permission denied/)
})

test('una anulación imposible revierte la transacción completa sin perder documento ni vínculos', async (t) => {
  const db = await fixture(t)
  await db.exec('update public.inventory_items set is_active = false')
  await assert.rejects(remove(db, true), /INVENTORY_ITEM_NOT_FOUND/)
  assert.equal(await quantity(db), 17)
  assert.equal((await db.query('select deleted_at from public.supplier_documents where id = $1', [documentId])).rows[0].deleted_at, null)
  assert.equal((await db.query('select * from public.supplier_document_links')).rows.length, 1)
  assert.equal((await remove(db, false)).stockReversed, false)
})

test('un cliente antiguo o un OCR tardío no pueden revivir, reescribir o vincular el borrado', async (t) => {
  const db = await fixture(t)
  await remove(db, false)
  await assert.rejects(db.query("update public.supplier_documents set status = 'review' where id = $1", [documentId]), /SUPPLIER_DOCUMENT_DELETED/)
  await assert.rejects(db.query('delete from public.supplier_document_lines where supplier_document_id = $1', [documentId]), /SUPPLIER_DOCUMENT_DELETED/)
  await assert.rejects(db.query('insert into public.supplier_document_links(tenant_id,venue_id,invoice_document_id,delivery_note_document_id) values ($1,$2,$3,$4)',
    [tenant, venue, documentId, noteId]), /SUPPLIER_DOCUMENT_DELETED/)
  assert.equal((await db.query('select public.can_access_supplier_document_object($1) as access', [`${tenant}/${venue}/${documentId}/original.pdf`])).rows[0].access, false)
  await db.exec('set role service_role')
  await db.query('select public.finish_supplier_document_deletion($1)', [documentId])
  await db.exec('reset role')
  assert.ok((await db.query('select storage_deleted_at from public.supplier_documents where id = $1', [documentId])).rows[0].storage_deleted_at)
})

const text = (tree) => typeof tree === 'string' ? tree : Array.isArray(tree) ? tree.map(text).join('') : tree?.props ? text(tree.props.children) : ''
function modalHarness({ stock = true, disabled = false, service = async () => ({ documentId, storageDeleted: true, stockReversed: false }) } = {}) {
  const hooks = createHookHarness(), calls = [], completed = [], closed = []
  const { DeletePurchaseDocumentModal: Modal } = compileComponent(modalSource, {
    react: hooks.react, 'react/jsx-runtime': jsxRuntime, 'lucide-react': { Trash2: 'svg', X: 'svg' },
    '../../../../components/ui': { Button: 'button' }, '../../../../utils/errors': { getReadableError: (error) => error.message },
    '../../shared/components/CrmModal': { CrmModal: 'section' }, '../../shared/components/CrmModalBusyContext': { useCrmModalBusy: () => false },
    '../services/purchaseService': { deletePurchaseDocument: (...args) => { calls.push(args); return service(...args) } },
  })
  const render = () => hooks.render(Modal, { document: { id: documentId, documentType: 'invoice', documentNumber: 'DOC-1',
    stockAppliedAt: stock ? '2026-10-06' : null, linkedDocumentCount: 0 }, disabled, tenantContext: { tenantId: tenant },
    selectedVenueId: venue, onClose: () => closed.push(true), onDeleted: (result) => completed.push(result) })
  const submit = (tree) => nodes(tree).find((node) => node.type === 'button' && text(node) === 'Eliminar documento')
  return { render, submit, calls, completed, closed }
}
const flush = () => new Promise(setImmediate)

test('modal: obliga a elegir, conserva o anula según la respuesta y cancelar no borra', async () => {
  for (const choice of [false, true]) {
    const ui = modalHarness()
    let tree = ui.render()
    assert.equal(ui.submit(tree).props.disabled, true)
    ui.submit(tree).props.onClick()
    assert.equal(ui.calls.length, 0)
    nodes(tree).filter((node) => node.props?.type === 'radio')[choice ? 1 : 0].props.onChange()
    tree = ui.render()
    assert.equal(ui.submit(tree).props.disabled, false)
    ui.submit(tree).props.onClick()
    await flush()
    assert.equal(ui.calls[0][3], choice)
    assert.equal(ui.completed.length, 1)
  }
  const ui = modalHarness()
  nodes(ui.render()).find((node) => node.type === 'button' && text(node) === 'Cancelar').props.onClick()
  assert.equal(ui.calls.length, 0)
  assert.equal(ui.closed.length, 1)
})

test('modal: doble clic y cierre durante la petición no duplican ni interrumpen el borrado', async () => {
  let finish
  const ui = modalHarness({ stock: false, service: () => new Promise((resolve) => { finish = resolve }) })
  const tree = ui.render(), button = ui.submit(tree)
  button.props.onClick(); button.props.onClick()
  nodes(tree).find((node) => node.type === 'button' && text(node) === 'Cancelar').props.onClick()
  tree.props.onClose()
  assert.equal(ui.calls.length, 1)
  assert.equal(ui.calls[0][3], null)
  assert.equal(ui.closed.length, 0)
  assert.equal(ui.render().props.dismissDisabled, true)
  finish({ documentId, storageDeleted: true, stockReversed: false })
  await flush()
  assert.equal(ui.completed.length, 1)
})

test('modal: fallo deja el documento y la elección disponibles; sin permiso no llama al backend', async () => {
  const ui = modalHarness({ stock: false, service: async () => { throw new Error('No se pudo eliminar') } })
  ui.submit(ui.render()).props.onClick()
  await flush()
  assert.equal(ui.completed.length, 0)
  assert.match(text(ui.render()), /No se pudo eliminar/)
  assert.equal(ui.submit(ui.render()).props.disabled, false)
  const blocked = modalHarness({ stock: false, disabled: true })
  blocked.submit(blocked.render()).props.onClick()
  assert.equal(blocked.calls.length, 0)
})

function edgeHarness({ auth = true, rpcError = null, path = `${tenant}/${venue}/${documentId}/original.pdf`, cleanupError = false } = {}) {
  let handler
  const calls = []
  const createClient = (_url, key) => key === 'anon' ? {
    auth: { getUser: async () => ({ data: { user: auth ? { id: id(1) } : null }, error: null }) },
    rpc: async (name, args) => { calls.push({ kind: 'delete', name, args }); return { error: rpcError, data: { documentId,
      storageBucket: 'supplier-documents', storagePath: path, storageDeleted: false, stockReversed: false } } },
  } : { storage: { from: (bucket) => ({ remove: async (paths) => { calls.push({ kind: 'storage', bucket, paths });
    if (cleanupError) throw new Error('storage unavailable'); return { error: null } } }) },
    rpc: async (name, args) => { calls.push({ kind: 'finish', name, args }); return { error: null } } }
  compileComponent(edgeSource, { 'https://esm.sh/@supabase/supabase-js@2.110.0': { createClient }, zod: { z } },
    { Response, Request, Deno: { serve: (fn) => { handler = fn }, env: { get: (key) => key === 'SUPABASE_ANON_KEY' ? 'anon' : 'server' } } })
  return { calls, invoke: (body = { documentId, venueId: venue, tenantId: tenant, reverseStock: false }) => handler(new Request('https://example.test', {
    method: 'POST', headers: { Authorization: 'Bearer test', 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })) }
}

test('Edge: solo limpia el original después del borrado autorizado y con el path exacto', async () => {
  const edge = edgeHarness()
  const response = await edge.invoke()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).storageDeleted, true)
  assert.deepEqual(edge.calls.map((call) => call.kind), ['delete', 'storage', 'finish'])
  assert.deepEqual(Array.from(edge.calls[1].paths), [`${tenant}/${venue}/${documentId}/original.pdf`])
  for (const scenario of [{ auth: false }, { rpcError: { code: '42501', message: 'SUPPLIER_DOCUMENT_FORBIDDEN' } }]) {
    const denied = edgeHarness(scenario)
    const result = await denied.invoke()
    assert.ok([401, 403].includes(result.status))
    assert.ok(denied.calls.every((call) => call.kind !== 'storage'))
  }
})

test('Edge: rechaza paths ajenos, conserva éxito si falla limpieza y valida los parámetros', async () => {
  const forged = edgeHarness({ path: `${id(11)}/${venue}/${documentId}/original.pdf` })
  assert.equal((await (await forged.invoke()).json()).storageDeleted, false)
  assert.ok(forged.calls.every((call) => call.kind !== 'storage'))
  const pending = edgeHarness({ cleanupError: true })
  const response = await pending.invoke()
  assert.equal(response.status, 200)
  assert.equal((await response.json()).storageDeleted, false)
  assert.equal(pending.calls.filter((call) => call.kind === 'storage').length, 3)
  const invalid = edgeHarness()
  assert.equal((await invalid.invoke({ documentId: 'bad-id' })).status, 400)
  assert.equal(invalid.calls.length, 0)
})
