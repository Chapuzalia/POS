import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'

export const readProductionSql = name => readFileSync(new URL(`../../supabase/migrations/${name}.sql`, import.meta.url), 'utf8')
const fix = readProductionSql('20261017120335_production_kds_workflow_fixes')
export const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
export const [tenant, venue, pos, kds, destination, pass, order, line, product, user] = Array.from({ length: 10 }, (_, i) => uuid(i + 1))

export async function createProductionDatabase(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table devices(id uuid primary key, tenant_id uuid, venue_id uuid, device_mode text, production_destination_id uuid, is_active boolean default true);
    create table orders(id uuid primary key, tenant_id uuid, venue_id uuid, status text default 'open', revision integer default 1, order_group_id uuid);
    create table order_lines(id uuid primary key, tenant_id uuid, venue_id uuid, order_id uuid, product_id uuid, variant_id uuid, product_name text, variant_name text,
      quantity numeric(18,3), served_quantity numeric(18,3), components jsonb default '[]', catalog_snapshot jsonb default '{}', modifiers jsonb default '[]', note text, created_at timestamptz default now(), split_from_line_id uuid);
    create table production_destinations(id uuid primary key, tenant_id uuid, venue_id uuid, is_active boolean default true, kds_enabled boolean default true);
    create table production_passes(id uuid primary key, tenant_id uuid, venue_id uuid, name text, sort_order integer default 0, is_active boolean default true);
    create table order_line_production_passes(tenant_id uuid, venue_id uuid, order_line_id uuid, component_id text, pass_id uuid, pass_name text, primary key(order_line_id, component_id));
    create table production_batches(id uuid primary key, tenant_id uuid, venue_id uuid, order_id uuid, sequence integer, request_id text, actor_user_id uuid, actor_device_id uuid, pass_id uuid, pass_name text, created_at timestamptz default now(), unique(venue_id,request_id), unique(order_id,sequence));
    create table production_items(id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, batch_id uuid, destination_id uuid, source_order_id uuid, source_order_line_id uuid,
      source_component_id text, product_id uuid, variant_id uuid, quantity numeric(18,3) check(quantity > 0), ready_quantity numeric(18,3) default 0, cancelled_quantity numeric(18,3) default 0,
      units_per_commercial_unit integer default 1, snapshot jsonb, pass_id uuid, pass_name text, created_at timestamptz default now(), updated_at timestamptz default now());
    create table production_line_allocations(id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, batch_id uuid, source_order_line_id uuid, current_order_line_id uuid, quantity numeric(18,3), ready_quantity numeric(18,3) default 0, cancelled_quantity numeric(18,3) default 0, created_at timestamptz default now(), updated_at timestamptz default now(), unique(batch_id,source_order_line_id,current_order_line_id));
    create table production_component_allocations(id uuid primary key default gen_random_uuid(), tenant_id uuid, venue_id uuid, batch_id uuid, source_order_line_id uuid, current_order_line_id uuid, source_component_id text, quantity numeric(18,3), ready_quantity numeric(18,3) default 0, cancelled_quantity numeric(18,3) default 0, created_at timestamptz default now(), updated_at timestamptz default now(), unique(batch_id,source_order_line_id,current_order_line_id,source_component_id));
    create table production_events(id uuid primary key, tenant_id uuid, venue_id uuid, destination_id uuid, event_type text, quantity numeric(18,3), payload jsonb, created_at timestamptz default now());
    create table production_printer_dispatches(batch_id uuid, destination_id uuid, status text, error_message text, created_at timestamptz default now());
    create table order_tables(order_group_id uuid, table_id uuid, released_at timestamptz);
    create table restaurant_tables(id uuid, name text);
    create function user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select auth.uid()='${user}'::uuid and $1='${tenant}'::uuid and $2='${venue}'::uuid $$;
    create function user_has_device_access(uuid,uuid,uuid) returns boolean language sql stable as $$ select public.user_has_venue_access($1,$2) and $3 in ('${pos}'::uuid,'${kds}'::uuid) $$;
    create function production_is_effective(uuid,uuid) returns boolean language sql stable as $$ select $1='${tenant}'::uuid and $2='${venue}'::uuid and coalesce(current_setting('test.production',true),'true') <> 'false' $$;
    create function production_resolve_destination(uuid,uuid,uuid,uuid) returns uuid language sql stable as $$ select '${destination}'::uuid where $1='${tenant}'::uuid and $2='${venue}'::uuid $$;
    create function production_catalog_category(uuid,uuid,uuid) returns uuid language sql stable as $$ select null::uuid $$;
    create function production_upsert_pass_snapshot(public.order_lines,text,uuid,uuid) returns void language sql as $$ select $$;
    create function production_create_batch_dispatches(uuid) returns integer language sql as $$ select 0 $$;
    insert into devices values('${pos}','${tenant}','${venue}','hybrid',null,true),('${kds}','${tenant}','${venue}','kds','${destination}',true);
    insert into orders(id,tenant_id,venue_id) values('${order}','${tenant}','${venue}');
    insert into order_lines(id,tenant_id,venue_id,order_id,product_id,product_name,quantity,served_quantity) values('${line}','${tenant}','${venue}','${order}','${product}','Absolut',5,4);
    insert into production_destinations(id,tenant_id,venue_id) values('${destination}','${tenant}','${venue}');
    insert into production_passes(id,tenant_id,venue_id,name) values('${pass}','${tenant}','${venue}','Directo');
    insert into order_line_production_passes values('${tenant}','${venue}','${line}','','${pass}','Directo');
    grant usage on schema public, auth to authenticated, anon;
    select set_config('test.uid','${user}',false);
  `)
  await db.exec(fix)
  await db.exec(`create trigger production_copy_passes_after_split after insert on order_lines for each row when (new.split_from_line_id is not null) execute function production_copy_passes_after_split();
    create trigger production_move_allocations_after_split after insert on order_lines for each row when (new.split_from_line_id is not null) execute function production_move_allocations_to_split_line();`)
  return db
}

