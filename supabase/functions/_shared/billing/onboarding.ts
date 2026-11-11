import { buildContract } from './domain.ts'
import type { Product, Selection, Version } from './domain.ts'

export function onboardingContract(catalog: { products: Product[]; versions: Version[] }, selection: Selection, initialVenueId?: string) {
  const current = new Map<string, string>()
  for (const version of catalog.versions) {
    const key = `${version.productKey}:${version.interval}`
    if (version.published && !current.has(key)) current.set(key, version.id)
  }
  for (const id of [selection.planVersionId, ...selection.addons.map(addon => addon.versionId)]) {
    const version = catalog.versions.find(row => row.id === id)
    if (!version || current.get(`${version.productKey}:${version.interval}`) !== id) throw new Error('BILLING_INVALID_HISTORICAL_TARIFF')
  }
  if (initialVenueId) {
    if (selection.addons.some(addon => addon.venueIds.length || addon.deviceIds.length)) throw new Error('BILLING_FOREIGN_ASSIGNMENT')
    selection = { ...selection, addons: selection.addons.map(addon => ({ ...addon, venueIds: addon.quantity > 0 && catalog.products.find(product => product.key === addon.key)?.scope === 'venue' ? [initialVenueId] : [] })) }
  }
  const contract = buildContract(catalog.products, catalog.versions, selection)
  if (contract.limits.venues < 1) throw new Error('BILLING_LIMIT_BELOW_USAGE')
  return contract
}
