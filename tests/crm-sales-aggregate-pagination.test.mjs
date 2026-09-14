import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test, { before, after } from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { buildSalesReportAggregates } from '../src/features/crm/sales/services/salesReportModel.ts'

const migration = await readFile(new URL('../supabase/migrations/20260913160716_paginate_crm_sales_aggregates.sql', import.meta.url), 'utf8')
const baseMigration = await readFile(new URL('../supabase/migrations/20260901130000_paginate_crm_sales_reports.sql', import.meta.url), 'utf8')
const uuid = (prefix, number) => `${prefix}0000000-0000-4000-8000-${String(number).padStart(12, '0')}`
const tenant = uuid(1, 1)
const venue = uuid(2, 1)
const db = new PGlite()
const tickets = []

before(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table tickets (id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz,
      status text, total_cents integer, discount_amount_cents integer default 0, discount_id uuid, discount_name text);
    create table sales (id uuid primary key, ticket_id uuid, payment_method text, created_at timestamptz default now());
    create table ticket_lines (id uuid primary key, ticket_id uuid, product_id uuid, product_name text,
      variant_id uuid, variant_name text, category_id_snapshot uuid, category_name_snapshot text,
      catalog_tab_id_snapshot uuid, catalog_tab_name_snapshot text, sale_format_id uuid, sale_format_name_snapshot text,
      quantity integer, allocated_quantity numeric, line_total_cents integer, tax_rate numeric, taxable_base_cents integer,
      tax_amount_cents integer, modifiers jsonb);
    create table ticket_line_components (id uuid primary key, ticket_line_id uuid, component_type text,
      product_id uuid, product_name_snapshot text, quantity integer, price_delta_cents integer);
  `)
  await db.exec(baseMigration)
  await db.exec(migration)
  for (let product = 1; product <= 31; product++) {
    for (let repeat = 0; repeat < 2; repeat++) {
      const id = product * 2 + repeat
      const quantity = repeat ? 0.5 : 1
      const label = String(product).padStart(2, '0')
      const line = {
        id: uuid(4, id), productId: uuid(3, product), productName: `Café ${label}`, variantId: uuid(5, product), variantName: `Variante ${label}`,
        categoryId: uuid(6, product), categoryName: `Categoría ${label}`, catalogTabId: uuid(7, product), catalogTabName: `Pestaña ${label}`,
        saleFormatId: uuid(8, product), saleFormatName: `Formato ${label}`, quantity, lineTotalCents: product * 100,
        modifiers: [{ name: `Extra ${label}`, priceCents: product * 10 }],
        components: ['mixer', 'menu_component'].map((type, i) => ({
          id: uuid(9, id * 2 + i), type, productId: uuid(3, product), productName: `Componente ${label}`,
          quantity: 2, priceDeltaCents: product * 10,
        })),
      }
      const ticket = { id: uuid(4, id), status: 'paid', totalCents: product * 100, lines: [line] }
      tickets.push(ticket)
      await db.query('insert into tickets(id, tenant_id, venue_id, local_created_at, status, total_cents) values ($1,$2,$3,$4,$5,$6)',
        [ticket.id, tenant, venue, '2026-09-10T10:00:00Z', ticket.status, ticket.totalCents])
      await db.query(`insert into ticket_lines values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,$13,$14,10,0,0,$15)`,
        [line.id, ticket.id, line.productId, line.productName, line.variantId, line.variantName, line.categoryId, line.categoryName,
          line.catalogTabId, line.catalogTabName, line.saleFormatId, line.saleFormatName, quantity, line.lineTotalCents, JSON.stringify(line.modifiers)])
      for (const c of line.components) await db.query('insert into ticket_line_components values ($1,$2,$3,$4,$5,$6,$7)',
        [c.id, line.id, c.type, c.productId, c.productName, c.quantity, c.priceDeltaCents])
    }
  }
  // Large values outside the requested venue/tenant/status must not leak into groups.
  for (let i = 0; i < 3; i++) {
    await db.query(`insert into tickets(id, tenant_id, venue_id, local_created_at, status, total_cents)
      values ($1,$2,$3,'2026-09-10',$4,999999)`, [uuid(4, 900 + i), i === 0 ? uuid(1, 2) : tenant, i === 1 ? uuid(2, 2) : venue, i === 2 ? 'void' : 'paid'])
    await db.query(`insert into ticket_lines(id,ticket_id,product_id,product_name,variant_name,quantity,line_total_cents,modifiers)
      values ($1,$1,$2,'Café ajeno','Normal',1,999999,'[]')`, [uuid(4, 900 + i), uuid(3, 1)])
  }
})
after(() => db.close())

async function page(view, pageNumber = 1, options = {}) {
  const { rows } = await db.query(`select public.crm_sales_report_aggregate_page(
    p_tenant_id => $1, p_venue_id => $2, p_view => $3, p_page => $4,
    p_product_query => $5, p_category_query => $6, p_sort_key => $7, p_sort_direction => $8,
    p_date_from => $9, p_date_to => $10, p_discount_filter => $11) as result`,
  [options.tenant ?? tenant, options.venue ?? venue, view, pageNumber, options.product ?? 'cafe', options.category ?? '',
    options.sort ?? 'totalCents', options.direction ?? 'desc', options.from ?? null, options.to ?? null, options.discount ?? 'all'])
  return rows[0].result
}

test('the additive migration follows deployment rules and preserves caller RLS', async () => {
  assert.deepEqual(analyzeMigration(migration), [])
  const { rows: [routine] } = await db.query(`select prosecdef, has_function_privilege('anon', oid, 'execute') as anonymous
    from pg_proc where proname = 'crm_sales_report_aggregate_page'`)
  assert.equal(routine.prosecdef, false)
  assert.equal(routine.anonymous, false)
})

for (const view of ['products', 'variants', 'categories', 'formats', 'tabs', 'mixers', 'menu-components', 'modifiers']) {
  test(`${view}: return only 12 matching groups and retain complete totals across tickets`, async () => {
    const first = await page(view)
    const second = await page(view, 2)
    const last = await page(view, 3)
    assert.equal(first.totalResults, 31)
    assert.equal(first.items.length, 12)
    assert.equal(second.items.length, 12)
    assert.equal(last.items.length, 7)
    const actual = [...first.items, ...second.items, ...last.items]
    assert.equal(new Set(actual.map(({ id }) => id)).size, 31)
    const expected = buildSalesReportAggregates(tickets, view, 'cafe', '').sort((a, b) => b.totalCents - a.totalCents)
    assert.deepEqual(actual, expected)
    assert.deepEqual((await page(view, 999)).items, last.items)
  })
}

test('product/category/date/discount filters apply before pagination, with correct empty counts', async () => {
  const first = await page('products', 1, { product: 'cafe 1' })
  assert.equal(first.totalResults, 10)
  assert.equal(first.items.length, 10)
  assert.ok(first.items.every(({ label }) => label.startsWith('Café 1')))
  assert.equal((await page('products', 1, { category: 'categoria 05' })).totalResults, 1)
  for (const options of [{ product: 'no-match' }, { from: '2026-09-11' }, { to: '2026-09-10' }, { discount: 'with' }]) {
    assert.deepEqual(await page('products', 1, options), { items: [], totalResults: 0 })
  }
  assert.equal((await page('products', 1, { discount: 'without' })).totalResults, 31)
})

test('ordering is applied to the entire matching set before the twelve-row limit', async () => {
  for (const sort of ['label', 'average', 'totalCents']) {
    const first = await page('products', 1, { sort, direction: 'asc' })
    assert.equal(first.items[0].label, 'Café 01')
    assert.equal(first.items[11].label, 'Café 12')
    assert.equal((await page('products', 2, { sort, direction: 'asc' })).items[0].label, 'Café 13')
  }
})

test('the original ticket RPC also filters before returning just twelve matching IDs', async () => {
  const { rows } = await db.query(`select * from public.crm_sales_report_ticket_page(
    p_tenant_id => $1, p_venue_id => $2, p_product_query => 'cafe 1', p_page_size => 12, p_include_summary => false)`, [tenant, venue])
  assert.equal(rows.length, 12)
  assert.equal(Number(rows[0].total_count), 20)
  const matching = new Set(tickets.filter((t) => t.lines[0].productName.startsWith('Café 1')).map(({ id }) => id))
  assert.ok(rows.every(({ ticket_id }) => matching.has(ticket_id)))
})

test('discounts are allocated across all ticket lines before filtering a matching line', async () => {
  await db.exec('begin')
  try {
    await db.query(`insert into tickets(id,tenant_id,venue_id,local_created_at,status,total_cents,discount_amount_cents,discount_id)
      values ($1,$2,$3,'2026-09-10','paid',270,30,$4)`, [uuid(4, 1000), tenant, venue, uuid(8, 1000)])
    await db.query(`insert into ticket_lines(id,ticket_id,product_id,product_name,variant_name,quantity,line_total_cents,modifiers)
      values ($1,$3,$4,'Especial descuento','Normal',1,100,'[]'),($2,$3,$5,'Otra línea','Normal',1,200,'[]')`,
    [uuid(4, 1001), uuid(4, 1002), uuid(4, 1000), uuid(3, 1000), uuid(3, 1001)])
    const result = await page('products', 1, { product: 'especial descuento', discount: `id:${uuid(8, 1000)}` })
    assert.equal(result.totalResults, 1)
    assert.equal(result.items[0].totalCents, 90)
    assert.equal(result.items[0].ticketCount, 1)
    assert.equal((await page('products', 1, { product: 'especial descuento', discount: 'without' })).totalResults, 0)
  } finally {
    await db.exec('rollback')
  }
})

test('the RPC honors RLS even when the caller supplies another tenant ID', async () => {
  await db.exec('begin')
  try {
    await db.exec(`
      alter table tickets enable row level security;
      create policy test_tenant on tickets to authenticated using (tenant_id::text = current_setting('app.tenant'));
      grant select on tickets, ticket_lines, ticket_line_components, sales to authenticated;
    `)
    await db.query("select set_config('app.tenant', $1, true)", [tenant])
    await db.exec('set local role authenticated')
    assert.equal((await page('products')).totalResults, 31)
    assert.deepEqual(await page('products', 1, { tenant: uuid(1, 2) }), { items: [], totalResults: 0 })
  } finally {
    await db.exec('rollback')
  }
})
