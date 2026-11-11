import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(`../../supabase/migrations/${name}`, import.meta.url), 'utf8').split('\r\n').join('\n')
// One function definition out of a migration that also touches unrelated objects.
const extractFunction = (file: string, signatureStart: string) => {
  const source = read(file)
  const start = source.indexOf(signatureStart)
  const end = source.indexOf('$$;', source.indexOf('as $$', start)) + 3
  if (start < 0 || end < 3) throw new Error(`${signatureStart} not found in ${file}`)
  return source.slice(start, end)
}
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2), otherVenue = id(3), foreignTenant = id(4)
const from = '2026-11-01T03:00:00Z', to = '2026-12-01T03:00:00Z'
const rpcs = ['crm_stats_period', 'crm_stats_live', 'pos_product_sales_stats']
let db: PGlite

const rows = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows
// Every stats RPC for one tenant/venue; "suffix" selects the previous invoker definitions.
const readAll = async (tenantId: string, venueId: string, suffix = '') => ({
  period: await rows(`select public.crm_stats_period${suffix}($1,$2,'month','2026-11-01','2026-11-30','2026-11-30',$3,$4,'Europe/Madrid','03:00') result`, [tenantId, venueId, from, to]),
  live: await rows(`select public.crm_stats_live${suffix}($1,$2,$3,$4) result`, [tenantId, venueId, '2026-11-10T03:00:00Z', '2026-11-11T03:00:00Z']),
  products: await rows(`select * from public.pos_product_sales_stats${suffix}($1,$2)`, [tenantId, venueId]),
})
const openSessionIds = async (tenantId: string, venueId: string) => {
  const [{ result }] = await rows('select public.crm_stats_live($1,$2,$3,$4) result', [tenantId, venueId, from, to])
  return (result.openCashSessions as Array<{ id: string }>).map(session => session.id).sort()
}
const grantAccess = (kind: 'admin' | 'gestor' | 'cashier', venueId: string | null = null, tenantId = tenant) =>
  db.query('insert into access_stub values ($1,$2,$3)', [tenantId, kind, venueId])

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role authenticated; create role service_role; create role anon;
    create schema auth; create function auth.uid() returns uuid language sql stable as $$ select '${id(500)}'::uuid $$;
    create table public.tickets(id uuid primary key, tenant_id uuid, venue_id uuid, local_created_at timestamptz not null,
      status text, total_cents integer, discount_id uuid, discount_name text, discount_amount_cents integer);
    create table public.ticket_lines(id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_id uuid, product_id uuid,
      product_name text, category_id_snapshot uuid, category_name_snapshot text, quantity integer, allocated_quantity numeric,
      line_total_cents integer, modifiers jsonb);
    create table public.ticket_line_components(id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_line_id uuid,
      component_type text, product_name_snapshot text);
    create table public.sales(id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid, local_created_at timestamptz,
      payment_method text, total_cents integer);
    create table public.sale_payments(id uuid primary key default gen_random_uuid(), tenant_id uuid, sale_id uuid, method text, amount_cents integer);
    create table public.cash_sessions(id uuid primary key, tenant_id uuid, venue_id uuid, device_id uuid, status text,
      opened_at timestamptz, opening_float_cents integer);
    create table public.venues(id uuid primary key, tenant_id uuid, name text);
    create table public.devices(id uuid primary key, tenant_id uuid, name text);
    -- Stand-ins for the RLS helpers: the signed-in user's grants per tenant.
    create table public.access_stub(tenant_id uuid, kind text, venue_id uuid);
    create function public.user_is_tenant_admin(t uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = 'admin') $$;
    create function public.user_has_tenant_role(t uuid, roles text[]) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = any(roles)) $$;
    create function public.user_has_venue_access(t uuid, v uuid) returns boolean language sql stable as
      $$ select exists (select 1 from public.access_stub a where a.tenant_id = t and a.kind = 'cashier' and a.venue_id = v) $$;
    ${read('20261015120000_optimize_crm_stats_period.sql')}
    ${read('20261101215608_optimize_crm_stats_live.sql')}
    ${extractFunction('20261003183458_optimize_pos_sale_latency.sql', 'create or replace function public.pos_product_sales_stats(')};
    ${extractFunction('20261111200000_check_crm_sales_access_once_per_call.sql', 'create function public.crm_can_read_venue_sales(')}
  `)
  // Keep the deployed invoker definitions (unrestricted here: PGlite runs without RLS) as the full-access baseline.
  for (const name of rpcs) {
    const [{ signature }] = await rows(`select oid::regprocedure::text signature from pg_proc where proname = $1`, [name])
    await db.exec(`alter function ${signature} rename to ${name}_invoker`)
  }
  let n = 10
  const sell = async (tenantId: string, venueId: string, sessionId: string, total: number, method = 'card') => {
    n += 1
    await db.query(`insert into tickets(id,tenant_id,venue_id,local_created_at,status,total_cents,discount_amount_cents)
      values($1,$2,$3,'2026-11-10T12:00:00Z','paid',$4,0)`, [id(n), tenantId, venueId, total])
    await db.query(`insert into ticket_lines(tenant_id,ticket_id,product_id,product_name,category_name_snapshot,quantity,line_total_cents,modifiers)
      values($1,$2,$3,'Café','Bebidas',1,$4,'[]')`, [tenantId, id(n), id(9000), total])
    await db.query(`insert into sales values($1,$2,$3,$4,'2026-11-10T12:00:00Z',$5,$6)`, [id(n + 1000), tenantId, venueId, sessionId, method, total])
    await db.query('insert into sale_payments(tenant_id,sale_id,method,amount_cents) values($1,$2,$3,$4)', [tenantId, id(n + 1000), method, total])
  }
  const openSession = (sessionId: string, tenantId: string, venueId: string) =>
    db.query(`insert into cash_sessions values($1,$2,$3,null,'open','2026-11-10T08:00:00Z',10000)`, [sessionId, tenantId, venueId])
  await openSession(id(300), tenant, venue); await openSession(id(301), tenant, otherVenue); await openSession(id(302), foreignTenant, venue)
  await sell(tenant, venue, id(300), 1000); await sell(tenant, venue, id(300), 450, 'cash')
  await sell(tenant, otherVenue, id(301), 900)
  await sell(foreignTenant, venue, id(302), 5000)
  await db.exec(read('20261111210000_check_crm_stats_access_once_per_call.sql'))
})
afterEach(async () => { await db.close() })

describe('CRM statistics and POS product stats check access once per call', () => {
  it('return the previous results to tenant admins and gestors', async () => {
    for (const kind of ['admin', 'gestor'] as const) {
      await db.exec('delete from access_stub'); await grantAccess(kind)
      for (const venueId of [venue, otherVenue]) {
        expect(await readAll(tenant, venueId), `${kind} ${venueId}`).toEqual(await readAll(tenant, venueId, '_invoker'))
      }
      expect(await openSessionIds(tenant, venue)).toEqual([id(300), id(301)])
    }
    const { period, products } = await readAll(tenant, venue)
    expect(period[0].result.monthSalesCents).toBe(1450)
    expect(products).toEqual([{ product_id: id(9000), quantity: '2', total_cents: 1450 }])
  })

  it('return nothing without access, or with access to another tenant only', async () => {
    const empty = await readAll(id(99), venue, '_invoker')
    expect(await readAll(tenant, venue)).toEqual(empty)
    await grantAccess('admin', null, foreignTenant)
    expect(await readAll(tenant, venue)).toEqual(empty)
    expect(await readAll(foreignTenant, venue)).toEqual(await readAll(foreignTenant, venue, '_invoker'))
  })

  it('limit venue-scoped users to their venues, also for open cash sessions', async () => {
    await grantAccess('cashier', venue)
    // The unrestricted baseline lists every open session, so compare the venue data apart.
    const { live, ...venueData } = await readAll(tenant, venue)
    const { live: baselineLive, ...baselineVenueData } = await readAll(tenant, venue, '_invoker')
    expect(venueData).toEqual(baselineVenueData)
    expect(live[0].result.dayActivity).toEqual(baselineLive[0].result.dayActivity)
    const { live: otherLive, ...otherVenueData } = await readAll(tenant, otherVenue)
    const { live: emptyLive, ...emptyVenueData } = await readAll(id(99), otherVenue, '_invoker')
    expect(otherVenueData).toEqual(emptyVenueData)
    expect(otherLive[0].result.dayActivity).toEqual(emptyLive[0].result.dayActivity)
    expect(await openSessionIds(tenant, venue)).toEqual([id(300)])
    expect(await openSessionIds(tenant, otherVenue)).toEqual([id(300)])
  })

  it('run as definer with authenticated-only execute grants', async () => {
    const result = await rows(`select p.proname, p.prosecdef,
      has_function_privilege('authenticated', p.oid, 'execute') authenticated,
      has_function_privilege('anon', p.oid, 'execute') anon
      from pg_proc p where p.proname = any($1) order by 1`, [rpcs])
    expect(result).toEqual([...rpcs].sort().map(proname => ({ proname, prosecdef: true, authenticated: true, anon: false })))
  })
})
