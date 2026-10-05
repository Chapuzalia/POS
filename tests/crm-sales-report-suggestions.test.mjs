import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261005203834_crm_sales_report_filter_suggestions.sql', import.meta.url), 'utf8')
const original = readFileSync(new URL('../supabase/migrations/20260901130000_paginate_crm_sales_reports.sql', import.meta.url), 'utf8')
const normalizer = original.slice(original.indexOf('create or replace function public.crm_normalize_search_text'), original.indexOf('create or replace function public.crm_allocate_net_total_to_lines'))
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2)

test('suggestions migration passes expand checks and preserves the old RPC', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  assert.doesNotMatch(migration, /create or replace|drop function|crm_sales_report_ticket_page/i)
})

test('SQL suggestions enforce period boundaries, text, limits, tenant, venue and RLS', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role service_role;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz, discount_id uuid, discount_name text);
    create table ticket_lines(ticket_id uuid, tenant_id uuid, product_name text, category_name_snapshot text);
    create function public.crm_sales_report_filter_options(uuid, uuid) returns jsonb language sql as $$select '{"legacy":true}'::jsonb$$;
    ${normalizer}
  `)
  await db.exec(migration)
  const insert = async (n, date, product, category, tenantId = tenant, venueId = venue) => {
    await db.query('insert into tickets values($1,$2,$3,$4,$5,$6)', [id(n), tenantId, venueId, date, id(n + 100), product + ' promo'])
    await db.query('insert into ticket_lines values($1,$2,$3,$4)', [id(n), tenantId, product, category])
  }
  await insert(10, '2026-10-01T04:00:00Z', 'Café', 'Bebídas')
  await insert(11, '2026-10-02T04:00:00Z', 'Agua', null)
  await insert(12, '2026-10-01T03:59:59Z', 'Too early', 'Old')
  await insert(13, '2026-10-08T04:00:00Z', 'Too late', 'Future')
  await insert(14, '2026-10-02T04:00:00Z', 'Other tenant', 'Private', id(3))
  await insert(15, '2026-10-02T04:00:00Z', 'Other venue', 'Private', tenant, id(4))
  const suggestions = async (product = '', category = '', tenantId = tenant, venueId = venue) => (await db.query(
    'select crm_sales_report_filter_suggestions($1,$2,$3,$4,$5,$6) as result',
    [tenantId, venueId, '2026-10-01T04:00:00Z', '2026-10-08T04:00:00Z', product, category],
  )).rows[0].result
  const initial = await suggestions()
  assert.deepEqual(initial.products, ['Agua', 'Café'])
  assert.deepEqual(initial.categories, ['Bebídas', 'Sin categoría'])
  assert.deepEqual(initial.discounts.map(item => item.name), ['Agua promo', 'Café promo'])
  assert.deepEqual((await suggestions('cafe', 'bebidas')).products, ['Café'])
  assert.deepEqual((await suggestions('cafe', 'bebidas')).categories, ['Bebídas'])
  assert.deepEqual((await suggestions('', '', tenant, null)).products, [])
  for (let n = 20; n < 45; n++) await insert(n, '2026-10-02T04:00:00Z', `Product ${n}`, `Category ${n}`)
  assert.equal((await suggestions()).products.length, 20)
  assert.equal((await suggestions()).categories.length, 20)
  assert.deepEqual((await suggestions('Product 44')).products, ['Product 44'])
  assert.equal((await db.query('select crm_sales_report_filter_options($1,$2) as result', [tenant, venue])).rows[0].result.legacy, true)

  await db.exec(`
    alter table tickets enable row level security;
    alter table ticket_lines enable row level security;
    create policy ticket_scope on tickets to authenticated using (tenant_id = current_setting('app.tenant')::uuid and venue_id = current_setting('app.venue')::uuid);
    create policy line_scope on ticket_lines to authenticated using (tenant_id = current_setting('app.tenant')::uuid);
    grant select on tickets, ticket_lines to authenticated;
    grant execute on function crm_normalize_search_text(text) to authenticated;
    set app.tenant = '${tenant}'; set app.venue = '${venue}'; set role authenticated;
  `)
  assert.equal((await suggestions('cafe')).products[0], 'Café')
  assert.deepEqual((await suggestions('', '', id(3), venue)).products, [])
  assert.deepEqual((await suggestions('', '', tenant, id(4))).products, [])
})
