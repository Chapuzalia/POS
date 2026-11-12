import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8')
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2), otherVenue = id(3), foreignTenant = id(4)
const from = '2026-11-01T03:00:00Z', to = '2026-12-01T03:00:00Z'
const rpcs = ['crm_sales_report_ticket_page', 'crm_sales_report_summary', 'crm_sales_report_aggregate_page', 'crm_sales_report_filter_suggestions', 'crm_dashboard_period_summary']
let db: PGlite

const rows = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows
// Every read RPC for one tenant/venue scope; "suffix" selects the previous invoker definitions.
const readAll = async (tenantId: string, venueId: string | null, suffix = '') => ({
  page: await rows(`select * from public.crm_sales_report_ticket_page${suffix}($1,$2,$3,$4)`, [tenantId, venueId, from, to]),
  summary: await rows(`select * from public.crm_sales_report_summary${suffix}($1,$2,$3,$4)`, [tenantId, venueId, from, to]),
  products: await rows(`select public.crm_sales_report_aggregate_page${suffix}($1,$2,'products',$3,$4) result`, [tenantId, venueId, from, to]),
  suggestions: venueId ? await rows(`select public.crm_sales_report_filter_suggestions${suffix}($1,$2,$3,$4) result`, [tenantId, venueId, from, to]) : null,
  dashboard: venueId ? await rows(`select public.crm_dashboard_period_summary${suffix}($1,$2,$3,$4) result`, [tenantId, venueId, from, to]) : null,
})
const grantAccess = (kind: 'admin' | 'gestor' | 'cashier', venueId: string | null = null, tenantId = tenant) =>
  db.query('insert into access_stub values ($1,$2,$3)', [tenantId, kind, venueId])

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role service_role; create role anon;
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz not null, created_at timestamptz default now(),
      status text, total_cents integer, discount_id uuid, discount_name text, discount_amount_cents integer);
    create table sales(id uuid primary key, ticket_id uuid, payment_method text, created_at timestamptz);
    create table ticket_lines(id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_id uuid, product_id uuid, variant_id uuid, variant_name text,
      product_name text, category_id_snapshot uuid, category_name_snapshot text, catalog_tab_id_snapshot uuid, catalog_tab_name_snapshot text,
      sale_format_id uuid, sale_format_name_snapshot text, quantity integer, allocated_quantity numeric, line_total_cents integer,
      tax_rate numeric, taxable_base_cents integer, tax_amount_cents integer, modifiers jsonb);
    create table ticket_line_components(id uuid primary key default gen_random_uuid(), ticket_line_id uuid, component_type text,
      product_id uuid, product_name_snapshot text, quantity numeric, price_delta_cents integer);
    create table cash_sessions(id uuid primary key, tenant_id uuid, venue_id uuid, status text, closed_at timestamptz);
    -- Stand-ins for the RLS helpers: the signed-in user's grants per tenant.
    create table public.access_stub(tenant_id uuid, kind text, venue_id uuid);
    create function public.user_is_tenant_admin(t uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = 'admin') $$;
    create function public.user_has_tenant_role(t uuid, roles text[]) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = any(roles)) $$;
    create function public.user_has_venue_access(t uuid, v uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = 'cashier' and a.venue_id = v) $$;
    ${read('20260901130000_paginate_crm_sales_reports.sql')}
    ${read('20261111180000_add_crm_dashboard_period_summary.sql')}
    ${read('20261111190000_speed_up_crm_sales_and_z_reports.sql')}
  `)
  // Keep the deployed invoker definitions (unrestricted here: PGlite runs without RLS) as the full-access baseline.
  for (const name of rpcs) {
    const [{ signature }] = await rows(`select oid::regprocedure::text signature from pg_proc where proname = $1`, [name])
    await db.exec(`alter function ${signature} rename to ${name}_invoker`)
  }
  let n = 10
  const ticket = async (tenantId: string, venueId: string, total: number, status = 'paid') => {
    n += 1
    await db.query('insert into tickets(id,tenant_id,venue_id,local_created_at,status,total_cents,discount_amount_cents) values($1,$2,$3,$4,$5,$6,0)',
      [id(n), tenantId, venueId, '2026-11-10T12:00:00Z', status, total])
    await db.query('insert into sales values($1,$2,$3,$4)', [id(n + 1000), id(n), 'card', '2026-11-10T12:00:00Z'])
    await db.query(`insert into ticket_lines(tenant_id,ticket_id,product_id,product_name,category_name_snapshot,variant_name,quantity,line_total_cents,tax_rate,taxable_base_cents,tax_amount_cents,modifiers)
      values($1,$2,$3,'Café','Bebidas','Normal',1,$4,10,$5,$6,'[]')`, [tenantId, id(n), id(9000), total, Math.round(total / 1.1), total - Math.round(total / 1.1)])
  }
  await ticket(tenant, venue, 1000); await ticket(tenant, venue, 450); await ticket(tenant, venue, 600, 'void')
  await ticket(tenant, otherVenue, 900)
  await ticket(foreignTenant, venue, 5000)
  await db.exec(read('20261111200000_check_crm_sales_access_once_per_call.sql'))
})
afterEach(async () => { await db.close() })

describe('CRM sales read RPCs check access once per call', () => {
  it('return the previous results to tenant admins and gestors, venue or tenant wide', async () => {
    for (const kind of ['admin', 'gestor'] as const) {
      await db.exec('delete from access_stub'); await grantAccess(kind)
      for (const venueId of [venue, otherVenue, null]) {
        expect(await readAll(tenant, venueId), `${kind} ${venueId}`).toEqual(await readAll(tenant, venueId, '_invoker'))
      }
    }
    const [summary] = await rows('select * from public.crm_sales_report_summary($1,$2,$3,$4)', [tenant, null, from, to])
    expect(Number(summary.paid_ticket_count)).toBe(3)
  })

  it('return nothing without access, or with access to another tenant only', async () => {
    const empty = await readAll(id(99), venue, '_invoker')
    expect(await readAll(tenant, venue)).toEqual(empty)
    await grantAccess('admin', null, foreignTenant)
    expect(await readAll(tenant, venue)).toEqual(empty)
    expect(await readAll(tenant, null)).toEqual(await readAll(id(99), null, '_invoker'))
    expect(await readAll(foreignTenant, venue)).toEqual(await readAll(foreignTenant, venue, '_invoker'))
  })

  it('limit venue-scoped users to their venues, also on tenant-wide reads', async () => {
    await grantAccess('cashier', venue)
    expect(await readAll(tenant, venue)).toEqual(await readAll(tenant, venue, '_invoker'))
    expect(await readAll(tenant, otherVenue)).toEqual(await readAll(id(99), otherVenue, '_invoker'))
    // Tenant-wide reads include only the assigned venue's tickets.
    const [summary] = await rows('select * from public.crm_sales_report_summary($1,$2,$3,$4)', [tenant, null, from, to])
    const [venueSummary] = await rows('select * from public.crm_sales_report_summary_invoker($1,$2,$3,$4)', [tenant, venue, from, to])
    expect(summary).toEqual(venueSummary)
    const page = await rows('select ticket_id, total_count from public.crm_sales_report_ticket_page($1,$2,$3,$4)', [tenant, null, from, to])
    expect(page).toEqual(await rows('select ticket_id, total_count from public.crm_sales_report_ticket_page_invoker($1,$2,$3,$4)', [tenant, venue, from, to]))
  })

  it('run as definer with authenticated-only execute grants', async () => {
    const result = await rows(`select p.proname, p.prosecdef,
      has_function_privilege('authenticated', p.oid, 'execute') authenticated,
      has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p where p.proname = any($1) order by 1`, [[...rpcs, 'crm_can_read_venue_sales']])
    expect(result).toEqual([...rpcs, 'crm_can_read_venue_sales'].sort()
      .map(proname => ({ proname, prosecdef: true, authenticated: true, anon: false })))
  })
})
