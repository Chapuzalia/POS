import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'
import { createRestaurantControllerHarness, deferred, flush } from './helpers/restaurant-controller-harness.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261003183458_optimize_pos_sale_latency.sql', import.meta.url), 'utf8')
const tenant = '11111111-1111-4111-8111-111111111111'
const venue = '22222222-2222-4222-8222-222222222222'
const otherVenue = '33333333-3333-4333-8333-333333333333'
const ticket = '44444444-4444-4444-8444-444444444444'
const product = '55555555-5555-4555-8555-555555555555'

test('latency migration satisfies expand/N-1 safety rules', () => assert.deepEqual(analyzeMigration(migration), []))

async function database(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role anon; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table offline_event_log(id uuid primary key default gen_random_uuid(), tenant_id uuid, event_kind text, payload jsonb, created_at timestamptz default now());
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, status text);
    create table ticket_lines(id uuid primary key default gen_random_uuid(), tenant_id uuid, ticket_id uuid, product_id uuid, quantity numeric, allocated_quantity numeric, line_total_cents integer);
    create table sale_payments(id uuid default gen_random_uuid(), tenant_id uuid, sale_id uuid, method text, cashlogy_request_id text, cashlogy_transaction_id text);
    create function public.close_order_and_create_sale_v2(uuid,text,integer,jsonb) returns jsonb language plpgsql as $$
    begin
      -- Fixture for the guarded upgrade of the existing routine.
      -- quantity, unit_price_cents, line_total_cents, modifiers
      -- ol.quantity, ol.unit_price_cents,
      return '{}';
    end; $$;
    alter table offline_event_log enable row level security;
    alter table tickets enable row level security;
    alter table ticket_lines enable row level security;
    create policy event_scope on offline_event_log for select to authenticated using (payload->'ticket'->>'venueId'='${venue}');
    create policy ticket_scope on tickets for select to authenticated using (venue_id='${venue}');
    create policy line_scope on ticket_lines for select to authenticated using (exists(select 1 from tickets t where t.id=ticket_id));
    grant usage on schema auth to authenticated;
    grant select on offline_event_log,tickets,ticket_lines to authenticated;
    insert into offline_event_log(tenant_id,event_kind,payload) values('${tenant}','sale_created','{"ticket":{"id":"old","cashSessionId":"session","venueId":"${venue}"}}');
  `)
  for (const statement of migration.split(/(create index concurrently[^;]+;)/i)) {
    if (statement.trim()) await db.exec(statement)
  }
  return db
}

test('scalar keys are backfilled, derived on old-client inserts, and cannot spoof RLS visibility', async t => {
  const db = await database(t)
  assert.equal((await db.query('select sale_ticket_id from offline_event_log')).rows[0].sale_ticket_id, 'old')
  assert.match((await db.query("select pg_get_functiondef('public.close_order_and_create_sale_v2(uuid,text,integer,jsonb)'::regprocedure) as d")).rows[0].d, /quantity, source_order_line_id, unit_price_cents/)
  await db.query(`insert into offline_event_log(tenant_id,event_kind,payload,sale_ticket_id,sale_cash_session_id)
    values($1,'sale_created',$2,'spoof','session')`, [tenant, { ticket: { id: 'hidden', cashSessionId: 'session', venueId: otherVenue } }])
  await db.exec(`set role authenticated; set test.uid='${ticket}';`)
  const rows = (await db.query("select sale_ticket_id from offline_event_log where tenant_id=$1 and event_kind='sale_created' and sale_cash_session_id='session'", [tenant])).rows
  assert.deepEqual(rows.map(row => row.sale_ticket_id), ['old'])
  await db.exec('reset role')
  assert.equal((await db.query("select sale_ticket_id from offline_event_log where payload->'ticket'->>'id'='hidden'")).rows[0].sale_ticket_id, 'hidden')
  await db.exec("update offline_event_log set payload=jsonb_set(payload,'{ticket,id}','\"changed\"') where sale_ticket_id='old'")
  assert.equal((await db.query("select sale_ticket_id from offline_event_log where sale_cash_session_id='session' order by sale_ticket_id")).rows[0].sale_ticket_id, 'changed')
})

test('server stats include more than 1000 lines, preserve cents and deny other venues/tenants/anonymous calls', async t => {
  const db = await database(t)
  await db.query('insert into tickets values($1,$2,$3,\'paid\')', [ticket, tenant, venue])
  await db.query('insert into ticket_lines(tenant_id,ticket_id,product_id,quantity,line_total_cents) select $1,$2,$3,1,200 from generate_series(1,1500)', [tenant,ticket,product])
  await db.exec(`set role authenticated; set test.uid='${ticket}';`)
  const result = (await db.query('select * from pos_product_sales_stats($1,$2)', [tenant,venue])).rows
  assert.equal(Number(result[0].quantity), 1500)
  assert.equal(Number(result[0].total_cents), 300000)
  assert.deepEqual((await db.query('select * from pos_product_sales_stats($1,$2)',[tenant,otherVenue])).rows, [])
  assert.deepEqual((await db.query('select * from pos_product_sales_stats($1,$2)',[otherVenue,venue])).rows, [])
  await db.exec('reset role; set role anon')
  await assert.rejects(db.query('select * from pos_product_sales_stats($1,$2)',[tenant,venue]), /permission denied/)
})

test('card payments skip offline Cashlogy lookup; cash retains historical identity recovery', async t => {
  const db = await database(t)
  await db.exec('create trigger cashlogy before insert on sale_payments for each row execute function apply_cashlogy_identity_from_sale_event()')
  await db.query(`insert into offline_event_log(tenant_id,event_kind,payload) values($1,'sale_created',$2)`,[tenant,{sale:{id:ticket},payment:{cashlogyRequestId:'request',cashlogyTransactionId:'transaction'}}])
  await db.query("insert into sale_payments(tenant_id,sale_id,method) values($1,$2,'card'),($1,$2,'cash')",[tenant,ticket])
  const rows = (await db.query('select method,cashlogy_request_id from sale_payments order by method')).rows
  assert.equal(rows[0].cashlogy_request_id, null)
  assert.equal(rows[1].cashlogy_request_id, 'request')
})

test('confirmed table checkout releases busy before refresh/printing and still reports background failure', async () => {
  const h = createRestaurantControllerHarness()
  await h.render().completePayment('card', null)
  assert.deepEqual(h.calls.busy, [true,false])
  assert.equal(h.order, null)
  h.print.reject(new Error('Printer unavailable'))
  h.queueSync.resolve()
  h.mapRefresh.resolve({ areas: [], tables: [] })
  await flush()
  assert.ok(h.calls.errors.includes('Printer unavailable'))
})

test('table checkout remains locked until the economic RPC confirms', async () => {
  const rpc = deferred()
  const h = createRestaurantControllerHarness({ tableService: { closeRestaurantOrder: () => rpc.promise } })
  const payment = h.render().completePayment('card', null)
  await flush()
  await h.render().completePayment('card', null)
  assert.deepEqual(h.calls.busy, [true])
  rpc.resolve({ requiresConfirmation: false, ticketId: 'ticket', saleId: 'sale', totalCents:600 })
  await payment
  assert.deepEqual(h.calls.busy, [true,false])
  h.print.resolve(); h.queueSync.resolve(); h.mapRefresh.resolve({ areas: [], tables: [] })
  await flush()
})

test('background checkout refresh does not replace the map after changing tenant/session', async () => {
  const h = createRestaurantControllerHarness()
  await h.render().completePayment('card', null)
  let mapsApplied = 0
  h.realtime.setMap = () => { mapsApplied += 1 }
  h.options.context = { ...h.options.context, tenantId: 'another-tenant' }
  h.options.cashSession = { id: 'another-session' }
  h.render()
  h.print.reject(new Error('Old-session printer unavailable'))
  h.queueSync.resolve()
  h.mapRefresh.resolve({ areas: [], tables: [] })
  await flush()
  assert.equal(mapsApplied, 0)
  assert.deepEqual(h.calls.errors.filter(Boolean), [])
})
