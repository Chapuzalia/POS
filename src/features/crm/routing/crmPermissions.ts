import type { TenantRole } from '../../../types'
import type { CrmSection } from './crmNavigation'

const CRM_ROLES = new Set<TenantRole>(['owner', 'manager'])
const OWNER_ONLY_SECTIONS = new Set<CrmSection>(['access', 'plan'])

export function canAccessCrm(role: TenantRole) {
  return CRM_ROLES.has(role)
}

export function canAccessCrmSection(role: TenantRole, section: CrmSection) {
  return canAccessCrm(role) && (role === 'owner' || !OWNER_ONLY_SECTIONS.has(section))
}

