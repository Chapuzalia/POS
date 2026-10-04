import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { PGlite } from '@electric-sql/pglite'

const base = await readFile(new URL('../supabase/migrations/20260928120000_prepare_local_verifactu_scope.sql', import.meta.url), 'utf8')
const settings = await readFile(new URL('../supabase/migrations/20260928160000_fiscal_pos_bridge_settings.sql', import.meta.url), 'utf8')
const optionalBridge = await readFile(new URL('../supabase/migrations/20260929150000_allow_local_fiscal_without_bridge.sql', import.meta.url), 'utf8')
const aeatEnvironment = await readFile(new URL('../supabase/migrations/20260929180000_add_aeat_environment_setting.sql', import.meta.url), 'utf8')
const ticketQr = await readFile(new URL('../supabase/migrations/20261003140000_add_ticket_qr_print_setting.sql', import.meta.url), 'utf8')

test('CRM bridge metadata is scoped by tenant and rejects non-HTTPS origins', async (t) => {
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`
    create role authenticated;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create table public.tenants (id uuid primary key);
    create table public.venues (id uuid primary key, tenant_id uuid not null);
    create table public.devices (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.cash_registers (id uuid primary key, tenant_id uuid not null, venue_id uuid not null);
    create table public.tickets (id uuid primary key);
    create table public.sales (id uuid primary key);
    create table public.tenant_memberships (tenant_id uuid, user_id uuid, role text, is_active boolean);
    create function public.user_is_tenant_admin(uuid) returns boolean language sql as $$ select true $$;
    create function public.user_has_venue_access(uuid, uuid) returns boolean language sql as $$ select true $$;
    insert into public.tenants values ('11111111-1111-4111-8111-111111111111'), ('22222222-2222-4222-8222-222222222222');
  `)
  await db.exec(base)
  await db.exec(settings)
  await db.exec(optionalBridge)
  await db.exec(aeatEnvironment)
  await db.exec(ticketQr)
  const row = "('11111111-1111-4111-8111-111111111111', 'https://fiscal.example.test/', 'Productor SL', 'B12345678', 'TK', '1.0')"
  await db.exec(`insert into public.fiscal_pos_bridge_settings
    (tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version) values ${row};`)
  const result = await db.query('select tenant_id, bridge_url, producer_nif, aeat_environment from public.fiscal_pos_bridge_settings')
  assert.deepEqual(result.rows, [{ tenant_id: '11111111-1111-4111-8111-111111111111', bridge_url: 'https://fiscal.example.test/', producer_nif: 'B12345678', aeat_environment: 'production' }])
  await db.exec(`update public.fiscal_pos_bridge_settings set aeat_environment = 'test'
    where tenant_id = '11111111-1111-4111-8111-111111111111';`)
  const testEnvironment = await db.query('select aeat_environment from public.fiscal_pos_bridge_settings')
  assert.deepEqual(testEnvironment.rows, [{ aeat_environment: 'test' }])
  const defaultQr = await db.query('select print_ticket_qr from public.fiscal_pos_bridge_settings')
  assert.deepEqual(defaultQr.rows, [{ print_ticket_qr: true }])
  await db.exec(`update public.fiscal_pos_bridge_settings set print_ticket_qr = false
    where tenant_id = '11111111-1111-4111-8111-111111111111';`)
  const disabledQr = await db.query('select print_ticket_qr, aeat_environment from public.fiscal_pos_bridge_settings')
  assert.deepEqual(disabledQr.rows, [{ print_ticket_qr: false, aeat_environment: 'test' }])
  await assert.rejects(db.exec(`update public.fiscal_pos_bridge_settings set aeat_environment = 'sandbox'
    where tenant_id = '11111111-1111-4111-8111-111111111111';`), /check constraint/i)
  await assert.rejects(db.exec(`insert into public.fiscal_pos_bridge_settings
    (tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version)
    values ('22222222-2222-4222-8222-222222222222', 'http://fiscal.example.test/', 'Productor SL', 'B12345678', 'TK', '1.0');`), /check constraint/i)
  await assert.rejects(db.exec(`insert into public.fiscal_pos_bridge_settings
    (tenant_id, bridge_url, producer_name, producer_nif, system_id, system_version)
    values ('22222222-2222-4222-8222-222222222222', 'https://user:pass@fiscal.example.test/', 'Productor SL', 'B12345678', 'TK', '1.0');`), /check constraint/i)
  await assert.rejects(db.exec(`update public.fiscal_pos_bridge_settings set tenant_id = '22222222-2222-4222-8222-222222222222';`), /cannot move between tenants/i)
  assert.match(settings, /fiscal_pos_bridge_settings_owner_insert[\s\S]*m\.role = 'owner'/)
  assert.match(settings, /fiscal_pos_bridge_settings_owner_update[\s\S]*m\.role = 'owner'/)
  await db.exec(`update public.fiscal_pos_bridge_settings set bridge_url = null
    where tenant_id = '11111111-1111-4111-8111-111111111111';`)
  const localOnly = await db.query('select bridge_url from public.fiscal_pos_bridge_settings')
  assert.deepEqual(localOnly.rows, [{ bridge_url: null }])
})
