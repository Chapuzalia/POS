import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const sql = readFileSync(new URL('../supabase/migrations/20261011104456_protect_accepted_sales.sql', import.meta.url), 'utf8')
const tenant = '11111111-1111-4111-8111-111111111111'
const venue = '22222222-2222-4222-8222-222222222222'
const ticket = '33333333-3333-4333-8333-333333333333'
const line = '44444444-4444-4444-8444-444444444444'
const device = '55555555-5555-4555-8555-555555555555'
const user = '66666666-6666-4666-8666-666666666666'

async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql stable as $$select $1='${tenant}' and $2='${venue}' and $3='${device}'$$;
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$select $1='${tenant}' and $2='${venue}'$$;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid);
    create table orders(id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid);
    create table order_lines(id uuid primary key, tenant_id uuid, venue_id uuid, order_id uuid, split_from_line_id uuid,
      catalog_snapshot jsonb default '{}', components jsonb default '[]', product_id uuid, variant_id uuid,
      product_name text, variant_name text, unit_price_cents integer, updated_at timestamptz default now());
    create table ticket_lines(id uuid primary key, tenant_id uuid, ticket_id uuid, source_order_line_id uuid, product_id uuid,
      variant_id uuid, product_name text, variant_name text, unit_price_cents integer,
      theoretical_cost_known boolean default false, theoretical_cost_cents integer,
      category_id_snapshot uuid, category_name_snapshot text, catalog_tab_id_snapshot uuid, catalog_tab_name_snapshot text,
      base_price_cents integer, component_delta_cents integer, modifier_delta_cents integer, gross_before_discount_cents integer);
    create table offline_event_log(tenant_id uuid,event_kind text,payload jsonb,created_at timestamptz default now(),sale_cash_session_id text,sale_ticket_id text);
    create table ticket_line_components(tenant_id uuid,ticket_line_id uuid,component_type text check(component_type in ('menu_item','mixer')),
      selection_group_id uuid,selection_group_name_snapshot text,product_id uuid,variant_id uuid,product_name_snapshot text not null,
      variant_name_snapshot text,quantity integer,price_delta_cents integer,sort_order integer,metadata jsonb);
    create table inventory_units(id uuid,tenant_id uuid,venue_id uuid,content_unit_id uuid,content_quantity numeric);
    create table restaurant_order_equal_splits(id uuid,order_id uuid,tenant_id uuid,venue_id uuid);
    create table test_payments(operation text);
    create function theoretical_ticket_line_cost(uuid) returns jsonb language plpgsql as $$begin
      raise exception 'INVENTORY_CONSUMPTION_UNIT_MISMATCH' using errcode='55000'; end$$;
    create function production_catalog_category(uuid,uuid,uuid) returns uuid language sql as $$select null::uuid$$;
    create function production_upsert_pass_snapshot(public.order_lines,text,uuid,uuid) returns void language plpgsql as $$begin raise exception 'No hay pase activo'; end$$;
    create function close_restaurant_order_checked_v2(uuid,text,integer,boolean,jsonb) returns jsonb language plpgsql as $$begin
      if (select cash_session_id is null from public.orders where id=$1) then raise exception 'caja cerrada' using errcode='55000'; end if;
      insert into public.test_payments values('close'); return jsonb_build_object('saleId','${line}','ticketId','${ticket}','totalCents',600); end$$;
    insert into tickets values('${ticket}','${tenant}','${venue}','${ticket}');
    insert into orders values('${ticket}','${tenant}','${venue}','${ticket}');
    set test.uid='${user}';
  `)
  await db.exec(sql)
  await db.exec(`
    create trigger capture_snapshot before insert on ticket_lines for each row execute function capture_ticket_line_catalog_snapshot();
    create trigger a_components after insert on ticket_lines for each row execute function capture_ticket_line_components();
    create trigger zz_cost after insert on ticket_lines for each row execute function snapshot_ticket_line_theoretical_cost();
    create trigger passes after insert on order_lines for each row execute function production_snapshot_line_passes();
  `)
  return db
}

test('accepted-sale migration preserves N-1 and passes migration safety checks', () => assert.deepEqual(analyzeMigration(sql), []))
test('recipe or unit error leaves the economic line with unknown cost and a scoped incident', async t => {
  const db = await fixture(t)
  await db.exec(`insert into ticket_lines(id,tenant_id,ticket_id,unit_price_cents) values('${line}','${tenant}','${ticket}',600)`)
  assert.deepEqual((await db.query('select theoretical_cost_known,theoretical_cost_cents,unit_price_cents from ticket_lines')).rows,
    [{ theoretical_cost_known: false, theoretical_cost_cents: null, unit_price_cents: 600 }])
  assert.deepEqual((await db.query('select tenant_id,venue_id,entity_id,stage,error_code from sale_auxiliary_failures')).rows,
    [{ tenant_id: tenant, venue_id: venue, entity_id: line, stage: 'theoretical_cost', error_code: '55000' }])
})
test('malformed historical components and category/prices do not reject the line or invent a known cost', async t => {
  const db = await fixture(t)
  await db.query('insert into offline_event_log values($1,\'sale_created\',$2,now(),$3,$3)', [tenant,
    { lines: [{ id: line, components: [{ type: 'menu_item', productId: 'not-a-uuid', productName: 'Antiguo' }],
      catalogSnapshot: { categoryId: 'deleted-bad-id' }, basePriceCents: 'NaN' }], ticket: { id: ticket } }, ticket])
  await db.exec(`insert into ticket_lines(id,tenant_id,ticket_id,unit_price_cents) values('${line}','${tenant}','${ticket}',600)`)
  assert.equal((await db.query('select count(*)::int n from ticket_lines')).rows[0].n, 1)
  assert.deepEqual((await db.query('select stage from sale_auxiliary_failures order by stage')).rows,
    [{ stage: 'catalog_snapshot' }, { stage: 'components' }])
  assert.equal((await db.query('select theoretical_cost_known from ticket_lines')).rows[0].theoretical_cost_known, false)
})
test('missing active production pass keeps order lines and exposes an incident', async t => {
  const db = await fixture(t)
  await db.exec(`insert into order_lines(id,tenant_id,venue_id,order_id) values('${line}','${tenant}','${venue}','${ticket}')`)
  assert.equal((await db.query('select count(*)::int n from order_lines')).rows[0].n, 1)
  assert.equal((await db.query('select stage from sale_auxiliary_failures')).rows[0].stage, 'production_pass')
})
test('quantity compatibility depends on explicit content identity and ratio, never bottle names', async t => {
  const db = await fixture(t)
  const source = readFileSync(new URL('../supabase/migrations/20260830120000_add_inventory_items_recipes_and_preparations.sql', import.meta.url), 'utf8')
  await db.exec(source.match(/create or replace function public\.inventory_convert_quantity\([\s\S]*?\$\$;/)[0])
  await db.exec(`insert into inventory_units values('${line}','${tenant}','${venue}','${ticket}',700),('${device}','${tenant}','${venue}','${ticket}',1)`)
  assert.equal((await db.query(`select inventory_units_compatible('${tenant}','${venue}','${line}','${device}') ok`)).rows[0].ok, true)
  assert.equal(Number((await db.query(`select inventory_convert_quantity('${tenant}','${venue}',1,'${line}','${device}') quantity`)).rows[0].quantity), 700)
  assert.equal((await db.query(`select inventory_units_compatible('${user}','${venue}','${line}','${device}') ok`)).rows[0].ok, false)
  await db.exec(`update inventory_units set content_unit_id='${line}' where id='${device}'`)
  assert.equal((await db.query(`select inventory_units_compatible('${tenant}','${venue}','${line}','${device}') ok`)).rows[0].ok, false)
})
test('lost restaurant RPC reply replays one economic operation, rejects changed identity and keeps cash guards', async t => {
  const db = await fixture(t)
  const call = (operation, params, selectedTenant = tenant) => db.query('select pay_restaurant_idempotent($1,$2,$3,$4,\'close\',$5) result',
    [operation, selectedTenant, venue, device, params])
  const params = { orderId: ticket, method: 'card', receivedCents: null, allowPending: true, discount: null }
  const first = (await call(line, params)).rows[0].result
  assert.deepEqual((await call(line, params)).rows[0].result, first)
  assert.deepEqual((await call(line, { ...params, allowPending: false })).rows[0].result, first)
  assert.equal((await db.query('select count(*)::int n from test_payments')).rows[0].n, 1)
  await assert.rejects(call(line, { ...params, method: 'cash' }), /PAYMENT_OPERATION_CONFLICT/)
  await assert.rejects(call(line, params, user), /PAYMENT_OPERATION_FORBIDDEN/)
  await db.exec('update orders set cash_session_id=null')
  await assert.rejects(call(device, params), /caja cerrada/)
  assert.equal((await db.query('select count(*)::int n from restaurant_payment_operations')).rows[0].n, 1)
})
test('browser roles cannot insert diagnostics or invoke the trusted diagnostic writer', async t => {
  const db = await fixture(t)
  await db.exec(`select record_sale_auxiliary_failure('${tenant}','${venue}','${line}','test','22023');
    select record_sale_auxiliary_failure('${user}','${venue}','${line}','foreign','22023');`)
  await db.exec('set role authenticated')
  assert.deepEqual((await db.query('select stage from sale_auxiliary_failures')).rows, [{ stage: 'test' }])
  await assert.rejects(db.exec(`select record_sale_auxiliary_failure('${tenant}','${venue}','${line}','fake','00000')`), /permission denied/)
  await assert.rejects(db.exec(`insert into sale_auxiliary_failures(tenant_id,venue_id,entity_id,stage,error_code) values('${tenant}','${venue}','${line}','fake','00000')`), /permission denied/)
})
