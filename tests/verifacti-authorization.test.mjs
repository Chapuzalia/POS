import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { authorizeSuperadmin } from '../supabase/functions/_shared/verifacti/authorization.ts'

const source = await readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8')
const venueAssignmentMigration = await readFile(new URL('../supabase/migrations/20260925100000_add_fiscal_entity_venue_assignment_rpc.sql', import.meta.url), 'utf8')
const venueSeriesPreservationMigration = await readFile(new URL('../supabase/migrations/20260925130000_preserve_fiscal_venue_series_on_assignment.sql', import.meta.url), 'utf8')
const fiscalOnboardingService = await readFile(new URL('../src/services/fiscalOnboardingService.ts', import.meta.url), 'utf8')
const superadminPage = await readFile(new URL('../src/components/superadmin/SuperAdminPage.tsx', import.meta.url), 'utf8')

test('superadmin valido autorizado por profiles.is_superadmin', () => {
  assert.deepEqual(authorizeSuperadmin('user-1', null, { is_superadmin: true }, null), {
    authorized: true,
    userId: 'user-1',
  })
})

test('usuario normal recibe 403', () => {
  const result = authorizeSuperadmin('user-1', null, { is_superadmin: false }, null)
  assert.equal(result.authorized, false)
  assert.equal(result.status, 403)
})

test('perfil inexistente recibe respuesta controlada 403', () => {
  const result = authorizeSuperadmin('user-1', null, null, null)
  assert.equal(result.authorized, false)
  assert.equal(result.status, 403)
  assert.match(result.error, /superadmin/)
  assert.doesNotThrow(() => JSON.stringify(result))
})

test('JWT invalido recibe 401 sin consultar permisos', () => {
  const result = authorizeSuperadmin(null, new Error('invalid token'), null, null)
  assert.deepEqual(result, { authorized: false, status: 401, error: 'Sesion no valida' })
})

test('verifacti-api no dereferencia role de una membership nula', () => {
  assert.match(source, /membership\?\.role === 'owner'/)
  assert.doesNotMatch(source, /membership\.role === 'owner'/)
  assert.match(source, /authorizeSuperadmin\(authData\.user\.id, null, callerProfile, callerProfileError\)/)
})

test('la migracion reutiliza entidades y bloquea NIF duplicados normalizados', () => {
  assert.match(source, /superadmin-configure-fiscal-entity/)
  assert.match(source, /Ya existe una entidad fiscal con el NIF/)
  assert.doesNotMatch(source, /fiscal_entity_venues.*delete/s)
})

test('el cutover Odoo actualiza la misma entidad y devuelve sus asociaciones', () => {
  assert.match(source, /update\(\{ integration_provider: 'odoo'/)
  assert.match(source, /provider_entity_ref: ref/)
  assert.match(source, /fiscal_documents/)
  assert.match(source, /loadSuperadminFiscalEntitySummary\(admin, tenantId, entityId\)/)
  assert.match(source, /venueNames: venueIds\.map/)
  assert.doesNotMatch(source, /if \(action === 'superadmin-configure-fiscal-entity'[\s\S]*fiscal_entity_venues'\)\.delete/)
})

test('Superadmin puede editar locales y el backend valida el tenant y asociaciones únicas', () => {
  assert.match(fiscalOnboardingService, /superadmin-update-fiscal-entity-venues/)
  assert.match(superadminPage, /Editar locales/)
  assert.match(superadminPage, /updateSuperadminFiscalEntityVenues/)
  assert.match(venueAssignmentMigration, /v\.tenant_id = p_tenant_id/)
  assert.match(venueAssignmentMigration, /create function public\.superadmin_update_fiscal_entity_venues/)
  assert.match(venueAssignmentMigration, /auth\.role\(\) <> 'service_role'/)
  assert.match(venueAssignmentMigration, /FISCAL_ENTITY_VENUE_ALREADY_ASSIGNED/)
  assert.match(venueAssignmentMigration, /delete from public\.fiscal_entity_venues/)
  assert.match(venueAssignmentMigration, /insert into public\.fiscal_entity_venues/)
})

test('editar locales de una entidad Odoo ready sincroniza el conjunto completo desde backend', () => {
  assert.match(source, /if \(entity\.integration_provider === 'odoo'\)/)
  assert.match(source, /await syncOdooFiscalEntity\(admin, env, tenantId, entityId\)/)
  assert.match(source, /const fiscalVenues = await fiscalVenueProvisioningPayload\(admin, tenantId, entityId, venueIds\)/)
  assert.match(source, /venues: fiscalVenues/)
  assert.match(source, /provider_entity_ref: ref/)
  assert.match(source, /provisioning_status: 'provisioning'/)
  assert.match(source, /provisioning_status: 'ready'/)
})

test('el payload Odoo usa IDs y datos recargados del servidor con series persistidas', () => {
  assert.match(source, /select\('venue_id, fiscal_series_code'\)/)
  assert.match(source, /select\('id, name'\)\.eq\('tenant_id', tenantId\)\.in\('id', venueIds\)/)
  assert.match(source, /venue_ref: venue\.id, name: venue\.name, series_code: seriesCode/)
  assert.match(source, /update\(\{ fiscal_series_code: update\.fiscal_series_code \}\)/)
  assert.match(source, /if \(!seriesCode\)/)
})

test('las asociaciones existentes preservan su serie y los locales quitados se eliminan', () => {
  assert.match(venueSeriesPreservationMigration, /venue_id <> all\(p_venue_ids\)/)
  assert.match(venueSeriesPreservationMigration, /where not exists \(/)
  assert.match(venueSeriesPreservationMigration, /existing\.venue_id = requested\.venue_id/)
})

test('un fallo Odoo deja estado recuperable y no devuelve éxito al frontend', () => {
  assert.match(source, /provisioning_status: 'error'/)
  assert.match(source, /Los locales se guardaron en Tickit, pero no se pudieron sincronizar con Odoo/)
  assert.match(source, /Odoo fiscal venue sync failed/)
})
