import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('la desactivacion de un negocio corta el acceso sin alterar sus membresias', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.match(migration, /is_active boolean default true not null/i)
  assert.match(migration, /join public\.tenants t on t\.id = tm\.tenant_id/)
  assert.match(migration, /and t\.is_active = true/)
  assert.match(migration, /create function public\.user_has_tenant_role\(/i)
})

test('las operaciones de plataforma permanecen restringidas al superadmin', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  for (const action of [
    'platform-update-tenant',
    'platform-set-tenant-active',
    'platform-delete-tenant',
  ]) {
    assert.match(edgeFunction, new RegExp(`action === '${action}'`))
  }

  assert.match(edgeFunction, /if \(!isSuperadmin\)/)
  assert.match(edgeFunction, /adminClient\.from\('tenants'\)\.delete\(\)/)
  assert.match(edgeFunction, /remainingMembership/)
})

test('el alta de negocio crea los formatos del catalogo actual para el local inicial', async () => {
  const [edgeFunction, platformService] = await Promise.all([
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/platformService.ts', import.meta.url), 'utf8'),
  ])

  assert.match(edgeFunction, /\.from\('venues'\)[\s\S]*\.select\('id'\)[\s\S]*\.single\(\)/)
  assert.match(edgeFunction, /adminClient\.from\('catalog_sale_formats'\)\.insert/)
  assert.match(edgeFunction, /venue_id: createdVenue\.id/)
  assert.doesNotMatch(edgeFunction, /adminClient\.from\('sale_formats'\)/)
  assert.match(edgeFunction, /console\.error\('manage-pos-users failed', error\)/)
  assert.match(platformService, /getFunctionInvokeErrorMessage/)
})
test('los limites del plan se aplican en base de datos a todos los recursos', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.match(migration, /max_venues integer default 1 not null/i)
  assert.match(migration, /max_devices integer default 5 not null/i)
  assert.doesNotMatch(migration, /max_users/)
  assert.match(migration, /for update/)
  assert.match(migration, /before insert on public\.venues/i)
  assert.match(migration, /before insert on public\.devices/i)
  assert.match(migration, /before insert on public\.tenant_memberships/i)
  assert.match(migration, /Has alcanzado el límite de % de tu plan/)
})

test('el crm puede consultar uso y limites desde una accion protegida', async () => {
  const edgeFunction = await readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8')

  assert.match(edgeFunction, /action === 'tenant-plan'/)
  assert.match(edgeFunction, /max_venues, max_devices/)
  assert.doesNotMatch(edgeFunction, /max_users/)
  assert.match(edgeFunction, /usage:/)
  assert.match(edgeFunction, /limits:/)
})

test('los usuarios tpv comparten el limite de dispositivos', async () => {
  const migration = await readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8')

  assert.doesNotMatch(migration, /max_users/i)
  assert.match(migration, /if new\.role <> 'cashier'/)
  assert.match(migration, /select max_devices into resource_limit/)
  assert.match(migration, /role = 'cashier'/)
})

test('las features usan un catalogo relacional y se asignan completas a negocios existentes', async () => {
  const [featureMigration, consolidatedSchema] = await Promise.all([
    readFile(new URL('../supabase/migrations/20260811220000_add_tenant_features.sql', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/0.Complete_Database_24-07-26.sql', import.meta.url), 'utf8'),
  ])

  for (const source of [featureMigration, consolidatedSchema]) {
    assert.match(source, /create table if not exists public\.platform_features/i)
    assert.match(source, /create table if not exists public\.tenant_feature_assignments/i)
    assert.match(source, /primary key \(tenant_id, feature_key\)/i)
    assert.match(source, /alter table public\.tenant_feature_assignments enable row level security/i)
    assert.match(source, /create or replace function public\.update_platform_tenant_config/i)
  }

  assert.match(featureMigration, /from public\.tenants tenant\s+cross join public\.platform_features feature/i)
  assert.match(featureMigration, /where feature\.is_core = false\s+and feature\.is_active = true/i)
  assert.match(featureMigration, /assign_default_tenant_features_after_insert/i)
  assert.match(featureMigration, /feature\.enabled_by_default = true/i)
  assert.doesNotMatch(featureMigration, /enabled_features text\[\]/i)
})

test('el superadmin carga el catalogo de features y guarda asignaciones de forma atomica', async () => {
  const [edgeFunction, platformService, superadminPage] = await Promise.all([
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/services/platformService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/superadmin/SuperAdminPage.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(edgeFunction, /from\('platform_features'\)/)
  assert.match(edgeFunction, /from\('tenant_feature_assignments'\)/)
  assert.match(edgeFunction, /rpc\('update_platform_tenant_config'/)
  assert.match(platformService, /features: PlatformFeature\[\]/)
  assert.match(platformService, /Array\.isArray\(tenant\.features\) \? tenant\.features : \[\]/)
  assert.match(superadminPage, /Features del negocio/)
  assert.match(superadminPage, /El núcleo está siempre incluido/)
  assert.match(superadminPage, /features: editingTenantFeatures/)
})

test('el selector de features usa un panel compacto y conserva el fondo neutro al seleccionar', async () => {
  const source = await readFile(new URL('../src/components/superadmin/SuperAdminPage.tsx', import.meta.url), 'utf8')

  assert.match(source, /Módulos opcionales/)
  assert.match(source, /!min-h-\[70px\]/)
  assert.match(source, /data-\[selected=true\]:!bg-\[var\(--crm-surface\)\]/)
  assert.doesNotMatch(source, /data-\[selected=true\]:!bg-\[var\(--crm-blue-soft\)\]/)
})

test('los slugs del superadmin usan un pattern compatible con Unicode v', async () => {
  const source = await readFile(new URL('../src/components/superadmin/SuperAdminPage.tsx', import.meta.url), 'utf8')

  assert.doesNotMatch(source, /pattern="\[a-z0-9\]\+\(\?:\[_-\]/)
  assert.equal((source.match(/pattern="\[a-z0-9\]\+\(\?:\(\?:_\|-\)\[a-z0-9\]\+\)\*"/g) ?? []).length, 2)
})
