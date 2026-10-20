import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
export const billingIds = { tenant: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002', owner: '20000000-0000-4000-8000-000000000001', stranger: '20000000-0000-4000-8000-000000000002', venue: '30000000-0000-4000-8000-000000000001', venueB: '30000000-0000-4000-8000-000000000002' }
export const billingMigration = await readFile(new URL('../../supabase/migrations/20261020174341_stripe_billing_foundation.sql', import.meta.url), 'utf8')
export const billingRepairMigration = await readFile(new URL('../../supabase/migrations/20261020213005_stripe_billing_failure_reconciliation.sql', import.meta.url), 'utf8')
export async function createBillingDb(t) {
  const db = new PGlite()
  t.after(() => db.close())
  const x = billingIds
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    grant usage on schema auth to authenticated;
    grant execute on function auth.uid() to authenticated;
    create table profiles(id uuid primary key,is_superadmin boolean default false);
    create table tenants(id uuid primary key,name text default 'Tenant',max_venues integer default 3,max_devices integer default 5,updated_at timestamptz default now());
    create table venues(id uuid primary key,tenant_id uuid references tenants(id),name text default 'Venue',is_active boolean default true, unique(id,tenant_id));
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,name text default 'Device',is_active boolean default true);
    create table cash_sessions(id uuid primary key,tenant_id uuid,status text);
    create table orders(id uuid primary key,tenant_id uuid,status text);
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean default true);
    create table platform_features(key text primary key,name text,description text default '',is_core boolean default false,is_active boolean default true,sort_order integer default 0);
    create table tenant_feature_assignments(tenant_id uuid references tenants(id),feature_key text references platform_features(key),primary key(tenant_id,feature_key));
    create table venue_addon_assignments(tenant_id uuid,venue_id uuid,addon_key text references platform_features(key),is_enabled boolean,updated_at timestamptz default now(),primary key(venue_id,addon_key),foreign key(venue_id,tenant_id) references venues(id,tenant_id));
    create function public.user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$ select auth.uid()='${x.owner}'::uuid and $1='${x.tenant}'::uuid and exists(select 1 from public.venues where id=$2 and tenant_id=$1) $$;
    create function public.get_current_tenant_features(uuid) returns text[] language sql stable security definer as $$ select array(select feature_key from public.tenant_feature_assignments where tenant_id=$1 and auth.uid()='${x.owner}'::uuid) $$;
    insert into profiles(id) values('${x.owner}'),('${x.stranger}');
    insert into tenants(id) values('${x.tenant}'),('${x.other}');
    insert into venues(id,tenant_id) values('${x.venue}','${x.tenant}'),('${x.venueB}','${x.tenant}');
    insert into tenant_memberships values('${x.tenant}','${x.owner}','owner',true),('${x.other}','${x.stranger}','owner',true);
    insert into platform_features(key,name) values('restaurant','Restaurante'),('reservations','Reservas'),('production','Producción'),('purchases','Compras');
    insert into tenant_feature_assignments values('${x.tenant}','restaurant'),('${x.tenant}','production');
    grant select on tenant_memberships to authenticated;
    grant all on all tables in schema public to service_role;
  `)
  await db.exec(billingMigration)
  await db.exec(billingRepairMigration)
  const transition = async (action, data) => (await db.query('select public.billing_transition($1,$2::jsonb) result', [action, JSON.stringify(data)])).rows[0].result
  return { db, transition }
}
