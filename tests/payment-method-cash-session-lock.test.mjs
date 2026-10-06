import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261005232109_fix_payment_method_cash_session_lock.sql', import.meta.url), 'utf8')
const original = readFileSync(new URL('../supabase/migrations/20260930170000_safe_payment_method_change.sql', import.meta.url), 'utf8')
const tenant = '11111111-1111-4111-8111-111111111111'
const venue = '22222222-2222-4222-8222-222222222222'
const device = '33333333-3333-4333-8333-333333333333'
const session = '44444444-4444-4444-8444-444444444444'
const sale = '55555555-5555-4555-8555-555555555555'
const ticket = '66666666-6666-4666-8666-666666666666'
const payment = '77777777-7777-4777-8777-777777777777'
const event = '88888888-8888-4888-8888-888888888888'
const user = '99999999-9999-4999-8999-999999999999'
const other = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

test('payment lock migration satisfies expand/N-1 rules', () => {
  assert.deepEqual(analyzeMigration(migration), [])
})

test('payment changes retain RLS while locking read-only cash sessions', async t => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated; create role anon; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('test.uid', true), '')::uuid
    $$;
    create function public.user_has_tenant_access(id uuid) returns boolean language sql stable as $$
      select auth.uid() = '${user}' and id = '${tenant}'
    $$;
    create function public.user_has_device_access(t uuid, v uuid, d uuid) returns boolean language sql stable as $$
      select public.user_has_tenant_access(t) and v = '${venue}' and d = '${device}'
    $$;
    create table public.cash_sessions(id uuid primary key, tenant_id uuid, venue_id uuid, status text);
    create table public.tickets(id uuid primary key, tenant_id uuid, venue_id uuid, device_id uuid, status text);
    create table public.sales(id uuid primary key, tenant_id uuid, ticket_id uuid, cash_session_id uuid, venue_id uuid, device_id uuid, payment_method text, total_cents integer);
    create table public.sale_payments(id uuid primary key, tenant_id uuid, sale_id uuid, method text, amount_cents integer, received_cents integer, change_cents integer, cashlogy_request_id text, cashlogy_transaction_id text);
    create table public.offline_event_log(id uuid primary key default gen_random_uuid(), tenant_id uuid, event_kind text, client_event_id uuid, payload jsonb, unique(tenant_id,client_event_id));
    alter table public.cash_sessions enable row level security;
    alter table public.sales enable row level security;
    alter table public.tickets enable row level security;
    alter table public.sale_payments enable row level security;
    alter table public.offline_event_log enable row level security;
    create policy cash_sessions_select on public.cash_sessions for select to authenticated using(public.user_has_tenant_access(tenant_id));
    create policy sales_select on public.sales for select to authenticated using(public.user_has_tenant_access(tenant_id));
    create policy sales_update on public.sales for update to authenticated using(public.user_has_device_access(tenant_id,venue_id,device_id)) with check(public.user_has_device_access(tenant_id,venue_id,device_id));
    create policy tickets_write on public.tickets to authenticated using(public.user_has_device_access(tenant_id,venue_id,device_id)) with check(public.user_has_device_access(tenant_id,venue_id,device_id));
    create policy payments_write on public.sale_payments to authenticated using(exists(select 1 from public.sales s where s.id=sale_id and public.user_has_device_access(s.tenant_id,s.venue_id,s.device_id))) with check(exists(select 1 from public.sales s where s.id=sale_id and public.user_has_device_access(s.tenant_id,s.venue_id,s.device_id)));
    create policy event_scope on public.offline_event_log to authenticated using(public.user_has_tenant_access(tenant_id)) with check(public.user_has_tenant_access(tenant_id));
    grant usage on schema auth to authenticated;
    grant all on public.cash_sessions, public.sales, public.tickets, public.sale_payments, public.offline_event_log to authenticated;
    insert into public.cash_sessions values('${session}','${tenant}','${venue}','open');
    insert into public.tickets values('${ticket}','${tenant}','${venue}','${device}','paid');
    insert into public.sales values('${sale}','${tenant}','${ticket}','${session}','${venue}','${device}','card',1250);
    insert into public.sale_payments values('${payment}','${tenant}','${sale}','card',1250,null,0,null,null);
    set test.uid='${user}';
  `)
  await db.exec(original.slice(original.indexOf('create or replace function public.change_sale_payment_method_safe(')))
  const change = (eventId = event, tenantId = tenant) => db.query(
    'select public.change_sale_payment_method_safe($1,$2,$3,$4,\'cash\',1250,0)',
    [eventId, tenantId, sale, payment],
  )
  await t.test('reproduces the false closed-session rejection with the deployed invoker RPC', async () => {
    await db.exec('set role authenticated')
    assert.equal((await db.query('select status from public.cash_sessions')).rows[0].status, 'open')
    await assert.rejects(change(), /PAYMENT_METHOD_CASH_SESSION_CLOSED/)
    await db.exec('reset role')
  })
  await db.exec(migration)
  await t.test('changes an open-session payment and keeps amounts and one audit on retries', async () => {
    await db.exec('set role authenticated')
    await change()
    await change()
    const row = (await db.query('select method, amount_cents, received_cents, change_cents from public.sale_payments')).rows[0]
    assert.deepEqual(row, { method: 'cash', amount_cents: 1250, received_cents: 1250, change_cents: 0 })
    assert.deepEqual((await db.query('select payment_method,total_cents from public.sales')).rows[0], { payment_method: 'cash', total_cents: 1250 })
    const events = (await db.query('select payload from public.offline_event_log')).rows
    assert.equal(events.length, 1)
    assert.equal(events[0].payload.audit.previousMethod, 'card')
    assert.equal(events[0].payload.audit.changedBy, user)
    await db.exec('reset role')
  })
  await t.test('never grants direct cash-session writes or makes the main RPC privileged', async () => {
    await db.exec('set role authenticated')
    assert.equal((await db.query("update public.cash_sessions set status='closed' returning id")).rows.length, 0)
    assert.equal((await db.query("select status from public.cash_sessions")).rows[0].status, 'open')
    await db.exec('reset role')
    assert.equal((await db.query("select prosecdef from pg_proc where oid='public.change_sale_payment_method_safe(uuid,uuid,uuid,uuid,text,integer,integer,jsonb,text,text)'::regprocedure")).rows[0].prosecdef, false)
  })
  await t.test('rejects genuinely closed sessions without new audit or payment writes', async () => {
    await db.exec("update public.cash_sessions set status='closed'; set role authenticated")
    await assert.rejects(change(other), /PAYMENT_METHOD_CASH_SESSION_CLOSED/)
    assert.equal((await db.query('select count(*)::integer as n from public.offline_event_log')).rows[0].n, 1)
    await db.exec("reset role; update public.cash_sessions set status='open'")
  })
  await t.test('private lock denies tenant, device and anonymous access', async () => {
    await db.exec('set role authenticated')
    await assert.rejects(change(other, other), /PAYMENT_METHOD_TENANT_ACCESS_DENIED/)
    await assert.rejects(db.query('select pos_private.lock_payment_change_cash_session($1,$2)', [other, sale]), /PAYMENT_METHOD_TENANT_ACCESS_DENIED/)
    await db.exec(`reset role; update public.sales set device_id='${other}'; set role authenticated`)
    await assert.rejects(db.query('select pos_private.lock_payment_change_cash_session($1,$2)', [tenant, sale]), /PAYMENT_METHOD_SALE_ACCESS_DENIED/)
    await assert.rejects(change(other), /PAYMENT_METHOD_SALE_NOT_FOUND/)
    await db.exec(`reset role; update public.sales set device_id='${device}', venue_id='${other}'; set role authenticated`)
    await assert.rejects(db.query('select pos_private.lock_payment_change_cash_session($1,$2)', [tenant, sale]), /PAYMENT_METHOD_SALE_ACCESS_DENIED/)
    await db.exec(`reset role; update public.sales set venue_id='${venue}'; set test.uid=''; set role authenticated`)
    await assert.rejects(db.query('select pos_private.lock_payment_change_cash_session($1,$2)', [tenant, sale]), /PAYMENT_METHOD_TENANT_ACCESS_DENIED/)
    await db.exec('reset role; set role anon')
    await assert.rejects(db.query('select pos_private.lock_payment_change_cash_session($1,$2)', [tenant, sale]), /permission denied/)
    await assert.rejects(change(), /permission denied/)
    await db.exec('reset role')
  })
})
