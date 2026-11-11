import type { BillingCatalog, Selection } from './types'
export { buildContract } from '../../../supabase/functions/_shared/billing/domain'

export const emptyBillingSelection: Selection = { planVersionId: '', addons: [] }

export function currentBillingVersions(catalog: BillingCatalog) {
  const seen = new Set<string>()
  return catalog.versions.filter(version => {
    const key = `${version.productKey}:${version.interval}`
    if (!version.published || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function changeBillingPlan(catalog: BillingCatalog, selection: Selection, planVersionId: string): Selection {
  const versions = currentBillingVersions(catalog)
  const plan = versions.find(version => version.id === planVersionId)
  return { planVersionId, addons: selection.addons.flatMap(addon => {
    const version = versions.find(row => row.productKey === addon.key && row.interval === plan?.interval)
    return version ? [{ ...addon, versionId: version.id }] : []
  }) }
}

export function generateOwnerPassword() {
  // 32 symbols: no modulo bias, ambiguous characters or non-cryptographic random.
  const characters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from(crypto.getRandomValues(new Uint8Array(8)), value => characters[value % characters.length]).join('')
}
