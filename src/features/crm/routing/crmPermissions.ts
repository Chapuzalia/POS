import type { TenantRole } from '../../../types'
import type { CrmSection } from './crmNavigation'
import { hasTenantCapability, type TenantCapabilityKey } from '../../platform/tenantFeatureAccess.ts'

const CRM_ROLES = new Set<TenantRole>(['owner', 'manager'])
const OWNER_ONLY_SECTIONS = new Set<CrmSection>(['plan'])
const SECTION_FEATURES: Partial<Record<CrmSection, TenantCapabilityKey>> = {
  discounts: 'promotions',
  tables: 'restaurant',
  production: 'production',
  'purchases-summary': 'purchase_analytics',
  'purchases-replenishment': 'replenishment',
  'purchases-invoices': 'purchases',
  'purchases-suppliers': 'purchases',
  profitability: 'profitability',
  'inventory-stock': 'inventory',
  'inventory-items': 'inventory',
  'inventory-preparations': 'costing',
  'inventory-warehouses': 'inventory',
  'inventory-units': 'inventory',
  'inventory-settings': 'inventory',
}

export function canAccessCrm(role: TenantRole) {
  return CRM_ROLES.has(role)
}

export function canAccessCrmSection(role: TenantRole, section: CrmSection, features?: string[]) {
  const requirement = SECTION_FEATURES[section]
  const hasRequiredCapability = requirement ? hasTenantCapability({ features }, requirement) : true
  return canAccessCrm(role) && hasRequiredCapability && (role === 'owner' || !OWNER_ONLY_SECTIONS.has(section))
}

