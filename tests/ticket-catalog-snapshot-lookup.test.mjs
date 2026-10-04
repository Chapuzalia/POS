import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = readFileSync(new URL('../supabase/migrations/20261003203503_optimize_ticket_catalog_snapshot_lookup.sql', import.meta.url), 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const tenant = id(1), venue = id(2), session = id(3), ticket = id(4), order = id(5), product = id(6), variant = id(7)

async function fixture(t) {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create table tickets(id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid);
    create table orders(id uuid primary key, tenant_id uuid, venue_id uuid, cash_session_id uuid);
    create table order_lines(id uuid primary key, tenant_id uuid, venue_id uuid, order_id uuid, product_id uuid, variant_id uuid, unit_price_cents integer, catalog_snapshot jsonb, updated_at timestamptz default now());
    create table offline_event_log(tenant_id uuid, event_kind text, payload jsonb, sale_ticket_id text, sale_cash_session_id text, created_at timestamptz default now());
    create table ticket_lines(id uuid primary key, tenant_id uuid, ticket_id uuid, product_id uuid, variant_id uuid, unit_price_cents integer, source_order_line_id uuid,
      category_id_snapshot uuid, category_name_snapshot text, catalog_tab_id_snapshot uuid, catalog_tab_name_snapshot text,
      base_price_cents integer, component_delta_cents integer, modifier_delta_cents integer, gross_before_discount_cents integer);
    insert into tickets values('${ticket}','${tenant}','${venue}','${session}');
    insert into orders values('${order}','${tenant}','${venue}','${session}');
  `)
  await db.exec(migration)
  await db.exec('create trigger capture_catalog before insert on ticket_lines for each row execute function capture_ticket_line_catalog_snapshot();')
  return db
}

async function source(db, lineId, snapshot, scope = {}) {
  await db.query('insert into order_lines(id,tenant_id,venue_id,order_id,product_id,variant_id,unit_price_cents,catalog_snapshot) values($1,$2,$3,$4,$5,$6,200,$7)',
    [lineId, scope.tenant ?? tenant, scope.venue ?? venue, scope.order ?? order, product, variant, snapshot])
}

async function insert(db, lineId, sourceId = null) {
  return (await db.query('insert into ticket_lines(id,tenant_id,ticket_id,product_id,variant_id,unit_price_cents,source_order_line_id) values($1,$2,$3,$4,$5,200,$6) returning *',
    [lineId, tenant, ticket, product, variant, sourceId])).rows[0]
}

async function event(db, lineId, fields, scope = {}) {
  await db.query('insert into offline_event_log(tenant_id,event_kind,payload,sale_ticket_id,sale_cash_session_id) values($1,$2,$3,$4,$5)',
    [scope.tenant ?? tenant, scope.kind ?? 'sale_created', { ticket: { id: ticket, cashSessionId: session }, lines: [{ id: lineId, ...fields }] }, ticket, scope.session ?? session])
}

test('catalog lookup migration retains the trigger contract and safe deployment rules', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  assert.match(migration, /e\.event_kind = 'sale_created'/)
  assert.match(migration, /e\.sale_ticket_id = new\.ticket_id::text/)
  assert.doesNotMatch(migration, /e\.payload\s*->\s*'ticket'/)
})

test('restaurant uses exact source snapshot even when several orders have the same product', async t => {
  const db = await fixture(t)
  await source(db, id(10), { categoryId: id(11), categoryName: 'Histórica', catalogTabId: id(12), catalogTabName: 'Carta antigua' })
  await source(db, id(13), { categoryName: 'Otra comanda' })
  await event(db, id(20), { catalogSnapshot: { categoryId: 'invalid' } })
  const line = await insert(db, id(20), id(10))
  assert.equal(line.category_id_snapshot, id(11))
  assert.equal(line.category_name_snapshot, 'Histórica')
  assert.equal(line.catalog_tab_id_snapshot, id(12))
  assert.equal(line.catalog_tab_name_snapshot, 'Carta antigua')
  assert.equal(line.base_price_cents, 200)
  assert.equal(line.component_delta_cents, 0)
})

test('empty source snapshot is retained instead of borrowing another historical order', async t => {
  const db = await fixture(t)
  await source(db, id(10), {})
  await source(db, id(13), { categoryName: 'Ajena a la línea' })
  await event(db, id(20), { catalogSnapshot: { categoryId: 'invalid' } })
  assert.equal((await insert(db, id(20), id(10))).category_name_snapshot, null)
})

test('quick sale keeps indexed event snapshot and price breakdown for legacy payloads', async t => {
  const db = await fixture(t)
  await event(db, id(20), { catalogSnapshot: { categoryName: 'Venta rápida' }, basePriceCents: 150, componentDeltaCents: 30, modifierDeltaCents: 20, grossBeforeDiscountCents: 200 })
  const line = await insert(db, id(20))
  assert.equal(line.category_name_snapshot, 'Venta rápida')
  assert.deepEqual([line.base_price_cents, line.component_delta_cents, line.modifier_delta_cents, line.gross_before_discount_cents], [150, 30, 20, 200])
})

test('legacy restaurant fallback accepts one matching historical source and rejects ambiguity', async t => {
  const db = await fixture(t)
  await source(db, id(10), { categoryName: 'Compatible' })
  assert.equal((await insert(db, id(20))).category_name_snapshot, 'Compatible')
  await source(db, id(13), { categoryName: 'Ambigua' })
  assert.equal((await insert(db, id(21))).category_name_snapshot, null)
})

test('source and event lookups exclude other tenants, venues, sessions and event kinds', async t => {
  const db = await fixture(t)
  await source(db, id(10), { categoryName: 'Otro tenant' }, { tenant: id(90) })
  await source(db, id(11), { categoryName: 'Otro local' }, { venue: id(90) })
  await db.query('insert into orders values($1,$2,$3,$4)', [id(91), tenant, venue, id(90)])
  await source(db, id(12), { categoryName: 'Otro turno' }, { order: id(91) })
  for (const sourceId of [id(10), id(11), id(12)]) {
    const lineId = id(Number(sourceId.slice(-12)) + 30)
    await event(db, lineId, { catalogSnapshot: { categoryId: 'invalid' } }, { tenant: id(90) })
    await event(db, lineId, { catalogSnapshot: { categoryId: 'invalid' } }, { session: id(90) })
    await event(db, lineId, { catalogSnapshot: { categoryId: 'invalid' } }, { kind: 'cash_opened' })
    assert.equal((await insert(db, lineId, sourceId)).category_name_snapshot, null)
  }
})
