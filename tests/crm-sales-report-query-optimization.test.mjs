import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const original = readFileSync(new URL('../supabase/migrations/20260901130000_paginate_crm_sales_reports.sql', import.meta.url), 'utf8')
const migration = readFileSync(new URL('../supabase/migrations/20261005205620_optimize_crm_sales_report_queries.sql', import.meta.url), 'utf8')
const start = original.indexOf('create or replace function public.crm_sales_report_ticket_page(')
const end = original.indexOf('create or replace function public.crm_sales_report_filter_options(')
const baseline = original.slice(start, end).replace('public.crm_sales_report_ticket_page(', 'public.crm_sales_report_ticket_page_baseline(')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2), discount = id(3)
const from = '2026-10-01T04:00:00Z', to = '2026-10-08T04:00:00Z'

test('query optimization is a compatible expand migration with a separate summary', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  const summary = migration.slice(migration.indexOf('create function public.crm_sales_report_summary('))
  assert.doesNotMatch(summary, /p_page|p_sort_key|line_totals|offset /)
  assert.match(summary, /crm_allocate_net_total_to_lines/)
})

async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role service_role;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz, status text, total_cents integer, discount_id uuid, discount_name text, discount_amount_cents integer);
    create table sales(id uuid primary key, ticket_id uuid, payment_method text, created_at timestamptz);
    create table ticket_lines(id uuid primary key, ticket_id uuid, quantity integer, allocated_quantity numeric, product_name text, category_name_snapshot text, line_total_cents integer, tax_rate numeric, taxable_base_cents integer, tax_amount_cents integer);
    ${original}
    ${baseline}
  `)
  for (const [n, status, total, discountCents, method] of [
    [10, 'paid', 1000, 100, 'card'], [11, 'paid', 0, 0, 'invitation'], [12, 'void', 600, 0, 'cash'],
    [13, 'paid', 333, 666, 'cash'], [14, 'paid', 777, 0, null], [15, 'paid', 0, 0, null],
    [16, 'paid', 200, 0, 'card'], [17, 'paid', 500, 0, 'card'], [18, 'paid', 500, 0, 'cash'],
  ]) {
    await db.query('insert into tickets values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      id(n), n === 17 ? id(4) : tenant, n === 18 ? id(5) : venue,
      n === 16 ? to : `2026-10-0${n % 3 + 2}T12:00:00Z`, status, total,
      discountCents ? discount : null, discountCents ? 'Promo' : null, discountCents,
    ])
    if (method) await db.query('insert into sales values($1,$2,$3,$4)', [id(n + 100), id(n), method, '2026-10-05T12:00:00Z'])
    if (n !== 15) {
      await db.query('insert into ticket_lines values($1,$2,2,$3,$4,$5,$6,$7,$8,$9)', [
        id(n + 200), id(n), n === 13 ? '0.75' : null, n === 10 ? 'Café' : 'Agua', n === 14 ? null : 'Bebidas',
        n === 10 ? 700 : n === 11 ? 500 : total + discountCents,
        n === 14 ? null : 21, n === 14 ? null : 123, n === 14 ? null : 45,
      ])
    }
  }
  await db.query('insert into ticket_lines values($1,$2,1,null,$3,$4,400,10,364,36)', [id(250), id(10), 'Bocadillo', 'Comida'])
  // Preserve the latest-sale rule when filtering invitations or sorting payment.
  await db.query('insert into sales values($1,$2,$3,$4)', [id(260), id(11), 'cash', '2026-09-01T12:00:00Z'])
  await db.exec(migration)
  return db
}

async function page(db, name, options = {}) {
  const values = [options.tenant ?? tenant, options.venue === undefined ? venue : options.venue,
    options.from === undefined ? from : options.from, options.to === undefined ? to : options.to,
    options.product ?? null, options.category ?? null, options.discount ?? 'all',
    options.sort ?? 'createdAt', options.direction ?? 'desc', options.page ?? 1, options.size ?? 2, options.summary ?? false]
  return (await db.query(`select * from public.${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, values)).rows
}

async function summary(db, options = {}) {
  return (await db.query('select * from public.crm_sales_report_summary($1,$2,$3,$4,$5,$6,$7)', [
    options.tenant ?? tenant, options.venue === undefined ? venue : options.venue,
    options.from === undefined ? from : options.from, options.to === undefined ? to : options.to,
    options.product ?? null, options.category ?? null, options.discount ?? 'all',
  ])).rows[0]
}

test('optimized pages and summary retain all legacy sorts, filters and historical tax allocation', async t => {
  const db = await fixture(t)
  const filters = [{}, { discount: 'with' }, { discount: 'without' }, { discount: 'id:' + discount },
    { product: 'cafe' }, { category: 'comida' }, { product: 'cafe', category: 'comida' },
    { product: 'missing' }, { category: 'sin categoria' }, { venue: null }, { from: null, to: null }, { tenant: id(4) }]
  for (const filter of filters) {
    for (const sort of ['createdAt', 'quantity', 'paymentMethod', 'status', 'totalCents', 'ticketId', 'unknown']) {
      for (const direction of ['asc', 'desc']) {
        for (const includeSummary of [false, true]) {
          for (const pageNumber of [1, 2, 20]) {
            const options = { ...filter, sort, direction, summary: includeSummary, page: pageNumber }
            assert.deepEqual(await page(db, 'crm_sales_report_ticket_page', options), await page(db, 'crm_sales_report_ticket_page_baseline', options), JSON.stringify(options))
          }
        }
      }
    }
    const [old] = await page(db, 'crm_sales_report_ticket_page_baseline', { ...filter, summary: true, size: 1 })
    const expected = Object.fromEntries(['paid_ticket_count', 'summary_subtotal_cents', 'summary_tax_amount_cents', 'summary_total_cents'].map(key => [key, old?.[key] ?? 0]))
    assert.deepEqual(await summary(db, filter), expected, JSON.stringify(filter))
  }
  const actual = await summary(db)
  assert.equal(Number(actual.summary_total_cents), 2110)
  assert.equal(Number(actual.paid_ticket_count), 5)
  const boundaries = await page(db, 'crm_sales_report_ticket_page', { summary: false, size: 100 })
  assert.ok(!boundaries.some(row => row.ticket_id === id(16)))
  assert.ok(!boundaries.some(row => row.ticket_id === id(17)))
  assert.ok(!boundaries.some(row => row.ticket_id === id(18)))
})

function planNodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(planNodes)]
}

test('date page execution avoids scanning sales and line quantities while quantity sorting still scans lines', async t => {
  const db = await fixture(t)
  const functionSql = migration.slice(migration.indexOf('create or replace function public.crm_sales_report_ticket_page('), migration.indexOf('create function public.crm_sales_report_summary('))
  const body = functionSql.slice(functionSql.indexOf('as $$') + 5, functionSql.indexOf('$$;', functionSql.indexOf('as $$') + 5))
  async function explain(sort) {
    const literals = { p_tenant_id: `'${tenant}'::uuid`, p_venue_id: `'${venue}'::uuid`, p_date_from: `'${from}'::timestamptz`, p_date_to: `'${to}'::timestamptz`, p_product_query: 'null::text', p_category_query: 'null::text', p_discount_filter: "'all'::text", p_sort_key: `'${sort}'::text`, p_sort_direction: "'desc'::text", p_page: '1', p_page_size: '2', p_include_summary: 'false' }
    const sql = body.replace(/\bp_\w+\b/g, parameter => literals[parameter])
    const [row] = (await db.query('explain (analyze, format json) ' + sql)).rows
    return planNodes(row['QUERY PLAN'][0].Plan)
  }
  const date = await explain('createdAt')
  assert.ok(date.filter(node => ['sales', 'ticket_lines'].includes(node['Relation Name'])).every(node => node['Actual Loops'] === 0))
  const quantity = await explain('quantity')
  assert.ok(quantity.some(node => node['Relation Name'] === 'ticket_lines' && node['Actual Loops'] > 0))
})

test('page and summary keep RLS and function permissions for authenticated callers', async t => {
  const db = await fixture(t)
  await db.exec(`
    alter table tickets enable row level security;
    alter table sales enable row level security;
    alter table ticket_lines enable row level security;
    create policy ticket_scope on tickets to authenticated using (tenant_id = current_setting('app.tenant')::uuid and venue_id = current_setting('app.venue')::uuid);
    create policy sale_scope on sales to authenticated using (exists(select 1 from tickets t where t.id = ticket_id));
    create policy line_scope on ticket_lines to authenticated using (exists(select 1 from tickets t where t.id = ticket_id));
    grant select on tickets, sales, ticket_lines to authenticated;
    set app.tenant = '${tenant}'; set app.venue = '${venue}'; set role authenticated;
  `)
  assert.ok((await page(db, 'crm_sales_report_ticket_page')).length)
  assert.equal(Number((await summary(db)).paid_ticket_count), 5)
  assert.deepEqual(await page(db, 'crm_sales_report_ticket_page', { tenant: id(4) }), [])
  assert.equal(Number((await summary(db, { tenant: id(4) })).summary_total_cents), 0)
  assert.equal(Number((await summary(db, { venue: id(5) })).paid_ticket_count), 0)
  await db.exec('reset role')
  const permissions = (await db.query("select has_function_privilege('authenticated', 'crm_sales_report_summary(uuid,uuid,timestamptz,timestamptz,text,text,text)', 'execute') as allowed, prosecdef from pg_proc where oid = 'crm_sales_report_summary(uuid,uuid,timestamptz,timestamptz,text,text,text)'::regprocedure")).rows[0]
  assert.equal(permissions.allowed, true)
  assert.equal(permissions.prosecdef, false)
})
