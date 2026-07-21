import type { TenantRole } from '../../../types'
import type { CrmSection } from './crmNavigation'

const CRM_ROLES = new Set<TenantRole>(['owner', 'admin'])

export function canAccessCrm(role: TenantRole) {
  return CRM_ROLES.has(role)
}

export function canAccessCrmSection(role: TenantRole, _section: CrmSection) {
  return canAccessCrm(role)
}

