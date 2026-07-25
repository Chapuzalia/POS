import type { TenantContext } from '../types'
import type { AppRoute } from './app-routes'

export function isCrmOwner(context: TenantContext) {
  return context.role === 'owner'
}

export function isCrmUser(context: TenantContext) {
  return context.role === 'owner' || context.role === 'manager'
}

export function isSuperadmin(context: TenantContext) {
  return context.role === 'superadmin'
}

export function isBackofficeUser(context: TenantContext) {
  return isSuperadmin(context) || isCrmUser(context)
}

export function getRequiredAppRoute(context: TenantContext): AppRoute {
  return isSuperadmin(context) ? 'superadmin' : isCrmUser(context) ? 'crm' : 'pos'
}
