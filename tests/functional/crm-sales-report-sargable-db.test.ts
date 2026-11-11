import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const helpers = read('20260901130000_paginate_crm_sales_reports.sql')
const migration = read('20261111190000_speed_up_crm_sales_and_z_reports.sql')
const previous = {
  crm_sales_report_ticket_page: read('20261005205620_optimize_crm_sales_report_queries.sql'),
  crm_sales_report_summary: read('20261005205620_optimize_crm_sales_report_queries.sql'),
  crm_sales_report_aggregate_page: read('20260913160716_paginate_crm_sales_aggregates.sql'),
  crm_sales_report_filter_suggestions: read('20261005203834_crm_sales_report_filter_suggestions.sql'),
}
// The deployed definitions, renamed, are the behavioural baseline.
const baselineSql = Object.entries(previous).map(([name, sql]) => {
  const start = sql.lastIndexOf('create', sql.indexOf(`function public.${name}(`))
  return sql.slice(start, sql.indexOf('$$;', start) + 3).replace(`public.${name}(`, `public.${name}_baseline(`)
}).join('\n')

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2), otherVenue = id(3), foreignTenant = id(4), discount = id(5)
const from = '2026-10-01T04:00:00Z', to = '2026-10-08T04:00:00Z'
let db: PGlite

type Options = { tenant?: string; venue?: string | null; from?: string | null; to?: string | null; product?: string | null; category?: string | null; discount?: string }
const base = (o: Options) => [o.tenant ?? tenant, o.venue === undefined ? venue : o.venue, o.from === undefined ? from : o.from, o.to === undefined ? to : o.to]
const call = async (sql: string, values: unknown[]) => (await db.query(sql, values)).rows

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role service_role; create role anon;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz not null, created_at timestamptz default now(),
      status text, total_cents integer, discount_id uuid, discount_name text, discount_amount_cents integer);
    create index tickets_tenant_idx on tickets (tenant_id, created_at desc);
    create index tickets_venue_local_created_idx on tickets (tenant_id, venue_id, local_created_at desc);
    create table sales(id uuid primary key, ticket_id uuid, payment_method text, created_at timestamptz);
    create index sales_ticket_idx on sales (ticket_id);
    create table ticket_lines(id uuid primary key, tenant_id uuid, ticket_id uuid, product_id uuid, variant_id uuid, variant_name text,
      product_name text, category_id_snapshot uuid, category_name_snapshot text, catalog_tab_id_snapshot uuid, catalog_tab_name_snapshot text,
      sale_format_id uuid, sale_format_name_snapshot text, quantity integer, allocated_quantity numeric, line_total_cents integer,
      tax_rate numeric, taxable_base_cents integer, tax_amount_cents integer, modifiers jsonb);
    create index ticket_lines_ticket_idx on ticket_lines (ticket_id, id);
    create table ticket_line_components(id uuid primary key default gen_random_uuid(), ticket_line_id uuid, component_type text,
      product_id uuid, product_name_snapshot text, quantity numeric, price_delta_cents integer);
    create table cash_sessions(id uuid primary key, tenant_id uuid, venue_id uuid, status text, closed_at timestamptz);
    ${helpers}
    ${[...new Set(Object.values(previous))].join('\n')}
    ${baselineSql}
  `)
  let n = 10
  const ticket = async (o: { at: string; status?: string; total: number; venueId?: string; tenantId?: string; discountCents?: number; method?: string | null; lines: Array<[string, string | null, number, number, number | null]> }) => {
    n += 1
    const ticketId = id(n)
    await db.query('insert into tickets(id,tenant_id,venue_id,local_created_at,status,total_cents,discount_id,discount_name,discount_amount_cents) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [
      ticketId, o.tenantId ?? tenant, o.venueId ?? venue, o.at, o.status ?? 'paid', o.total,
      o.discountCents ? discount : null, o.discountCents ? 'Promo' : null, o.discountCents ?? 0,
    ])
    if (o.method !== null) await db.query('insert into sales values($1,$2,$3,$4)', [id(n + 1000), ticketId, o.method ?? 'card', o.at])
    for (const [product, category, quantity, total, taxRate] of o.lines) {
      n += 1
      await db.query(`insert into ticket_lines(id,tenant_id,ticket_id,product_id,product_name,category_name_snapshot,variant_name,quantity,line_total_cents,tax_rate,taxable_base_cents,tax_amount_cents,modifiers)
        values($1,$2,$3,$4,$5,$6,'Normal',$7,$8,$9,$10,$11,$12)`, [
        id(n + 2000), o.tenantId ?? tenant, ticketId, product === 'Borrado' ? null : id(product.length + 9000), product, category, quantity, total,
        taxRate, taxRate === null ? null : Math.round(total / (1 + taxRate / 100)), taxRate === null ? null : total - Math.round(total / (1 + taxRate / 100)),
        JSON.stringify(product === 'Café' ? [{ name: 'Leche avena', priceCents: 30 }] : []),
      ])
    }
  }
  await ticket({ at: '2026-10-02T12:00:00Z', total: 1000, discountCents: 100, lines: [['Café', 'Bebidas', 2, 700, 10], ['Bocadillo', 'Comida', 1, 400, 10]] })
  await ticket({ at: '2026-10-03T12:00:00Z', total: 0, method: 'invitation', lines: [['Agua', null, 1, 200, 21]] })
  await ticket({ at: '2026-10-03T13:00:00Z', status: 'void', total: 600, method: 'cash', lines: [['Agua', 'Bebidas', 3, 600, 21]] })
  await ticket({ at: '2026-10-04T12:00:00Z', total: 777, method: null, lines: [['Borrado', 'Bebidas', 1, 777, null]] })
  await ticket({ at: from, total: 300, method: 'cash', lines: [['Café', 'Bebidas', 1, 300, 10]] })
  await ticket({ at: to, total: 500, lines: [['Café', 'Bebidas', 1, 500, 10]] })
  await ticket({ at: '2026-09-30T12:00:00Z', total: 450, lines: [['Agua', 'Bebidas', 1, 450, 21]] })
  await ticket({ at: '2026-10-05T12:00:00Z', total: 900, venueId: otherVenue, lines: [['Café', 'Bebidas', 3, 900, 10]] })
  await ticket({ at: '2026-10-05T12:00:00Z', total: 5000, tenantId: foreignTenant, lines: [['Café', 'Bebidas', 5, 5000, 10]] })
  await db.exec(migration)
})
afterEach(async () => { await db.close() })

const scopes: Options[] = [
  {}, { venue: null }, { venue: otherVenue }, { from: null }, { to: null }, { from: null, to: null }, { venue: null, from: null, to: null },
  { tenant: foreignTenant, venue: null }, { tenant: id(99) }, { from: to, to: from },
]
const filters: Options[] = [{}, { discount: 'with' }, { discount: 'without' }, { discount: `id:${discount}` }, { product: 'cafe' }, { category: 'sin categoria' }]

describe('index-friendly CRM sales report RPCs', () => {
  it('return exactly the deployed results for every scope, filter, sort and page', async () => {
    for (const scope of scopes) {
      for (const filter of filters) {
        const o = { ...scope, ...filter }
        const reportArgs = [...base(o), o.product ?? null, o.category ?? null, o.discount ?? 'all']
        for (const sort of ['createdAt', 'quantity', 'paymentMethod', 'totalCents']) {
          for (const page of [1, 2]) {
            const args = [...reportArgs, sort, 'desc', page, 2, true]
            const sql = (name: string) => `select * from public.${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`
            expect(await call(sql('crm_sales_report_ticket_page'), args), JSON.stringify({ o, sort, page }))
              .toEqual(await call(sql('crm_sales_report_ticket_page_baseline'), args))
          }
        }
        const summarySql = (name: string) => `select * from public.${name}($1,$2,$3,$4,$5,$6,$7)`
        expect(await call(summarySql('crm_sales_report_summary'), reportArgs)).toEqual(await call(summarySql('crm_sales_report_summary_baseline'), reportArgs))
        for (const view of ['products', 'categories', 'variants', 'modifiers']) {
          const args = [base(o)[0], base(o)[1], view, base(o)[2], base(o)[3], o.product ?? null, o.category ?? null, o.discount ?? 'all', 'totalCents', 'desc', 1]
          const sql = (name: string) => `select public.${name}($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) result`
          expect(await call(sql('crm_sales_report_aggregate_page'), args), JSON.stringify({ o, view }))
            .toEqual(await call(sql('crm_sales_report_aggregate_page_baseline'), args))
        }
      }
      const suggestionArgs = [...base(scope), null, null]
      const sql = (name: string) => `select public.${name}($1,$2,$3,$4,$5,$6) result`
      expect(await call(sql('crm_sales_report_filter_suggestions'), suggestionArgs)).toEqual(await call(sql('crm_sales_report_filter_suggestions_baseline'), suggestionArgs))
    }
    // Sanity check that the fixture exercises real data rather than comparing empty sets.
    const [summary] = await call('select * from public.crm_sales_report_summary($1,$2,$3,$4)', base({}))
    expect(Number(summary.paid_ticket_count)).toBe(4)
  })

  it('reach tickets through the venue/date index instead of scanning the table', async () => {
    await db.exec(`
      insert into tickets(id,tenant_id,venue_id,local_created_at,status,total_cents)
      select gen_random_uuid(), case when g % 2 = 0 then '${foreignTenant}'::uuid else '${tenant}'::uuid end, '${venue}',
        timestamptz '2026-10-01' - g * interval '1 minute', 'paid', 100 from generate_series(1, 20000) g;
      analyze;
      set plan_cache_mode = force_generic_plan;
    `)
    // Rows Postgres read from tickets, through any scan or index.
    const ticketRowsRead = async () => {
      await db.query('select pg_stat_force_next_flush()')
      const [row] = await call("select coalesce(seq_tup_read, 0) + coalesce(idx_tup_fetch, 0) as rows from pg_stat_user_tables where relname = 'tickets'", [])
      return Number(row.rows)
    }
    const measure = async (sql: string) => {
      const before = await ticketRowsRead()
      await call(sql, base({}))
      return await ticketRowsRead() - before
    }
    // Only the handful of in-range tickets, not the tenant's 10k-row history.
    expect(await measure('select * from public.crm_sales_report_ticket_page($1,$2,$3,$4)')).toBeLessThan(100)
    expect(await measure('select * from public.crm_sales_report_summary($1,$2,$3,$4)')).toBeLessThan(100)
    expect(await measure("select public.crm_sales_report_aggregate_page($1,$2,'products',$3,$4)")).toBeLessThan(100)
    expect(await measure('select public.crm_sales_report_filter_suggestions($1,$2,$3,$4)')).toBeLessThan(100)
    expect(await measure('select * from public.crm_sales_report_ticket_page_baseline($1,$2,$3,$4)')).toBeGreaterThan(5000)
  })

  it('keeps invoker security and authenticated-only grants', async () => {
    const rows = await call(`select p.proname, p.prosecdef,
      has_function_privilege('authenticated', p.oid, 'execute') authenticated,
      has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p where p.proname in ('crm_sales_report_summary','crm_sales_report_aggregate_page','crm_sales_report_filter_suggestions') order by 1`, [])
    expect(rows).toEqual(['crm_sales_report_aggregate_page', 'crm_sales_report_filter_suggestions', 'crm_sales_report_summary']
      .map(proname => ({ proname, prosecdef: false, authenticated: true, anon: false })))
  })
})
