import { PGlite } from '@electric-sql/pglite'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest'
import { createProductionDatabase, readProductionSql, uuid, tenant, venue, pos, kds, destination, order, line } from '../helpers/production-db.mjs'
import type { KdsQueue } from '../../src/features/production/types'

let db: PGlite

beforeAll(async () => {
  db = await createProductionDatabase({ after: afterAll })
  await db.exec(readProductionSql('20261017125631_production_kds_columns_lifecycle'))
  await db.exec(readProductionSql('20261017153230_production_paid_orders_count_as_served'))
  await db.exec(`alter table order_lines add column mixer jsonb;
    alter table production_events add column batch_id uuid, add column production_item_id uuid, add column actor_user_id uuid;
    create function production_table_label_for_line(uuid) returns text language sql as $$ select 'Mesa 7' $$;
    create function production_create_event_dispatch(uuid) returns void language sql as $$ select $$;`)
  const notify = readProductionSql('20260825120000_add_production_domain')
    .match(/create or replace function public\.production_notify_line_change\([\s\S]*?\n\$\$;/)
  if (!notify) throw new Error('Production notification trigger not found')
  await db.exec(notify[0])
  await db.exec(`create trigger notify_note after update of note on order_lines
    for each row execute function production_notify_line_change();`)
  await db.exec(readProductionSql('20261028220358_kds_current_kitchen_comments'))
}, 30_000)

beforeEach(async () => { await db.exec('begin') })
afterEach(async () => { await db.exec('rollback') })

const queue = async (deviceId = kds) => (await db.query<{ value: KdsQueue }>('select get_kds_workflow_queue($1) value', [deviceId])).rows[0].value
const send = async (requestId: string) => db.query('select send_production_batch($1,1,$2,$3,null)', [order, pos, requestId])
const setNote = async (note: string | null) => db.query('update order_lines set note=$1 where id=$2', [note, line])

it('adds the current note to the sent card while preserving its snapshot, quantities and workflow', async () => {
  await send('initial')
  const before = (await queue()).items[0]
  expect(before.snapshot.note).toBeNull()
  await setNote('Sin cebolla\nSalsa aparte')
  const result = await queue()
  expect(result.items[0]).toEqual({ ...before, snapshot: { ...before.snapshot, note: 'Sin cebolla\nSalsa aparte' } })
  expect(result.events[0].payload).toMatchObject({ note: 'Sin cebolla\nSalsa aparte', tableName: 'Mesa 7' })
  expect((await db.query<{ snapshot: { note: string | null } }>('select snapshot from production_items')).rows[0].snapshot.note).toBeNull()
})

it('keeps the latest comment after acknowledging notices, expiry and reload, including explicit removal', async () => {
  await setNote('Original')
  await send('initial')
  await setNote('Sin sal')
  await db.exec("update production_events set created_at=now()-interval '10 hours'")
  await setNote('Salsa aparte')
  const result = await queue()
  expect(result.items[0].snapshot.note).toBe('Salsa aparte')
  for (const event of result.events) await db.query('select acknowledge_kds_event($1,$2)', [kds, event.id])
  expect((await queue()).events).toEqual([])
  expect((await queue()).items[0].snapshot.note).toBe('Salsa aparte')
  await db.exec("update production_events set created_at=created_at-interval '10 hours'")
  expect((await queue()).items[0].snapshot.note).toBe('Salsa aparte')
  await setNote(null)
  expect((await queue()).items[0].snapshot.note).toBeNull()
  expect((await db.query<{ snapshot: { note: string } }>('select snapshot from production_items')).rows[0].snapshot.note).toBe('Original')
})

it('ignores unrelated items, destinations, tenants, venues, event types and events without a note', async () => {
  await setNote('Original')
  await send('initial')
  const itemId = (await queue()).items[0].id
  const addEvent = (id: number, item: string, tenantId: string, venueId: string, destinationId: string, type: string, payload: object) => db.query(`
    insert into production_events(id,production_item_id,tenant_id,venue_id,destination_id,event_type,quantity,payload)
    values($1,$2,$3,$4,$5,$6,1,$7)`, [uuid(id), item, tenantId, venueId, destinationId, type, payload])
  await addEvent(40, uuid(99), tenant, venue, destination, 'modified', { note: 'Other item' })
  await addEvent(41, itemId, uuid(99), venue, destination, 'modified', { note: 'Other tenant' })
  await addEvent(42, itemId, tenant, uuid(99), destination, 'modified', { note: 'Other venue' })
  await addEvent(43, itemId, tenant, venue, uuid(99), 'modified', { note: 'Other destination' })
  await addEvent(44, itemId, tenant, venue, destination, 'cancelled', { note: 'Cancelled' })
  await addEvent(45, itemId, tenant, venue, destination, 'modified', { productName: 'Other change' })
  expect((await queue()).items[0].snapshot.note).toBe('Original')
})

it('preserves KDS access checks and authenticated-only execution', async () => {
  await send('initial')
  await db.exec('savepoint access_check')
  await expect(queue(pos)).rejects.toThrow('Producción no está activa')
  await db.exec('rollback to savepoint access_check')
  await expect(queue(uuid(99))).rejects.toThrow('Producción no está activa')
  await db.exec('rollback to savepoint access_check')
  await db.exec('set role anon')
  await expect(queue()).rejects.toThrow('permission denied')
})
