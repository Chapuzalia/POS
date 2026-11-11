import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { createProductionDatabase, readProductionSql, uuid, tenant, venue, pos, kds, pass, order, line, product, user } from './helpers/production-db.mjs'
import { reconcileMenuEdit } from '../src/features/restaurant/services/menuCourses.ts'
import { getProductionUnsentQuantity, buildOptimisticProductionEntries } from '../src/features/production/routing.ts'
import { buildSaleLine, canonicalizeProductLineSelection } from '../src/features/catalog/services/saleLineBuilder.ts'
import { resolveSellableProduct } from '../src/features/catalog/domain/resolver.ts'
import { createMenuCatalog } from './helpers/menu-catalog.mjs'
import { getKdsEventChanges } from '../src/features/production/kds-event-changes.ts'

// pg_get_functiondef is normalized to LF inside this migration. Match that
// format in its multiline patch literals when the checkout uses Windows CRLF.
const migration = readProductionSql('20261024123435_flexible_restaurant_menu_courses').replaceAll('\r\n', '\n')
const baseline = readFileSync(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')
const routine = (source, name) => {
  const match = source.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`, 'i'))
  assert.ok(match, name)
  return match[0]
}
const variant = uuid(20)
const groupIds = [uuid(21), uuid(22), uuid(23)]
const optionIds = [uuid(31), uuid(32), uuid(33), uuid(34)]
const component = (index, extra = {}) => ({ id: optionIds[index], type: 'menu_component', selectionGroupId: groupIds[Math.min(index, 2)],
  selectionGroupName: ['Primero', 'Segundo', 'Postre', 'Postre'][index], productId: product, variantId: variant,
  productName: ['Ensalada', 'Pollo', 'Flan', 'Helado'][index], variantName: 'Normal', quantity: 1, priceDeltaCents: 0, sortOrder: index, modifiers: [], ...extra })

test('only restaurant menus can defer choices; maxima, modifiers and non-menu selections stay strict', () => {
  const catalog = createMenuCatalog()
  const sellable = resolveSellableProduct(catalog, 'p0', 'v0')
  const selection = { components: [], modifiers: [], mixerProductId: null, mixer: null }
  assert.throws(() => canonicalizeProductLineSelection(catalog, sellable, selection), /selecciona entre/)
  assert.equal(buildSaleLine('menu', catalog, sellable, selection, null, true).unitPriceCents, 1500)
  const group = sellable.selectionGroups[0]
  const option = group.options[0]
  const chosen = { id: option.id, selectionGroupId: group.group.id, quantity: 1, modifiers: [] }
  assert.equal(buildSaleLine('menu', catalog, sellable, { ...selection, components: [chosen] }, null, true).unitPriceCents, 1500)
  assert.throws(() => buildSaleLine('menu', catalog, sellable, { ...selection, components: [{ ...chosen, quantity: 2 }] }, null, true), /selecciona entre/)
  assert.throws(() => buildSaleLine('menu', catalog, sellable, { ...selection, components: [chosen, chosen] }, null, true), /repetida/)
  const standard = { ...sellable, product: { ...sellable.product, type: 'standard' } }
  assert.throws(() => canonicalizeProductLineSelection(catalog, standard, selection, true), /selecciona entre/)
})

async function setup(t) {
  const db = await createProductionDatabase(t)
  await db.exec(readProductionSql('20261017125631_production_kds_columns_lifecycle'))
  await db.exec(readProductionSql('20261017153230_production_paid_orders_count_as_served'))
  await db.exec(`alter table order_lines add column unit_price_cents integer default 1500, add column mixer_product_id uuid,
    add column mixer jsonb, add column fully_served_at timestamptz, add column updated_at timestamptz default now();
    alter table order_lines alter column served_quantity set default 0;
    alter table devices add column can_take_orders boolean default true;
    alter table production_events add column batch_id uuid, add column production_item_id uuid, add column actor_user_id uuid;
    create function production_table_label_for_line(uuid) returns text language sql as $$ select 'Mesa 1' $$;
    create function production_create_event_dispatch(uuid) returns void language sql as $$ select $$;
    create function production_cancel_line_excess_decimal(uuid,numeric,boolean) returns numeric language sql as $$ select 0::numeric $$;`)
  await db.exec(readProductionSql('20261028220358_kds_current_kitchen_comments'))
  for (const name of ['products', 'product_variants', 'selection_groups', 'selection_group_options',
    'product_selection_group_assignments', 'product_selection_group_assignment_variants', 'modifier_groups', 'modifiers',
    'product_modifier_group_assignments', 'product_modifier_group_assignment_variants', 'order_line_components']) {
    const sql = baseline.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\n\\);`))
    assert.ok(sql, name)
    await db.exec(sql[0])
  }
  await db.exec(routine(baseline, 'persist_catalog_order_line_draft'))
  await db.exec(routine(baseline, 'remove_restaurant_order_line'))
  // Apply the deployed served-line and decimal edits before the new migration.
  const lifecycle = readProductionSql('20260815150000_harden_menu_lifecycle').replaceAll('\r', '')
  const servedPatch = lifecycle.slice(lifecycle.indexOf('do $$', lifecycle.indexOf('do $$') + 1), lifecycle.indexOf('create or replace function public.capture_ticket_line_components'))
  await db.exec(servedPatch)
  let persist = (await db.query("select pg_get_functiondef('persist_catalog_order_line_draft(uuid,integer,jsonb)'::regprocedure) d")).rows[0].d
  persist = persist.replace('quantity_value integer', 'quantity_value numeric(18,3)').replaceAll("(item->>'quantity')::integer", "(item->>'quantity')::numeric(18,3)")
  await db.exec(persist)
  await db.exec(routine(baseline, 'save_catalog_order_lines').replace('public.save_catalog_order_lines(', 'public.save_catalog_order_lines_canonical('))
  const preservePrices = readProductionSql('20260831130000_preserve_restaurant_order_line_prices')
  await db.exec(preservePrices.slice(preservePrices.indexOf('create function public.save_catalog_order_lines(')))
  // Menu changes must go through the real legacy notification trigger too.
  await db.exec(routine(readProductionSql('20260825120000_add_production_domain'), 'production_notify_line_change')
    .replaceAll('public.production_cancel_line_excess(', 'public.production_cancel_line_excess_decimal('))
  await db.exec(routine(readProductionSql('20260921120100_add_production_passes'), 'production_upsert_pass_snapshot'))
  await db.exec(`create function production_resolve_pass(uuid,uuid,uuid,uuid) returns public.production_passes language sql as $$ select * from public.production_passes where id='${pass}' $$;`)
  await db.exec(`create function canonical_catalog_modifiers(uuid,uuid,uuid,jsonb) returns jsonb language sql as $$ select coalesce($4,'[]') $$;`)
  await db.exec(migration)
  await db.exec(readProductionSql('20261028230136_kds_modifier_updates_and_change_notices'))
  await db.exec(`create trigger notify_menu_update after update of quantity,product_id,variant_id,product_name,variant_name,modifiers,components,mixer,note
    on order_lines for each row execute function production_notify_line_change();
    create trigger notify_menu_delete before delete on order_lines for each row execute function production_notify_line_change();
    delete from order_line_production_passes; delete from order_lines;
    insert into products(id,tenant_id,venue_id,product_type,name) values('${product}','${tenant}','${venue}','menu','Menú diario');
    insert into product_variants(id,tenant_id,venue_id,product_id,name,price_cents,is_default) values('${variant}','${tenant}','${venue}','${product}','Normal',1500,true);`)
  for (const [index, id] of groupIds.entries()) {
    await db.query(`insert into selection_groups(id,tenant_id,venue_id,kind,name) values($1,$2,$3,'menu_component',$4)`, [id, tenant, venue, ['Primero', 'Segundo', 'Postre'][index]])
    await db.query(`insert into product_selection_group_assignments(id,tenant_id,venue_id,product_id,group_id,min_selection,max_selection,applies_to_all_variants)
      values($1,$2,$3,$4,$5,1,1,true)`, [uuid(50 + index), tenant, venue, product, id])
  }
  for (let i = 0; i < optionIds.length; i++) await db.query(`insert into selection_group_options(id,tenant_id,venue_id,group_id,product_id,variant_id,supplement_cents)
    values($1,$2,$3,$4,$5,$6,0)`, [optionIds[i], tenant, venue, component(i).selectionGroupId, product, variant])
  const save = async (components, revision, extra = {}) => (await db.query('select save_catalog_order_lines($1,$2,$3) value', [order, revision, [{ id: line,
    productId: product, variantId: variant, quantity: 1, modifierIds: [], components, unitPriceCents: 1500, catalogSnapshot: { productType: 'menu' }, ...extra }]])).rows[0].value
  const state = async () => (await db.query('select get_order_production_state($1) value', [order])).rows[0].value
  const send = async (request, revision, selection = null) => (await db.query('select send_production_batch($1,$2,$3,$4,$5) value', [order, revision, pos, request, selection])).rows[0].value
  const serve = async (componentId, quantity, revision, device = pos) => db.query('select serve_restaurant_menu_component($1,$2,$3,$4,$5,$6)', [order, line, componentId, quantity, revision, device])
  const queue = async () => (await db.query('select get_kds_workflow_queue($1) value', [kds])).rows[0].value
  return { db, save, state, send, serve, queue }
}

test('deferred choices, independent sends, service, substitution and late included dessert preserve the first and the menu price', async t => {
  const { db, save, state, send, serve, queue } = await setup(t)
  const initial = await save([component(0), component(1)], 1)
  assert.equal(initial.lines[0].unitPriceCents, 1500)
  let entries = (await state()).entries
  assert.equal(entries.length, 2)
  const first = entries.find(entry => entry.componentId === optionIds[0])
  const sent = await send('first-only', 2, [{ lineId: line, componentId: first.componentId, quantity: 1, passId: pass }])
  await serve(optionIds[0], 1, 2)
  await assert.rejects(db.query('select save_catalog_order_lines($1,3,$2)', [order, []]), /SERVED_LINE_DELETE_FORBIDDEN/)
  await assert.rejects(db.query('select remove_restaurant_order_line($1)', [line]), /ya servidos/)
  assert.equal((await queue()).items.length, 0, 'serving the first retires only that course')
  assert.equal((await db.query('select served_quantity from order_lines')).rows[0].served_quantity, '0.000', 'dessert remains undecided')
  await save([component(0), component(1), component(2)], 3)
  entries = (await state()).entries
  assert.equal(entries.find(entry => entry.componentId === optionIds[0]).unsentQuantity, 0)
  assert.equal(entries.find(entry => entry.componentId === optionIds[2]).unsentQuantity, 1)
  assert.equal((await db.query('select count(*)::int n from production_events')).rows[0].n, 0, 'adding dessert does not modify the served first')
  await send('main-dessert', 4)
  assert.equal((await db.query('select count(*)::int n from production_items where batch_id=$1', [sent.batchId])).rows[0].n, 1)
  await serve(optionIds[1], 1, 4)
  await serve(optionIds[2], 1, 5)
  assert.equal((await queue()).items.length, 0)
  assert.equal((await db.query('select unit_price_cents from order_lines')).rows[0].unit_price_cents, 1500)
  assert.equal((await db.query('select served_quantity::float8 n from order_lines')).rows[0].n, 1)
  await assert.rejects(save([component(0), component(1), component(3)], 6), /ya se ha servido/)
})

test('changing an already sent course cancels only it and keeps its replacement unsent; removing the last choice never sends the menu parent', async t => {
  const { db, save, state, send } = await setup(t)
  await save([component(0), component(2)], 1)
  await send('before-change', 2)
  await save([component(0), component(3)], 2)
  const items = (await db.query('select source_component_id, cancelled_quantity::float8 cancelled from production_items order by source_component_id')).rows
  assert.equal(items.find(item => item.source_component_id === optionIds[0]).cancelled, 0)
  assert.equal(items.find(item => item.source_component_id === optionIds[2]).cancelled, 1)
  const entries = (await state()).entries
  assert.equal(entries.some(entry => entry.componentId === optionIds[2]), false)
  assert.equal(entries.find(entry => entry.componentId === optionIds[3]).unsentQuantity, 1)
  assert.equal((await db.query('select count(*)::int n from production_events')).rows[0].n, 1)
  await save([], 3)
  assert.deepEqual((await state()).entries, [])
  await assert.rejects(send('empty-menu', 4), /No hay productos nuevos/)
})

test('course service enforces revision, device and tenant access and prevents lowering quantities below served courses', async t => {
  const { db, save, serve } = await setup(t)
  await save([component(0)], 1)
  await assert.rejects(serve(optionIds[0], 1, 2, kds), /no disponible/)
  await assert.rejects(serve(optionIds[0], 1, 1), /otro dispositivo/)
  await assert.rejects(serve(optionIds[0], 2, 2), /no válida/)
  await db.exec(`select set_config('test.uid','${uuid(99)}',false)`)
  await assert.rejects(serve(optionIds[0], 1, 2), /no disponible/)
  await db.exec(`select set_config('test.uid','${user}',false); set role anon;`)
  await assert.rejects(serve(optionIds[0], 1, 2), /permission denied/)
  await db.exec('reset role')
  await serve(optionIds[0], 1, 2)
  await assert.rejects(save([], 3), /ya se ha servido/)
  await assert.rejects(save([component(0)], 3, { quantity: 0.5 }), /CATALOG_INVALID_ORDER_DRAFT/)
  await assert.rejects(save([component(0), component(0)], 3), /DUPLICATE_COMPONENT/)
  await assert.rejects(save([component(2), component(3)], 3), /SELECTION_LIMITS/)
  await db.exec(`update orders set status='paid' where id='${order}'`)
  await assert.rejects(serve(optionIds[0], 1, 3), /no disponible/)
})

test('menu edits retain the agreed base, manual price and unchanged component snapshots while applying only new supplements', () => {
  const old = { id: line, quantity: 1, servedQuantity: 0, unitPriceCents: 1200, components: [component(0), component(1)] }
  const entries = [{ componentId: optionIds[0], servedQuantity: 1, sentQuantity: 1 }, { componentId: optionIds[1], servedQuantity: 0, sentQuantity: 0 }]
  const edited = reconcileMenuEdit(old, [component(0, { productName: 'Catalog renamed', priceDeltaCents: 200 }), component(1), component(2)], entries)
  assert.equal(edited.unitPriceCents, 1200)
  assert.equal(edited.components[0].productName, 'Ensalada')
  assert.equal(edited.changesSentDish, false)
  assert.equal(reconcileMenuEdit(old, [...old.components, component(2, { priceDeltaCents: 100 })], entries).unitPriceCents, 1300)
  assert.throws(() => reconcileMenuEdit(old, [component(1)], entries), /ya se ha servido/)
  assert.equal(getProductionUnsentQuantity({ sentQuantity: 1, skippedQuantity: 0, servedQuantity: 1, unsentQuantity: 0 }, { quantity: 1, servedQuantity: 0 }), 0)
  assert.deepEqual(buildOptimisticProductionEntries([{ ...old, catalogSnapshot: { productType: 'menu' }, components: [] }], {}, {}), [])
})

test('identical menus stay separate, direct service is never resent, quantity reductions and splits preserve each course', async t => {
  const { db, save, serve, send, state } = await setup(t)
  const saved = await save([component(0), component(1)], 1, { quantity: 2 })
  await serve(optionIds[0], 1, 2)
  await serve(optionIds[0], 2, 3)
  await assert.rejects(save([component(0), component(1)], 4, { quantity: 1 }), /inferior a los platos servidos/)
  await send('only-main', 4)
  assert.deepEqual((await db.query('select source_component_id,quantity::float8 n from production_items')).rows, [{ source_component_id: optionIds[1], n: 2 }])
  const split = uuid(90)
  await db.exec(`insert into order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,quantity,served_quantity,components,catalog_snapshot,split_from_line_id)
    select '${split}',tenant_id,venue_id,order_id,product_id,variant_id,product_name,1,0,components,catalog_snapshot,id from order_lines where id='${line}';
    update order_lines set quantity=1 where id='${line}';`)
  const entries = (await state()).entries
  assert.equal(entries.find(entry => entry.lineId === split && entry.componentId === optionIds[0]).servedQuantity, 1)
  assert.equal(entries.find(entry => entry.lineId === line && entry.componentId === optionIds[0]).servedQuantity, 1)
  assert.equal(entries.find(entry => entry.lineId === split && entry.componentId === optionIds[1]).unsentQuantity, 0)
  const payload = saved.lines.map(row => ({ ...row, quantity: 1, modifierIds: [], id: line }))
  payload.push({ ...payload[0], id: split })
  await db.query('select save_catalog_order_lines($1,4,$2)', [order, payload])
  assert.equal((await db.query('select count(*)::int n from order_lines')).rows[0].n, 2)
  assert.equal((await db.query('select sum(cancelled_quantity)::float8 n from production_items')).rows[0].n, 0)
})

test('kitchen notes affect only outstanding sent dishes and repeat saves leave no extra notices', async t => {
  const { db, save, send, serve, queue } = await setup(t)
  await db.exec(readProductionSql('20261024203609_kitchen_order_comments'))
  await save([component(0), component(1)], 1, { note: 'Salsa aparte' })
  await send('both', 2)
  const sentItems = (await db.query('select id,source_component_id from production_items')).rows
  const firstItemId = sentItems.find(item => item.source_component_id === optionIds[0]).id
  const secondItemId = sentItems.find(item => item.source_component_id === optionIds[1]).id
  assert.ok((await db.query('select snapshot from production_items')).rows.every(row => row.snapshot.note === 'Salsa aparte'))
  await serve(optionIds[0], 1, 2)
  await save([component(0), component(1)], 3, { note: 'Segundo sin sal' })
  const events = (await db.query('select event_type,payload from production_events')).rows
  assert.equal(events.length, 1)
  assert.equal(events[0].event_type, 'modified')
  assert.equal(events[0].payload.productName, 'Menú diario')
  assert.equal(events[0].payload.note, 'Segundo sin sal')
  assert.equal(events[0].payload.tableName, 'Mesa 1')
  assert.equal((await queue()).items.find(item => item.id === secondItemId).snapshot.note, 'Segundo sin sal')
  assert.equal((await queue()).items.find(item => item.id === firstItemId).snapshot.note, 'Salsa aparte', 'served dishes keep their original note')
  for (const event of (await queue()).events) await db.query('select acknowledge_kds_event($1,$2)', [kds, event.id])
  assert.equal((await queue()).events.length, 0)
  assert.equal((await queue()).items.find(item => item.id === secondItemId).snapshot.note, 'Segundo sin sal')
  assert.ok((await db.query('select production_render_event_lines(id) lines from production_events')).rows[0].lines.includes('NOTA: Segundo sin sal'))
  assert.ok((await db.query('select snapshot from production_items')).rows.every(row => row.snapshot.note === 'Salsa aparte'), 'already sent snapshots remain immutable')
  await save([component(0), component(1)], 4, { note: 'Segundo sin sal' })
  assert.equal((await db.query('select count(*)::int n from production_events')).rows[0].n, 1)
  await save([component(0), component(1)], 5, { note: null })
  assert.equal((await db.query('select count(*)::int n from production_events')).rows[0].n, 2)
  assert.equal((await queue()).items.find(item => item.id === secondItemId).snapshot.note, null)
  assert.ok((await db.query("select production_render_event_lines(id) lines from production_events where payload->>'note' is null")).rows[0].lines.includes('NOTA: SIN COMENTARIO'))
})

test('an optional course chosen after all previous dishes were served reopens just that course', async t => {
  const { db, save, serve, state, send } = await setup(t)
  await db.query('update product_selection_group_assignments set min_selection=0 where group_id=$1', [groupIds[2]])
  await save([component(0), component(1)], 1)
  await serve(optionIds[0], 1, 2)
  await serve(optionIds[1], 1, 3)
  assert.equal((await db.query('select served_quantity::float8 n from order_lines')).rows[0].n, 1)
  await save([component(0), component(1), component(2)], 4)
  const entries = (await state()).entries
  assert.equal(entries.find(entry => entry.componentId === optionIds[0]).servedQuantity, 1)
  assert.equal(entries.find(entry => entry.componentId === optionIds[1]).unsentQuantity, 0)
  assert.equal(entries.find(entry => entry.componentId === optionIds[2]).unsentQuantity, 1)
  await send('late-optional-dessert', 5)
  assert.deepEqual((await db.query('select source_component_id from production_items')).rows.map(row => row.source_component_id), [optionIds[2]])
})

test('modifier notices and KDS cards update only the outstanding menu course and retain immutable snapshots', async t => {
  const { db, save, send, serve, queue } = await setup(t)
  await save([component(0), component(1)], 1)
  await send('menu-modifiers', 2)
  const sentItems = (await db.query('select id,source_component_id,snapshot from production_items')).rows
  await serve(optionIds[0], 1, 2)
  const cheese = { id: 'cheese', groupId: 'extras', name: 'Queso', priceCents: 100 }
  await db.query('update order_lines set modifiers=$1 where id=$2', [JSON.stringify([cheese]), line])
  let result = await queue()
  assert.equal(result.events.length, 1)
  assert.deepEqual(getKdsEventChanges(result.events[0]), ['Añadido: Queso'])
  for (const sent of sentItems) assert.deepEqual(result.items.find(item => item.id === sent.id).snapshot.lineModifiers,
    sent.source_component_id === optionIds[0] ? [] : [cheese])
  await db.query('select acknowledge_kds_event($1,$2)', [kds, result.events[0].id])
  result = await queue()
  assert.equal(result.events.length, 0)
  assert.deepEqual(result.items.find(item => item.id === sentItems.find(sent => sent.source_component_id === optionIds[1]).id).snapshot.lineModifiers, [cheese])
  assert.ok((await db.query('select snapshot from production_items')).rows.every(row => row.snapshot.lineModifiers.length === 0))
})

test('cancelling a ready split course cannot mark its unprepared sibling ready', async t => {
  const { db, save, send, state } = await setup(t)
  await save([component(0), component(1)], 1, { quantity: 2 })
  await send('split-readiness', 2)
  await db.query('update production_component_allocations set ready_quantity=1 where source_component_id=$1', [optionIds[0]])
  await db.query('update production_items set ready_quantity=1 where source_component_id=$1', [optionIds[0]])
  const split = uuid(90)
  await db.exec(`insert into order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,product_name,quantity,served_quantity,components,catalog_snapshot,split_from_line_id)
    select '${split}',tenant_id,venue_id,order_id,product_id,variant_id,product_name,1,0,components,catalog_snapshot,id from order_lines where id='${line}';
    update order_lines set quantity=1 where id='${line}';`)
  assert.equal((await state()).entries.find(entry => entry.lineId === split && entry.componentId === optionIds[0]).readyQuantity, 1)
  await db.query('update order_lines set components=$1 where id=$2', [[component(1)], split])
  assert.equal((await db.query('select ready_quantity::float8 n from production_items where source_component_id=$1', [optionIds[0]])).rows[0].n, 0)
  assert.equal((await state()).entries.find(entry => entry.lineId === line && entry.componentId === optionIds[0]).readyQuantity, 0)
})
