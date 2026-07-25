import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('crear un dispositivo provisiona automaticamente su usuario y credenciales', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /action === 'create-device-with-user'/)
  assert.doesNotMatch(edgeFunction, /action === 'create'/)
  assert.match(edgeFunction, /const email = `\$\{emailDevice\}@\$\{emailVenue\}\.\$\{emailTenant\}`/)
  assert.doesNotMatch(edgeFunction, /device\.id\.slice/)
  assert.match(edgeFunction, /const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'/)
  assert.match(edgeFunction, /\{ length: 6 \}/)
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
  assert.match(accessPage, /Usuarios con acceso al CRM/)
  assert.doesNotMatch(accessPage, /Usuarios de caja/)
})

test('el crm muestra el detalle devuelto por la edge function en vez del error non-2xx genérico', async () => {
  const service = await readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8')
  const support = await readFile(new URL('../src/features/crm/shared/services/crmServiceSupport.ts', import.meta.url), 'utf8')

  assert.match(service, /getFunctionInvokeErrorMessage/)
  assert.match(support, /context instanceof Response/)
  assert.match(support, /await context\.json\(\)/)
  assert.match(support, /non-2xx status code/)
})

test('accesos integra las credenciales y la edición dentro de cada dispositivo', async () => {
  const [accessPage, accessService, edgeFunction] = await Promise.all([
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(accessPage, /data\.devices\.map/)
  assert.match(accessPage, /device\.account\?\.email/)
  assert.match(accessPage, /updateCrmDevice/)
  assert.match(accessPage, /maxLength=\{6\} minLength=\{6\}/)
  assert.match(accessService, /action: "update-device"/)
  assert.match(edgeFunction, /action === 'update-device'/)
  assert.match(edgeFunction, /password\.length !== 6/)
  assert.match(edgeFunction, /managementMemberships/)
  assert.match(edgeFunction, /\['owner', 'manager'\]/)
})

test('los headers de dispositivos y usuarios usan los tokens del tema CRM', async () => {
  const accessPage = await readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8')
  const themedHeaders = accessPage.match(/crm-list-toolbar[^"]*!bg-transparent[^"]*!text-\[var\(--crm-text\)\]/g) ?? []

  assert.equal(themedHeaders.length, 2)
  assert.match(accessPage, /!border-\[var\(--crm-border-subtle\)\]/)
})

test('los dispositivos se eliminan y sus referencias historicas quedan a null', async () => {
  const [accessPage, accessService, edgeFunction, schema, migration] = await Promise.all([
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260724210000_delete_devices_safely.sql', import.meta.url), 'utf8'),
  ])

  assert.match(accessPage, /deleteCrmDevice/)
  assert.doesNotMatch(accessPage, /retireCrmDevice/)
  assert.match(accessService, /action: "delete-device"/)
  assert.match(edgeFunction, /action === 'delete-device'/)
  assert.match(edgeFunction, /Cierra la caja y las comandas abiertas/)
  assert.match(edgeFunction, /auth\.admin\.deleteUser\(assignment\.user_id, true\)/)
  assert.match(schema, /sales_device_id_fkey[\s\S]*ON DELETE SET NULL/)
  assert.match(schema, /tickets_device_id_fkey[\s\S]*ON DELETE SET NULL/)
  assert.match(schema, /orders_opened_by_device_id_fkey[\s\S]*ON DELETE SET NULL/)
  assert.match(schema, /CREATE TRIGGER prevent_device_delete_with_open_work BEFORE DELETE ON public\.devices/)
  assert.match(migration, /alter column device_id drop not null/i)
  assert.match(migration, /ON DELETE SET NULL/i)
  assert.match(migration, /Cierra la caja y las comandas abiertas de este dispositivo antes de eliminarlo/)
})
