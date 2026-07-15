import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('crear un dispositivo provisiona automaticamente su usuario y credenciales', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /action === 'create-device-with-user'/)
  assert.doesNotMatch(edgeFunction, /action === 'create'/)
  assert.match(edgeFunction, /const email = `\$\{emailDevice\}@\$\{emailVenue\}\.\$\{emailTenant\}`/)
  assert.match(edgeFunction, /const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'/)
  assert.match(edgeFunction, /const lowercase = 'abcdefghijklmnopqrstuvwxyz'/)
  assert.match(edgeFunction, /const digits = '0123456789'/)
  assert.match(edgeFunction, /Array\.from\(\{ length: 9 \}/)
  assert.match(edgeFunction, /credentials: \{ email, password \}/)
})

test('un fallo al crear el usuario revierte el dispositivo nuevo', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /auth\.admin\.deleteUser\(userId\)/)
  assert.match(edgeFunction, /from\('devices'\)\.delete\(\)\.eq\('id', device\.id\)/)
})

test('el crm ya no contiene el formulario manual de usuarios', async () => {
  const crmPage = await readFile(new URL('../src/components/crm/CrmPage.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(crmPage, /Nuevo usuario TPV/)
  assert.doesNotMatch(crmPage, /createCrmPosUser/)
  assert.match(crmPage, /Credenciales del nuevo dispositivo/)
})
