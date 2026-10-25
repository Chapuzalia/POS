import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

const read = path => readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
const base = read('supabase/0.Complete_Database_24-07-26.sql')
export const migration = read('supabase/migrations/20261024234554_venue_restaurant_operations.sql')
export const uuid = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
export const ids = Object.fromEntries(['tenant','venue','user','deviceA','sessionA','registerA','group','order','table','area',
  'deviceB','sessionB','registerB','otherTenant','otherVenue','line'].map((key,n) => [key,uuid(n+1)]))
const fn = (source,name) => {
  const match = source.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`,'i'))
  assert.ok(match,name)
  return match[0]
}

export async function venueRestaurantDb({ apply = true } = {}) {
  const db = new PGlite()
  try {
  await db.exec(`
    create schema auth; create role authenticated; create role anon; create role service_role;
    create publication supabase_realtime;
    create table auth.users(id uuid primary key);
    create table tenants(id uuid primary key);
    create table venues(id uuid primary key,tenant_id uuid,name text default 'Local',timezone text default 'Europe/Madrid',currency_code text default 'EUR',
      tickit_assist_enabled boolean default false,tickit_assist_sensitivity text default 'normal');
    create table profiles(id uuid primary key,full_name text);
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    grant usage on schema auth to authenticated;
    create function public.user_has_venue_access(uuid,uuid) returns boolean language sql as $$select $1='${ids.tenant}'::uuid and $2='${ids.venue}'::uuid and auth.uid()='${ids.user}'::uuid$$;
    create function public.user_has_device_access(uuid,uuid,uuid) returns boolean language sql as $$select public.user_has_venue_access($1,$2) and $3 in ('${ids.deviceA}'::uuid,'${ids.deviceB}'::uuid)$$;
    create function public.record_restaurant_order_event(uuid,text,jsonb) returns void language plpgsql as $$begin return; end;$$;
    create function public.resolve_ticket_discount(uuid,uuid,integer,jsonb) returns jsonb language sql as $$select jsonb_build_object('amountCents',0,'totalCents',$3)$$;
    create function public.tickit_assist_enabled(uuid,uuid) returns boolean language sql as $$select false$$;
    create function public.tenant_addon_enabled(uuid,text) returns boolean language sql as $$select false$$;
  `)
  for (const name of ['devices','cash_sessions','cash_registers','dining_areas','restaurant_tables','cash_session_table_layouts',
    'order_groups','orders','order_lines','order_tables','restaurant_order_equal_splits','restaurant_order_equal_split_payments',
    'tickets','ticket_lines','sales','sale_payments','device_user_assignments','cash_movements','cash_session_stacker_collections']) {
    const source = base.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\\r?\\n\\);`))
    assert.ok(source,name)
    await db.exec(source[0])
    const primary = name === 'cash_session_table_layouts' ? 'cash_session_id' : name === 'order_tables' ? 'order_id,table_id,joined_at' : 'id'
    if (!/primary key/i.test(source[0])) await db.exec(`alter table public.${name} add primary key(${primary})`)
  }
  await db.exec(`
    alter table restaurant_tables alter column area_id drop not null;
    alter table restaurant_tables add cash_session_id uuid;
    alter table orders add draft_discount jsonb;
    alter table order_lines add if not exists components jsonb default '[]';
    alter table order_lines add if not exists catalog_snapshot jsonb default '{}';
    alter table restaurant_tables add constraint restaurant_tables_area_or_session_check check(area_id is not null or cash_session_id is not null);
    alter table public.restaurant_order_equal_splits add unique(order_id);
    alter table public.ticket_lines add source_order_line_id uuid;
    alter table ticket_lines add if not exists category_id_snapshot uuid,add if not exists category_name_snapshot text,
      add if not exists catalog_tab_id_snapshot uuid,add if not exists catalog_tab_name_snapshot text,
      add if not exists base_price_cents integer,add if not exists component_delta_cents integer,
      add if not exists modifier_delta_cents integer,add if not exists gross_before_discount_cents integer;
    create function public.record_sale_auxiliary_failure(uuid,uuid,uuid,text,text) returns void language plpgsql as $$begin raise exception 'Auxiliary snapshot failed'; end;$$;
    alter table public.sale_payments add cashlogy_request_id text,add cashlogy_transaction_id text;
    create unique index one_active_order_per_restaurant_table on order_tables(table_id) where released_at is null;
    create table public.restaurant_payment_operations(operation_id uuid primary key,tenant_id uuid,venue_id uuid,device_id uuid,user_id uuid,action text,params jsonb,result jsonb);
    create table public.fiscal_sif_installations(id uuid,tenant_id uuid,fiscal_subject_id uuid,venue_id uuid,cash_register_id uuid,device_id uuid,retired_at timestamptz,mode text,venue_code text,register_code text,installation_code text,series_version integer,installation_sequence integer);
    create table public.fiscal_subjects(id uuid,tenant_id uuid,nif text);
    create table public.fiscal_local_records(id uuid,tenant_id uuid,fiscal_subject_id uuid,installation_id uuid,venue_id uuid,cash_register_id uuid,invoice_id uuid,ticket_id uuid,sale_id uuid,record_kind text,chain_position bigint,previous_hash text,hash text,canonical_schema text,canonical_record jsonb,record_envelope jsonb,invoice_snapshot jsonb,generated_at timestamptz,idempotency_key uuid,rpc_result jsonb);
    create table public.fiscal_local_series(id uuid default gen_random_uuid(),tenant_id uuid,fiscal_subject_id uuid,installation_id uuid,venue_id uuid,cash_register_id uuid,device_id uuid,document_kind text,exercise integer,series text,last_number bigint default 0,unique(tenant_id,fiscal_subject_id,series));
    create table public.customers(id uuid,tenant_id uuid);
    create table public.fiscal_integration_settings(tenant_id uuid,enabled boolean);
    create function public.fiscal_series_exercise(text) returns integer language sql as $$select split_part($1,'-',4)::integer$$;
    create function public.fiscal_installation_series_prefix(public.fiscal_sif_installations) returns text language sql as $$select $1.venue_code || '-' || $1.register_code || '-' || $1.installation_sequence::text$$;
    create table reservations(id uuid,tenant_id uuid,venue_id uuid,customer_name text,customer_phone text,party_size integer,starts_at timestamptz,ends_at timestamptz,status text);
    create table reservation_tables(reservation_id uuid,tenant_id uuid,venue_id uuid,table_id uuid);
    create table production_line_allocations(current_order_line_id uuid,ready_quantity numeric,quantity numeric,cancelled_quantity numeric,batch_id uuid,tenant_id uuid,venue_id uuid,updated_at timestamptz);
    create table production_batches(id uuid,created_at timestamptz);
  `)
  await db.exec(base.match(/CREATE TABLE public\.ticket_line_components \([\s\S]*?\r?\n\);/)[0])
  for (const name of ['restaurant_equal_split_to_json','configure_restaurant_order_equal_split','close_restaurant_order_checked_v2',
    'block_cash_close_with_open_restaurant_orders','clear_closed_cash_session_table_layout','guard_equal_split_order_close','set_order_cash_register','open_cash_register_session']) {
    await db.exec(fn(base,name))
  }
  await db.exec(fn(read('supabase/migrations/20260726220000_add_restaurant_reservations.sql'),'open_restaurant_order'))
  await db.exec(fn(read('supabase/migrations/20260827120000_add_cashlogy_stacker_collections.sql'),'close_cash_register_session'))
  await db.exec(read('supabase/migrations/20261014115222_equal_split_single_ticket.sql'))
  await db.exec(`create trigger close_guard before update of status on cash_sessions for each row execute function block_cash_close_with_open_restaurant_orders();
    create trigger clear_layout after update of status on cash_sessions for each row execute function clear_closed_cash_session_table_layout();
    create trigger set_order_register before insert on orders for each row execute function set_order_cash_register();
    create trigger guard_equal_split before update of status on orders for each row execute function guard_equal_split_order_close();`)
  if (apply) {
    await db.exec(migration)
    await db.exec('create trigger snapshot_before_ticket_line before insert on ticket_lines for each row execute function capture_ticket_line_catalog_snapshot();')
  }
  const { tenant,venue,user,deviceA,deviceB,registerA,registerB,sessionA,sessionB,area,table } = ids
  await db.exec(`
    insert into tenants values('${tenant}'),('${ids.otherTenant}');
    insert into venues(id,tenant_id) values('${venue}','${tenant}'),('${ids.otherVenue}','${ids.otherTenant}');
    insert into auth.users values('${user}'); insert into profiles values('${user}','Cajero');
    insert into devices(id,tenant_id,venue_id,name,can_take_orders,can_take_payments,can_close_cash_session) values
      ('${deviceA}','${tenant}','${venue}','A',true,true,true),('${deviceB}','${tenant}','${venue}','B',true,true,true);
    insert into cash_registers(id,tenant_id,venue_id,name) values('${registerA}','${tenant}','${venue}','A'),('${registerB}','${tenant}','${venue}','B');
    insert into device_user_assignments(tenant_id,venue_id,device_id,user_id) values('${tenant}','${venue}','${deviceA}','${user}'),('${tenant}','${venue}','${deviceB}','${user}');
    insert into cash_sessions(id,tenant_id,venue_id,opened_by,opened_by_device_id,status,cash_register_id,opening_float_cents) values
      ('${sessionA}','${tenant}','${venue}','${user}','${deviceA}','open','${registerA}',0),('${sessionB}','${tenant}','${venue}','${user}','${deviceB}','open','${registerB}',0);
    update devices set active_cash_session_id = case when id='${deviceA}' then '${sessionA}'::uuid else '${sessionB}'::uuid end;
    insert into dining_areas(id,tenant_id,venue_id,name) values('${area}','${tenant}','${venue}','Sala');
    insert into restaurant_tables(id,tenant_id,venue_id,area_id,name,position_x,position_y,width,height) values('${table}','${tenant}','${venue}','${area}','Mesa 1',10,10,12,12);
    set test.uid='${user}';
  `)
  const query = async (sql,params = []) => (await db.query(sql,params)).rows
  const open = async (tableId = table) => (await query('select open_restaurant_order(array[$1::uuid],2,$2,$3) as id',[tableId,sessionA,deviceA]))[0].id
  const addLines = async (orderId,quantity = 2) => {
    await query(`insert into order_lines(id,tenant_id,venue_id,order_id,product_name,variant_name,unit_price_cents,quantity,served_quantity) values($1,$2,$3,$4,'Cena','',500,$5,$5)`,[ids.line,tenant,venue,orderId,quantity])
  }
  const pay = async (orderId,params = {},deviceId = deviceB,operationId = uuid(60),action = 'close') => (await query(
    'select pay_restaurant_equal_split_single_idempotent($1,$2,$3,$4,$5,$6) as result',
    [operationId,tenant,venue,deviceId,action,{ orderId,expectedRevision:0,method:'card',allowPending:true,cashSessionId:deviceId === deviceA ? sessionA : sessionB,...params }]))[0].result
  return { db,query,open,addLines,pay }
  } catch (error) {
    await db.close()
    delete error.query
    throw error
  }
}
