import assert from 'node:assert/strict'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { createReservationsControllerHarness } from './helpers/reservations-controller-harness.mjs'

const migration = await readFile(
  new URL('../supabase/migrations/20260909160347_repair_reservation_order_reuse.sql', import.meta.url),
  'utf8',
)

test('a seated reservation only reuses an open linked order', () => {
  assert.match(
    migration,
    /v_reservation\.status = 'seated'[\s\S]*linked_order\.id = v_reservation\.order_id[\s\S]*linked_order\.status = 'open'[\s\S]*return v_reservation\.order_id/i,
  )
  assert.match(migration, /v_reservation\.status not in \('confirmed', 'arrived', 'seated'\)/i)
  assert.match(migration, /v_order_id := public\.open_restaurant_order/i)
  assert.match(migration, /set status = 'seated', order_id = v_order_id/i)
})

test('opening a seated reservation goes through the status-aware service flow', async () => {
  const calls = []
  const harness = createReservationsControllerHarness({ services: {
    seatReservation: async (...args) => { calls.push(args); return 'order-existing' },
  } })
  const reservation = { id: 'reservation-1', orderId: 'order-existing', status: 'seated', tableIds: ['table-1'] }

  const result = await harness.render().seat(reservation)

  assert.equal(result, 'order-existing')
  assert.deepEqual(calls, [['reservation-1', 'cash-session', 'device', null]])
  assert.deepEqual(harness.calls.openOrders, ['order-existing'])
  assert.equal(harness.calls.operationalRefreshes, 1)
})

test('the repair keeps the existing backend guards and least-privilege grants', () => {
  assert.match(migration, /raise exception 'RESERVATION_FORBIDDEN' using errcode = '42501'/i)
  assert.doesNotMatch(migration, /save_catalog_order_lines/i)
  assert.match(migration, /revoke all on function public\.seat_reservation\(uuid, uuid, uuid, uuid\[\]\) from public, anon/i)
  assert.match(migration, /grant execute on function public\.seat_reservation\(uuid, uuid, uuid, uuid\[\]\) to authenticated/i)
})

test('the RPC reuses an open order and replaces cancelled or paid orders atomically', async (context) => {
  const db = new PGlite()
  context.after(() => db.close())
  await db.exec(`
    create role anon;
    create role authenticated;
    create table public.reservations (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      status text not null,
      order_id uuid,
      starts_at timestamptz not null,
      party_size integer not null,
      seated_at timestamptz
    );
    create table public.cash_sessions (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      status text not null
    );
    create table public.venues (id uuid primary key, timezone text not null);
    create table public.restaurant_tables (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      is_active boolean not null
    );
    create table public.reservation_tables (
      reservation_id uuid not null,
      table_id uuid not null,
      tenant_id uuid not null,
      venue_id uuid not null
    );
    create table public.orders (id uuid primary key, status text not null);
    create function public.user_can_manage_reservations(uuid, uuid)
    returns boolean language sql stable as 'select true';
    create function public.open_restaurant_order(uuid[], integer, uuid, uuid)
    returns uuid language plpgsql as $$
    declare created_order_id uuid := gen_random_uuid();
    begin
      insert into public.orders (id, status) values (created_order_id, 'open');
      return created_order_id;
    end;
    $$;
  `)
  await db.exec(migration)

  const tenantId = '10000000-0000-0000-0000-000000000001'
  const venueId = '20000000-0000-0000-0000-000000000001'
  const sessionId = '30000000-0000-0000-0000-000000000001'
  const deviceId = '40000000-0000-0000-0000-000000000001'
  const tableId = '50000000-0000-0000-0000-000000000001'
  const reservationId = '60000000-0000-0000-0000-000000000001'
  const originalOrderId = '70000000-0000-0000-0000-000000000001'
  await db.query(`insert into public.venues values ($1, 'UTC')`, [venueId])
  await db.query(`insert into public.cash_sessions values ($1, $2, $3, 'open')`, [sessionId, tenantId, venueId])
  await db.query('insert into public.restaurant_tables values ($1, $2, $3, true)', [tableId, tenantId, venueId])
  await db.query(`insert into public.orders values ($1, 'open')`, [originalOrderId])
  await db.query(
    `insert into public.reservations
      (id, tenant_id, venue_id, status, order_id, starts_at, party_size, seated_at)
     values ($1, $2, $3, 'seated', $4, now(), 2, now())`,
    [reservationId, tenantId, venueId, originalOrderId],
  )
  await db.query('insert into public.reservation_tables values ($1, $2, $3, $4)', [reservationId, tableId, tenantId, venueId])

  const reused = await db.query(
    'select public.seat_reservation($1, $2, $3, null) as order_id',
    [reservationId, sessionId, deviceId],
  )
  assert.equal(reused.rows[0].order_id, originalOrderId)

  await db.query('update public.orders set status = $1 where id = $2', ['cancelled', originalOrderId])
  const replaced = await db.query(
    'select public.seat_reservation($1, $2, $3, null) as order_id',
    [reservationId, sessionId, deviceId],
  )
  assert.notEqual(replaced.rows[0].order_id, originalOrderId)
  let saved = await db.query('select order_id from public.reservations where id = $1', [reservationId])
  assert.equal(saved.rows[0].order_id, replaced.rows[0].order_id)

  await db.query('update public.orders set status = $1 where id = $2', ['paid', replaced.rows[0].order_id])
  const replacedAgain = await db.query(
    'select public.seat_reservation($1, $2, $3, null) as order_id',
    [reservationId, sessionId, deviceId],
  )
  assert.notEqual(replacedAgain.rows[0].order_id, replaced.rows[0].order_id)
  saved = await db.query('select order_id from public.reservations where id = $1', [reservationId])
  assert.equal(saved.rows[0].order_id, replacedAgain.rows[0].order_id)
})
