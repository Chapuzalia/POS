import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(
  new URL('../supabase/migrations/20260921120400_reframe_commercial_addons.sql', import.meta.url),
  'utf8',
)
const venueMigration = await readFile(
  new URL('../supabase/migrations/20260921130000_add_venue_addon_activations.sql', import.meta.url),
  'utf8',
)

test('la migración conserva contratos antiguos y distingue la selección nueva vacía', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  await db.exec(`
    create role anon;
    create role authenticated;
    create role service_role;
    create table public.platform_features (
      key text primary key,
      name text not null,
      description text not null,
      is_core boolean not null default false,
      is_active boolean not null default true,
      enabled_by_default boolean not null default false,
      sort_order integer not null,
      updated_at timestamptz not null default now()
    );
    create table public.tenant_feature_assignments (
      tenant_id uuid not null,
      feature_key text not null references public.platform_features(key),
      primary key (tenant_id, feature_key)
    );
    create table public.tenants (
      id uuid primary key,
      name text not null,
      slug text not null,
      max_venues integer not null,
      max_devices integer not null,
      updated_at timestamptz not null default now()
    );
    create table public.venues (
      id uuid primary key,
      tenant_id uuid not null references public.tenants(id),
      is_active boolean not null default true,
      tables_enabled boolean not null default true,
      production_enabled boolean not null default true,
      inventory_enabled boolean not null default true,
      unique (id, tenant_id)
    );
    create table public.devices (id uuid primary key, tenant_id uuid not null, is_active boolean not null);
    create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select true $$;
    insert into public.platform_features (key, name, description, sort_order)
    values
      ('discounts', 'Descuentos', '', 1),
      ('multi_device', 'Multidispositivo', '', 2),
      ('inventory_recipes', 'Escandallos', '', 3),
      ('supplier_documents', 'Documentos', '', 4),
      ('supplier_document_scanning', 'Escaneo', '', 5);
    insert into public.tenants (id, name, slug, max_venues, max_devices)
    values ('11111111-1111-1111-1111-111111111111', 'Bar', 'bar', 1, 1);
    insert into public.tenant_feature_assignments (tenant_id, feature_key)
    values
      ('11111111-1111-1111-1111-111111111111', 'discounts'),
      ('11111111-1111-1111-1111-111111111111', 'multi_device');
  `)
  await db.exec(migration)

  const tenantId = '11111111-1111-1111-1111-111111111111'
  const features = async () => {
    const { rows } = await db.query(
      'select feature_key from public.tenant_feature_assignments where tenant_id = $1 order by feature_key',
      [tenantId],
    )
    return rows.map((row) => row.feature_key)
  }
  const update = async (keys) => {
    await db.query(
      'select * from public.update_platform_tenant_config($1, $2, $3, $4, $5, $6)',
      [tenantId, 'Bar', 'bar', 1, 1, keys],
    )
  }

  assert.deepEqual(await features(), ['discounts', 'multi_device', 'promotions'])
  await db.query(
    'insert into public.tenant_feature_assignments (tenant_id, feature_key) values ($1, $2), ($1, $3)',
    [tenantId, 'analytics_advanced', 'cashlogy'],
  )
  await update(['discounts', 'multi_device'])
  assert.deepEqual(await features(), ['analytics_advanced', 'cashlogy', 'discounts', 'multi_device', 'promotions'])
  await update(['__addon_catalog_v2'])
  assert.deepEqual(await features(), ['multi_device'])

  await db.exec(venueMigration)
  await db.query(
    'insert into public.venues (id, tenant_id) values ($1, $2)',
    ['22222222-2222-2222-2222-222222222222', tenantId],
  )
  await update(['promotions', '__addon_catalog_v2'])
  const venueId = '22222222-2222-2222-2222-222222222222'
  await db.query('select public.set_venue_addon_enabled($1, $2, $3)', [venueId, 'promotions', false])
  const { rows } = await db.query(
    'select public.venue_addon_enabled($1, $2, $3) as enabled',
    [tenantId, venueId, 'promotions'],
  )
  assert.equal(rows[0].enabled, false)
})
