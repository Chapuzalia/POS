import type { TenantContext } from '../../types'

export const tenantAddonKeys = ['analytics_advanced', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'document_ai', 'promotions', 'cashlogy'] as const
export const tenantCapabilityKeys = ['analytics_basic', 'analytics_advanced', 'profitability', 'purchase_analytics', 'restaurant', 'reservations', 'production', 'inventory', 'costing', 'purchases', 'replenishment', 'document_ai', 'manual_discounts', 'promotions', 'cashlogy'] as const

export type TenantAddonKey = typeof tenantAddonKeys[number]
export type TenantCapabilityKey = typeof tenantCapabilityKeys[number]

type FeatureContext = Pick<TenantContext, 'features'>

const legacyAddonAliases: Readonly<Record<string, TenantAddonKey>> = {
  discounts: 'promotions',
  inventory_recipes: 'costing',
  supplier_documents: 'purchases',
  supplier_document_scanning: 'document_ai',
}

export const tenantAddonCatalog: ReadonlyArray<{
  key: TenantAddonKey
  name: string
  description: string
  requires: readonly TenantAddonKey[]
}> = [
  { key: 'analytics_advanced', name: 'Analítica avanzada', description: 'Comparativas, actividad, distribuciones e informes agregados avanzados.', requires: [] },
  { key: 'restaurant', name: 'Restaurante', description: 'Mesas, zonas, comandas, división de cuenta, pretickets y carryovers.', requires: [] },
  { key: 'reservations', name: 'Reservas', description: 'Reservas, disponibilidad y asignación de mesas.', requires: ['restaurant'] },
  { key: 'production', name: 'Producción & KDS', description: 'Destinos, routing, impresión de producción, KDS y dispatches.', requires: ['restaurant'] },
  { key: 'inventory', name: 'Inventario', description: 'Stock, artículos, almacenes, unidades, rutas, objetivos y ajustes.', requires: [] },
  { key: 'costing', name: 'Escandallos & Costes', description: 'Recetas, ingredientes, elaboraciones y cálculo de costes.', requires: ['inventory'] },
  { key: 'purchases', name: 'Compras & Proveedores', description: 'Proveedores, documentos, archivo e histórico de precios.', requires: [] },
  { key: 'document_ai', name: 'Escaneo inteligente', description: 'OCR, extracción de líneas e identificación y actualización desde documentos.', requires: ['purchases', 'inventory'] },
  { key: 'promotions', name: 'Promociones avanzadas', description: 'Reglas, autoaplicación, horarios, targets, PIN y redondeos.', requires: [] },
  { key: 'cashlogy', name: 'Cashlogy', description: 'Configuración y operativa de la integración Cashlogy.', requires: [] },
]

export function normalizeTenantFeatures(value: unknown): TenantAddonKey[] {
  if (!Array.isArray(value)) return []
  const requested = new Set<TenantAddonKey>()
  for (const feature of value) {
    if (typeof feature !== 'string') continue
    const key = (legacyAddonAliases[feature] ?? feature) as TenantAddonKey
    if (tenantAddonKeys.includes(key)) requested.add(key)
  }
  return tenantAddonKeys.filter((feature) => requested.has(feature))
}

const legacyCachedAddonKeys = tenantAddonKeys.filter((key) => key !== 'analytics_advanced' && key !== 'cashlogy')

function resolvedAddons(context: FeatureContext) {
  return context.features === undefined ? new Set<TenantAddonKey>(legacyCachedAddonKeys) : new Set(normalizeTenantFeatures(context.features))
}

export function hasTenantAddon(context: FeatureContext, addon: TenantAddonKey) {
  return resolvedAddons(context).has(addon)
}

export function hasTenantCapability(context: FeatureContext, capability: TenantCapabilityKey) {
  const addons = resolvedAddons(context)
  switch (capability) {
    case 'analytics_basic':
    case 'manual_discounts':
      return true
    case 'profitability':
      return addons.has('analytics_advanced') && addons.has('inventory') && addons.has('costing')
    case 'purchase_analytics':
      return addons.has('analytics_advanced') && addons.has('purchases')
    case 'reservations':
    case 'production':
      return addons.has('restaurant') && addons.has(capability)
    case 'costing':
      return addons.has('inventory') && addons.has('costing')
    case 'replenishment':
      return addons.has('purchases') && addons.has('inventory')
    case 'document_ai':
      return addons.has('purchases') && addons.has('inventory') && addons.has('document_ai')
    default:
      return addons.has(capability)
  }
}

export function hasTenantFeature(context: FeatureContext, feature: string) {
  const alias = legacyAddonAliases[feature]
  if (alias) return hasTenantAddon(context, alias)
  if (feature === 'analytics_basic' || feature === 'manual_discounts') return true
  if (feature === 'profitability' || feature === 'purchase_analytics' || feature === 'replenishment') return hasTenantCapability(context, feature)
  return tenantAddonKeys.includes(feature as TenantAddonKey) ? hasTenantAddon(context, feature as TenantAddonKey) : false
}

export function updateTenantAddons(current: readonly string[], addon: TenantAddonKey, enabled: boolean) {
  const next = new Set(normalizeTenantFeatures(current))
  if (enabled) {
    next.add(addon)
    tenantAddonCatalog.find((item) => item.key === addon)?.requires.forEach((requirement) => next.add(requirement))
  } else {
    next.delete(addon)
    for (const item of tenantAddonCatalog) {
      if (item.requires.includes(addon)) next.delete(item.key)
    }
  }
  return tenantAddonKeys.filter((key) => next.has(key))
}
