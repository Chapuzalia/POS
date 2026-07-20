import type { TenantContext } from '../types'
import type { AppRoute } from './app-routes'

export function isCrmAdministrator(context: TenantContext) {
  return context.role === 'owner' || context.role === 'admin'
}

export function isSuperadmin(context: TenantContext) {
  return context.role === 'superadmin'
}

export function isAdministrativeUser(context: TenantContext) {
  return isSuperadmin(context) || isCrmAdministrator(context)
}

export function getRequiredAppRoute(context: TenantContext): AppRoute {
  return isSuperadmin(context) ? 'superadmin' : isCrmAdministrator(context) ? 'crm' : 'pos'
}
