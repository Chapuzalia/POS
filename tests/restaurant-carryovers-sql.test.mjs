import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), 'utf8')
const baseline = await read('supabase/0.Complete_Database_24-07-26.sql')
const virtual = await read('supabase/migrations/20260814120000_add_session_virtual_restaurant_tables.sql')
const closing = await read('supabase/migrations/20260827120000_add_cashlogy_stacker_collections.sql')
const migration = await read('supabase/migrations/20260907191602_carry_forward_restaurant_orders.sql')
const fn = (source, name) => {
  const match = source.match(new RegExp(`create (?:or replace )?function public\\.${name}\\([\\s\\S]*?\\$\\$;`, 'i'))
  assert.ok(match, name)
  return match[0]
}
const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`
const [tenant, venue, user, device, register, origin, second, third, group, order, sibling, table] = Array.from({ length: 12 }, (_, n) => id(n + 1))

test('carryover executes against PostgreSQL with the existing close accounting and lifecycle triggers', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  const query = async (sql, args = []) => (await db.query(sql, args)).rows
  await db.exec(`
    create role anon; create role authenticated;
    create schema auth; create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table public.tenants(id uuid primary key);
    create table public.venues(id uuid primary key, name text, timezone text, currency_code text);
    create table public.profiles(id uuid primary key, full_name text);
    create table public.devices(id uuid primary key, tenant_id uuid, venue_id uuid, is_active boolean,
      can_close_cash_session boolean, can_take_orders boolean, active_cash_session_id uuid);
    create table public.cash_registers(id uuid primary key, name text);
    create function public.user_has_venue_access(t uuid, v uuid) returns boolean language sql stable as $$
      select auth.uid() = '${user}' and t = '${tenant}' and v = '${venue}' $$;
    create function public.user_has_device_access(t uuid, v uuid, d uuid) returns boolean language sql stable as $$
      select public.user_has_venue_access(t,v) and d = '${device}' $$;
  `)
  // Use the repository's actual table shapes, checks, close and cleanup functions.
  for (const name of ['cash_sessions', 'order_groups', 'orders', 'order_lines', 'order_tables', 'restaurant_tables',
    'cash_session_table_layouts', 'sales', 'tickets', 'sale_payments', 'cash_movements', 'cash_session_stacker_collections',
    'restaurant_order_equal_splits', 'restaurant_order_equal_split_payments', 'ticket_lines', 'order_events']) {
    const tableSql = baseline.match(new RegExp(`CREATE TABLE public\\.${name} \\([\\s\\S]*?\n\\);`))
    assert.ok(tableSql, name)
    await db.exec(tableSql[0])
    const primary = name === 'cash_session_table_layouts' ? 'cash_session_id' : name === 'order_tables' ? 'order_id, table_id, joined_at' : 'id'
    if (!/primary key/i.test(tableSql[0])) await db.exec(`alter table public.${name} add primary key (${primary})`)
  }
  await db.exec('alter table restaurant_tables alter column area_id drop not null; alter table restaurant_tables add column cash_session_id uuid;')
  await db.exec("alter table cash_sessions alter column status set default 'open'")
  await db.exec(`alter table devices add column can_take_payments boolean default true;
    create table device_user_assignments(device_id uuid, tenant_id uuid, venue_id uuid, user_id uuid, is_active boolean);
    insert into device_user_assignments values ('${device}','${tenant}','${venue}','${user}',true);`)
  for (const name of ['pay_restaurant_order_equal_part', 'restaurant_equal_split_to_json', 'record_restaurant_order_event', 'persist_catalog_order_line_draft']) {
    await db.exec(fn(baseline, name))
  }
  await db.exec(fn(closing, 'close_cash_register_session'))
  await db.exec(fn(baseline, 'block_cash_close_with_open_restaurant_orders'))
  await db.exec(fn(baseline, 'guard_equal_split_order_close'))
  await db.exec(fn(baseline, 'clear_closed_cash_session_table_layout'))
  await db.exec(fn(virtual, 'deactivate_closed_session_virtual_tables'))
  await db.exec(fn(virtual, 'get_cash_session_table_layout'))
  await db.exec(`
    create trigger block_close before update of status on cash_sessions for each row execute function block_cash_close_with_open_restaurant_orders();
    create trigger guard_equal_split before update of status on orders for each row execute function guard_equal_split_order_close();
    create trigger clear_layout after update of status on cash_sessions for each row execute function clear_closed_cash_session_table_layout();
    create trigger deactivate_virtual after update of status on cash_sessions for each row execute function deactivate_closed_session_virtual_tables();
  `)
  await db.exec(migration)
  await query("select set_config('test.uid', $1, false)", [user])
  await db.exec(`
    insert into tenants values ('${tenant}'); insert into venues values ('${venue}', 'Local', 'Europe/Madrid', 'EUR');
    insert into auth.users values ('${user}'); insert into profiles values ('${user}', 'Cajero');
    insert into devices(id,tenant_id,venue_id,is_active,can_close_cash_session,can_take_orders,active_cash_session_id)
      values ('${device}','${tenant}','${venue}',true,true,true,'${origin}');
    insert into cash_registers values ('${register}','Caja');
    insert into cash_sessions(id,tenant_id,venue_id,cash_register_id,opened_by,opened_by_device_id,opening_float_cents)
      values ('${origin}','${tenant}','${venue}','${register}','${user}','${device}',1000);
    insert into order_groups(id,tenant_id,venue_id,cash_session_id) values ('${group}','${tenant}','${venue}','${origin}');
    insert into orders(id,tenant_id,venue_id,cash_session_id,cash_register_id,opened_by_user_id,opened_by_device_id,order_group_id,split_sequence)
      values ('${order}','${tenant}','${venue}','${origin}','${register}','${user}','${device}','${group}',1),
      ('${sibling}','${tenant}','${venue}','${origin}','${register}','${user}','${device}','${group}',2);
    insert into restaurant_tables(id,tenant_id,venue_id,cash_session_id,name) values ('${table}','${tenant}','${venue}','${origin}','Virtual 1');
    insert into order_tables(tenant_id,venue_id,order_id,order_group_id,table_id) values ('${tenant}','${venue}','${order}','${group}','${table}');
    select get_cash_session_table_layout('${origin}');
    insert into order_lines(tenant_id,venue_id,order_id,product_name,variant_name,unit_price_cents,quantity,served_quantity,modifiers,note)
      values ('${tenant}','${venue}','${order}','Cafe','Grande',250,4,2,'[{"name":"Leche","priceCents":50}]','Sin azucar');
    -- A partial payment already produced a paid ticket in the original shift.
    insert into tickets(id,tenant_id,cash_session_id,cash_register_id,venue_id,device_id,user_id,status,subtotal_cents,total_cents,local_created_at)
      values ('${id(20)}','${tenant}','${origin}','${register}','${venue}','${device}','${user}','paid',300,300,now());
    insert into sales(id,tenant_id,ticket_id,cash_session_id,cash_register_id,venue_id,device_id,user_id,total_cents,payment_method,local_created_at)
      values ('${id(21)}','${tenant}','${id(20)}','${origin}','${register}','${venue}','${device}','${user}',300,'cash',now());
    insert into sale_payments(tenant_id,sale_id,method,amount_cents) values ('${tenant}','${id(21)}','cash',300);
    insert into restaurant_order_equal_splits(id,tenant_id,venue_id,order_group_id,order_id,total_cents,part_count,paid_parts,paid_cents,default_discount)
      values ('${id(30)}','${tenant}','${venue}','${group}','${order}',1000,2,1,500,
        '{"amountCents":400,"calculationType":"fixed","type":"manual","name":"Descuento guardado","value":400,"storedValue":4}');
  `)
  const carry = (session = origin, payload = {}) => query('select carry_forward_and_close_cash_session($1,$2,$3::jsonb)', [session, device, JSON.stringify(payload)])
  const recover = (session, ids) => query('select recover_restaurant_carryovers($1,$2,$3::uuid[]) as count', [session, device, ids])
  const newSession = async (session) => {
    await query(`insert into cash_sessions(id,tenant_id,venue_id,cash_register_id,opened_by,opened_by_device_id,opening_float_cents)
      values ($1,$2,$3,$4,$5,$6,0)`, [session,tenant,venue,register,user,device])
    await query('update devices set active_cash_session_id=$1', [session])
  }
  const originalLines = await query('select * from order_lines')
  const originalPayments = await query('select * from sale_payments')
  const originalSplit = await query('select * from restaurant_order_equal_splits')
  await t.test('ordinary close refuses open orders; failed carryover rolls back suspension and audit', async () => {
    await assert.rejects(query('select close_cash_register_session($1,$2,$3)', [origin, device, '{}']), /comandas abiertas/)
    await assert.rejects(carry(origin, { finalCashFundCents: -1 }), /Fondo final/)
    assert.equal((await query('select * from restaurant_order_carryovers')).length, 0)
    assert.ok((await query('select status from orders')).every((r) => r.status === 'open'))
  })
  let transfer
  await t.test('only collected money enters the close; identity, lines, payments and group links survive', async () => {
    await carry()
    const [closed] = await query('select * from cash_sessions where id=$1', [origin])
    assert.equal(closed.status, 'closed')
    assert.equal(closed.expected_cash_cents, 1300)
    assert.equal(closed.print_snapshot.summary.totalSalesCents, 300)
    assert.equal(closed.print_snapshot.summary.salesCount, 1)
    assert.deepEqual(await query('select * from order_lines'), originalLines)
    assert.deepEqual(await query('select * from sale_payments'), originalPayments)
    assert.deepEqual(await query('select * from restaurant_order_equal_splits'), originalSplit)
    assert.ok((await query('select status from orders')).every((r) => r.status === 'carried_forward'))
    assert.equal((await query('select * from order_tables where released_at is null')).length, 1)
    ;[transfer] = await query('select * from restaurant_order_carryovers')
    assert.deepEqual(transfer.order_ids, [order, sibling])
    await carry()
    assert.equal((await query('select * from restaurant_order_carryovers')).length, 1)
  })
  await t.test('suspended orders reject edits and payments, including an old revision', async () => {
    await assert.rejects(query('select persist_catalog_order_line_draft($1,0,\'[]\')', [order]), /CATALOG_ORDER_NOT_FOUND/)
    await assert.rejects(query('select pay_restaurant_order_equal_part($1,\'card\',null,true)', [id(30)]), /Division no disponible/)
  })
  await t.test('recovery restores the same virtual table and both split orders exactly once', async () => {
    await newSession(second)
    const competing = await Promise.all([recover(second, [transfer.id]), recover(second, [transfer.id])])
    assert.deepEqual(competing.map((rows) => rows[0].count).sort(), [0, 2])
    assert.equal((await recover(second, [transfer.id]))[0].count, 0)
    assert.deepEqual(await query('select * from order_lines'), originalLines)
    const [virtualTable] = await query('select * from restaurant_tables')
    assert.equal(virtualTable.id, table)
    assert.equal(virtualTable.is_active, true)
    assert.equal(virtualTable.cash_session_id, second)
    assert.ok((await query('select * from orders')).every((r) => r.status === 'open' && r.cash_session_id === second && r.revision === 2))
    assert.equal((await query('select cash_session_id from sales'))[0].cash_session_id, origin)
  })
  await t.test('multiple shifts retain a full chain and an old recovery request cannot recover the new transfer', async () => {
    await carry(second)
    await newSession(third)
    assert.equal((await recover(third, [transfer.id]))[0].count, 0)
    const [pending] = await query('select * from restaurant_order_carryovers where recovered_at is null')
    assert.equal((await recover(third, [pending.id]))[0].count, 2)
    const chain = await query('select from_cash_session_id, to_cash_session_id from restaurant_order_carryovers order by carried_at')
    assert.deepEqual(chain, [{ from_cash_session_id: origin, to_cash_session_id: second }, { from_cash_session_id: second, to_cash_session_id: third }])
    assert.deepEqual(await query('select * from order_lines'), originalLines)
    assert.deepEqual(await query('select * from sale_payments'), originalPayments)
  })
  await t.test('invalid IDs, devices and unauthenticated callers cannot mutate carryovers', async () => {
    await assert.rejects(recover(third, [id(999)]), /Traspaso no disponible/)
    await query('update devices set can_close_cash_session=false')
    await assert.rejects(carry(third), /dispositivo/)
    await query("select set_config('test.uid', '', false)")
    await assert.rejects(recover(third, [transfer.id]), /Autenticacion/)
    await query("select set_config('test.uid', $1, false)", [user])
    await query('update devices set can_close_cash_session=true')
  })
  await t.test('the audit is read-only through RLS and private to the venue', async () => {
    await db.exec('grant usage on schema auth to authenticated; set role authenticated')
    assert.equal((await query('select * from restaurant_order_carryovers')).length, 2)
    await assert.rejects(query('update restaurant_order_carryovers set recovered_at=null'), /permission denied/)
    await assert.rejects(query('delete from restaurant_order_carryovers'), /permission denied/)
    await assert.rejects(query('insert into restaurant_order_carryovers default values'), /permission denied/)
    await query("select set_config('test.uid', $1, false)", [id(999)])
    assert.equal((await query('select * from restaurant_order_carryovers')).length, 0)
    await assert.rejects(recover(third, [transfer.id]), /Selecciona una caja/)
    await db.exec('reset role')
    await query("select set_config('test.uid', $1, false)", [user])
  })
  await t.test('the existing equal-part payment charges only the remaining part in the collecting shift', async () => {
    await assert.rejects(query('select persist_catalog_order_line_draft($1,0,\'[]\')', [order]), /REVISION_CONFLICT/)
    const [paid] = await query('select pay_restaurant_order_equal_part($1,\'card\',null,true) as result', [id(30)])
    const [sale] = await query('select * from sales where id=$1', [paid.result.saleId])
    assert.equal(sale.cash_session_id, third)
    assert.equal(sale.total_cents, 300)
    assert.equal((await query('select count(*)::integer as n from sales'))[0].n, 2)
    assert.equal((await query('select status from orders where id=$1', [order]))[0].status, 'paid')
    assert.deepEqual(await query('select * from order_lines'), originalLines)
    await carry(third)
    const [closed] = await query('select * from cash_sessions where id=$1', [third])
    assert.equal(closed.expected_card_cents, 300)
    assert.equal(closed.expected_cash_cents, 0)
    assert.equal(closed.print_snapshot.summary.totalSalesCents, 300)
  })
})
