import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { buildContract, changeTiming, commercialState, recurringMetrics } from './domain.ts'
import type { CommercialException, Contract, ContractAccess, Product, Selection, Version } from './domain.ts'
import { MollieRequestError, cents, dateOnly, epoch, grossCents, mollieInterval, money, netFromGross, normalizeIban } from './mollie.ts'
import type { MollieGateway, MollieMandate, MolliePayment, MollieSubscription } from './mollie.ts'
import { addMonths, promotionPhases, renewalOnOrAfter, resolvePromotions } from './promotions.ts'
import type { PromotionPhase, PromotionPreview } from './promotions.ts'
import { onboardingContract } from './onboarding.ts'
import { odooSyncDiagnostic } from './diagnostics.ts'
import type { OdooGateway } from './odoo.ts'
import { odooDocument, syncOdoo } from './odoo-sync.ts'
import type { BillingAddress, BillingProfile } from './profile.ts'
import { invoiceServiceSnapshot } from './invoice-description.ts'
import { billingLegalDocuments, billingLegalVersion, requireBillingLegalAcceptance } from './legal.ts'
import type { BillingLegalInput, BillingLegalReceipt } from './legal.ts'

// shortcut: the stripe_* columns/keys are kept (expand-only migrations) and now hold Mollie IDs (cst_, sub_, tr_); rename them in a contract migration.
export type Account = {
  tenant_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null
  source: string; status: string; legal_name: string | null; tax_id: string | null; email: string | null
  contract: Contract | null; billed_contract: Contract | null; revision: number; period_end: string | null; cancel_at_period_end: boolean
  delinquent_since: string | null; grace_days: number; last_payment_status: string | null
  last_reconciled_at: string | null; sync_error: string | null; created_at: string
  schedule_operation_id: string | null
  onboarding_contract: Contract | null
  odoo_partner_id: number | string | null
  billing_address: BillingAddress | null
}
type ProviderParams = {
  legalVersion?: string
  provider?: 'mollie'; subscriptionId: string | null; checkoutPolicy?: string; baseline?: string
  previousContract?: Contract | null; phases?: PromotionPhase[]; scheduleId?: string; cancelSchedule?: boolean; supersededOperationId?: string
}
export type Operation = {
  id: string; tenant_id: string; actor_id: string; kind: 'change' | 'cancel' | 'cancel_now'; reason: string
  status: string; contract: Contract | null; restore_contract: Contract | null
  timing: 'immediate' | 'period_end'; preview: { amountDueCents: number; recurringCents: number; renewalCents?: number | null; currency: string; effectiveAt: string | null; details: string; promotions?: PromotionPreview[]; afterPromotionCents?: number; losses?: string[] }
  stripe_params: ProviderParams
  result: { url?: string; paymentId?: string; mandateId?: string; scheduleId?: string } | null; created_at: string; proration_date: number; effective_at: string | null
}
export type ConfirmInput = { sepa?: { accountHolder: string; iban: string }; payer?: Pick<BillingProfile, 'legalName' | 'taxId'> & Partial<Pick<BillingProfile, 'email' | 'address'>>; acceptLosses?: boolean; legal?: BillingLegalInput }
// What the owner chose to switch off (downgrade) or back on (upgrade) with a plan change.
export type AccessRequest = { deactivateVenueIds: string[]; deactivateDeviceIds: string[]; reactivateVenueIds: string[] }
type UsageVenue = { id: string; name: string; is_active: boolean }
type UsageDevice = { id: string; name: string; venue_id: string; is_active: boolean }
const unique = (ids: string[] | undefined) => [...new Set(ids ?? [])].sort()

function confirmationResult(operation: Operation) {
  if (['failed', 'expired'].includes(operation.status)) throw new Error('BILLING_STALE')
  if (operation.status === 'applying') throw new Error('BILLING_ACTION_REQUIRED')
  return { operation, url: operation.status === 'payment_pending' ? operation.result?.url : undefined }
}
type VersionRow = { id: string; product_key: string; interval: 'month' | 'year'; amount_cents: number; features: string[]; limits: Version['limits']; included: Record<string, number>; maximum: number | null; requires: string[]; stripe_price_id: string | null; published: boolean }
type ProductRow = { key: string; kind: Product['kind']; name: string; description: string; scope: Product['scope']; feature_key: string | null; resource: Product['resource']; active: boolean; sort_order: number }
const iso = (seconds: number | undefined | null) => seconds ? new Date(seconds * 1000).toISOString() : null
const now = () => Math.floor(Date.now() / 1000)
const months = (interval: Contract['interval']) => interval === 'year' ? 12 : 1
const live = (sub: MollieSubscription) => ['active', 'pending', 'suspended'].includes(sub.status)
const settled = (payment: MolliePayment) => payment.status === 'paid' && cents(payment.amountChargedBack) === 0
const failed = (payment: MolliePayment) => ['failed', 'expired', 'canceled'].includes(payment.status) || cents(payment.amountChargedBack) > 0
// Accepted SEPA debits stay pending for days before the money arrives. Access is kept meanwhile.
const inTransit = (payment: MolliePayment) => ['open', 'pending', 'authorized'].includes(payment.status)
// Upgrades are paid in Mollie Checkout (one-off); older in-flight ones were SEPA recurring debits.
const cardCheckout = (payment: MolliePayment) => payment.metadata?.tickit_kind === 'proration' && payment.sequenceType === 'oneoff'
const baseline = (sub: MollieSubscription) => JSON.stringify({ status: sub.status, amount: sub.amount, interval: sub.interval, next: sub.nextPaymentDate, mandate: sub.mandateId })
const phaseAt = (phases: PromotionPhase[], at: number) => phases.find(phase => phase.start <= at && at < phase.end) ?? (at < phases[0].start ? null : phases.at(-1) ?? null)
const restoreAt = (op: Operation) => op.effective_at && op.contract?.exception?.cycles ? addMonths(epoch(op.effective_at), op.contract.exception.cycles * months(op.contract.interval)) : null
// Contract in force at `at` for a renewal-boundary change, before or after its temporary concession.
function scheduledContract(op: Operation, at: number) {
  if (!op.effective_at || at < epoch(op.effective_at)) return null
  const restore = restoreAt(op)
  return op.restore_contract && restore !== null && at >= restore ? op.restore_contract : op.contract
}
// Linear proration of the net recurring increase over the remaining period. No refunds on decreases.
export function prorationNet(current: Contract, next: Contract, periodEnd: number, at: number) {
  const start = addMonths(periodEnd, -months(current.interval))
  const remaining = Math.min(Math.max(periodEnd - at, 0), periodEnd - start)
  const delta = next.recurringCents - current.recurringCents
  if (delta <= 0 || periodEnd <= start) return 0
  return Number((BigInt(delta) * BigInt(remaining) * 2n + BigInt(periodEnd - start)) / (BigInt(periodEnd - start) * 2n))
}

export class BillingService {
  readonly db: SupabaseClient
  readonly mollie: MollieGateway
  readonly appUrl: string
  readonly webhookUrl: string
  readonly odoo: OdooGateway | null
  constructor(db: SupabaseClient, mollie: MollieGateway, appUrl: string, webhookUrl: string, odoo: OdooGateway | null = null) {
    this.db = db; this.mollie = mollie; this.appUrl = appUrl; this.webhookUrl = webhookUrl; this.odoo = odoo
  }

  async transition<T>(action: string, data: object): Promise<T> {
    const result = await this.db.rpc('billing_transition', { p_action: action, p_data: data })
    if (result.error) {
      const known = ['BILLING_STALE','BILLING_FORBIDDEN','BILLING_SYNC_BUSY','BILLING_EVENT_BUSY','BILLING_PRODUCT_IDENTITY_IMMUTABLE','BILLING_PENDING_CHANGE']
      throw new Error(known.includes(result.error.message) ? result.error.message : `BILLING_DB_${result.error.code}`)
    }
    return result.data as T
  }
  async account(tenantId: string): Promise<Account> {
    const result = await this.db.from('billing_accounts').select('*').eq('tenant_id', tenantId).maybeSingle<Account>()
    if (result.error) throw new Error('BILLING_DB_READ')
    if (result.data) {
      // Legacy Stripe sandbox links cannot be read through Mollie.
      if (result.data.stripe_customer_id && !result.data.stripe_customer_id.startsWith('cst_')) throw new Error('BILLING_LEGACY_PROVIDER')
      return result.data
    }
    const created = await this.db.from('billing_accounts').upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id', ignoreDuplicates: true })
    if (created.error) throw new Error('BILLING_DB_ACCOUNT')
    return this.account(tenantId)
  }
  async saveProfile(tenantId: string, actorId: string, profile: ConfirmInput['payer']) {
    if (!profile) throw new Error('BILLING_INVALID_REQUEST')
    const saved = await this.db.rpc('billing_save_profile', { p_tenant_id: tenantId, p_data: { ...profile, actorId } })
    if (saved.error) throw new Error('BILLING_DB_PROFILE')
    return { saved: true }
  }
  async catalog() {
    const [p, v, features] = await Promise.all([
      this.db.from('billing_products').select('*').order('sort_order').returns<ProductRow[]>(),
      this.db.from('billing_price_versions').select('*').order('created_at', { ascending: false }).returns<VersionRow[]>(),
      this.db.from('platform_features').select('key,name,is_core').eq('is_active', true),
    ])
    if (p.error || v.error || features.error) throw new Error('BILLING_DB_CATALOG')
    const products: Product[] = (p.data ?? []).map(row => ({ key: row.key, kind: row.kind, name: row.name, description: row.description, scope: row.scope, featureKey: row.feature_key, resource: row.resource, active: row.active, sortOrder: row.sort_order }))
    const versions: Version[] = (v.data ?? []).map(row => ({ id: row.id, productKey: row.product_key, interval: row.interval, amountCents: row.amount_cents, features: row.features, limits: row.limits, included: row.included, maximum: row.maximum, requires: row.requires, stripePriceId: row.stripe_price_id, published: row.published }))
    return { products, versions, features: features.data ?? [] }
  }
  async publish(versionId: string) {
    const { versions } = await this.catalog()
    const version = versions.find(row => row.id === versionId)
    if (!version) throw new Error('BILLING_VERSION_NOT_FOUND')
    if (version.published) return version
    // Mollie has no price objects; amounts come from the contract. The legacy CHECK still needs a reference.
    const reference = `mollie_${version.id}`
    const update = await this.db.from('billing_price_versions').update({ stripe_price_id: reference, published: true }).eq('id', versionId)
    if (update.error) throw new Error('BILLING_DB_PUBLISH')
    return { ...version, stripePriceId: reference, published: true }
  }
  async detail(tenantId: string, admin: boolean) {
    const account = await this.account(tenantId)
    const scheduled = await this.scheduleOperation(account)
    const [tenant, venues, devices, invoices, operations, audit] = await Promise.all([
      this.db.from('tenants').select('id,name,max_venues,max_devices,billing_activation_required').eq('id', tenantId).single(),
      this.db.from('venues').select('id,name,is_active').eq('tenant_id', tenantId),
      this.db.from('devices').select('id,name,venue_id,is_active').eq('tenant_id', tenantId),
      this.db.from('billing_invoices').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100),
      this.db.from('billing_operations').select('id,kind,status,timing,preview,result,reason,created_at,effective_at,contract').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(50),
      admin ? this.db.from('billing_audit').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    ])
    if ([tenant, venues, devices, invoices, operations, audit].some(result => result.error)) throw new Error('BILLING_DB_DETAIL')
    const odooDocs = await this.db.from('billing_odoo_documents').select('payment_id,state,refund_id').eq('tenant_id', tenantId).limit(1000)
    if (odooDocs.error) throw new Error('BILLING_DB_DETAIL')
    const docs = new Map((odooDocs.data ?? []).map(doc => [doc.payment_id, doc]))
    const invoiceRows = (invoices.data ?? []).map(row => ({ ...row, odoo_state: docs.get(row.stripe_invoice_id)?.state ?? null, has_refund: Boolean(docs.get(row.stripe_invoice_id)?.refund_id) }))
    const history = operations.data ?? []
    if (scheduled && !history.some(row => row.id === scheduled.id)) {
      const { id, kind, status, timing, preview, result, reason, created_at, effective_at, contract } = scheduled
      history.push({ id, kind, status, timing, preview, result, reason, created_at, effective_at, contract })
    }
    const legal = await this.db.rpc('billing_legal_receipts', { p_tenant_id: tenantId, p_data: {} })
    if (legal.error) throw new Error('BILLING_DB_LEGAL')
    return { account, legalAcceptances: legal.data, scheduledContract: scheduled?.contract ?? null, tenant: tenant.data, venues: venues.data, devices: devices.data, paymentMethod: await this.paymentMethod(account), invoices: invoiceRows, operations: history, audit: audit.data, commercialState: commercialState(account.status, account.delinquent_since, account.grace_days) }
  }
  // Masked direct-debit account of the live subscription. Never returns or logs the full IBAN.
  async paymentMethod(account: Account) {
    try {
      const sub = await this.subscription(account)
      if (!sub?.mandateId || !live(sub)) return null
      const mandate = await this.mollie.request<MollieMandate>('GET', `/customers/${sub.customerId}/mandates/${sub.mandateId}`)
      const iban = mandate.details?.consumerAccount ?? ''
      return { method: mandate.method, status: mandate.status, last4: iban.slice(-4) || null }
    } catch { return null }
  }
  async overview() {
    // Paginate; PostgREST's default 1000-row cap must not silently undercount revenue.
    const accounts: Account[] = []
    for (let offset = 0; ; offset += 500) {
      const result = await this.db.from('billing_accounts').select('*').order('tenant_id').range(offset, offset + 499).returns<Account[]>()
      if (result.error) throw new Error('BILLING_DB_OVERVIEW')
      accounts.push(...result.data)
      if (result.data.length < 500) break
    }
    const [tenants, venues, events, invoices, odooFailed] = await Promise.all([
      this.db.from('tenants').select('id,name').order('name').limit(1000),
      this.db.from('venues').select('tenant_id').limit(1000),
      this.db.from('billing_stripe_events').select('*').order('created_at', { ascending: false }).limit(100),
      this.db.from('billing_invoices').select('amount_paid_cents,paid_excluding_tax_cents').gte('paid_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).limit(1000),
      this.db.from('billing_odoo_documents').select('payment_id').eq('state', 'failed').limit(1000),
    ])
    if ([tenants, venues, events, invoices, odooFailed].some(result => result.error)) throw new Error('BILLING_DB_OVERVIEW')
    const names = new Map((tenants.data ?? []).map(row => [row.id, row.name]))
    return { accounts: accounts.map(account => ({ ...account, contract: account.billed_contract ?? account.contract, name: names.get(account.tenant_id) ?? account.tenant_id, venueCount: (venues.data ?? []).filter(row => row.tenant_id === account.tenant_id).length })), events: events.data,
      metrics: { ...recurringMetrics(accounts.map(account => ({ status: account.status, contract: account.billed_contract ?? account.contract }))), paidCents: (invoices.data ?? []).reduce((sum, row) => sum + row.amount_paid_cents, 0), paidExcludingTaxCents: (invoices.data ?? []).reduce((sum, row) => sum + row.paid_excluding_tax_cents, 0) },
      odoo: { enabled: this.odoo !== null, failed: odooFailed.data?.length ?? 0 },
      truncated: (tenants.data?.length ?? 0) >= 1000 || (venues.data?.length ?? 0) >= 1000 || (invoices.data?.length ?? 0) >= 1000 }
  }
  async saveOnboarding(tenantId: string, selection: Selection) {
    const contract = onboardingContract(await this.catalog(), selection)
    await this.validateSelection(tenantId, contract)
    const result = await this.db.rpc('billing_save_onboarding', { p_tenant_id: tenantId, p_contract: contract })
    if (result.error) throw new Error(result.error.message === 'BILLING_PENDING_CHANGE' ? 'BILLING_PENDING_CHANGE' : 'BILLING_DB_ONBOARDING')
    return { saved: true }
  }
  async inflight(tenantId: string) {
    const result = await this.db.from('billing_operations').select('*').eq('tenant_id', tenantId).in('status', ['applying','payment_pending','scheduled']).order('created_at', { ascending: false }).returns<Operation[]>()
    if (result.error) throw new Error('BILLING_DB_OPERATION')
    return result.data
  }
  async restartCheckout(tenantId: string) {
    const tenant = await this.db.from('tenants').select('billing_activation_required').eq('id', tenantId).single()
    if (tenant.error || !tenant.data.billing_activation_required) throw new Error('BILLING_PENDING_CHANGE')
    const account = await this.account(tenantId)
    if (account.stripe_customer_id) await this.reconcile(tenantId)
    for (const op of await this.inflight(tenantId)) {
      if (op.status !== 'payment_pending' || !op.result?.paymentId) throw new Error('BILLING_PENDING_CHANGE')
      let payment = await this.payment(account, op.result.paymentId)
      // A card checkout that may still be paid must not be abandoned: it would charge without service.
      if (payment.status === 'open') {
        try { payment = await this.mollie.request<MolliePayment>('DELETE', `/payments/${payment.id}`) } catch { throw new Error('BILLING_PENDING_CHANGE') }
      }
      if (!payment || !['canceled','expired','failed'].includes(payment.status)) throw new Error('BILLING_PENDING_CHANGE')
      const expired = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', op.id).eq('status', 'payment_pending')
      if (expired.error) throw new Error('BILLING_DB_OPERATION')
    }
    return { editable: true }
  }
  async payment(account: Account, id: string) {
    const payment = await this.mollie.request<MolliePayment>('GET', `/payments/${id}`)
    if (payment.id !== id || payment.customerId !== account.stripe_customer_id || (payment.metadata?.tickit_tenant_id && payment.metadata.tickit_tenant_id !== account.tenant_id)) throw new Error('BILLING_PAYMENT_MISMATCH')
    return payment
  }
  async subscription(account: Account) {
    if (!account.stripe_subscription_id || !account.stripe_customer_id) return null
    const sub = await this.mollie.request<MollieSubscription>('GET', `/customers/${account.stripe_customer_id}/subscriptions/${account.stripe_subscription_id}`)
    if (sub.id !== account.stripe_subscription_id || sub.customerId !== account.stripe_customer_id || sub.metadata?.tickit_tenant_id !== account.tenant_id) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
    return sub
  }
  async scheduleOperation(account: Account) {
    if (!account.schedule_operation_id) return null
    const stored = await this.db.from('billing_operations').select('*').eq('tenant_id', account.tenant_id).eq('id', account.schedule_operation_id).single<Operation>()
    if (stored.error || !stored.data.stripe_params.phases) throw new Error('BILLING_DB_OPERATION')
    return stored.data
  }
  async usage(tenantId: string) {
    const [venues, devices] = await Promise.all([
      this.db.from('venues').select('id,name,is_active').eq('tenant_id', tenantId).returns<UsageVenue[]>(),
      this.db.from('devices').select('id,name,venue_id,is_active').eq('tenant_id', tenantId).returns<UsageDevice[]>(),
    ])
    if (venues.error || devices.error) throw new Error('BILLING_DB_USAGE')
    return { venues: venues.data, devices: devices.data }
  }
  // Capacity counts what stays active after the contract's own deactivations/reactivations.
  async validateSelection(tenantId: string, contract: Contract) {
    const { venues, devices } = await this.usage(tenantId)
    const access = contract.access
    const venueOff = new Set(access?.deactivateVenueIds), venueOn = new Set(access?.reactivateVenueIds)
    const deviceOff = new Set(access?.deactivateDeviceIds), deviceOn = new Set(access?.reactivateDeviceIds)
    const venue = new Map(venues.map(row => [row.id, row])), device = new Map(devices.map(row => [row.id, row]))
    if ([...venueOff].some(id => !venue.get(id)?.is_active) || [...venueOn].some(id => venue.get(id)?.is_active !== false)
      || [...deviceOff].some(id => !device.get(id)?.is_active) || [...deviceOn].some(id => { const row = device.get(id); return !row || row.is_active || !venueOn.has(row.venue_id) })) throw new Error('BILLING_FOREIGN_ASSIGNMENT')
    const activeVenues = new Set(venues.filter(row => row.is_active ? !venueOff.has(row.id) : venueOn.has(row.id)).map(row => row.id))
    const activeDevices = new Set(devices.filter(row => row.is_active ? !deviceOff.has(row.id) && !venueOff.has(row.venue_id) : deviceOn.has(row.id)).map(row => row.id))
    if (activeVenues.size > contract.limits.venues || activeDevices.size > contract.limits.devices) throw new Error('BILLING_LIMIT_BELOW_USAGE')
    for (const addon of contract.addons) {
      if (addon.venueIds.some(id => !activeVenues.has(id)) || addon.deviceIds.some(id => !activeDevices.has(id))) throw new Error('BILLING_FOREIGN_ASSIGNMENT')
    }
  }
  // Devices of a switched-off venue go with it. Reactivating a venue brings back only the
  // terminals billing switched off, never ones the owner retired by hand.
  async contractAccess(tenantId: string, request: AccessRequest | null): Promise<ContractAccess | undefined> {
    const deactivateVenueIds = unique(request?.deactivateVenueIds), reactivateVenueIds = unique(request?.reactivateVenueIds)
    if (!deactivateVenueIds.length && !reactivateVenueIds.length && !request?.deactivateDeviceIds.length) return undefined
    const { devices } = await this.usage(tenantId)
    const deactivateDeviceIds = unique([...(request?.deactivateDeviceIds ?? []), ...devices.filter(row => row.is_active && deactivateVenueIds.includes(row.venue_id)).map(row => row.id)])
    let reactivateDeviceIds: string[] = []
    if (reactivateVenueIds.length) {
      const history = await this.db.from('billing_operations').select('contract').eq('tenant_id', tenantId).eq('status', 'completed').returns<Pick<Operation, 'contract'>[]>()
      if (history.error) throw new Error('BILLING_DB_OPERATION')
      const switchedOff = new Set(history.data.flatMap(row => row.contract?.access?.deactivateDeviceIds ?? []))
      reactivateDeviceIds = unique(devices.filter(row => !row.is_active && reactivateVenueIds.includes(row.venue_id) && switchedOff.has(row.id)).map(row => row.id))
    }
    return { deactivateVenueIds, deactivateDeviceIds, reactivateVenueIds, reactivateDeviceIds }
  }
  // Plain-language list of what stops working at renewal; the owner must accept it before confirming.
  async losses(tenantId: string, current: Contract | null, next: Contract, products: Product[], features: { key: string; name: string }[]) {
    const { venues, devices } = await this.usage(tenantId)
    const venueName = (id: string) => venues.find(row => row.id === id)?.name ?? 'Local'
    const off = new Set(next.access?.deactivateVenueIds)
    const result = [...off].map(id => {
      const terminals = devices.filter(row => row.venue_id === id && row.is_active).length
      return `Local «${venueName(id)}»${terminals ? ` y sus ${terminals} ${terminals === 1 ? 'terminal' : 'terminales'} TPV` : ''}: quedará inactivo (se conservan sus datos).`
    })
    for (const id of next.access?.deactivateDeviceIds ?? []) {
      const row = devices.find(item => item.id === id)
      if (row && !off.has(row.venue_id)) result.push(`Terminal «${row.name}»: quedará inactivo.`)
    }
    if (current) {
      const label = (key: string) => products.find(row => row.featureKey === key)?.name ?? features.find(row => row.key === key)?.name ?? key
      const shown = new Set(features.map(row => row.key))
      for (const key of current.features) if (!next.features.includes(key) && shown.has(key)) result.push(`${label(key)}: dejará de estar disponible.`)
      for (const addon of current.addons) {
        if (addon.scope !== 'venue' || !addon.featureKey || !next.features.includes(addon.featureKey)) continue
        const kept = next.addons.find(row => row.key === addon.key)?.venueIds ?? []
        for (const id of addon.venueIds) if (!kept.includes(id) && !off.has(id)) result.push(`${label(addon.featureKey)} en «${venueName(id)}»: dejará de estar disponible.`)
      }
    }
    return result
  }
  async quote(tenantId: string, actorId: string, selection: Selection, exception: CommercialException | null, reason: string, isSuperadmin = false, accessRequest: AccessRequest | null = null) {
    const account = await this.account(tenantId)
    // Never stack a second economic change on a debit the bank has not settled yet.
    if (['processing','pending'].includes(account.last_payment_status ?? '')) throw new Error('BILLING_PENDING_CHANGE')
    if (commercialState(account.status, account.delinquent_since, account.grace_days) === 'restricted' && !['canceled','incomplete_expired'].includes(account.status)) throw new Error('BILLING_PAYMENT_REQUIRED')
    const { products, versions, features } = await this.catalog()
    const existingContract = account.billed_contract ?? account.contract
    const scheduled = await this.scheduleOperation(account)
    const agreement = scheduled?.contract ?? existingContract ?? account.onboarding_contract
    if (!isSuperadmin) {
      if (exception) throw new Error('BILLING_FORBIDDEN')
      exception = agreement?.exception ?? null
      const retained = new Set([agreement?.selection.planVersionId, ...(agreement?.selection.addons.map(addon => addon.versionId) ?? [])])
      const current = new Map<string, string>()
      for (const version of versions) if (version.published && !current.has(`${version.productKey}:${version.interval}`)) current.set(`${version.productKey}:${version.interval}`,version.id)
      for (const id of [selection.planVersionId,...selection.addons.map(addon => addon.versionId)]) {
        const version = versions.find(row => row.id === id)
        if (!version || (!retained.has(id) && current.get(`${version.productKey}:${version.interval}`) !== id)) throw new Error('BILLING_INVALID_HISTORICAL_TARIFF')
      }
    }
    // N-1 admin clients do not send the promotions field. Omission cannot revoke
    // a signed grant; the new editor sends an explicit [] to withdraw promotions.
    if (isSuperadmin && exception?.promotions === undefined && agreement?.exception?.promotions?.length) {
      exception = { ...(exception ?? { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason }), promotions: agreement.exception.promotions }
    }
    const effectiveProducts = products.map(product => {
      if (product.active) return product
      const existingPlan = existingContract && versions.find(version => version.id === existingContract.selection.planVersionId)
      if (existingPlan?.productKey === product.key && selection.planVersionId === existingPlan.id) return { ...product, active: true }
      const previous = existingContract?.selection.addons.find(addon => addon.key === product.key)
      const requested = selection.addons.find(addon => addon.key === product.key)
      return previous && requested && previous.versionId === requested.versionId && requested.quantity <= previous.quantity ? { ...product, active: true } : product
    })
    // Reject foreign assignments and invalid quantities before any Mollie request.
    const access = await this.contractAccess(tenantId, accessRequest)
    await this.validateSelection(tenantId, { ...buildContract(effectiveProducts, versions, selection, exception), access })
    const linked = await this.subscription(account)
    if (linked && linked.status !== 'active' && live(linked)) throw new Error('BILLING_PENDING_CHANGE')
    const subscription = linked?.status === 'active' ? linked : null
    // A cancelled subscription keeps its paid period; a new signup would charge it twice.
    if (account.cancel_at_period_end && account.period_end && Date.parse(account.period_end) > Date.now()) throw new Error('BILLING_PENDING_CHANGE')
    if ((await this.inflight(tenantId)).some(op => !op.stripe_params.phases)) throw new Error('BILLING_PENDING_CHANGE')
    const at = now()
    if (exception?.promotions?.length || scheduled) {
      // Promotion timelines keep their venues; capacity changes go through a normal plan change.
      if (access) throw new Error('BILLING_INVALID_PROMOTION_CONTRACT')
      exception ??= { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason }
      if (!subscription || !existingContract || exception.cycles || existingContract.exception?.cycles || !subscription.nextPaymentDate) throw new Error('BILLING_INVALID_PROMOTION_CONTRACT')
      const renewal = epoch(subscription.nextPaymentDate)
      const promotions = resolvePromotions(exception.promotions ?? [], agreement?.exception?.promotions ?? [], selection, at, renewal, existingContract.interval, epoch(subscription.startDate))
      return this.quotePromotions(account, actorId, selection, { ...exception, promotions }, reason, effectiveProducts, versions, subscription, at, agreement)
    }
    const next: Contract = { ...buildContract(effectiveProducts, versions, selection, exception), ...(access ? { access } : {}) }
    await this.validateSelection(tenantId, next)
    if (exception?.cycles && !subscription) throw new Error('BILLING_TEMPORARY_REQUIRES_SUBSCRIPTION')
    // Switching venues/devices off is a reduction: it waits for the renewal like any other.
    const switchesOff = Boolean(access?.deactivateVenueIds.length || access?.deactivateDeviceIds.length)
    const timing = exception?.cycles || (subscription && switchesOff) ? 'period_end' : subscription && account.contract ? changeTiming(account.contract, next) : 'immediate'
    const losses = await this.losses(tenantId, subscription ? account.contract : null, next, effectiveProducts, features)
    const restore = exception?.cycles ? buildContract(effectiveProducts, versions, selection) : null
    const periodEnd = subscription?.nextPaymentDate ? epoch(subscription.nextPaymentDate) : null
    if (subscription && (!periodEnd || !existingContract)) throw new Error('BILLING_PENDING_CHANGE')
    const amountDueCents = !subscription ? grossCents(next.recurringCents) : timing === 'immediate' && existingContract && periodEnd ? grossCents(prorationNet(existingContract, next, periodEnd, at)) : 0
    const details = !subscription
      ? 'Primera cuota con tarjeta en Mollie, IVA del 21 % incluido. Las siguientes cuotas se cobrarán por domiciliación SEPA.'
      : timing === 'period_end'
        ? 'Cambio al vencimiento; sin cargo inmediato. La siguiente cuota se cobrará con el nuevo importe, IVA del 21 % incluido. Cuotas recurrentes sin IVA.'
        : amountDueCents > 0
          ? 'Pagarás ahora con tarjeta en Mollie la parte proporcional del aumento hasta la renovación, IVA del 21 % incluido. El acceso se amplía al confirmarse el pago. Cuotas recurrentes sin IVA.'
          : 'Sin cargo inmediato. El cambio se aplica ahora y la siguiente cuota se cobrará con el nuevo importe, IVA del 21 % incluido. Cuotas recurrentes sin IVA.'
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: 'change', contract: next, restoreContract: restore, timing,
      stripeParams: { provider: 'mollie', subscriptionId: subscription?.id ?? null, ...(!subscription ? { checkoutPolicy: 'mollie_card_sepa_v1', legalVersion: billingLegalVersion } : { baseline: baseline(subscription), previousContract: existingContract }) },
      preview: { amountDueCents, renewalCents: timing === 'period_end' ? grossCents(next.recurringCents) : null, recurringCents: next.recurringCents, currency: 'eur', effectiveAt: timing === 'period_end' ? iso(periodEnd) : null, details, ...(losses.length ? { losses } : {}) }, reason, prorationDate: at })
  }
  async quotePromotions(account: Account, actorId: string, selection: Selection, exception: CommercialException, reason: string, products: Product[], versions: Version[], sub: MollieSubscription, at: number, agreement: Contract | null) {
    const current = account.billed_contract ?? account.contract
    if (!current || !sub.nextPaymentDate) throw new Error('BILLING_CONTRACT_REQUIRED')
    const renewal = epoch(sub.nextPaymentDate), anchor = epoch(sub.startDate)
    const requested = buildContract(products, versions, selection, exception, at)
    if (requested.interval !== current.interval) throw new Error('BILLING_INVALID_PROMOTION_DATE')
    const fresh = (exception.promotions ?? []).filter(p => !(agreement?.exception?.promotions ?? []).some(old => old.id === p.id))
    const immediate = fresh.some(p => p.start === 'immediate')
    // Only the newly granted units may change the bill immediately; existing paid
    // periods are not refunded. Other prices, discounts and reductions use renewal.
    const grantedKeys = new Set(fresh.filter(p => p.start === 'immediate').map(p => p.key))
    const grantOnly = current.lines.every(line => {
      const target = requested.lines.find(row => row.key === line.key)
      return grantedKeys.has(line.key) ? !target || target.versionId === line.versionId && target.quantity <= line.quantity : target?.versionId === line.versionId && target.quantity === line.quantity && target.amountCents === line.amountCents
    }) && requested.lines.every(line => current.lines.some(row => row.key === line.key))
    if (immediate && (!grantOnly || changeTiming(current, { ...requested, recurringCents: current.recurringCents }) !== 'immediate' || requested.recurringCents > current.recurringCents || requested.exception?.discountBasisPoints !== (current.exception?.discountBasisPoints ?? 0))) throw new Error('BILLING_INVALID_PROMOTION_IMMEDIATE_CHANGE')
    const effective = immediate ? at : renewal
    if (fresh.some(p => (p.startsAt ?? 0) < effective)) throw new Error('BILLING_INVALID_PROMOTION_DATE')
    const phases = promotionPhases(products, versions, selection, exception, current, effective, addMonths(renewal, -months(current.interval)), at, renewal)
    // Preserve existing grants until a deferred change, including expirations before renewal.
    for (const phase of phases) {
      if (phase.start < effective && !immediate) {
        const retainedKeys = new Set([versions.find(v => v.id === current.selection.planVersionId)?.productKey, ...current.selection.addons.map(addon => addon.key)])
        phase.contract = buildContract(products.map(product => retainedKeys.has(product.key) ? { ...product, active: true } : product), versions, current.selection, current.exception, Math.max(at, phase.start))
      }
      await this.validateSelection(account.tenant_id, phase.contract)
    }
    const next = phases.find(p => p.start <= effective && effective < p.end)?.contract
    if (!next) throw new Error('BILLING_INVALID_PROMOTION_DATE')
    const previews: PromotionPreview[] = (exception.promotions ?? []).map(promotion => {
      const firstCharge = renewalOnOrAfter(promotion.endsAt ?? at, renewal, next.interval, anchor)
      const after = buildContract(products, versions, selection, exception, firstCharge)
      const line = after.lines.find(l => l.key === promotion.key)
      const version = versions.find(v => v.id === selection.addons.find(a => a.key === promotion.key)?.versionId)
      return { id: promotion.id, key: promotion.key, freeUnits: promotion.freeUnits, activationAt: iso(promotion.startsAt) ?? '', endsAt: iso(promotion.endsAt) ?? '', firstChargeAt: line && line.amountCents > 0 && exception.discountBasisPoints < 10_000 ? iso(firstCharge) : null, regularUnitCents: exception.customAmounts[promotion.key] ?? version?.amountCents ?? 0, firstAddonChargeCents: line ? Number((BigInt(line.amountCents) * BigInt(line.quantity) * BigInt(10_000 - exception.discountBasisPoints) + 5_000n) / 10_000n) : 0, firstInvoiceCents: grossCents(after.recurringCents), prorated: false }
    })
    const renewalPhase = phaseAt(phases, renewal)
    return this.transition<Operation>('quote', { tenantId: account.tenant_id, actorId, revision: account.revision, kind: 'change', contract: next, restoreContract: null, timing: immediate ? 'immediate' : 'period_end',
      stripeParams: { provider: 'mollie', subscriptionId: sub.id, baseline: baseline(sub), phases },
      preview: { amountDueCents: 0, recurringCents: next.recurringCents, afterPromotionCents: phases.at(-1)?.contract.recurringCents, renewalCents: grossCents((renewalPhase?.contract ?? current).recurringCents), currency: 'eur', effectiveAt: iso(effective), promotions: previews, details: 'Sin cargos ni prorrateos ahora o al cambiar de fase. Si la promoción termina entre renovaciones, el tramo restante es gratuito y el precio habitual se cobra en la siguiente renovación. Cambios de plan, cantidades o retirada de promociones: próxima renovación. Importes recurrentes sin IVA; cuotas estimadas con IVA del 21 %.' }, reason, prorationDate: at })
  }
  async quoteCancel(tenantId: string, actorId: string, immediate: boolean, reason: string) {
    const account = await this.account(tenantId)
    const sub = await this.subscription(account)
    const ops = await this.inflight(tenantId)
    if (!sub || !live(sub) || ops.some(op => op.status !== 'scheduled')) throw new Error('BILLING_PENDING_CHANGE')
    // A cancellation may supersede its own pending renewal change; never a promotion timeline still to start.
    const scheduled = ops.find(op => op.status === 'scheduled')
    if (scheduled && (scheduled.stripe_params.phases || scheduled.result?.scheduleId !== sub.id)) throw new Error('BILLING_PENDING_CHANGE')
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: immediate ? 'cancel_now' : 'cancel', contract: null, restoreContract: null, timing: immediate ? 'immediate' : 'period_end',
      stripeParams: { provider: 'mollie', subscriptionId: sub.id, baseline: baseline(sub), ...(scheduled ? { scheduleId: sub.id, cancelSchedule: true, supersededOperationId: scheduled.id } : {}) },
      preview: { amountDueCents: 0, recurringCents: 0, currency: 'eur', effectiveAt: immediate ? new Date().toISOString() : iso(sub.nextPaymentDate ? epoch(sub.nextPaymentDate) : null), details: 'No se reembolsan periodos pagados. Un adeudo SEPA ya aceptado se mantiene hasta que el banco lo liquide. La baja sustituye cualquier cambio o promoción programados. Se conserva la información y la continuidad operativa.' }, reason, prorationDate: now() })
  }
  async mutate<T>(op: Operation, work: () => Promise<T>, releaseOnRejection: boolean) {
    try { return await work() }
    catch (error) {
      const diagnostic = error instanceof MollieRequestError ? error.diagnostic : { outcome: 'uncertain', code: 'MOLLIE_TRANSPORT_OR_RESPONSE_ERROR' }
      await this.transition('apply_error', { tenantId: op.tenant_id, operationId: op.id, error: diagnostic, release: releaseOnRejection && diagnostic.outcome === 'rejected' })
      throw error
    }
  }
  // Lookups by metadata make retries safe after Mollie's idempotency window has passed.
  async operationPayment(customerId: string, op: Operation, kind: string) {
    const payments = await this.mollie.list<MolliePayment>(`/customers/${customerId}/payments`, 'payments')
    return payments.find(row => row.metadata?.tickit_operation_id === op.id && row.metadata.tickit_kind === kind) ?? null
  }
  async sepaMandate(op: Operation, customerId: string, accountHolder: string | undefined, iban: string | null, release: boolean) {
    const reference = `TICKIT-${op.id.slice(0, 8).toUpperCase()}`
    const mandates = await this.mollie.list<MollieMandate>(`/customers/${customerId}/mandates`, 'mandates')
    const existing = mandates.find(row => row.mandateReference === reference && row.method === 'directdebit' && ['valid','pending'].includes(row.status))
    if (existing) return existing
    if (!iban || !accountHolder) throw new Error('BILLING_SEPA_REQUIRED')
    return this.mutate(op, () => this.mollie.request<MollieMandate>('POST', `/customers/${customerId}/mandates`, { method: 'directdebit', consumerName: accountHolder, consumerAccount: iban, signatureDate: dateOnly(now()), mandateReference: reference }, `tickit:${op.id}:mandate`), release)
  }
  async confirm(tenantId: string, actorId: string, operationId: string, retry = false, input: ConfirmInput = {}) {
    const before = await this.db.from('billing_operations').select('*').eq('id', operationId).eq('tenant_id', tenantId).single<Operation>()
    if (before.error) throw new Error('BILLING_OPERATION_NOT_FOUND')
    if (before.data.status !== 'quoted' && !retry) return { ...confirmationResult(before.data), acceptance: await this.legalAcceptance(tenantId, operationId) }
    if (retry && (before.data.status !== 'applying' || Date.now() - Date.parse(before.data.created_at) > 23 * 3600_000)) throw new Error('BILLING_MANUAL_RECONCILIATION_REQUIRED')
    // Stripe-era quotes cannot be executed against Mollie.
    if (before.data.stripe_params.provider !== 'mollie') throw new Error('BILLING_STALE_PROVIDER_QUOTE')
    const signup = before.data.kind === 'change' && !before.data.stripe_params.subscriptionId
    const iban = input.sepa ? normalizeIban(input.sepa.iban) : null
    if (signup && !retry && !iban) throw new Error('BILLING_SEPA_REQUIRED')
    if (signup && !retry) requireBillingLegalAcceptance(input.legal)
    if (signup && retry && before.data.stripe_params.legalVersion && !await this.legalAcceptance(tenantId, operationId)) throw new Error('BILLING_LEGAL_REQUIRED')
    if (!retry && before.data.preview.losses?.length && input.acceptLosses !== true) throw new Error('BILLING_LOSSES_NOT_ACCEPTED')
    if (!retry && before.data.stripe_params.baseline) {
      const sub = await this.subscription(await this.account(tenantId))
      if (!sub || baseline(sub) !== before.data.stripe_params.baseline) throw new Error('BILLING_STALE_PROVIDER_QUOTE')
    }
    if (before.data.contract) await this.validateSelection(tenantId, before.data.contract)
    // Cross-terminal serialization is enforced in the DB, including duplicate button presses.
    let op: Operation
    if (signup && !retry) {
      if (!before.data.contract || !input.payer?.legalName.trim() || !input.payer.taxId.trim()) throw new Error('BILLING_INVALID_REQUEST')
      const receipt: BillingLegalReceipt['receipt'] = {
        version: billingLegalVersion, documents: billingLegalDocuments,
        declarations: { terms: true, dpa: true, businessRepresentative: true },
        payer: { legalName: input.payer.legalName, taxId: input.payer.taxId, ...(input.payer.email ? { email: input.payer.email } : {}) },
        contract: before.data.contract,
        offer: { amountDueCents: before.data.preview.amountDueCents, recurringNetCents: before.data.contract.recurringCents, recurringGrossCents: grossCents(before.data.contract.recurringCents), vatBasisPoints: 2100, currency: 'EUR', interval: before.data.contract.interval, automaticRenewal: true, firstPayment: 'card', renewals: 'sepa' },
      }
      const accepted = await this.db.rpc('billing_accept_contract', { p_tenant_id: tenantId, p_data: { actorId, operationId, receipt } })
      if (accepted.error) throw new Error(accepted.error.message === 'BILLING_STALE' ? 'BILLING_STALE' : 'BILLING_LEGAL_REQUIRED')
      op = accepted.data as Operation
    } else op = retry ? before.data : await this.transition<Operation>('apply_claim', { tenantId, actorId, operationId })
    if (op.status !== 'applying') return confirmationResult(op)
    const account = await this.account(tenantId)
    const key = `tickit:${op.id}`
    let result: Operation['result'] = {}
    let status = 'payment_pending'
    // A retry may follow earlier effects: only a first, definitively rejected mutation can release.
    if (op.kind === 'cancel_now' || op.kind === 'cancel') {
      const sub = await this.subscription(account)
      if (!sub || sub.id !== op.stripe_params.subscriptionId) throw new Error('BILLING_SUBSCRIPTION_REQUIRED')
      // Deleting stops future charges only; an accepted SEPA debit still settles.
      if (live(sub)) await this.mutate(op, () => this.mollie.request('DELETE', `/customers/${sub.customerId}/subscriptions/${sub.id}`, undefined, key), !retry && !op.stripe_params.cancelSchedule)
      status = 'completed'
    } else if (signup) {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const contract = op.contract
      let customerId = account.stripe_customer_id
      if (!customerId) {
        const customer = await this.mutate(op, () => this.mollie.request<{ id: string }>('POST', '/customers', { name: input.payer?.legalName || account.legal_name || undefined, email: input.payer?.email || account.email || undefined, metadata: { tickit_tenant_id: tenantId } }, `${key}:customer`), !retry)
        customerId = customer.id
        await this.transition('link_customer', { tenantId, customerId })
      }
      if (input.payer) {
        await this.saveProfile(tenantId, actorId, input.payer)
      }
      const subs = await this.mollie.list<MollieSubscription>(`/customers/${customerId}/subscriptions`, 'subscriptions')
      if (subs.some(live)) throw new Error('BILLING_EXISTING_SUBSCRIPTION')
      const mandate = await this.sepaMandate(op, customerId, input.sepa?.accountHolder.trim(), iban, !retry)
      const payment = await this.operationPayment(customerId, op, 'first') ?? await this.mutate(op, () => this.mollie.request<MolliePayment>('POST', '/payments', {
        amount: money(grossCents(contract.recurringCents)), description: `Tickit ${contract.planName} · alta ${op.id.slice(0, 8)}`,
        sequenceType: 'first', method: 'creditcard', customerId,
        redirectUrl: `${this.appUrl}/crm?billing=success`, cancelUrl: `${this.appUrl}/crm?billing=cancelled`, webhookUrl: this.webhookUrl,
        metadata: { tickit_tenant_id: tenantId, tickit_operation_id: op.id, tickit_kind: 'first' },
      }, `${key}:payment`), !retry)
      result = { paymentId: payment.id, mandateId: mandate.id, url: payment._links.checkout?.href }
    } else {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const contract = op.contract
      const sub = await this.subscription(account)
      if (!sub || sub.id !== op.stripe_params.subscriptionId || !sub.nextPaymentDate) throw new Error('BILLING_PENDING_CHANGE')
      const path = `/customers/${sub.customerId}/subscriptions/${sub.id}`
      if (op.stripe_params.phases) {
        const phase = phaseAt(op.stripe_params.phases, epoch(sub.nextPaymentDate))
        await this.mutate(op, () => this.mollie.request('PATCH', path, { amount: money(grossCents((phase?.contract ?? contract).recurringCents)) }, `${key}:amount`), !retry)
        result = { scheduleId: sub.id }; status = 'scheduled'
      } else if (op.timing === 'period_end') {
        if (mollieInterval(contract.interval) === sub.interval) {
          // Mollie charges the new amount at the next payment date; access changes at that renewal.
          await this.mutate(op, () => this.mollie.request('PATCH', path, { amount: money(grossCents(contract.recurringCents)) }, `${key}:amount`), !retry)
        } else {
          // An interval change starts a new subscription exactly at the renewal date, on the same mandate.
          const replacement = (await this.mollie.list<MollieSubscription>(`/customers/${sub.customerId}/subscriptions`, 'subscriptions')).find(row => row.metadata?.tickit_operation_id === op.id)
            ?? await this.mutate(op, () => this.mollie.request<MollieSubscription>('POST', `/customers/${sub.customerId}/subscriptions`, {
              amount: money(grossCents(contract.recurringCents)), interval: mollieInterval(contract.interval), startDate: sub.nextPaymentDate,
              description: `Tickit ${contract.planName} (${op.id.slice(0, 8)})`, mandateId: sub.mandateId ?? undefined, webhookUrl: this.webhookUrl,
              metadata: { tickit_tenant_id: tenantId, tickit_operation_id: op.id },
            }, `${key}:replacement`), !retry)
          if (replacement.id !== sub.id) await this.mutate(op, () => this.mollie.request('DELETE', path, undefined, `${key}:replaced`), false)
        }
        result = { scheduleId: sub.id }; status = 'scheduled'
      } else {
        const due = op.preview.amountDueCents
        if (due > 0) {
          // The increase is paid by card in Mollie Checkout. Access and the subscription amount
          // change only once Mollie reports it paid (reconcile); an abandoned checkout changes nothing.
          const payment = await this.operationPayment(sub.customerId, op, 'proration') ?? await this.mutate(op, () => this.mollie.request<MolliePayment>('POST', '/payments', {
            amount: money(due), description: `Tickit ${contract.planName} · ampliación ${op.id.slice(0, 8)}`, method: 'creditcard',
            customerId: sub.customerId, redirectUrl: `${this.appUrl}/crm/plan?billing=return`, cancelUrl: `${this.appUrl}/crm/plan?billing=cancelled`, webhookUrl: this.webhookUrl,
            metadata: { tickit_tenant_id: tenantId, tickit_operation_id: op.id, tickit_kind: 'proration' },
          }, `${key}:payment`), !retry)
          result = { paymentId: payment.id, url: payment._links.checkout?.href }
        } else await this.mutate(op, () => this.mollie.request('PATCH', path, { amount: money(grossCents(contract.recurringCents)) }, `${key}:amount`), false)
      }
    }
    const operation = await this.transition<Operation>('apply_result', { tenantId, operationId, status, result, effectiveAt: op.timing === 'period_end' ? op.preview.effectiveAt : null })
    // Completion is determined by Mollie, not the browser redirect or this POST response.
    await this.reconcile(tenantId)
    return { operation, url: result?.url, ...(signup ? { acceptance: await this.legalAcceptance(tenantId, operationId) } : {}) }
  }
  async legalAcceptance(tenantId: string, operationId: string): Promise<BillingLegalReceipt | null> {
    const result = await this.db.rpc('billing_legal_receipts', { p_tenant_id: tenantId, p_data: { operationId } })
    if (result.error) throw new Error('BILLING_DB_LEGAL')
    const receipts = result.data as BillingLegalReceipt[]
    return receipts[0] ?? null
  }
  // New IBAN for the renewals: a new SEPA mandate replaces the subscription's one, then older direct-debit mandates are revoked.
  // requestId makes a repeated click reuse the same mandate. The IBAN goes to Mollie only; it is never stored or logged.
  async changeMandate(tenantId: string, requestId: string, sepa: { accountHolder: string; iban: string }) {
    const iban = normalizeIban(sepa.iban)
    const account = await this.account(tenantId)
    const sub = await this.subscription(account)
    if (!sub || sub.status !== 'active') throw new Error('BILLING_SUBSCRIPTION_REQUIRED')
    // A debit already accepted on the old mandate must settle first; the change would otherwise race it.
    if (['processing','pending'].includes(account.last_payment_status ?? '') || (await this.inflight(tenantId)).some(op => op.status !== 'scheduled')) throw new Error('BILLING_PENDING_CHANGE')
    const path = `/customers/${sub.customerId}/mandates`
    const reference = `TICKIT-M-${requestId.slice(0, 8).toUpperCase()}`
    const mandates = await this.mollie.list<MollieMandate>(path, 'mandates')
    const mandate = mandates.find(row => row.mandateReference === reference && row.method === 'directdebit' && ['valid','pending'].includes(row.status))
      ?? await this.mollie.request<MollieMandate>('POST', path, { method: 'directdebit', consumerName: sepa.accountHolder.trim(), consumerAccount: iban, signatureDate: dateOnly(now()), mandateReference: reference }, `tickit:mandate:${requestId}`)
    if (sub.mandateId !== mandate.id) await this.mollie.request('PATCH', `/customers/${sub.customerId}/subscriptions/${sub.id}`, { mandateId: mandate.id }, `tickit:mandate:${requestId}:subscription`)
    for (const old of mandates) {
      if (old.id !== mandate.id && old.method === 'directdebit' && ['valid','pending'].includes(old.status)) await this.mollie.request('DELETE', `${path}/${old.id}`, undefined, `tickit:mandate:${requestId}:revoke:${old.id}`)
    }
    const audit = await this.db.from('billing_audit').insert({ tenant_id: tenantId, action: 'mandate', reason: 'Cambio de IBAN de domiciliación', details: { mandateId: mandate.id } })
    if (audit.error) throw new Error('BILLING_DB_AUDIT')
    return { mandateId: mandate.id, last4: iban.slice(-4) }
  }
  // "Pay outstanding": a failed renewal or charge-back is settled by card through Mollie Checkout.
  async portal(tenantId: string) {
    const account = await this.account(tenantId)
    if (!account.stripe_customer_id) throw new Error('BILLING_NOTHING_DUE')
    const payments = await this.mollie.list<MolliePayment>(`/customers/${account.stripe_customer_id}/payments`, 'payments')
    const debt = this.outstanding(payments)
    if (!debt) throw new Error('BILLING_NOTHING_DUE')
    const open = payments.find(row => row.metadata?.tickit_covers === debt.id && inTransit(row) && row._links.checkout?.href)
    if (open?._links.checkout) return { url: open._links.checkout.href }
    const payment = await this.mollie.request<MolliePayment>('POST', '/payments', {
      amount: debt.amount, description: `Tickit · cuota pendiente ${debt.id}`, customerId: account.stripe_customer_id, method: 'creditcard',
      redirectUrl: `${this.appUrl}/crm?billing=return`, webhookUrl: this.webhookUrl,
      metadata: { tickit_tenant_id: tenantId, tickit_kind: 'arrears', tickit_covers: debt.id },
    }, `tickit:arrears:${debt.id}:${Math.floor(Date.now() / 3_600_000)}`)
    if (!payment._links.checkout?.href) throw new Error('BILLING_ACTION_REQUIRED')
    return { url: payment._links.checkout.href }
  }
  // Latest failed renewal, or charged-back renewal/upgrade, that no paid arrears payment covers.
  // An upgrade charge that never succeeded is not debt: the upgrade is withdrawn instead.
  outstanding(payments: MolliePayment[]) {
    const covered = new Set(payments.filter(row => row.metadata?.tickit_kind === 'arrears' && settled(row)).map(row => row.metadata?.tickit_covers))
    return payments.filter(row => (row.subscriptionId && failed(row) && row.status !== 'canceled' || row.metadata?.tickit_kind === 'proration' && cents(row.amountChargedBack) > 0) && !covered.has(row.id))
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ?? null
  }
  async ensureSubscription(account: Account, op: Operation, first: MolliePayment, subs: MollieSubscription[]) {
    const existing = subs.find(row => row.metadata?.tickit_operation_id === op.id)
    if (existing) return existing
    const contract = op.contract
    if (!contract || !first.paidAt || !account.stripe_customer_id) throw new Error('BILLING_CONTRACT_REQUIRED')
    // The card paid the first period; renewals use the SEPA mandate created at signup.
    const mandates = await this.mollie.list<MollieMandate>(`/customers/${account.stripe_customer_id}/mandates`, 'mandates')
    const sepa = mandates.find(row => row.id === op.result?.mandateId && ['valid','pending'].includes(row.status))
    return this.mollie.request<MollieSubscription>('POST', `/customers/${account.stripe_customer_id}/subscriptions`, {
      amount: money(grossCents(contract.recurringCents)), interval: mollieInterval(contract.interval),
      startDate: dateOnly(addMonths(epoch(first.paidAt), months(contract.interval))),
      description: `Tickit ${contract.planName} (${op.id.slice(0, 8)})`, mandateId: sepa?.id ?? first.mandateId ?? undefined, webhookUrl: this.webhookUrl,
      metadata: { tickit_tenant_id: account.tenant_id, tickit_operation_id: op.id },
    }, `tickit:${op.id}:subscription`)
  }
  async expire(tenantId: string, op: Operation) {
    const saved = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', op.id).eq('status', 'payment_pending')
    if (saved.error) throw new Error('BILLING_DB_PENDING_EXPIRY')
  }
  async reconcile(tenantId: string) {
    const { token } = await this.transition<{ token: string }>('sync_claim', { tenantId })
    try {
      const account = await this.account(tenantId)
      const customerId = account.stripe_customer_id
      if (!customerId) throw new Error('BILLING_CUSTOMER_REQUIRED')
      const at = now()
      let subs = await this.mollie.list<MollieSubscription>(`/customers/${customerId}/subscriptions`, 'subscriptions')
      const payments = await this.mollie.list<MolliePayment>(`/customers/${customerId}/payments`, 'payments')
      if ([...subs, ...payments].some(row => row.customerId && row.customerId !== customerId || row.metadata?.tickit_tenant_id && row.metadata.tickit_tenant_id !== tenantId)) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
      const storedInvoices = payments.length ? await this.db.from('billing_invoices').select('stripe_invoice_id,customer_snapshot,service_snapshot').eq('tenant_id', tenantId).in('stripe_invoice_id', payments.map(payment => payment.id)) : { data: [], error: null }
      if (storedInvoices.error) throw new Error('BILLING_DB_INVOICE')
      const snapshots = new Map((storedInvoices.data ?? []).map(row => [row.stripe_invoice_id, row.customer_snapshot]))
      const services = new Map((storedInvoices.data ?? []).map(row => [row.stripe_invoice_id, row.service_snapshot]))
      const operations = payments.some(payment => !services.has(payment.id) || services.get(payment.id) && !services.get(payment.id).periodEnd)
        ? await this.db.from('billing_operations').select('*').eq('tenant_id', tenantId).eq('kind', 'change').order('created_at', { ascending: false }).limit(1000).returns<Operation[]>()
        : { data: [], error: null }
      if (operations.error) throw new Error('BILLING_DB_OPERATION')
      for (const payment of payments) {
        const gross = cents(payment.amount), returned = cents(payment.amountChargedBack)
        const storedService = services.get(payment.id)
        const serviceSnapshot = services.has(payment.id) && (storedService === null || storedService?.periodEnd)
          ? storedService : invoiceServiceSnapshot(payment, payments, subs, operations.data ?? [], services)
        const saved = await this.db.from('billing_invoices').upsert({
          stripe_invoice_id: payment.id, tenant_id: tenantId, currency: 'eur',
          status: settled(payment) ? 'paid' : returned ? 'uncollectible' : inTransit(payment) ? (payment.method === 'directdebit' ? 'processing' : 'open') : payment.status === 'canceled' ? 'void' : payment.status,
          amount_due_cents: gross, amount_paid_cents: payment.status === 'paid' ? gross - returned : 0,
          paid_excluding_tax_cents: settled(payment) ? netFromGross(gross) : 0,
          issuer_snapshot: {}, customer_snapshot: snapshots.get(payment.id) ?? { name: account.legal_name, taxIds: account.tax_id ? [account.tax_id] : [], email: account.email, address: account.billing_address },
          service_snapshot: serviceSnapshot,
          // Fiscal fields (number, fiscal_export_status, fiscal_external_reference) belong to the Odoo sync: never overwrite them here.
          hosted_invoice_url: inTransit(payment) ? payment._links.checkout?.href ?? null : null, invoice_pdf: null,
          created_at: payment.createdAt, paid_at: payment.paidAt ?? null,
        })
        if (saved.error) throw new Error('BILLING_DB_INVOICE')
      }
      const pending = await this.inflight(tenantId)
      const timeline = await this.scheduleOperation(account)
      let contract: Contract | null = null
      let financial: Contract | null = null
      let completed: string | null = null
      let paymentStatus = account.last_payment_status
      let clearSchedule = false

      let signupOpen = false
      const signup = pending.find(op => op.kind === 'change' && !op.stripe_params.subscriptionId && op.status === 'payment_pending' && op.result?.paymentId)
      if (signup) {
        const first = payments.find(row => row.id === signup.result?.paymentId)
        if (!first || first.metadata?.tickit_operation_id !== signup.id) throw new Error('BILLING_PAYMENT_MISMATCH')
        paymentStatus = first.status
        signupOpen = first.status !== 'paid'
        if (first.status === 'paid') {
          const created = await this.ensureSubscription(account, signup, first, subs)
          if (!subs.some(row => row.id === created.id)) subs = [...subs, created]
          contract = signup.contract; completed = signup.id
        } else if (failed(first)) await this.expire(tenantId, signup)
      }
      const alive = subs.filter(live)
      if (alive.length > 1) throw new Error('BILLING_MULTIPLE_SUBSCRIPTIONS')
      const sub = alive[0] ?? subs.find(row => row.id === account.stripe_subscription_id) ?? null
      let status = account.status, periodEnd = account.period_end, cancelAtPeriodEnd = false
      if (sub) {
        const cancellations = sub.status === 'canceled' ? await this.db.from('billing_operations').select('stripe_params').eq('tenant_id', tenantId).eq('kind', 'cancel_now').eq('status', 'completed').returns<Pick<Operation, 'stripe_params'>[]>() : { data: [], error: null }
        if (cancellations.error) throw new Error('BILLING_DB_OPERATION')
        const cancelledNow = cancellations.data.some(row => row.stripe_params.subscriptionId === sub.id)
        // An upgrade checkout not yet paid is not a charge in progress at the bank.
        const charges = payments.filter(row => row.subscriptionId && subs.some(item => item.id === row.subscriptionId) || ['first','proration'].includes(row.metadata?.tickit_kind ?? '') && !(cardCheckout(row) && row.status !== 'paid')).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        const debt = this.outstanding(payments)
        if (live(sub)) periodEnd = sub.nextPaymentDate ? iso(epoch(sub.nextPaymentDate)) : periodEnd
        else if (cancelledNow) periodEnd = sub.canceledAt ?? periodEnd
        const paidPeriod = !live(sub) && periodEnd !== null && Date.parse(periodEnd) > Date.now()
        status = sub.status === 'suspended' ? 'unpaid' : sub.status === 'pending' ? 'incomplete' : debt ? 'past_due' : sub.status === 'active' || paidPeriod ? 'active' : 'canceled'
        cancelAtPeriodEnd = paidPeriod
        if (charges[0] && !signupOpen) paymentStatus = debt ? 'failed' : inTransit(charges[0]) ? 'pending' : 'paid'

        if (status === 'active') {
          const upgrade = pending.find(op => op.kind === 'change' && op.status === 'payment_pending' && op.stripe_params.subscriptionId)
          const scheduled = pending.find(op => op.status === 'scheduled' && !op.stripe_params.phases)
          if (upgrade) {
            const charge = upgrade.result?.paymentId ? payments.find(row => row.id === upgrade.result?.paymentId) : null
            if (upgrade.result?.paymentId && !charge) throw new Error('BILLING_PAYMENT_MISMATCH')
            if (!charge || settled(charge)) { contract = upgrade.contract; completed = upgrade.id }
            else if (cardCheckout(charge)) {
              // Waiting for the card: nothing changed. Unpaid, expired or cancelled: the upgrade is dropped.
              if (!inTransit(charge)) await this.expire(tenantId, upgrade)
            } else if (inTransit(charge)) { contract = upgrade.contract; financial = account.billed_contract ?? upgrade.stripe_params.previousContract ?? null; paymentStatus = 'pending' }
            else {
              // An unpaid upgrade is withdrawn; the previous paid contract and amount return.
              await this.expire(tenantId, upgrade)
              contract = upgrade.stripe_params.previousContract ?? account.billed_contract
            }
          } else if (scheduled) {
            contract = scheduledContract(scheduled, at)
            const restore = restoreAt(scheduled)
            if (contract && (!scheduled.restore_contract || restore !== null && at >= restore)) completed = scheduled.id
          } else if (timeline?.stripe_params.phases) {
            const phase = phaseAt(timeline.stripe_params.phases, at)
            if (phase) { contract = phase.contract; if (timeline.status === 'scheduled') completed = timeline.id }
            clearSchedule = at >= (timeline.stripe_params.phases.at(-1)?.start ?? 0)
          }
          // The next Mollie charge must match the contract in force on that date.
          if (sub.status === 'active' && sub.nextPaymentDate && !pending.some(op => op.status === 'applying')) {
            const next = epoch(sub.nextPaymentDate)
            const charged = timeline?.stripe_params.phases && !clearSchedule ? phaseAt(timeline.stripe_params.phases, next)?.contract
              : scheduled ? scheduledContract(scheduled, next) ?? (financial ?? contract ?? account.billed_contract ?? account.contract)
              : contract ?? account.billed_contract ?? account.contract
            if (charged && mollieInterval(charged.interval) === sub.interval && grossCents(charged.recurringCents) !== cents(sub.amount)) {
              await this.mollie.request('PATCH', `/customers/${customerId}/subscriptions/${sub.id}`, { amount: money(grossCents(charged.recurringCents)) }, `tickit:amount:${sub.id}:${charged.recurringCents}:${next}`)
            }
          }
        }
        if (!live(sub) && !paidPeriod) clearSchedule = true
      }
      // Inside the sync claim so a webhook and the cron never issue the same Odoo document twice; never throws.
      if (this.odoo) odooSyncDiagnostic(await syncOdoo({ odoo: this.odoo, db: this.db, account, payments, mode: this.mollie.mode }))
      // Card or SEPA charges that are accepted keep access; the paid snapshot moves only once settled.
      await this.transition('sync_commit', { tenantId, token, customerId, subscriptionId: sub?.id ?? account.stripe_subscription_id, status, contract, clearSchedule,
        financialContract: financial ?? contract, sepaAuthorization: null, payer: null,
        paymentStatus, periodEnd, cancelAtPeriodEnd, completedOperationId: completed, discrepancy: null })
      return { reconciled: true, discrepancy: null }
    } catch (error) {
      await this.transition('sync_fail', { tenantId, token })
      throw error
    }
  }
  invoiceDocument(tenantId: string, paymentId: string, document: 'main' | 'refund') {
    return odooDocument({ odoo: this.odoo, db: this.db, tenantId, paymentId, document })
  }
  async processEvent(event:{ id: string; type: string; created: number; customer?: string }) {
    const claim = await this.transition<{ claimed: boolean }>('event_claim', event)
    if (!claim.claimed) return
    try {
      const account = event.customer ? await this.db.from('billing_accounts').select('tenant_id').eq('stripe_customer_id', event.customer).maybeSingle() : { data: null, error: null }
      if (account.error) throw new Error('BILLING_DB_EVENT')
      if (account.data) await this.reconcile(account.data.tenant_id)
      await this.transition('event_finish', { id: event.id, status: account.data ? 'completed' : 'ignored' })
    } catch {
      await this.transition('event_finish', { id: event.id, status: 'failed', error: 'RECONCILIATION_REQUIRED' })
      throw new Error('BILLING_EVENT_RETRY_REQUIRED')
    }
  }
  // Mollie webhooks carry only an ID and no signature: the state is always re-read from the API.
  async handleWebhook(paymentId: string) {
    let payment: MolliePayment
    try { payment = await this.mollie.request<MolliePayment>('GET', `/payments/${paymentId}`) }
    catch (error) {
      if (error instanceof MollieRequestError && error.diagnostic.status === 404) return
      throw error
    }
    if (payment.id !== paymentId || !payment.customerId) return
    await this.processEvent({ id: `mollie:${payment.id}:${payment.status}:${cents(payment.amountChargedBack)}`, type: `payment.${payment.status}`, created: epoch(payment.createdAt), customer: payment.customerId })
  }
}
