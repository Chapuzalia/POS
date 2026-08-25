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

test('el owner puede crear cuentas CRM con email, contrasena y rol desde Accesos', async () => {
  const [accessPage, accessService, edgeFunction] = await Promise.all([
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(accessPage, /Añadir usuario/)
  assert.match(accessPage, /Nuevo usuario CRM/)
  assert.match(accessPage, /type="email"/)
  assert.match(accessPage, /type="password"/)
  assert.match(accessPage, /roleOptions/)
  assert.match(accessPage, /createCrmUser/)
  assert.match(accessService, /action: "create-crm-user"/)
  assert.match(accessService, /CRM_USER_PASSWORD_MIN_LENGTH = 8/)
  assert.match(edgeFunction, /action === 'create-crm-user'/)
  assert.match(edgeFunction, /\['owner', 'manager'\]\.includes\(role\)/)
  assert.match(edgeFunction, /auth\.admin\.createUser/)
  assert.match(edgeFunction, /from\('tenant_memberships'\)\.insert/)
  assert.match(edgeFunction, /auth\.admin\.deleteUser\(userId, true\)/)
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

test('produccion permite editar el nombre y la contrasena de un KDS sin darle permisos de caja', async () => {
  const [productionPage, productionService, edgeFunction] = await Promise.all([
    readFile(new URL('../src/features/crm/production/pages/ProductionPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/production/services/productionAdminService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  assert.match(productionPage, /Pencil/)
  assert.match(productionPage, /Nueva contraseña \(6 caracteres\)/)
  assert.match(productionPage, /updateKdsDevice/)
  assert.match(productionService, /action: 'update-kds-device'/)
  assert.match(edgeFunction, /action === 'update-kds-device'/)
  assert.match(edgeFunction, /device\.device_mode !== 'kds'/)
  assert.match(edgeFunction, /can_take_orders: deviceMode !== 'kds'/)
  assert.match(edgeFunction, /can_manage_cash: deviceMode !== 'satellite' && deviceMode !== 'kds'/)
})

test('el owner asigna locales al manager y el manager solo administra dispositivos de su ambito', async () => {
  const [permissions, accessPage, accessService, edgeFunction, migration] = await Promise.all([
    readFile(new URL('../src/features/crm/routing/crmPermissions.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/migrations/20260805000000_add_manager_venue_assignments.sql', import.meta.url), 'utf8'),
  ])

  assert.doesNotMatch(permissions, /OWNER_ONLY_SECTIONS[^\n]*access/)
  assert.match(accessPage, /VenueScopePicker/)
  assert.match(accessPage, /tenantContext\.role === 'owner' \? <section/)
  assert.match(accessService, /action: "set-manager-venues"/)
  assert.match(accessService, /manager_venue_assignments/)
  assert.match(edgeFunction, /allowedVenueIds: isOwner \? null : \[\.\.\.managerVenueIds\]/)
  assert.match(edgeFunction, /if \(!canManageVenue\(venue\.id\)\)/)
  assert.match(migration, /manager_user_id = \(select auth\.uid\(\)\)/i)
  assert.match(migration, /function public\.set_manager_venue_assignments/i)
  assert.match(edgeFunction, /authClient\.rpc\('set_manager_venue_assignments'/)
})

test('los headers de dispositivos y usuarios usan Tailwind con tokens del tema CRM', async () => {
  const accessPage = await readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8')

  assert.match(accessPage, /border-\[var\(--crm-border-subtle\)\][^"]*bg-transparent[^"]*text-\[var\(--crm-text\)\][\s\S]{0,500}<h2>Dispositivos/)
  assert.match(accessPage, /border-\[var\(--crm-border-subtle\)\][^"]*bg-transparent[^"]*text-\[var\(--crm-text\)\][\s\S]{0,500}<h2>Usuarios con acceso al CRM/)
  assert.doesNotMatch(accessPage, /crm-list-toolbar/)
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
