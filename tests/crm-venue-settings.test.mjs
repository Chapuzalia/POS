import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

test('configuracion permite editar el nombre y crear locales segun el plan', async () => {
  const [page, service, accessPage] = await Promise.all([
    readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/pages/AccessPage.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(page, /name="name"/)
  assert.match(page, /loadCrmPlan/)
  assert.match(page, /plan\.usage\.venues >= plan\.limits\.venues/)
  assert.match(page, /Nuevo local/)
  assert.match(page, /createCrmVenue\(tenantContext, name, newVenueProfile\)/)
  assert.match(service, /name: string;/)
  assert.match(service, /name,/)
  assert.doesNotMatch(accessPage, /Nuevo local/)
  assert.doesNotMatch(accessPage, /createCrmVenue/)
})

test('el alta usa una plantilla actual y revierte el local si falla su catalogo', async () => {
  const [page, service, edgeFunction] = await Promise.all([
    readFile(new URL('../src/features/crm/venues/pages/VenueSettingsPage.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/features/crm/access/services/accessService.ts', import.meta.url), 'utf8'),
    readFile(new URL('../supabase/functions/manage-pos-users/index.ts', import.meta.url), 'utf8'),
  ])

  for (const profile of ['bar_classic', 'restaurant', 'custom']) {
    assert.match(page, new RegExp(`value: '${profile}'`))
    assert.match(edgeFunction, new RegExp(`'${profile}'`))
  }

  assert.match(service, /action: "create-venue"/)
  assert.match(edgeFunction, /action === 'create-venue'/)
  assert.match(edgeFunction, /catalog_profile: catalogProfile/)
  assert.match(edgeFunction, /tables_enabled: catalogProfile === 'restaurant'/)
  assert.match(edgeFunction, /from\('catalog_sale_formats'\)/)
  assert.match(edgeFunction, /from\('catalog_tabs'\)/)
  assert.match(edgeFunction, /from\('categories'\)/)
  assert.match(edgeFunction, /from\('catalog_tab_categories'\)/)
  assert.match(edgeFunction, /venueCreateError\?\.code === 'P0001'/)
  assert.match(edgeFunction, /create-venue rollback failed/)
})