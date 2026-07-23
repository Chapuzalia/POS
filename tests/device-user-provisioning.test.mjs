import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('crear un dispositivo provisiona automaticamente su usuario y credenciales', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /action === 'create-device-with-user'/)
  assert.doesNotMatch(edgeFunction, /action === 'create'/)
  assert.match(edgeFunction, /const email = `\$\{emailDevice\}-\$\{device\.id\.slice\(0, 8\)\}@\$\{emailVenue\}\.\$\{emailTenant\}`/)
  assert.match(edgeFunction, /const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'/)
  assert.match(edgeFunction, /const lowercase = 'abcdefghijklmnopqrstuvwxyz'/)
  assert.match(edgeFunction, /const digits = '0123456789'/)
  assert.match(edgeFunction, /Array\.from\(\{ length: 9 \}/)
  assert.match(edgeFunction, /credentials: \{ email, password \}/)
  assert.match(edgeFunction, /Ya existe un dispositivo con ese nombre en el local/)
})

test('un fallo al crear el usuario revierte el dispositivo nuevo', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /auth\.admin\.deleteUser\(userId\)/)
  assert.match(edgeFunction, /from\('devices'\)\.delete\(\)\.eq\('id', device\.id\)/)
})

test('el crm ya no contiene el formulario manual de usuarios', async () => {
  const accessPage = await readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(accessPage, /Nuevo usuario TPV/)
  assert.doesNotMatch(accessPage, /createCrmPosUser/)
  assert.match(accessPage, /Credenciales del nuevo dispositivo/)
})

test('el crm muestra el detalle devuelto por la edge function en vez del error non-2xx genérico', async () => {
  const service = await readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')
  const support = await readFile(new URL('../src/features/crm/shared/services/crmServiceSupport.ts', import.meta.url), 'utf8')

  assert.match(service, /getFunctionInvokeErrorMessage/)
  assert.match(support, /context instanceof Response/)
  assert.match(support, /await context\.json\(\)/)
  assert.match(support, /non-2xx status code/)
})

test('accesos muestra todos los dispositivos y permite retirar los que no tienen usuario', async () => {
  const [accessPage, accessService, edgeFunction, migration] = await Promise.all([
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/45.active-device-plan-usage.sql', import.meta.url), 'utf8'),
  ])

  assert.match(accessPage, /data\.devices\.map/)
  assert.match(accessPage, /Sin usuario asignado/)
  assert.match(accessPage, /retireCrmDevice/)
  assert.match(accessService, /action:\s*["']retire-device["']/)
  assert.match(edgeFunction, /action === 'retire-device'/)
  assert.match(edgeFunction, /El dispositivo tiene un usuario asociado/)
  assert.match(migration, /where tenant_id = new\.tenant_id and is_active/)
  assert.match(migration, /where is_active/)
})
