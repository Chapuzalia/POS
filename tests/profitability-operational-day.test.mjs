import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'
import { analyzeMigration } from '../scripts/check-migrations.mjs'

const migration = await readFile(
  new URL('../supabase/migrations/20260919233403_fix_profitability_timeline_operational_day.sql', import.meta.url),
  'utf8',
)

test('la timeline de rentabilidad usa la zona y el cambio de día del local', () => {
  assert.deepEqual(analyzeMigration(migration), [])
  assert.match(migration, /coalesce\(venue\.timezone, 'Europe\/Madrid'\)/i)
  assert.match(migration, /coalesce\(venue\.day_change_time, time '00:00'\) - time '00:00'/i)
  assert.match(migration, /local_created_at\s+at time zone v_time_zone[\s\S]*?- v_day_change_offset[\s\S]*?::date::text as day/i)
  assert.doesNotMatch(migration, /local_created_at\s+at time zone 'UTC'/i)
})

test('la migración de reemplazo compila como función PostgreSQL', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  await db.exec(migration)
})

test('la clave diaria cambia en la hora local configurada también con horario de verano', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  const operationalDay = async (instant, dayChangeTime) => {
    const { rows } = await db.query(`
      select (
        (
          $1::timestamptz at time zone 'Europe/Madrid'
        ) - (
          coalesce($2::time, time '00:00') - time '00:00'
        )
      )::date::text as day
    `, [instant, dayChangeTime])
    return rows[0].day
  }

  assert.equal(await operationalDay('2026-07-23T01:59:59Z', '04:00'), '2026-07-22')
  assert.equal(await operationalDay('2026-07-23T02:00:00Z', '04:00'), '2026-07-23')
  assert.equal(await operationalDay('2026-12-10T02:59:59Z', '04:00'), '2026-12-09')
  assert.equal(await operationalDay('2026-12-10T03:00:00Z', '04:00'), '2026-12-10')
  assert.equal(await operationalDay('2026-07-22T22:30:00Z', null), '2026-07-23')
})

test('el RPC reúne en una barra las ventas del mismo día operativo', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())

  await db.exec(`
    create function public.user_is_tenant_admin(uuid)
      returns boolean language sql stable as $$ select true $$;
    create function public.user_has_venue_access(uuid, uuid)
      returns boolean language sql stable as $$ select true $$;
    create table public.venues (
      id uuid primary key,
      tenant_id uuid not null,
      timezone text not null,
      day_change_time time without time zone
    );
    create table public.tickets (
      id uuid primary key,
      tenant_id uuid not null,
      venue_id uuid not null,
      status text not null,
      local_created_at timestamptz not null
    );
    create table public.ticket_lines (
      id uuid primary key,
      ticket_id uuid not null,
      tenant_id uuid not null,
      product_id uuid,
      product_name text not null,
      category_id_snapshot uuid,
      category_name_snapshot text,
      allocated_quantity numeric,
      quantity numeric not null,
      taxable_base_cents integer,
      net_total_cents integer not null,
      tax_rate numeric,
      line_total_cents integer not null,
      theoretical_cost_cents integer,
      theoretical_cost_known boolean not null
    );
  `)
  await db.exec(migration)

  const tenantId = '00000000-0000-4000-8000-000000000001'
  const venueId = '00000000-0000-4000-8000-000000000002'
  const productId = '00000000-0000-4000-8000-000000000003'
  await db.query(
    'insert into public.venues values ($1, $2, $3, $4)',
    [venueId, tenantId, 'Europe/Madrid', '04:00'],
  )

  const instants = [
    '2026-07-22T23:00:00Z',
    '2026-07-23T01:59:59Z',
    '2026-07-23T02:00:00Z',
  ]
  for (const [index, instant] of instants.entries()) {
    const ticketId = `00000000-0000-4000-8000-${String(index + 10).padStart(12, '0')}`
    const lineId = `00000000-0000-4000-8000-${String(index + 20).padStart(12, '0')}`
    await db.query(
      'insert into public.tickets values ($1, $2, $3, $4, $5)',
      [ticketId, tenantId, venueId, 'paid', instant],
    )
    await db.query(`
      insert into public.ticket_lines values (
        $1, $2, $3, $4, 'Producto', null, null, null, 1,
        100, 100, 0, 100, 40, true
      )
    `, [lineId, ticketId, tenantId, productId])
  }

  const { rows } = await db.query(`
    select public.crm_profitability_report(
      $1,
      '2026-07-22T02:00:00Z',
      '2026-07-24T02:00:00Z',
      null,
      null
    ) as report
  `, [venueId])

  assert.deepEqual(rows[0].report.timeline.map(({ day, net_sales_cents }) => ({ day, net_sales_cents })), [
    { day: '2026-07-22', net_sales_cents: 200 },
    { day: '2026-07-23', net_sales_cents: 100 },
  ])
})
