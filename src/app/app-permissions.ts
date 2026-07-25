import type { TenantContext } from '../types'
import type { AppRoute } from './app-routes'

export function isCrmOwner(context: TenantContext) {
  return context.role === 'owner'
}

export function isSuperadmin(context: TenantContext) {
  return context.role === 'superadmin'
}

export function isBackofficeUser(context: TenantContext) {
  return isSuperadmin(context) || isCrmOwner(context)
}

export function getRequiredAppRoute(context: TenantContext): AppRoute {
  return isSuperadmin(context) ? 'superadmin' : isCrmOwner(context) ? 'crm' : 'pos'
}
