import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import { authorizeSuperadmin } from '../supabase/functions/_shared/verifacti/authorization.ts'

const source = await readFile(new URL('../supabase/functions/verifacti-api/index.ts', import.meta.url), 'utf8')

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

test('el cutover Odoo actualiza la misma entidad', () => {
  assert.match(source, /update\(\{ integration_provider: 'odoo'/)
  assert.match(source, /provider_entity_ref: ref/)
  assert.match(source, /fiscal_documents/)
})
