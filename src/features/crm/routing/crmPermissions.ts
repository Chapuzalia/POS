import type { CrmVenue, TenantRole } from '../../../types'
import { reportSections, type CrmSection } from './crmNavigation'
import { hasTenantCapability, hasTenantVenueCapability, type TenantCapabilityKey } from '../../platform/tenantFeatureAccess.ts'

const CRM_ROLES = new Set<TenantRole>(['owner', 'manager', 'gestor'])
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

// A gestor only reads the sales reports (Tickets, Informes Z), so it lands there instead of the dashboard.
export function defaultCrmSection(role: TenantRole): CrmSection {
  return role === 'gestor' ? 'reports' : 'dashboard'
}

export function canAccessCrmSection(role: TenantRole, section: CrmSection, features?: string[], venue?: Pick<CrmVenue, 'addonActivations' | 'inventoryEnabled' | 'tablesEnabled' | 'productionEnabled'>, billingActivationRequired = false) {
  if (billingActivationRequired) return role === 'owner' && section === 'plan'
  if (role === 'gestor') return reportSections.has(section)
  const requirement = SECTION_FEATURES[section]
  const featureContext = venue ? { features, venue } : { features }
  const hasRequiredCapability = requirement ? (venue ? hasTenantVenueCapability(featureContext, requirement) : hasTenantCapability(featureContext, requirement)) : true
  return canAccessCrm(role) && hasRequiredCapability && (role === 'owner' || !OWNER_ONLY_SECTIONS.has(section))
}

