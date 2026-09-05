import type { TenantRole } from '../../../types'
import type { CrmSection } from './crmNavigation'
import { hasTenantFeature, type TenantFeatureKey } from '../../platform/tenantFeatureAccess.ts'

const CRM_ROLES = new Set<TenantRole>(['owner', 'manager'])
const OWNER_ONLY_SECTIONS = new Set<CrmSection>(['plan'])
const SECTION_FEATURES: Partial<Record<CrmSection, TenantFeatureKey | TenantFeatureKey[]>> = {
  access: 'multi_device',
  discounts: 'discounts',
  tables: 'restaurant',
  production: 'production',
  'purchases-summary': 'supplier_document_scanning',
  'purchases-invoices': 'supplier_documents',
  'purchases-suppliers': 'supplier_documents',
  'inventory-stock': 'inventory',
  'inventory-items': 'inventory',
  'inventory-preparations': ['inventory', 'inventory_recipes'],
  'inventory-warehouses': 'inventory',
  'inventory-units': 'inventory',
  'inventory-settings': 'inventory',
}

export function canAccessCrm(role: TenantRole) {
  return CRM_ROLES.has(role)
}

export function canAccessCrmSection(role: TenantRole, section: CrmSection, features?: string[]) {
  const requirement = SECTION_FEATURES[section]
  const requiredFeatures = requirement ? (Array.isArray(requirement) ? requirement : [requirement]) : []
  const hasRequiredFeatures = requiredFeatures.every((feature) => hasTenantFeature({ features }, feature))
  return canAccessCrm(role) && hasRequiredFeatures && (role === 'owner' || !OWNER_ONLY_SECTIONS.has(section))
}

