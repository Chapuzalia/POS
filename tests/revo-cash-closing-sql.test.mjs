import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const migration = await readFile(new URL('../supabase/migrations/20260903100000_import_revo_cash_closings.sql', import.meta.url), 'utf8')
const tenant = '00000000-0000-0000-0000-000000000001'
const otherTenant = '00000000-0000-0000-0000-000000000002'
const venue = '00000000-0000-0000-0000-000000000011'
const secondVenue = '00000000-0000-0000-0000-000000000012'
const foreignVenue = '00000000-0000-0000-0000-000000000013'
const owner = '00000000-0000-0000-0000-000000000021'
const manager = '00000000-0000-0000-0000-000000000022'
const staff = '00000000-0000-0000-0000-000000000023'
const day = (date, cashCents = 1250) => ({ date, cashCents, cardCents: 3500, cashTipCents: 50, cardTipCents: 25, rowCount: 3 })

test('la RPC de importación valida permisos y guarda el histórico de forma atómica e idempotente', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
    create table public.tenants(id uuid primary key);
    create table public.venues(id uuid primary key, tenant_id uuid not null references tenants);
    create table public.tenant_memberships(tenant_id uuid, user_id uuid, role text, is_active boolean);
    create table public.manager_venue_assignments(tenant_id uuid, venue_id uuid, manager_user_id uuid);
    create function public.user_has_tenant_role(t uuid, roles text[]) returns boolean language sql stable security definer as $$
      select exists(select 1 from public.tenant_memberships where tenant_id=t and user_id=auth.uid() and role=any(roles) and is_active)
    $$;
    grant usage on schema auth to authenticated;
    grant select on public.manager_venue_assignments to authenticated;
    insert into tenants values ('${tenant}'), ('${otherTenant}');
    insert into venues values ('${venue}','${tenant}'), ('${secondVenue}','${tenant}'), ('${foreignVenue}','${otherTenant}');
    insert into auth.users values ('${owner}'), ('${manager}'), ('${staff}');
    insert into tenant_memberships values ('${tenant}','${owner}','owner',true), ('${tenant}','${manager}','manager',true), ('${tenant}','${staff}','staff',true);
    insert into manager_venue_assignments values ('${tenant}','${venue}','${manager}');
  `)
  await db.exec(migration)
  const query = async (sql, params = []) => (await db.query(sql, params)).rows
  const asUser = async (id) => { await query("select set_config('test.uid', $1, false)", [id ?? '']) }
  const importDays = async (days, target = venue) => (await query('select public.import_revo_cash_closings($1, $2, $3::jsonb) as result', [target, 'Fiscal.csv', JSON.stringify(days)]))[0].result

  await t.test('importa con el local seleccionado, conserva propinas y omite reintentos', async () => {
    await asUser(owner)
    assert.deepEqual(await importDays([day('2026-07-23'), day('2026-07-24')]), { inserted: 2, skipped: 0 })
    assert.deepEqual(await importDays([day('2026-07-23'), day('2026-07-24')]), { inserted: 0, skipped: 2 })
    assert.deepEqual(await importDays([day('2026-07-23')], secondVenue), { inserted: 1, skipped: 0 })
    const [saved] = await query('select * from imported_cash_closings where venue_id=$1 order by business_date', [venue])
    assert.equal(saved.tenant_id, tenant)
    assert.equal(saved.imported_by, owner)
    assert.equal(saved.cash_tip_cents, 50)
    assert.equal(saved.card_tip_cents, 25)
    assert.equal(saved.source_row_count, 3)
    assert.equal(saved.file_name, 'Fiscal.csv')
  })

  await t.test('un solapamiento distinto o una fila inválida revierte también los días nuevos', async () => {
    await assert.rejects(importDays([day('2026-07-25'), day('2026-07-23', 9999)]), /ya está importado con otros importes/)
    assert.equal((await query("select * from imported_cash_closings where business_date='2026-07-25'")).length, 0)
    for (const invalid of [
      { ...day('2026-07-26'), cashCents: null }, { ...day('2026-07-26'), cashCents: '12' },
      { ...day('2026-07-26'), cashCents: 1.25 }, { ...day('2026-07-26'), rowCount: 0 },
      { ...day('2026-07-26'), cardCents: 2147483648 }, day('2026-02-30'), day('1899-01-01'),
    ]) {
      await assert.rejects(importDays([day('2026-07-25'), invalid]))
      assert.equal((await query("select * from imported_cash_closings where business_date='2026-07-25'")).length, 0)
    }
    await assert.rejects(importDays([day('2026-07-25'), day('2026-07-25')]), /una sola vez/)
    await assert.rejects(importDays([]), /entre 1 y/)
    await assert.rejects(importDays({}), /deben ser una lista/)
    await assert.rejects(importDays(null), /deben ser una lista/)
  })

  await t.test('rechaza otros tenants, personal sin permisos, gerentes sin asignación y usuarios inactivos', async () => {
    await assert.rejects(importDays([day('2026-07-25')], foreignVenue), /permiso/)
    await asUser(staff)
    await assert.rejects(importDays([day('2026-07-25')]), /permiso/)
    await asUser(manager)
    await assert.rejects(importDays([day('2026-07-25')], secondVenue), /acceso/)
    assert.deepEqual(await importDays([day('2026-07-25', -200)]), { inserted: 1, skipped: 0 })
    await query('update tenant_memberships set is_active=false where user_id=$1', [manager])
    await assert.rejects(importDays([day('2026-07-26')]), /permiso/)
    await query('update tenant_memberships set is_active=true where user_id=$1', [manager])
    await asUser(null)
    await assert.rejects(importDays([day('2026-07-26')]), /Autenticación/)
  })

  await t.test('RLS limita las lecturas por local y prohíbe escrituras directas', async () => {
    await asUser(manager)
    await db.exec('set role authenticated')
    try {
      const records = await query('select * from imported_cash_closings')
      assert.equal(records.length, 3)
      assert.ok(records.every((record) => record.venue_id === venue))
      await assert.rejects(query('update imported_cash_closings set cash_cents=0'), /permission denied/)
      await assert.rejects(query('delete from imported_cash_closings'), /permission denied/)
      await assert.rejects(query('insert into imported_cash_closings default values'), /permission denied/)
      await assert.rejects(importDays([day('2026-07-26')], secondVenue), /acceso/)
      assert.deepEqual(await importDays([day('2026-07-23')]), { inserted: 0, skipped: 1 })
      await asUser(staff)
      assert.equal((await query('select * from imported_cash_closings')).length, 0)
    } finally { await db.exec('reset role') }
  })

  await t.test('acepta históricos con más de mil días en una sola transacción', async () => {
    await asUser(owner)
    const days = Array.from({ length: 1001 }, (_, index) => day(new Date(Date.UTC(2020, 0, index + 1)).toISOString().slice(0, 10)))
    assert.deepEqual(await importDays(days), { inserted: 1001, skipped: 0 })
    assert.deepEqual(await importDays(days), { inserted: 0, skipped: 1001 })
  })
})
