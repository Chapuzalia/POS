import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../../supabase/migrations/20261111180000_add_crm_dashboard_period_summary.sql', import.meta.url), 'utf8')
const periodMigration = readFileSync(new URL('../../supabase/migrations/20261015120000_optimize_crm_stats_period.sql', import.meta.url), 'utf8')
const periodSql = periodMigration.slice(periodMigration.indexOf('create or replace function public.crm_stats_period('))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), foreignTenant = id(2), venue = id(3), otherVenue = id(4)
const start = '2026-11-01T03:00:00Z', end = '2026-12-01T03:00:00Z'
let db: PGlite

type Summary = {
  averageTicketCents: number
  monthSalesCents: number
  monthTicketCount: number
  topProducts: Array<{ productName: string; quantity: number; totalCents: number }>
}

const summary = async (tenantId = tenant, venueId = venue, from = start, to = end) => (
  await db.query<{ result: Summary }>('select public.crm_dashboard_period_summary($1,$2,$3,$4) result', [tenantId, venueId, from, to])
).rows[0].result
const fullStats = async (tenantId = tenant, venueId = venue, from = start, to = end) => (
  await db.query<{ result: Summary }>(
    "select public.crm_stats_period($1,$2,'month','2026-11-01','2026-11-30','2026-11-30',$3,$4,'Europe/Madrid','03:00') result",
    [tenantId, venueId, from, to],
  )
).rows[0].result
const pick = ({ averageTicketCents, monthSalesCents, monthTicketCount, topProducts }: Summary) => ({ averageTicketCents, monthSalesCents, monthTicketCount, topProducts })

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table tickets (id uuid primary key, tenant_id uuid, venue_id uuid, status text, total_cents integer, local_created_at timestamptz,
      discount_id uuid, discount_name text, discount_amount_cents integer);
    create table ticket_lines (id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_id uuid, product_id uuid, product_name text,
      category_id_snapshot uuid, category_name_snapshot text, quantity integer, allocated_quantity numeric, line_total_cents integer, modifiers jsonb);
    create table ticket_line_components (id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_line_id uuid, component_type text, product_name_snapshot text);
    create table sales (id uuid primary key, tenant_id uuid, venue_id uuid, payment_method text, total_cents integer, local_created_at timestamptz);
    create table sale_payments (id uuid primary key default gen_random_uuid(), tenant_id uuid, sale_id uuid, method text, amount_cents integer);
    create table cash_sessions (id uuid primary key, tenant_id uuid, venue_id uuid, opened_at timestamptz);
    ${periodSql}
    ${migration}
  `)
  const ticket = async (n: number, total: number, { at = start, status = 'paid', tenantId = tenant, venueId = venue } = {}) =>
    db.query('insert into tickets (id,tenant_id,venue_id,status,total_cents,local_created_at) values ($1,$2,$3,$4,$5,$6)', [id(n), tenantId, venueId, status, total, at])
  const line = async (ticketN: number, productN: number | null, name: string, quantity: number, total: number, allocated: number | null = null, tenantId = tenant) =>
    db.query('insert into ticket_lines (tenant_id,ticket_id,product_id,product_name,quantity,allocated_quantity,line_total_cents) values ($1,$2,$3,$4,$5,$6,$7)',
      [tenantId, id(ticketN), productN === null ? null : id(productN), name, quantity, allocated, total])

  await ticket(100, 1000); await line(100, 50, 'Caña', 2, 600); await line(100, 51, 'Tapa', 1, 400)
  await ticket(101, 450); await line(101, 50, 'Caña', 1, 300); await line(101, null, ' Vino viejo ', 1, 150)
  // Equal split: allocated quantity wins over the raw quantity.
  await ticket(102, 250); await line(102, 51, 'Tapa', 2, 250, 0.5)
  await ticket(103, 99999, { status: 'void' }); await line(103, 50, 'Caña', 50, 99999)
  await ticket(104, 700, { at: '2026-11-01T02:59:59Z' }); await line(104, 50, 'Caña', 7, 700)
  await ticket(105, 800, { at: end }); await line(105, 50, 'Caña', 8, 800)
  await ticket(106, 900, { venueId: otherVenue }); await line(106, 50, 'Caña', 9, 900)
  await ticket(107, 5000, { tenantId: foreignTenant }); await line(107, 50, 'Caña', 5, 5000, null, foreignTenant)
  for (let n = 0; n < 10; n += 1) {
    await ticket(200 + n, 100 + n); await line(200 + n, 60 + n, `Producto ${n}`, 1, 100 + n)
  }
})
afterEach(async () => { await db.close() })

describe('CRM dashboard period summary', () => {
  it('matches the full period stats for month totals and top products', async () => {
    const result = await summary()
    expect(result).toEqual(pick(await fullStats()))
    expect(result).toMatchObject({ monthTicketCount: 13, monthSalesCents: 2745, averageTicketCents: 211 })
    expect(result.topProducts).toHaveLength(8)
    expect(result.topProducts.slice(0, 3)).toEqual([
      { productName: 'Caña', quantity: 3, totalCents: 900 },
      { productName: 'Tapa', quantity: 1.5, totalCents: 650 },
      { productName: 'Vino viejo', quantity: 1, totalCents: 150 },
    ])
  })

  it('keeps tenant and venue scope and returns zeros without activity', async () => {
    expect(await summary(tenant, otherVenue)).toEqual(pick(await fullStats(tenant, otherVenue)))
    expect((await summary(tenant, otherVenue)).monthSalesCents).toBe(900)
    // The foreign tenant's row shares the venue id; it is only visible under its own tenant.
    expect((await summary(foreignTenant, venue)).monthSalesCents).toBe(5000)
    expect(await summary(id(99), venue)).toEqual({ averageTicketCents: 0, monthSalesCents: 0, monthTicketCount: 0, topProducts: [] })
    expect(await summary(tenant, venue, end, end)).toEqual({ averageTicketCents: 0, monthSalesCents: 0, monthTicketCount: 0, topProducts: [] })
  })

  it('runs as invoker with authenticated-only execute grants', async () => {
    const [permissions] = (await db.query(`select prosecdef,
      has_function_privilege('authenticated',oid,'execute') authenticated,
      has_function_privilege('service_role',oid,'execute') service_role,
      has_function_privilege('anon',oid,'execute') anon
      from pg_proc where oid='public.crm_dashboard_period_summary(uuid,uuid,timestamptz,timestamptz)'::regprocedure`)).rows
    expect(permissions).toEqual({ prosecdef: false, authenticated: true, service_role: true, anon: false })
  })
})
