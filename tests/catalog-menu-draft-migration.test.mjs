import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(
  new URL('../supabase/migrations/20260925130000_allow_inactive_menu_assignments.sql', import.meta.url),
  'utf8',
)

test('permite assignments activos en borradores de menú y mantiene productos estándar estrictos', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
  const venueId = '11111111-1111-4111-8111-111111111111'
  const menuId = '33333333-3333-4333-8333-333333333333'
  const standardId = '44444444-4444-4444-8444-444444444444'
  const groupId = '55555555-5555-4555-8555-555555555555'

  await db.exec(`
    create table public.venues (id uuid primary key, tenant_id uuid not null);
    create table public.products (
      id uuid primary key,
      venue_id uuid not null,
      product_type text not null,
      is_active boolean not null
    );
    create table public.selection_groups (
      id uuid primary key,
      venue_id uuid not null,
      is_active boolean not null
    );
    create table public.modifier_groups (
      id uuid primary key,
      venue_id uuid not null,
      is_active boolean not null
    );
    create table public.selection_group_options (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      product_id uuid not null
    );
    create table public.product_selection_group_assignments (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      product_id uuid not null,
      group_id uuid not null,
      is_active boolean not null
    );
    create table public.product_modifier_group_assignments (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      product_id uuid not null,
      group_id uuid not null,
      is_active boolean not null
    );
    insert into public.venues values ('${venueId}', '${tenantId}');
    insert into public.products values
      ('${menuId}', '${venueId}', 'menu', false),
      ('${standardId}', '${venueId}', 'standard', false);
    insert into public.selection_groups values ('${groupId}', '${venueId}', true);
  `)
  await db.exec(migration)
  await db.exec(`
    create trigger selection_assignment_catalog_validate
    before insert or update on public.product_selection_group_assignments
    for each row execute function public.validate_catalog_entity();
  `)

  await db.exec(`
    insert into public.product_selection_group_assignments
      (id, tenant_id, venue_id, product_id, group_id, is_active)
    values
      ('66666666-6666-4666-8666-666666666666', '${tenantId}', '${venueId}', '${menuId}', '${groupId}', true);
  `)
  const saved = await db.query('select count(*)::int as count from public.product_selection_group_assignments')
  assert.equal(saved.rows[0].count, 1)

  await assert.rejects(
    () => db.exec(`
      insert into public.product_selection_group_assignments
        (id, tenant_id, venue_id, product_id, group_id, is_active)
      values
        ('77777777-7777-4777-8777-777777777777', '${tenantId}', '${venueId}', '${standardId}', '${groupId}', true);
    `),
    /ACTIVE_ASSIGNMENT_INACTIVE_PRODUCT/,
  )
})
