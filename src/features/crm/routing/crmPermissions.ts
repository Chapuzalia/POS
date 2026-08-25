import type { TenantRole } from '../../../types'
import type { CrmSection } from './crmNavigation'
import type { TenantFeatureKey } from '../../platform/tenantFeatureAccess'

const CRM_ROLES = new Set<TenantRole>(['owner', 'manager'])
const OWNER_ONLY_SECTIONS = new Set<CrmSection>(['plan'])
const SECTION_FEATURES: Partial<Record<CrmSection, TenantFeatureKey>> = {
  access: 'multi_device',
  discounts: 'discounts',
  tables: 'restaurant',
  production: 'production',
  'inventory-stock': 'inventory',
  'inventory-warehouses': 'inventory',
  'inventory-settings': 'inventory',
}

export function canAccessCrm(role: TenantRole) {
  return CRM_ROLES.has(role)
}

export function canAccessCrmSection(role: TenantRole, section: CrmSection, features?: string[]) {
  const requiredFeature = SECTION_FEATURES[section]
  const hasRequiredFeature = !requiredFeature || features === undefined || features.includes(requiredFeature)
  return canAccessCrm(role) && hasRequiredFeature && (role === 'owner' || !OWNER_ONLY_SECTIONS.has(section))
}

