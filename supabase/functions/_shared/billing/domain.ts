// Shared deterministic commercial rules. No network, browser storage or POS dependency.
export type Interval = 'month' | 'year'
export type Product = {
  key: string
  kind: 'plan' | 'addon'
  name: string
  description: string
  scope: 'tenant' | 'venue' | 'device'
  featureKey: string | null
  resource: 'venues' | 'devices' | null
  active: boolean
  sortOrder: number
}
export type Version = {
  id: string
  productKey: string
  interval: Interval
  amountCents: number
  stripePriceId: string | null
  features: string[]
  limits: { venues: number; devices: number }
  included: Record<string, number>
  maximum: number | null
  requires: string[]
  published: boolean
}
export type AddonSelection = { key: string; versionId: string; quantity: number; venueIds: string[]; deviceIds: string[] }
export type Selection = { planVersionId: string; addons: AddonSelection[] }
export type CommercialException = {
  freeUnits: Record<string, number>
  limits: Partial<{ venues: number; devices: number }>
  discountBasisPoints: number
  customAmounts: Record<string, number>
  // A temporary exception ends at an exact subscription boundary via a Stripe schedule.
  cycles: number | null
  reason: string
}
export type Line = { key: string; versionId: string; stripePriceId: string | null; quantity: number; amountCents: number }
export type Contract = {
  selection: Selection
  planName: string
  interval: Interval
  lines: Line[]
  addons: Array<AddonSelection & { featureKey: string | null; scope: Product['scope']; included: number; billable: number }>
  features: string[]
  limits: { venues: number; devices: number }
  recurringCents: number
  exception: CommercialException | null
}

function integer(value: number, label: string, max = 100_000) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`BILLING_INVALID_${label}`)
  return value
}

export function buildContract(products: Product[], versions: Version[], selection: Selection, exception: CommercialException | null = null): Contract {
  const byKey = new Map(products.map(product => [product.key, product]))
  const byId = new Map(versions.map(version => [version.id, version]))
  const plan = byId.get(selection.planVersionId)
  const planProduct = plan && byKey.get(plan.productKey)
  if (!plan || !plan.published || planProduct?.kind !== 'plan' || !planProduct.active) throw new Error('BILLING_INVALID_PLAN')
  const discount = integer(exception?.discountBasisPoints ?? 0, 'DISCOUNT', 10_000)
  const features = new Set(plan.features)
  const limits = { ...plan.limits }
  integer(limits.venues, 'VENUES'); integer(limits.devices, 'DEVICES')
  const amount = (key: string, standard: number) => integer(exception?.customAmounts[key] ?? standard, 'AMOUNT', 100_000_000)
  const lines: Line[] = [{ key: plan.productKey, versionId: plan.id, stripePriceId: plan.stripePriceId, quantity: 1, amountCents: amount(plan.productKey, plan.amountCents) }]
  const seen = new Set<string>()
  const addons: Contract['addons'] = selection.addons.map(addon => {
    const product = byKey.get(addon.key)
    const version = byId.get(addon.versionId)
    if (!product || product.kind !== 'addon' || !product.active || !version?.published || version.productKey !== addon.key || version.interval !== plan.interval || seen.has(addon.key)) throw new Error('BILLING_INVALID_ADDON')
    seen.add(addon.key)
    const quantity = integer(addon.quantity, 'QUANTITY')
    if (version.maximum !== null && quantity > version.maximum) throw new Error('BILLING_MAXIMUM')
    if (product.scope === 'tenant' && !product.resource && quantity > 1) throw new Error('BILLING_TENANT_QUANTITY')
    if (new Set(addon.venueIds).size !== addon.venueIds.length || new Set(addon.deviceIds).size !== addon.deviceIds.length) throw new Error('BILLING_DUPLICATE_ASSIGNMENT')
    if (product.scope === 'venue' && (addon.venueIds.length > quantity || addon.deviceIds.length)) throw new Error('BILLING_VENUE_QUANTITY')
    if (product.scope === 'device' && (addon.deviceIds.length > quantity || addon.venueIds.length)) throw new Error('BILLING_DEVICE_QUANTITY')
    if (product.scope === 'tenant' && (addon.venueIds.length || addon.deviceIds.length)) throw new Error('BILLING_TENANT_ASSIGNMENT')
    const included = (product.featureKey && plan.features.includes(product.featureKey) ? quantity : integer(plan.included[addon.key] ?? 0, 'INCLUDED')) + integer(exception?.freeUnits[addon.key] ?? 0, 'FREE_UNITS')
    const billable = Math.max(0, quantity - included)
    if (quantity > 0 && product.featureKey) features.add(product.featureKey)
    if (product.resource) limits[product.resource] += quantity
    if (billable > 0) lines.push({ key: addon.key, versionId: version.id, stripePriceId: version.stripePriceId, quantity: billable, amountCents: amount(addon.key, version.amountCents) })
    return { ...addon, featureKey: product.featureKey, scope: product.scope, included, billable }
  })
  for (const addon of addons) {
    if (!addon.quantity) continue
    const version = byId.get(addon.versionId)
    if (!version || version.requires.some(key => !features.has(key))) throw new Error('BILLING_MISSING_PREREQUISITE')
    if (addon.scope === 'venue') for (const venueId of addon.venueIds) {
      for (const requirement of version.requires) {
        if (plan.features.includes(requirement)) continue
        const prerequisite = addons.find(item => item.featureKey === requirement && item.quantity > 0)
        if (!prerequisite || (prerequisite.scope === 'venue' && !prerequisite.venueIds.includes(venueId))) throw new Error('BILLING_MISSING_VENUE_PREREQUISITE')
      }
    }
  }
  // Legacy readers still consume these assignment keys.
  const aliases: Record<string, string> = { promotions: 'discounts', costing: 'inventory_recipes', purchases: 'supplier_documents', document_ai: 'supplier_document_scanning' }
  for (const key of features) if (aliases[key]) features.add(aliases[key])
  for (const resource of ['venues', 'devices'] as const) {
    if (exception?.limits[resource] !== undefined) limits[resource] = integer(exception.limits[resource], 'LIMIT')
  }
  const subtotal = lines.reduce((sum, line) => sum + line.amountCents * line.quantity, 0)
  if (!Number.isSafeInteger(subtotal)) throw new Error('BILLING_AMOUNT_OVERFLOW')
  const recurringCents = Number((BigInt(subtotal) * BigInt(10_000 - discount) + 5_000n) / 10_000n)
  return { selection, planName: planProduct.name, interval: plan.interval, lines, addons, features: [...features].sort(), limits, recurringCents, exception }
}

export function changeTiming(current: Contract, next: Contract): 'immediate' | 'period_end' {
  // Any removal, even in a mixed upgrade, is scheduled. Never silently remove paid access early.
  if (current.interval !== next.interval || next.recurringCents < current.recurringCents || current.features.some(key => !next.features.includes(key)) || next.limits.venues < current.limits.venues || next.limits.devices < current.limits.devices) return 'period_end'
  for (const addon of current.addons) {
    const target = next.addons.find(item => item.key === addon.key)
    if (!target || target.quantity < addon.quantity || addon.venueIds.some(id => !target.venueIds.includes(id)) || addon.deviceIds.some(id => !target.deviceIds.includes(id))) return 'period_end'
  }
  return 'immediate'
}

export function stripeItems(current: { id: string; price: { id: string }; quantity: number }[], next: Line[]) {
  const result: Array<{ id?: string; price?: string; quantity?: number; deleted?: boolean }> = []
  const matched = new Set<string>()
  for (const item of current) {
    const line = next.find(value => value.stripePriceId === item.price.id)
    if (line && !matched.has(item.price.id)) { result.push({ id: item.id, price: item.price.id, quantity: line.quantity }); matched.add(item.price.id) }
    else result.push({ id: item.id, deleted: true })
  }
  for (const line of next) {
    if (!line.stripePriceId) throw new Error('BILLING_UNSYNCED_PRICE')
    if (!matched.has(line.stripePriceId)) result.push({ price: line.stripePriceId, quantity: line.quantity })
  }
  return result
}

export function matchesContract(items: { price: { id: string }; quantity: number }[], contract: Contract) {
  return items.length === contract.lines.length && contract.lines.every(line => items.some(item => item.price.id === line.stripePriceId && item.quantity === line.quantity))
}

export function mayProject(status: string, pending: boolean, latestInvoicePaid: boolean) {
  return !pending && (status === 'trialing' || (status === 'active' && latestInvoicePaid))
}

export function commercialState(status: string, delinquentSince: string | null, graceDays: number, now = Date.now()) {
  if (status === 'manual') return 'manual'
  if (['active', 'trialing'].includes(status)) return 'current'
  if (!delinquentSince || now < Date.parse(delinquentSince) + graceDays * 86_400_000) return 'grace'
  return 'restricted'
}

export function recurringMetrics(accounts: Array<{ status: string; contract: Contract | null }>) {
  // Sum annualized integer cents first; divide once. Taxes and one-off prorations are excluded.
  const arrCents = accounts.filter(row => row.status === 'active' || row.status === 'past_due').reduce((sum, row) => sum + (row.contract ? row.contract.recurringCents * (row.contract.interval === 'month' ? 12 : 1) : 0), 0)
  return { arrCents, mrrCents: Math.round(arrCents / 12) }
}
