import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { authorizeSuperadmin } from '../supabase/functions/_shared/verifacti/authorization.ts'

const source = await readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8')
const venueAssignmentMigration = await readFile(new URL('../supabase/migrations/20260925100000_add_fiscal_entity_venue_assignment_rpc.sql', import.meta.url), 'utf8')
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
