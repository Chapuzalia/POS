import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const migration = readFileSync(new URL('../../supabase/migrations/20261101215608_optimize_crm_stats_live.sql', import.meta.url), 'utf8')
const previous = readFileSync(new URL('../../supabase/migrations/20261014115222_equal_split_single_ticket.sql', import.meta.url), 'utf8')
const liveSql = previous.slice(previous.indexOf('create or replace function public.crm_stats_live('))
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), foreignTenant = id(2), venue = id(3), otherVenue = id(4)
const start = '2026-11-01T03:00:00Z', end = '2026-11-02T03:00:00Z'
let db: PGlite

interface Session {
  id: string
  venueId: string
  salesCents: number
  ticketCount: number
  cashCents: number
  cardCents: number
  invitationCents: number
  otherCents: number
}
interface Stats {
  dayActivity: { totalCents: number; ticketCount: number; cashCents: number; cardCents: number }
  openCashSessions: Session[]
}
const stats = async (baseline = false, tenantId = tenant, venueId = venue, from = start, to = end) => (
  await db.query<{ result: Stats }>(`select public.crm_stats_live${baseline ? '_baseline' : ''}($1,$2,$3,$4) result`, [tenantId, venueId, from, to])
).rows[0].result

async function enableRls() {
  for (const table of ['tickets', 'sales', 'cash_sessions', 'devices', 'venues']) {
    const venueColumn = table === 'venues' ? 'id' : 'venue_id'
    await db.exec(`alter table ${table} enable row level security;
      create policy scoped_read on ${table} to authenticated using (public.user_is_tenant_admin(tenant_id) or public.user_has_venue_access(tenant_id,${venueColumn}));
      grant select on ${table} to authenticated;`)
  }
  await db.exec(`
    alter table sale_payments enable row level security;
    create policy payment_read on sale_payments for select to authenticated using (
      exists(select 1 from sales s where s.id=sale_payments.sale_id and
        (public.user_is_tenant_admin(s.tenant_id) or public.user_has_venue_access(s.tenant_id,s.venue_id)))
    );
    grant select on sale_payments to authenticated;
    set role authenticated;
  `)
}

beforeEach(async () => {
  db = new PGlite()
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table tickets (id uuid primary key, tenant_id uuid, venue_id uuid, status text, total_cents integer, local_created_at timestamptz);
    create table sales (id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid, payment_method text, total_cents integer, local_created_at timestamptz);
    create table sale_payments (id uuid primary key default gen_random_uuid(), tenant_id uuid, sale_id uuid, method text, amount_cents integer);
    create table cash_sessions (id uuid primary key, tenant_id uuid, venue_id uuid, device_id uuid, status text, opened_at timestamptz, opening_float_cents integer);
    create table venues (id uuid primary key, tenant_id uuid, name text);
    create table devices (id uuid primary key, tenant_id uuid, venue_id uuid, name text);
    create index sales_venue_local_created_idx on sales (tenant_id, venue_id, local_created_at desc);
    create index tickets_venue_local_created_idx on tickets (tenant_id, venue_id, local_created_at desc);
    create index sale_payments_tenant_sale_stats_idx on sale_payments (tenant_id,sale_id) include (method,amount_cents);
    create index cash_sessions_venue_open_register_idx on cash_sessions (tenant_id,venue_id) where status='open';
    create function public.user_is_tenant_admin(uuid) returns boolean language sql stable as $$
      select $1=current_setting('test.tenant')::uuid and current_setting('test.admin')::boolean
    $$;
    create function public.user_has_venue_access(uuid,uuid) returns boolean language sql stable as $$
      select $1=current_setting('test.tenant')::uuid and $2=current_setting('test.venue')::uuid
    $$;
    set test.tenant='${tenant}'; set test.venue='${venue}'; set test.admin='true';
    ${liveSql}
    ${liveSql.replace('public.crm_stats_live(', 'public.crm_stats_live_baseline(')}
    revoke all on function public.crm_stats_live(uuid,uuid,timestamptz,timestamptz) from public,anon;
    grant execute on function public.crm_stats_live(uuid,uuid,timestamptz,timestamptz) to authenticated,service_role;
    insert into venues values ('${venue}','${tenant}','Principal'),('${otherVenue}','${tenant}','Segundo');
    insert into devices values ('${id(6)}','${tenant}','${venue}','Caja 1');
    insert into cash_sessions values
      ('${id(10)}','${tenant}','${venue}','${id(6)}','open','2026-11-01T10:00Z',10000),
      ('${id(11)}','${tenant}','${otherVenue}',null,'open','2026-11-01T09:00Z',0),
      ('${id(12)}','${tenant}','${venue}',null,'open','2026-11-01T08:00Z',0),
      ('${id(13)}','${tenant}','${venue}',null,'closed','2026-10-31T08:00Z',0),
      ('${id(14)}','${foreignTenant}','${id(5)}',null,'open','2026-11-01T11:00Z',0);
  `)
  const sale = async (n: number, total: number, method: string | null, session = 10, timestamp = start, tenantId = tenant, venueId = venue) => {
    await db.query('insert into sales values ($1,$2,$3,$4,$5,$6,$7)', [id(n), tenantId, venueId, id(session), method, total, timestamp])
    await db.query("insert into tickets values ($1,$2,$3,'paid',$4,$5)", [id(n), tenantId, venueId, total, timestamp])
  }
  for (const [n, total, method] of [
    [100, 1000, 'card'], [101, 300, 'cash'], [102, 200, 'card'], [103, 500, 'cash'],
    [104, 100, null], [105, 100, 'cash'], [106, 0, 'card'], [107, 0, 'invitation'], [108, -200, 'card'],
  ] as const) await sale(n, total, method)
  await sale(109, 600, 'cash', 10, '2026-11-01T02:59:59Z')
  await sale(110, 700, 'card', 10, end)
  await sale(111, 800, 'card', 11, start, tenant, otherVenue)
  await sale(112, 400, 'cash', 13)
  await sale(113, 9000, 'cash', 14, start, foreignTenant, id(5))
  for (const [n, method, amount] of [
    [100, 'cash', 250], [100, 'card', 750], [102, 'cash', 50], [102, 'cash', 150],
    [103, 'voucher', 500], [105, null, 100], [106, 'cash', 0], [107, 'invitation', 0],
  ] as const) await db.query('insert into sale_payments(tenant_id,sale_id,method,amount_cents) values ($1,$2,$3,$4)', [tenant, id(n), method, amount])
  // A foreign tenant's row must neither contribute nor suppress legacy fallback.
  await db.query("insert into sale_payments(tenant_id,sale_id,method,amount_cents) values ($1,$2,'card',90000)", [foreignTenant, id(101)])
  await db.exec(`insert into tickets values ('${id(999)}','${tenant}','${venue}','void',99999,'${start}'); ${migration}`)
})
afterEach(async () => { await db.close() })

describe('live CRM aggregates', () => {
  it('preserves daily snapshots, split tenders, legacy fallback, boundaries and tenant-wide open sessions', async () => {
    const result = await stats()
    expect(result).toEqual(await stats(true))
    expect(result.dayActivity).toEqual({ totalCents: 2400, ticketCount: 10, cashCents: 1150, cardCents: 550 })
    expect(result.openCashSessions.map(s => s.id)).toEqual([id(10), id(11), id(12)])
    expect(result.openCashSessions[0]).toMatchObject({
      salesCents: 3300, ticketCount: 11, cashCents: 1350, cardCents: 1250, invitationCents: 0, otherCents: 700,
    })
    expect(result.openCashSessions[1]).toMatchObject({ venueId: otherVenue, salesCents: 800, ticketCount: 1, cardCents: 800 })
    expect(result.openCashSessions[2]).toMatchObject({ salesCents: 0, ticketCount: 0, cashCents: 0, cardCents: 0, otherCents: 0 })
    for (const args of [[tenant, otherVenue], [foreignTenant, id(5)], [id(99), venue]] as const) {
      expect(await stats(false, ...args)).toEqual(await stats(true, ...args))
    }
  })

  it('returns zeros and an empty array when there is no activity or open session', async () => {
    await db.exec("update cash_sessions set status='closed'")
    const result = await stats(false, tenant, venue, end, end)
    expect(result).toEqual(await stats(true, tenant, venue, end, end))
    expect(result).toEqual({ dayActivity: { totalCents: 0, ticketCount: 0, cashCents: 0, cardCents: 0 }, openCashSessions: [] })
  })

  it('preserves invoker RLS for tenant admins and venue-limited users and retains the existing grants', async () => {
    await enableRls()
    expect(await stats()).toEqual(await stats(true))
    expect((await stats()).openCashSessions).toHaveLength(3)
    await db.exec("set test.admin='false'")
    const limited = await stats()
    expect(limited).toEqual(await stats(true))
    expect(limited.openCashSessions.map(s => s.id)).toEqual([id(10), id(12)])
    expect((await stats(false, tenant, otherVenue)).dayActivity.totalCents).toBe(0)
    expect(await stats(false, foreignTenant, id(5))).toEqual({ dayActivity: { totalCents: 0, ticketCount: 0, cashCents: 0, cardCents: 0 }, openCashSessions: [] })
    await db.exec('reset role')
    const [permissions] = (await db.query(`select prosecdef,
      has_function_privilege('authenticated',oid,'execute') authenticated,
      has_function_privilege('service_role',oid,'execute') service_role,
      has_function_privilege('anon',oid,'execute') anon
      from pg_proc where oid='public.crm_stats_live(uuid,uuid,timestamptz,timestamptz)'::regprocedure`)).rows
    expect(permissions).toEqual({ prosecdef: false, authenticated: true, service_role: true, anon: false })
    await db.exec('set role anon')
    await expect(stats()).rejects.toThrow('permission denied')
  })

  it('uses bounded sales lookups when closed-session history grows', async () => {
    await db.exec(`
      insert into sales select gen_random_uuid(),'${tenant}','${venue}','${id(13)}','cash',100,'2026-01-01T12:00Z'
      from generate_series(1,10000);
      insert into sale_payments(tenant_id,sale_id,method,amount_cents)
      select tenant_id,id,payment_method,total_cents from sales where local_created_at='2026-01-01T12:00Z';
      analyze sales; analyze tickets; analyze sale_payments; analyze cash_sessions;
      set plan_cache_mode='force_generic_plan';
    `)
    await enableRls()
    expect(await stats()).toEqual(await stats(true))
    // Explain the function body because EXPLAIN on a non-inlined SQL RPC hides its scans.
    const body = migration.split('$$')[1]
      .replaceAll('p_tenant_id', '$1').replaceAll('p_venue_id', '$2')
      .replaceAll('p_day_start', '$3').replaceAll('p_day_end', '$4')
    await db.exec(`prepare live_stats_plan(uuid,uuid,timestamptz,timestamptz) as ${body}`)
    interface PlanNode {
      'Relation Name'?: string
      'Actual Rows': number
      'Actual Loops': number
      'Rows Removed by Filter'?: number
      Plans?: PlanNode[]
    }
    const [result] = (await db.query<{ 'QUERY PLAN': Array<{ Plan: PlanNode }> }>(
      `explain (analyze,format json) execute live_stats_plan('${tenant}','${venue}','${start}','${end}')`,
    )).rows
    const salesScans: PlanNode[] = []
    const visit = (node: PlanNode) => {
      if (node['Relation Name'] === 'sales') salesScans.push(node)
      node.Plans?.forEach(visit)
    }
    visit(result['QUERY PLAN'][0].Plan)
    expect(salesScans.length).toBeGreaterThan(0)
    const rowsRead = salesScans.reduce((sum, node) => sum +
      (node['Actual Rows'] + (node['Rows Removed by Filter'] ?? 0)) * node['Actual Loops'], 0)
    expect(rowsRead).toBeLessThan(100)
  })
})
