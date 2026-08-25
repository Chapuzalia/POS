import type { TenantContext } from '../../types'

export const tenantFeatureKeys = ['discounts', 'restaurant', 'reservations', 'inventory', 'multi_device', 'production'] as const

export type TenantFeatureKey = typeof tenantFeatureKeys[number]

export function normalizeTenantFeatures(value: unknown): TenantFeatureKey[] {
  if (!Array.isArray(value)) return []
  const requested = new Set(value.filter((feature): feature is string => typeof feature === 'string'))
  return tenantFeatureKeys.filter((feature) => requested.has(feature))
}

export function hasTenantFeature(context: Pick<TenantContext, 'features'>, feature: TenantFeatureKey) {
  // Cached contexts created before feature entitlements existed retain the previous all-enabled behaviour.
  return context.features === undefined || context.features.includes(feature)
}
