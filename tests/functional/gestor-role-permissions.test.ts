import { expect, it } from 'vitest'
import { getRequiredAppRoute, isCrmOwner } from '../../src/app/app-permissions'
import { allNavItems } from '../../src/features/crm/routing/crmNavigation'
import { canAccessCrm, canAccessCrmSection, defaultCrmSection } from '../../src/features/crm/routing/crmPermissions'
import type { TenantContext } from '../../src/types'

it('lets a gestor open only the sales report sections', () => {
  const allowed = allNavItems.filter((item) => canAccessCrmSection('gestor', item.id)).map((item) => item.id)
  expect(allowed.sort()).toEqual(['reports', 'x-reports'])
  expect(canAccessCrm('gestor')).toBe(true)
  expect(defaultCrmSection('gestor')).toBe('reports')
  expect(defaultCrmSection('manager')).toBe('dashboard')
})

it('blocks a gestor while billing activation is pending', () => {
  expect(canAccessCrmSection('gestor', 'reports', undefined, undefined, true)).toBe(false)
})

it('routes a gestor to the CRM without owner privileges', () => {
  const context = { role: 'gestor' } as TenantContext
  expect(getRequiredAppRoute(context)).toBe('crm')
  expect(isCrmOwner(context)).toBe(false)
})
