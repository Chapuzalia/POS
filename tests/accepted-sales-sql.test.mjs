import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

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

test('recipe or unit error leaves the economic line with unknown cost and a scoped incident', async t => {
  const db = await fixture(t)
  await db.exec(`insert into ticket_lines(id,tenant_id,ticket_id,unit_price_cents) values('${line}','${tenant}','${ticket}',600)`)
  assert.deepEqual((await db.query('select theoretical_cost_known,theoretical_cost_cents,unit_price_cents from ticket_lines')).rows,
    [{ theoretical_cost_known: false, theoretical_cost_cents: null, unit_price_cents: 600 }])
  assert.deepEqual((await db.query('select tenant_id,venue_id,entity_id,stage,error_code from sale_auxiliary_failures')).rows,
    [{ tenant_id: tenant, venue_id: venue, entity_id: line, stage: 'theoretical_cost', error_code: '55000' }])
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
