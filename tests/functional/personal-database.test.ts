import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
import { employeeSnapshot, personalIds as ids } from '../helpers/personal'

const db = new PGlite()
const config = { connectionId: ids.connection, organizationId: ids.personalOrg, secret: 'a'.repeat(64), venueMappings: { [ids.personalVenue]: ids.venue } }
const snapshot = { ...employeeSnapshot, venue_ids: [ids.personalVenue], policies: { [ids.personalVenue]: employeeSnapshot.policies[ids.venue] } }
const event = { contract_version: 1, event_id: ids.employee, event_type: 'staff.updated', occurred_at: new Date().toISOString(), organization_id: ids.personalOrg, target_organization_id: ids.tenant, payload: snapshot }
async function call(name: string, params: unknown[]) {
  return (await db.query<{ result: unknown }>(`select public.${name}(${params.map((_, index) => '$' + (index + 1)).join(',')}) result`, params.map(value => value !== null && typeof value === 'object' ? JSON.stringify(value) : value))).rows[0].result
}
async function link() {
  await call('tickit_personal_configure', [ids.tenant, config])
  return call('tickit_personal_ingest', [ids.connection, 'link', { contract_version: 1, organization_id: ids.personalOrg, connection_id: ids.connection, external_organization_id: ids.tenant }])
}
beforeAll(async () => {
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
    create table tenants(id uuid primary key,name text,slug text,max_venues integer,max_devices integer,updated_at timestamptz);
    create table venues(id uuid primary key,tenant_id uuid,is_active boolean);
    create table devices(id uuid primary key,tenant_id uuid,venue_id uuid,is_active boolean);
    create table device_user_assignments(tenant_id uuid,user_id uuid,venue_id uuid,device_id uuid,is_active boolean);
    create table tenant_memberships(tenant_id uuid,user_id uuid,role text,is_active boolean);
    create table platform_features(key text primary key,name text,description text,is_core boolean,is_active boolean,enabled_by_default boolean,sort_order integer);
    create table tenant_feature_assignments(tenant_id uuid,feature_key text);
    create table billing_products(key text primary key,kind text,name text,description text,scope text,feature_key text,sort_order integer);
    create function tenant_addon_enabled(uuid,text) returns boolean language sql stable as $$ select exists(select 1 from public.tenant_feature_assignments where tenant_id=$1 and feature_key=$2) $$;
    insert into tenants(id) values('${ids.tenant}'),('${ids.other}');
    insert into venues values('${ids.venue}','${ids.tenant}',true),('${ids.venueB}','${ids.other}',true);
    insert into devices values('${ids.device}','${ids.tenant}','${ids.venue}',true);
    insert into device_user_assignments values('${ids.tenant}','${ids.user}','${ids.venue}','${ids.device}',true);
    insert into tenant_memberships values('${ids.tenant}','${ids.user}','owner',true);
  `)
  await db.exec(await readFile(new URL('../../supabase/migrations/20261102163328_tickit_personal_integration.sql', import.meta.url), 'utf8'))
})
beforeEach(async () => {
  await db.exec(`reset role; set test.uid='${ids.user}'; truncate tickit_private.personal_staff,tickit_private.personal_connections,tenant_feature_assignments; insert into tenant_feature_assignments values('${ids.tenant}','tickit_personal');`)
})
afterAll(() => db.close())
it('requires both a contracted addon and a confirmed link before activating worker selection', async () => {
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toEqual({ enabled: false, connectionId: null, staff: [] })
  await call('tickit_personal_configure', [ids.tenant, config])
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toMatchObject({ enabled: false })
  expect(await link()).toBe(ids.tenant)
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toMatchObject({ enabled: true })
  await db.exec('delete from tenant_feature_assignments')
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toMatchObject({ enabled: false })
})
it('maps Personal venues to POS and prevents stale or replayed snapshots from resurrecting a revoked worker', async () => {
  await link()
  await call('tickit_personal_ingest', [ids.connection, 'event', event])
  await call('tickit_personal_ingest', [ids.connection, 'event', { ...event, payload: { ...snapshot, status: 'inactive', version: 2 } }])
  await call('tickit_personal_ingest', [ids.connection, 'event', event])
  const state = await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])
  expect(state).toMatchObject({ staff: [{ employee_id: ids.employee, status: 'inactive', version: 2, venue_ids: [ids.venue], policies: { [ids.venue]: snapshot.policies[ids.personalVenue] } }] })
  await expect(call('tickit_personal_ingest', [ids.connection, 'event', { ...event, payload: { ...snapshot, status: 'active', version: 2 } }])).rejects.toThrow('PERSONAL_VERSION_CONFLICT')
})
it('rejects cross-tenant configuration, linking, event destinations and device reads', async () => {
  await expect(call('tickit_personal_configure', [ids.other, config])).rejects.toThrow('PERSONAL_FORBIDDEN')
  await expect(call('tickit_personal_configure', [ids.tenant, { ...config, venueMappings: { [ids.personalVenue]: ids.venueB } }])).rejects.toThrow('PERSONAL_FOREIGN_VENUE')
  await link()
  await expect(call('tickit_personal_ingest', [ids.connection, 'event', { ...event, target_organization_id: ids.other }])).rejects.toThrow('PERSONAL_FORBIDDEN')
  await expect(call('tickit_personal_ingest', [ids.connection, 'event', { ...event, organization_id: ids.other }])).rejects.toThrow('PERSONAL_FORBIDDEN')
  await expect(call('tickit_personal_device_state', [ids.other, ids.venueB, ids.device])).rejects.toThrow('PERSONAL_DEVICE_FORBIDDEN')
})
it('exposes neither the integration secret nor ingest access to authenticated devices', async () => {
  await link()
  await db.exec('set role authenticated')
  await expect(call('tickit_personal_credentials', [ids.connection])).rejects.toThrow('permission denied')
  await expect(call('tickit_personal_ingest', [ids.connection, 'event', event])).rejects.toThrow('permission denied')
  await expect(db.query('select secret from tickit_private.personal_connections')).rejects.toThrow('permission denied')
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toMatchObject({ enabled: true })
})
it('revokes the connector and rejects subsequent deliveries without affecting legacy device access', async () => {
  await link()
  await call('tickit_personal_configure', [ids.tenant, { enabled: false }])
  expect(await call('tickit_personal_credentials', [ids.connection])).toBeNull()
  expect(await call('tickit_personal_device_state', [ids.tenant, ids.venue, ids.device])).toMatchObject({ enabled: false })
  await expect(call('tickit_personal_ingest', [ids.connection, 'event', event])).rejects.toThrow('PERSONAL_FORBIDDEN')
})

it('preserves the addon for older Superadmin clients and allows explicit changes from the new catalog', async () => {
  await db.query(`select public.update_platform_tenant_config($1,'Tenant','tenant',3,3,array['__addon_catalog_v2','__assist_catalog_v1'])`, [ids.tenant])
  expect((await db.query('select feature_key from tenant_feature_assignments where tenant_id=$1', [ids.tenant])).rows).toContainEqual({ feature_key: 'tickit_personal' })
  await db.query(`select public.update_platform_tenant_config($1,'Tenant','tenant',3,3,array['__addon_catalog_v2','__assist_catalog_v1','__personal_catalog_v1'])`, [ids.tenant])
  expect((await db.query('select feature_key from tenant_feature_assignments where tenant_id=$1', [ids.tenant])).rows).not.toContainEqual({ feature_key: 'tickit_personal' })
})
