import { expect, it } from 'vitest'
import { getAppRoute } from '../../src/app/app-routes'
import { allNavItems, crmSectionFromPath, crmSectionPath } from '../../src/features/crm/routing/crmNavigation'

it('keeps CRM section URLs inside the CRM app so a reload does not switch sessions', () => {
  expect(getAppRoute('/crm/products')).toBe('crm')
  expect(getAppRoute('/crm/tickets/')).toBe('crm')
  expect(getAppRoute('/crm')).toBe('crm')
  expect(getAppRoute('/crmx')).toBe('pos')
  expect(getAppRoute('/superadmin')).toBe('superadmin')
})

it('maps every CRM section to a URL and back', () => {
  expect(crmSectionPath('products')).toBe('/crm/products')
  expect(crmSectionPath('reports')).toBe('/crm/tickets')
  expect(crmSectionPath('dashboard')).toBe('/crm/')
  for (const { id } of allNavItems) expect(crmSectionFromPath(crmSectionPath(id))).toBe(id)
  expect(crmSectionFromPath('/crm/tickets/')).toBe('reports')
  expect(crmSectionFromPath('/crm/reports')).toBe('dashboard')
  expect(crmSectionFromPath('/crm/unknown')).toBe('dashboard')
})
