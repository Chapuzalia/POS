import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { buildContract, changeTiming, commercialState, matchesContract, mayProject, recurringMetrics, stripeItems } from './domain.ts'
import type { CommercialException, Contract, Product, Selection, Version } from './domain.ts'
import { StripeGateway, StripeRequestError } from './stripe.ts'
import type { StripeInvoice, StripeSubscription } from './stripe.ts'
import { promotionPhases, renewalOnOrAfter, resolvePromotions } from './promotions.ts'
import type { PromotionPhase, PromotionPreview } from './promotions.ts'
import { spanishVatRate } from './taxes.ts'
import { onboardingContract } from './onboarding.ts'
import { processingSepaAuthorization, subscriptionUsesSepa } from './sepa.ts'
import type { SepaAuthorization } from './sepa.ts'

export type Account = {
  tenant_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null
  source: string; status: string; legal_name: string | null; tax_id: string | null; email: string | null
  contract: Contract | null; billed_contract: Contract | null; revision: number; period_end: string | null; cancel_at_period_end: boolean
  delinquent_since: string | null; grace_days: number; last_payment_status: string | null
  last_reconciled_at: string | null; sync_error: string | null; created_at: string
  schedule_operation_id: string | null
  onboarding_contract: Contract | null
  sepa_authorization?: SepaAuthorization | null
}
export type Operation = {
  id: string; tenant_id: string; actor_id: string; kind: 'change' | 'cancel' | 'cancel_now'; reason: string
  status: string; contract: Contract | null; restore_contract: Contract | null
  timing: 'immediate' | 'period_end'; preview: { amountDueCents: number; recurringCents: number; renewalCents?: number | null; currency: string; effectiveAt: string | null; details: string; promotions?: PromotionPreview[]; afterPromotionCents?: number }
  stripe_params: { subscriptionId: string | null; taxRateId?: string; sepaDebit?: boolean; checkoutPolicy?: string; items?: ReturnType<typeof stripeItems>; discounts?: Array<{ coupon: string }> | ''; scheduleId?: string; baseline?: string; scheduleBaseline?: string; phases?: PromotionPhase[]; cancelSchedule?: boolean; supersededOperationId?: string }
  result: { url?: string; checkoutId?: string; scheduleId?: string; pendingInvoiceId?: string | null } | null; created_at: string; proration_date: number; effective_at: string | null
}

function confirmationResult(operation: Operation) {
  if (['failed', 'expired'].includes(operation.status)) throw new Error('BILLING_STALE')
  if (operation.status === 'applying') throw new Error('BILLING_ACTION_REQUIRED')
  return { operation, url: operation.status === 'payment_pending' ? operation.result?.url : undefined }
}
type VersionRow = { id: string; product_key: string; interval: 'month' | 'year'; amount_cents: number; features: string[]; limits: Version['limits']; included: Record<string, number>; maximum: number | null; requires: string[]; stripe_price_id: string | null; published: boolean }
type ProductRow = { key: string; kind: Product['kind']; name: string; description: string; scope: Product['scope']; feature_key: string | null; resource: Product['resource']; active: boolean; sort_order: number }
type StripePrice = { id: string; unit_amount: number; currency: string; recurring: { interval: string }; active: boolean; metadata: Record<string, string> }
const iso = (seconds: number | undefined | null) => seconds ? new Date(seconds * 1000).toISOString() : null
const subscriptionBaseline = (sub: StripeSubscription) => JSON.stringify({ status: sub.status, anchor: sub.billing_cycle_anchor, items: sub.items.data.map(item => [item.id,item.price.id,item.quantity,item.current_period_start,item.current_period_end,item.tax_rates]), taxes: sub.default_tax_rates, automaticTax: sub.automatic_tax, pending: sub.pending_update, schedule: sub.schedule, cancellation: sub.cancel_at_period_end, discounts: sub.discounts, invoice: typeof sub.latest_invoice === 'object' ? sub.latest_invoice?.id : sub.latest_invoice })
type Schedule = { id: string; subscription: string; status: string; current_phase: { start_date: number; end_date: number }; phases: Array<{ metadata?: Record<string, string> }>; metadata: Record<string, string> }
const scheduleBaseline = (schedule: Schedule) => JSON.stringify({ phases: schedule.phases, status: schedule.status, current: schedule.current_phase })
const previewItems = (items: ReturnType<typeof stripeItems> | undefined, taxRateId?: string) => items?.map(item => taxRateId && !item.deleted ? { ...item, tax_rates: '' } : item)

export class BillingService {
  readonly db: SupabaseClient
  readonly stripe: StripeGateway
  readonly appUrl: string
  readonly portalConfiguration: string
  constructor(db: SupabaseClient, stripe: StripeGateway, appUrl: string, portalConfiguration: string) {
    this.db = db; this.stripe = stripe; this.appUrl = appUrl; this.portalConfiguration = portalConfiguration
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
    if (result.data) return result.data
    const created = await this.db.from('billing_accounts').upsert({ tenant_id: tenantId }, { onConflict: 'tenant_id', ignoreDuplicates: true })
    if (created.error) throw new Error('BILLING_DB_ACCOUNT')
    return this.account(tenantId)
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
    const { products, versions } = await this.catalog()
    const version = versions.find(row => row.id === versionId)
    const product = products.find(row => row.key === version?.productKey)
    if (!version || !product) throw new Error('BILLING_VERSION_NOT_FOUND')
    if (version.published) return version
    const productId = `tickit_${product.key}`
    // Product identity is stable. Existing product is retrieved rather than recreated after 24h.
    try { await this.stripe.request('GET', `/products/${productId}`) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'STRIPE_HTTP_404') throw error
      await this.stripe.request('POST', '/products', { id: productId, name: product.name, description: product.description || undefined, metadata: { tickit_product_key: product.key } }, `product:${product.key}`)
    }
    const existing = await this.stripe.list<StripePrice>('/prices', { product: productId })
    const found = existing.find(row => row.metadata.tickit_version_id === version.id && !row.metadata.tickit_custom)
    const price = found ?? await this.stripe.request<StripePrice>('POST', '/prices', { product: productId, currency: 'eur', unit_amount: version.amountCents, tax_behavior: 'exclusive', recurring: { interval: version.interval }, metadata: { tickit_version_id: version.id } }, `price:${version.id}`)
    if (price.unit_amount !== version.amountCents || price.currency !== 'eur' || price.recurring.interval !== version.interval || !price.active) throw new Error('BILLING_STRIPE_PRICE_MISMATCH')
    const update = await this.db.from('billing_price_versions').update({ stripe_price_id: price.id, published: true }).eq('id', versionId)
    if (update.error) throw new Error('BILLING_DB_PUBLISH')
    return { ...version, stripePriceId: price.id, published: true }
  }
  async detail(tenantId: string, admin: boolean) {
    const account = await this.account(tenantId)
    const scheduled = await this.scheduleOperation(account)
    const [tenant, venues, devices, invoices, operations, audit] = await Promise.all([
      this.db.from('tenants').select('id,name,max_venues,max_devices,billing_activation_required').eq('id', tenantId).single(),
      this.db.from('venues').select('id,name,is_active').eq('tenant_id', tenantId),
      this.db.from('devices').select('id,name,venue_id,is_active').eq('tenant_id', tenantId).eq('is_active', true),
      this.db.from('billing_invoices').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100),
      this.db.from('billing_operations').select('id,kind,status,timing,preview,result,reason,created_at,effective_at,contract').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(50),
      admin ? this.db.from('billing_audit').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    ])
    if ([tenant, venues, devices, invoices, operations, audit].some(result => result.error)) throw new Error('BILLING_DB_DETAIL')
    const history = operations.data ?? []
    if (scheduled && !history.some(row => row.id === scheduled.id)) {
      const { id, kind, status, timing, preview, result, reason, created_at, effective_at, contract } = scheduled
      history.push({ id, kind, status, timing, preview, result, reason, created_at, effective_at, contract })
    }
    return { account, scheduledContract: scheduled?.contract ?? null, tenant: tenant.data, venues: venues.data, devices: devices.data, invoices: invoices.data, operations: history, audit: audit.data, commercialState: commercialState(account.status, account.delinquent_since, account.grace_days) }
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
    const [tenants, venues, events, invoices] = await Promise.all([
      this.db.from('tenants').select('id,name').order('name').limit(1000),
      this.db.from('venues').select('tenant_id').limit(1000),
      this.db.from('billing_stripe_events').select('*').order('created_at', { ascending: false }).limit(100),
      this.db.from('billing_invoices').select('amount_paid_cents,paid_excluding_tax_cents').gte('paid_at', new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString()).limit(1000),
    ])
    if ([tenants, venues, events, invoices].some(result => result.error)) throw new Error('BILLING_DB_OVERVIEW')
    const names = new Map((tenants.data ?? []).map(row => [row.id, row.name]))
    return { accounts: accounts.map(account => ({ ...account, contract: account.billed_contract ?? account.contract, name: names.get(account.tenant_id) ?? account.tenant_id, venueCount: (venues.data ?? []).filter(row => row.tenant_id === account.tenant_id).length })), events: events.data,
      metrics: { ...recurringMetrics(accounts.map(account => ({ status: account.status, contract: account.billed_contract ?? account.contract }))), paidCents: (invoices.data ?? []).reduce((sum, row) => sum + row.amount_paid_cents, 0), paidExcludingTaxCents: (invoices.data ?? []).reduce((sum, row) => sum + row.paid_excluding_tax_cents, 0) },
      truncated: (tenants.data?.length ?? 0) >= 1000 || (venues.data?.length ?? 0) >= 1000 || (invoices.data?.length ?? 0) >= 1000 }
  }
  async saveOnboarding(tenantId: string, selection: Selection) {
    const contract = onboardingContract(await this.catalog(), selection)
    await this.validateSelection(tenantId, contract)
    const result = await this.db.rpc('billing_save_onboarding', { p_tenant_id: tenantId, p_contract: contract })
    if (result.error) throw new Error(result.error.message === 'BILLING_PENDING_CHANGE' ? 'BILLING_PENDING_CHANGE' : 'BILLING_DB_ONBOARDING')
    return { saved: true }
  }
  async restartCheckout(tenantId: string) {
    const tenant = await this.db.from('tenants').select('billing_activation_required').eq('id', tenantId).single()
    if (tenant.error || !tenant.data.billing_activation_required) throw new Error('BILLING_PENDING_CHANGE')
    const account = await this.account(tenantId)
    if (account.stripe_customer_id) await this.reconcile(tenantId)
    const inflight = await this.db.from('billing_operations').select('*').eq('tenant_id', tenantId).in('status', ['applying','payment_pending','scheduled']).returns<Operation[]>()
    if (inflight.error) throw new Error('BILLING_DB_OPERATION')
    for (const op of inflight.data) {
      if (op.status !== 'payment_pending' || !op.result?.checkoutId) throw new Error('BILLING_PENDING_CHANGE')
      const session = await this.stripe.request<{ status: string; customer: string }>('GET', `/checkout/sessions/${op.result.checkoutId}`)
      if (session.customer !== account.stripe_customer_id || !['open','expired'].includes(session.status)) throw new Error('BILLING_PENDING_CHANGE')
      if (session.status === 'open') await this.stripe.request('POST', `/checkout/sessions/${op.result.checkoutId}/expire`, {}, `onboarding-expire:${op.id}`)
      // Stripe expiry is authoritative. A race with payment fails without releasing the lock.
      const expired = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', op.id).eq('status', 'payment_pending')
      if (expired.error) throw new Error('BILLING_DB_OPERATION')
    }
    return { editable: true }
  }
  async subscription(account: Account) {
    if (!account.stripe_subscription_id) return null
    const sub = await this.stripe.request<StripeSubscription>('GET', `/subscriptions/${account.stripe_subscription_id}`, { expand: ['latest_invoice','discounts','default_payment_method'] })
    if (sub.customer !== account.stripe_customer_id || sub.livemode !== false || sub.items.has_more) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
    return sub
  }
  async ownedSchedule(account: Account, sub: StripeSubscription, allowScheduledCancellation = false) {
    if (!sub.schedule || (!account.schedule_operation_id && !allowScheduledCancellation)) return null
    const query = this.db.from('billing_operations').select('*').eq('tenant_id', account.tenant_id)
    const stored = account.schedule_operation_id
      ? await query.eq('id', account.schedule_operation_id).maybeSingle<Operation>()
      : await query.eq('kind', 'change').eq('status', 'scheduled').maybeSingle<Operation>()
    if (stored.error) throw new Error('BILLING_DB_OPERATION')
    const op = stored.data
    if (!op || op.result?.scheduleId !== sub.schedule || op.stripe_params.subscriptionId !== sub.id || Boolean(op.stripe_params.phases) !== Boolean(account.schedule_operation_id)) return null
    const schedule = await this.stripe.request<Schedule>('GET', `/subscription_schedules/${sub.schedule}`)
    // Older renewal changes recorded ownership on phases, before the account timeline existed.
    const phaseOwners = schedule.phases.map(phase => phase.metadata?.tickit_operation_id).filter(Boolean)
    const owned = op.stripe_params.phases ? schedule.metadata.tickit_operation_id === op.id
      : phaseOwners.includes(op.id) && phaseOwners.every(id => id === op.id) && (!schedule.metadata.tickit_operation_id || schedule.metadata.tickit_operation_id === op.id)
    if (schedule.subscription !== sub.id || schedule.status !== 'active' || !owned) throw new Error('BILLING_PENDING_CHANGE')
    return { ...schedule, supersededOperationId: op.stripe_params.phases ? undefined : op.id }
  }
  async scheduleOperation(account: Account) {
    if (!account.schedule_operation_id) return null
    const stored = await this.db.from('billing_operations').select('*').eq('tenant_id', account.tenant_id).eq('id', account.schedule_operation_id).single<Operation>()
    if (stored.error || !stored.data.stripe_params.phases) throw new Error('BILLING_DB_OPERATION')
    return stored.data
  }
  async validateSelection(tenantId: string, contract: Contract) {
    const [venues, devices] = await Promise.all([
      this.db.from('venues').select('id').eq('tenant_id', tenantId),
      this.db.from('devices').select('id').eq('tenant_id', tenantId).eq('is_active', true),
    ])
    if (venues.error || devices.error) throw new Error('BILLING_DB_USAGE')
    const venueIds = new Set(venues.data.map(row => row.id))
    const deviceIds = new Set(devices.data.map(row => row.id))
    if (venueIds.size > contract.limits.venues || deviceIds.size > contract.limits.devices) throw new Error('BILLING_LIMIT_BELOW_USAGE')
    for (const addon of contract.addons) {
      if (addon.venueIds.some(id => !venueIds.has(id)) || addon.deviceIds.some(id => !deviceIds.has(id))) throw new Error('BILLING_FOREIGN_ASSIGNMENT')
    }
  }
  async materialize(contract: Contract, tenantId: string) {
    for (const line of contract.lines) {
      if (!line.stripePriceId) throw new Error('BILLING_UNSYNCED_PRICE')
      if (contract.exception?.customAmounts[line.key] !== undefined) {
        const productId = `tickit_${line.key}`
        const fingerprint = `${tenantId}:${line.versionId}:${line.amountCents}`
        const prices = await this.stripe.list<StripePrice>('/prices', { product: productId })
        const price = prices.find(row => row.metadata.tickit_custom === fingerprint) ?? await this.stripe.request<StripePrice>('POST', '/prices', { product: productId, currency: 'eur', unit_amount: line.amountCents, tax_behavior: 'exclusive', recurring: { interval: contract.interval }, metadata: { tickit_custom: fingerprint, tickit_tenant_id: tenantId } }, `custom:${fingerprint}`)
        if (price.unit_amount !== line.amountCents || price.currency !== 'eur' || price.recurring.interval !== contract.interval || !price.active) throw new Error('BILLING_STRIPE_PRICE_MISMATCH')
        line.stripePriceId = price.id
      }
    }
    const basisPoints = contract.exception?.discountBasisPoints ?? 0
    if (!basisPoints) return '' as const
    const couponId = `tickit_discount_${basisPoints}`
    type Coupon = { percent_off: number | null; amount_off: number | null; duration: string; valid: boolean }
    let coupon: Coupon
    try { coupon = await this.stripe.request<Coupon>('GET', `/coupons/${couponId}`) }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'STRIPE_HTTP_404') throw error
      coupon = await this.stripe.request<Coupon>('POST', '/coupons', { id: couponId, percent_off: basisPoints / 100, duration: 'forever', name: 'Condición comercial Tickit' }, `coupon:${basisPoints}`)
    }
    if (coupon.percent_off !== basisPoints / 100 || coupon.amount_off !== null || coupon.duration !== 'forever' || !coupon.valid) throw new Error('BILLING_STRIPE_COUPON_MISMATCH')
    return [{ coupon: couponId }]
  }
  async quote(tenantId: string, actorId: string, selection: Selection, exception: CommercialException | null, reason: string, isSuperadmin = false) {
    const account = await this.account(tenantId)
    if (account.last_payment_status === 'processing') throw new Error('BILLING_PENDING_CHANGE')
    if (commercialState(account.status, account.delinquent_since, account.grace_days) === 'restricted' && !['canceled','incomplete_expired'].includes(account.status)) throw new Error('BILLING_PAYMENT_REQUIRED')
    const { products, versions } = await this.catalog()
    const existingContract = account.billed_contract ?? account.contract
    const scheduled = await this.scheduleOperation(account)
    const agreement = scheduled?.contract ?? existingContract ?? account.onboarding_contract
    if (!isSuperadmin) {
      if (exception) throw new Error('BILLING_FORBIDDEN')
      exception = agreement?.exception ?? null
      const existing = agreement
      const retained = new Set([existing?.selection.planVersionId, ...(existing?.selection.addons.map(addon => addon.versionId) ?? [])])
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
    // Reject foreign assignments and invalid quantities before any Stripe request.
    await this.validateSelection(tenantId, buildContract(effectiveProducts, versions, selection, exception))
    const linkedSubscription = await this.subscription(account)
    const subscription = linkedSubscription && !['canceled','incomplete_expired'].includes(linkedSubscription.status) ? linkedSubscription : null
    const owned = subscription ? await this.ownedSchedule(account, subscription) : null
    if (scheduled && subscription?.schedule !== scheduled.result?.scheduleId) throw new Error('BILLING_STALE_STRIPE_QUOTE')
    if (subscription?.pending_update || (subscription?.schedule && !owned) || subscription?.cancel_at_period_end || (subscription && !['active','trialing'].includes(subscription.status))) throw new Error('BILLING_PENDING_CHANGE')
    const now = Math.floor(Date.now() / 1000)
    if (exception?.promotions?.length || owned) {
      exception ??= { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason }
      if (!subscription || !existingContract || exception.cycles || existingContract.exception?.cycles) throw new Error('BILLING_INVALID_PROMOTION_CONTRACT')
      // A promotion may be removed by Superadmin, but a self-service change retains it.
      if (subscription.status !== 'active') throw new Error('BILLING_PENDING_CHANGE')
      if (!Number.isSafeInteger(subscription.billing_cycle_anchor) || subscription.items.data.some(item => item.current_period_start !== subscription.items.data[0].current_period_start || item.current_period_end !== subscription.items.data[0].current_period_end)) throw new Error('BILLING_INVALID_PROMOTION_DATE')
      const interval = versions.find(v => v.id === selection.planVersionId)?.interval ?? existingContract.interval
      const renewal = subscription.items.data[0].current_period_end
      const promotions = resolvePromotions(exception.promotions ?? [], agreement?.exception?.promotions ?? [], selection, now, renewal, interval, interval === existingContract.interval ? subscription.billing_cycle_anchor : renewal)
      exception = { ...exception, promotions }
      return this.quotePromotions(account, actorId, selection, exception, reason, effectiveProducts, versions, subscription, owned, now, agreement)
    }
    const next = buildContract(effectiveProducts, versions, selection, exception)
    await this.validateSelection(tenantId, next)
    // Fixed-term concessions use schedule phases; only at renewal, never an ad-hoc expiry cron.
    const timing = exception?.cycles ? 'period_end' : subscription && account.contract ? changeTiming(account.contract, next) : 'immediate'
    if (exception?.cycles && !subscription) throw new Error('BILLING_TEMPORARY_REQUIRES_SUBSCRIPTION')
    const restore = exception?.cycles ? buildContract(effectiveProducts, versions, selection) : null
    const sepaDebit = subscription ? await subscriptionUsesSepa(this.stripe, subscription) : false
    const discounts = await this.materialize(next, tenantId)
    if (restore) await this.materialize(restore, tenantId)
    const prorationDate = Math.floor(Date.now() / 1000)
    const taxRateId = await spanishVatRate(this.stripe)
    const items = subscription ? stripeItems(subscription.items.data, next.lines) : next.lines.map(line => ({ price: line.stripePriceId ?? undefined, quantity: line.quantity }))
    const preview = await this.stripe.request<StripeInvoice>('POST', '/invoices/create_preview', { customer: account.stripe_customer_id ?? undefined, customer_details: { tax_exempt: 'none' }, automatic_tax: { enabled: false }, ...(subscription ? { subscription: subscription.id } : {}), ...(timing === 'period_end' ? { preview_mode: 'recurring' } : {}), subscription_details: { default_tax_rates: [taxRateId], items: previewItems(items, taxRateId), proration_behavior: timing === 'immediate' && subscription ? 'always_invoice' : undefined, proration_date: timing === 'immediate' && subscription ? prorationDate : undefined }, discounts })
    if (preview && preview.currency !== 'eur') throw new Error('BILLING_CURRENCY_MISMATCH')
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: 'change', contract: next, restoreContract: restore, timing, stripeParams: { subscriptionId: subscription?.id ?? null, taxRateId, sepaDebit, ...(!subscription ? { checkoutPolicy: 'fiscal_sepa_v2' } : {}), items, discounts, baseline: subscription ? subscriptionBaseline(subscription) : undefined }, preview: { amountDueCents: timing === 'immediate' ? preview.amount_due : 0, renewalCents: timing === 'period_end' ? preview.amount_due : null, recurringCents: next.recurringCents, currency: 'eur', effectiveAt: timing === 'period_end' ? account.period_end : null, details: timing === 'period_end' ? 'Cambio al vencimiento; sin cargo inmediato. Vista previa de renovación calculada por Stripe con IVA del 21 %. Cuotas recurrentes sin IVA.' : sepaDebit ? 'Vista previa de Stripe con IVA del 21 %. La ampliación será inmediata cuando Stripe confirme que el cobro SEPA está autorizado y en trámite; el banco todavía puede rechazarlo. Cuotas recurrentes sin IVA.' : 'Vista previa de Stripe con IVA del 21 % y los ajustes aplicables. Cuotas recurrentes sin IVA.' }, reason, prorationDate })
  }
  async promotionInvoice(account: Account, sub: StripeSubscription, contract: Contract, discounts: PromotionPhase['discounts'], taxRateId?: string) {
    const preview = await this.stripe.request<StripeInvoice>('POST', '/invoices/create_preview', {
      customer: account.stripe_customer_id ?? undefined, subscription: sub.id, preview_mode: 'recurring',
      ...(taxRateId ? { customer_details: { tax_exempt: 'none' }, automatic_tax: { enabled: false } } : {}),
      subscription_details: { ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}), items: previewItems(stripeItems(sub.items.data, contract.lines), taxRateId), proration_behavior: 'none' }, discounts,
    })
    if (preview.currency !== 'eur') throw new Error('BILLING_CURRENCY_MISMATCH')
    return preview.amount_due
  }
  async quotePromotions(account: Account, actorId: string, selection: Selection, exception: CommercialException, reason: string, products: Product[], versions: Version[], sub: StripeSubscription, owned: Schedule | null, now: number, agreement: Contract | null) {
    const taxRateId = await spanishVatRate(this.stripe)
    const current = account.billed_contract ?? account.contract
    if (!current) throw new Error('BILLING_CONTRACT_REQUIRED')
    const renewal = sub.items.data[0].current_period_end
    const requested = buildContract(products, versions, selection, exception, now)
    await this.materialize(requested, account.tenant_id)
    const fresh = (exception.promotions ?? []).filter(p => !(agreement?.exception?.promotions ?? []).some(old => old.id === p.id))
    const immediate = fresh.some(p => p.start === 'immediate')
    // Only the newly granted units may change the bill immediately; existing paid
    // periods are not refunded. Other prices, discounts and reductions use renewal.
    const grantedKeys = new Set(fresh.filter(p => p.start === 'immediate').map(p => p.key))
    const grantOnly = current.lines.every(line => {
      const target = requested.lines.find(row => row.key === line.key)
      return grantedKeys.has(line.key) ? !target || target.stripePriceId === line.stripePriceId && target.quantity <= line.quantity : target?.stripePriceId === line.stripePriceId && target.quantity === line.quantity
    }) && requested.lines.every(line => current.lines.some(row => row.key === line.key))
    if (immediate && (!grantOnly || changeTiming(current, { ...requested, recurringCents: current.recurringCents }) !== 'immediate' || requested.recurringCents > current.recurringCents || requested.exception?.discountBasisPoints !== (current.exception?.discountBasisPoints ?? 0) || !matchesContract(sub.items.data, current))) throw new Error('BILLING_INVALID_PROMOTION_IMMEDIATE_CHANGE')
    const effective = immediate ? now : renewal
    if (fresh.some(p => (p.startsAt ?? 0) < effective)) throw new Error('BILLING_INVALID_PROMOTION_DATE')
    const phases = promotionPhases(products, versions, selection, exception, current, effective, owned?.current_phase.start_date ?? sub.items.data[0].current_period_start, now, renewal)
    // Preserve existing grants until a deferred change, including expirations before renewal.
    for (const phase of phases) {
      if (phase.start < effective && !immediate) {
        const retainedKeys = new Set([versions.find(v => v.id === current.selection.planVersionId)?.productKey, ...current.selection.addons.map(addon => addon.key)])
        phase.contract = buildContract(products.map(product => retainedKeys.has(product.key) ? { ...product, active: true } : product), versions, current.selection, current.exception, Math.max(now, phase.start))
      }
      await this.validateSelection(account.tenant_id, phase.contract)
      // Stripe resets anchors on zero-to-paid classic subscriptions. Require a paid
      // base so an expiry cannot unexpectedly invoice in the middle of a period.
      if (!phase.contract.lines.some(line => line.amountCents > 0)) throw new Error('BILLING_INVALID_PROMOTION_ZERO_BASE')
      phase.discounts = await this.materialize(phase.contract, account.tenant_id)
    }
    const next = phases.find(p => p.start <= effective && effective < p.end)?.contract
    if (!next) throw new Error('BILLING_INVALID_PROMOTION_DATE')
    const previews: PromotionPreview[] = []
    for (const promotion of exception.promotions ?? []) {
      const firstCharge = renewalOnOrAfter(promotion.endsAt ?? now, renewal, next.interval, next.interval === current.interval ? sub.billing_cycle_anchor : renewal)
      const after = buildContract(products, versions, selection, exception, firstCharge)
      const discounts = await this.materialize(after, account.tenant_id)
      const line = after.lines.find(l => l.key === promotion.key)
      const version = versions.find(v => v.id === selection.addons.find(a => a.key === promotion.key)?.versionId)
      previews.push({ id: promotion.id, key: promotion.key, freeUnits: promotion.freeUnits, activationAt: iso(promotion.startsAt) ?? '', endsAt: iso(promotion.endsAt) ?? '', firstChargeAt: line && line.amountCents > 0 && exception.discountBasisPoints < 10_000 ? iso(firstCharge) : null, regularUnitCents: exception.customAmounts[promotion.key] ?? version?.amountCents ?? 0, firstAddonChargeCents: line ? Number((BigInt(line.amountCents) * BigInt(line.quantity) * BigInt(10_000 - exception.discountBasisPoints) + 5_000n) / 10_000n) : 0, firstInvoiceCents: await this.promotionInvoice(account, sub, after, discounts, taxRateId), prorated: false })
    }
    const renewalPhase = phases.find(p => p.start <= renewal && renewal < p.end) ?? phases.at(-1)
    const renewalCents = renewalPhase ? await this.promotionInvoice(account, sub, renewalPhase.contract, renewalPhase.discounts, taxRateId) : 0
    return this.transition<Operation>('quote', { tenantId: account.tenant_id, actorId, revision: account.revision, kind: 'change', contract: next, restoreContract: null, timing: immediate ? 'immediate' : 'period_end',
      stripeParams: { subscriptionId: sub.id, taxRateId, scheduleId: owned?.id, baseline: subscriptionBaseline(sub), scheduleBaseline: owned ? scheduleBaseline(owned) : undefined, phases },
      preview: { amountDueCents: 0, recurringCents: next.recurringCents, afterPromotionCents: phases.at(-1)?.contract.recurringCents, renewalCents, currency: 'eur', effectiveAt: iso(effective), promotions: previews, details: 'Sin cargos ni prorrateos ahora o al cambiar de fase. Si la promoción termina entre renovaciones, el tramo restante es gratuito y el precio habitual se cobra en la siguiente renovación. Cambios de plan, cantidades o retirada de promociones: próxima renovación. Importes recurrentes sin IVA; facturas estimadas por Stripe con IVA del 21 %, sujetas a cambios de saldo y de contrato.' }, reason, prorationDate: now })
  }
  async quoteCancel(tenantId: string, actorId: string, immediate: boolean, reason: string) {
    const account = await this.account(tenantId)
    const sub = await this.subscription(account)
    const pending = await this.db.from('billing_operations').select('id').eq('tenant_id', tenantId).in('status', ['applying', 'payment_pending']).limit(1)
    if (pending.error) throw new Error('BILLING_DB_OPERATION')
    if (pending.data?.length) throw new Error('BILLING_PENDING_CHANGE')
    const owned = sub ? await this.ownedSchedule(account, sub, true) : null
    if (!sub || (sub.schedule && !owned) || sub.pending_update) throw new Error('BILLING_PENDING_CHANGE')
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: immediate ? 'cancel_now' : 'cancel', contract: null, restoreContract: null, timing: immediate ? 'immediate' : 'period_end', stripeParams: { subscriptionId: sub.id, baseline: subscriptionBaseline(sub), scheduleId: owned?.id, scheduleBaseline: owned ? scheduleBaseline(owned) : undefined, cancelSchedule: Boolean(owned), supersededOperationId: owned?.supersededOperationId }, preview: { amountDueCents: 0, recurringCents: 0, currency: 'eur', effectiveAt: immediate ? new Date().toISOString() : account.period_end, details: 'No se reembolsan periodos pagados. La baja sustituye cualquier cambio o promoción programados; no se cobrarán recuperaciones de precio posteriores. Se conserva la información y la continuidad operativa.' }, reason, prorationDate: Math.floor(Date.now() / 1000) })
  }
  async applyStripeMutation<T>(op: Operation, work: () => Promise<T>, releaseOnRejection: boolean) {
    try { return await work() }
    catch (error) {
      const diagnostic = error instanceof StripeRequestError ? error.diagnostic : { outcome: 'uncertain', code: 'STRIPE_TRANSPORT_OR_RESPONSE_ERROR' }
      await this.transition('apply_error', { tenantId: op.tenant_id, operationId: op.id, error: diagnostic, release: releaseOnRejection && diagnostic.outcome === 'rejected' })
      throw error
    }
  }
  async confirm(tenantId: string, actorId: string, operationId: string, retry = false) {
    const before = await this.db.from('billing_operations').select('*').eq('id', operationId).eq('tenant_id', tenantId).single<Operation>()
    if (before.error) throw new Error('BILLING_OPERATION_NOT_FOUND')
    if (before.data.status !== 'quoted' && !retry) return confirmationResult(before.data)
    if (retry && (before.data.status !== 'applying' || Date.now() - Date.parse(before.data.created_at) > 23 * 3600_000)) throw new Error('BILLING_MANUAL_RECONCILIATION_REQUIRED')
    // Requote old offers; an in-flight retry must retain its original Stripe parameters.
    if (!retry && before.data.kind === 'change' && !before.data.stripe_params.taxRateId) throw new Error('BILLING_STALE_STRIPE_QUOTE')
    if (!retry && before.data.kind === 'change' && !before.data.stripe_params.subscriptionId && before.data.stripe_params.checkoutPolicy !== 'fiscal_sepa_v2') throw new Error('BILLING_STALE_STRIPE_QUOTE')
    if (!retry && before.data.stripe_params.baseline) {
      const account = await this.account(tenantId)
      const sub = await this.subscription(account)
      if (!sub || subscriptionBaseline(sub) !== before.data.stripe_params.baseline) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      if (before.data.stripe_params.sepaDebit !== undefined && await subscriptionUsesSepa(this.stripe, sub) !== before.data.stripe_params.sepaDebit) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      if (before.data.stripe_params.scheduleId && before.data.stripe_params.scheduleBaseline) {
        const schedule = await this.ownedSchedule(account, sub, before.data.kind !== 'change')
        if (!schedule || scheduleBaseline(schedule) !== before.data.stripe_params.scheduleBaseline || schedule.supersededOperationId !== before.data.stripe_params.supersededOperationId) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      }
    }
    if (!retry && before.data.stripe_params.phases) {
      const account = await this.account(tenantId), sub = await this.subscription(account)
      const phases = before.data.stripe_params.phases
      if (!sub || phases[0].end <= Math.floor(Date.now() / 1000)) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      const renewal = sub.items.data[0].current_period_end
      const phase = phases.find(p => p.start <= renewal && renewal < p.end) ?? phases.at(-1)
      if (!phase || await this.promotionInvoice(account, sub, phase.contract, phase.discounts, before.data.stripe_params.taxRateId) !== before.data.preview.renewalCents) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      for (const promotion of before.data.preview.promotions ?? []) {
        if (!promotion.firstChargeAt) continue
        const at = Date.parse(promotion.firstChargeAt) / 1000
        const after = phases.find(p => p.start <= at && at < p.end) ?? phases.at(-1)
        if (!after || await this.promotionInvoice(account, sub, after.contract, after.discounts, before.data.stripe_params.taxRateId) !== promotion.firstInvoiceCents) throw new Error('BILLING_STALE_STRIPE_QUOTE')
      }
    } else if (!retry && before.data.kind === 'change') {
      const account = await this.account(tenantId)
      const immediate = before.data.timing === 'immediate'
      const subId = before.data.stripe_params.subscriptionId
      const taxRateId = before.data.stripe_params.taxRateId
      const preview = await this.stripe.request<StripeInvoice>('POST', '/invoices/create_preview', {
        customer: account.stripe_customer_id ?? undefined,
        ...(taxRateId ? { customer_details: { tax_exempt: 'none' }, automatic_tax: { enabled: false } } : {}),
        subscription: subId ?? undefined,
        preview_mode: immediate ? undefined : 'recurring',
        subscription_details: { ...(taxRateId ? { default_tax_rates: [taxRateId] } : {}), items: previewItems(before.data.stripe_params.items, taxRateId), proration_behavior: immediate && subId ? 'always_invoice' : undefined, proration_date: immediate && subId ? before.data.proration_date : undefined },
        discounts: before.data.stripe_params.discounts,
      })
      const expected = immediate ? before.data.preview.amountDueCents : before.data.preview.renewalCents
      if (preview.currency !== 'eur' || preview.amount_due !== expected) throw new Error('BILLING_STALE_STRIPE_QUOTE')
    }
    if (before.data.contract) await this.validateSelection(tenantId, before.data.contract)
    // Cross-terminal serialization is enforced in the DB, including duplicate button presses.
    const op = retry ? before.data : await this.transition<Operation>('apply_claim', { tenantId, actorId, operationId })
    if (op.status !== 'applying') return confirmationResult(op)
    const account = await this.account(tenantId)
    const idempotencyKey = `tickit:${op.id}`
    const taxRateId = op.stripe_params.taxRateId
    const taxes = taxRateId ? { default_tax_rates: [taxRateId] } : {}
    const phaseTaxes = taxRateId ? { ...taxes, automatic_tax: { enabled: false } } : {}
    // A prior tax configuration write may have succeeded even if its response was lost.
    const configuredCustomerTax = op.kind === 'change' && Boolean(taxRateId && account.stripe_customer_id)
    if (configuredCustomerTax) {
      await this.applyStripeMutation(op, () => this.stripe.request('POST', `/customers/${account.stripe_customer_id}`, { tax_exempt: 'none' }, `${idempotencyKey}:vat-customer`), !retry)
    }
    let result: Operation['result'] = {}
    let status = 'payment_pending'
    // A retry may follow earlier effects: only a first, definitively rejected mutation can release.
    if (op.kind === 'cancel_now' || op.kind === 'cancel') {
      if (!op.stripe_params.subscriptionId) throw new Error('BILLING_SUBSCRIPTION_REQUIRED')
      if (op.stripe_params.cancelSchedule && op.stripe_params.scheduleId) {
        await this.applyStripeMutation(op, () => this.stripe.request('POST', `/subscription_schedules/${op.stripe_params.scheduleId}/release`, { preserve_cancel_date: false }, `${idempotencyKey}:release`), !retry)
      }
      await this.applyStripeMutation(op, () => this.stripe.request(op.kind === 'cancel_now' ? 'DELETE' : 'POST', `/subscriptions/${op.stripe_params.subscriptionId}`, op.kind === 'cancel_now' ? { prorate: false, invoice_now: false } : { cancel_at_period_end: true }, idempotencyKey), !retry && !op.stripe_params.cancelSchedule)
      status = 'completed'
    } else if (!op.stripe_params.subscriptionId) {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const contract = op.contract
      let customerId = account.stripe_customer_id
      if (!customerId) {
        const customer = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string }>('POST', '/customers', { name: account.legal_name ?? undefined, email: account.email ?? undefined, ...(taxRateId ? { tax_exempt: 'none' } : {}), metadata: { tickit_tenant_id: tenantId } }, `${idempotencyKey}:customer`), !retry)
        customerId = customer.id
        await this.transition('link_customer', { tenantId, customerId })
      }
      const existing = await this.stripe.list<StripeSubscription>('/subscriptions', { customer: customerId, status: 'all' })
      if (existing.some(sub => !['canceled','incomplete_expired'].includes(sub.status))) throw new Error('BILLING_EXISTING_SUBSCRIPTION')
      const checkout = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string; url: string }>('POST', '/checkout/sessions', {
        customer: customerId, mode: 'subscription',
        ...(taxRateId ? { automatic_tax: { enabled: false } } : {}),
        // Preserve historical in-flight requests: changing parameters under their key
        // could hide a successful Checkout whose response was lost.
        ...(op.stripe_params.checkoutPolicy === 'fiscal_sepa_v2'
          ? { tax_id_collection: { enabled: true, required: 'if_supported' } }
          : op.stripe_params.checkoutPolicy === 'fiscal_sepa_v1'
            ? { payment_method_types: ['card', 'sepa_debit'], tax_id_collection: { enabled: true, required: 'if_supported' } }
            : { tax_id_collection: { enabled: true } }),
        billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' },
        client_reference_id: tenantId, metadata: { tickit_operation_id: op.id, tickit_tenant_id: tenantId },
        subscription_data: { ...taxes, metadata: { tickit_operation_id: op.id, tickit_tenant_id: tenantId } },
        line_items: contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity })),
        discounts: op.stripe_params.discounts || undefined,
        success_url: `${this.appUrl}/crm?billing=success`, cancel_url: `${this.appUrl}/crm?billing=cancelled`,
      }, idempotencyKey), !retry && !configuredCustomerTax)
      result = { checkoutId: checkout.id, url: checkout.url }
    } else if (op.stripe_params.phases) {
      const schedule = op.stripe_params.scheduleId ? { id: op.stripe_params.scheduleId } : await this.applyStripeMutation(op, () => this.stripe.request<{ id: string }>('POST', '/subscription_schedules', { from_subscription: op.stripe_params.subscriptionId }, `${idempotencyKey}:schedule`), !retry && !configuredCustomerTax)
      const phases = op.stripe_params.phases.map((phase,index) => ({ ...phaseTaxes, start_date: phase.start, end_date: phase.end, items: phase.contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity, ...(taxRateId ? { tax_rates: '' } : {}) })), discounts: phase.discounts, proration_behavior: 'none', metadata: { tickit_operation_id: op.id, tickit_phase: String(index), tickit_exception_restored: '' } }))
      await this.applyStripeMutation(op, () => this.stripe.request('POST', `/subscription_schedules/${schedule.id}`, { end_behavior: 'release', proration_behavior: 'none', metadata: { tickit_operation_id: op.id, tickit_tenant_id: tenantId }, phases }, `${idempotencyKey}:phases`), false)
      result = { scheduleId: schedule.id }; status = 'scheduled'
    } else if (op.timing === 'period_end') {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const sub = await this.subscription(account)
      if (!sub || sub.pending_update || (sub.schedule && !retry)) throw new Error('BILLING_PENDING_CHANGE')
      const schedule = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string; current_phase: { start_date: number; end_date: number } }>('POST', '/subscription_schedules', { from_subscription: sub.id }, `${idempotencyKey}:schedule`), !retry && !configuredCustomerTax)
      const basePhase = { ...phaseTaxes, start_date: schedule.current_phase.start_date, end_date: schedule.current_phase.end_date, items: sub.items.data.map(item => ({ price: item.price.id, quantity: item.quantity, ...(taxRateId ? { tax_rates: '' } : {}) })), proration_behavior: 'none', discounts: account.contract?.exception?.discountBasisPoints ? [{ coupon: `tickit_discount_${account.contract.exception.discountBasisPoints}` }] : '' }
      const nextPhase = { ...phaseTaxes, items: op.contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity, ...(taxRateId ? { tax_rates: '' } : {}) })), discounts: op.stripe_params.discounts, proration_behavior: 'none', metadata: { tickit_operation_id: op.id, tickit_exception_restored: '' }, duration: { interval: op.contract.interval, interval_count: op.contract.exception?.cycles ?? 1 } }
      const phases = [basePhase, nextPhase, ...(op.restore_contract ? [{ ...phaseTaxes, items: op.restore_contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity, ...(taxRateId ? { tax_rates: '' } : {}) })), discounts: '', proration_behavior: 'none', duration: { interval: op.restore_contract.interval, interval_count: 1 }, metadata: { tickit_operation_id: op.id, tickit_exception_restored: 'true' } }] : [])]
      // A schedule already exists. Even a definitive phase rejection must retain the lock.
      await this.applyStripeMutation(op, () => this.stripe.request('POST', `/subscription_schedules/${schedule.id}`, { end_behavior: 'release', proration_behavior: 'none', phases }, `${idempotencyKey}:phases`), false)
      result = { scheduleId: schedule.id }; status = 'scheduled'
    } else {
      if (taxRateId) {
        const sub = await this.subscription(account)
        if (!sub) throw new Error('BILLING_SUBSCRIPTION_REQUIRED')
        const configured = !sub.automatic_tax?.enabled && sub.default_tax_rates?.length === 1 && sub.default_tax_rates[0].id === taxRateId && sub.items.data.every(item => !item.tax_rates?.length)
        if (!configured) {
          // Tax settings are unsupported by pending_if_incomplete. Configure them
          // without proration first; the paid upgrade remains a pending update.
          if (sub.pending_update) throw new Error('BILLING_PENDING_CHANGE')
          await this.applyStripeMutation(op, () => this.stripe.request('POST', `/subscriptions/${sub.id}`, { ...taxes, automatic_tax: { enabled: false }, items: sub.items.data.map(item => ({ id: item.id, tax_rates: '' })), proration_behavior: 'none' }, `${idempotencyKey}:vat-subscription`), !retry && !configuredCustomerTax)
        }
      }
      const updated = await this.applyStripeMutation(op, () => this.stripe.request<StripeSubscription>('POST', `/subscriptions/${op.stripe_params.subscriptionId}`, { items: op.stripe_params.items, discounts: op.stripe_params.discounts, payment_behavior: op.stripe_params.sepaDebit ? 'allow_incomplete' : 'pending_if_incomplete', proration_behavior: 'always_invoice', proration_date: op.proration_date }, idempotencyKey), !retry && !taxRateId)
      result = { pendingInvoiceId: typeof updated.latest_invoice === 'object' ? updated.latest_invoice?.id : updated.latest_invoice }
    }
    const operation = await this.transition<Operation>('apply_result', { tenantId, operationId, status, result, effectiveAt: op.timing === 'period_end' ? account.period_end : null })
    // Completion is determined by Stripe, not the browser redirect or this POST response.
    await this.reconcile(tenantId)
    return { operation, url: result?.url }
  }
  async portal(tenantId: string) {
    const account = await this.account(tenantId)
    if (!account.stripe_customer_id || !this.portalConfiguration) throw new Error('BILLING_PORTAL_NOT_CONFIGURED')
    const configuration = await this.stripe.request<{ features: { subscription_update: { enabled: boolean }; subscription_cancel: { enabled: boolean } } }>('GET', `/billing_portal/configurations/${this.portalConfiguration}`)
    if (configuration.features.subscription_update.enabled || configuration.features.subscription_cancel.enabled) throw new Error('BILLING_PORTAL_UNSAFE_CONFIGURATION')
    return this.stripe.request<{ url: string }>('POST', '/billing_portal/sessions', { customer: account.stripe_customer_id, configuration: this.portalConfiguration, return_url: `${this.appUrl}/crm?billing=return` })
  }
  async reconcile(tenantId: string) {
    const { token } = await this.transition<{ token: string }>('sync_claim', { tenantId })
    try {
      const account = await this.account(tenantId)
      if (!account.stripe_customer_id) throw new Error('BILLING_CUSTOMER_REQUIRED')
      const subscriptions = await this.stripe.list<StripeSubscription>('/subscriptions', { customer: account.stripe_customer_id, status: 'all' })
      const live = subscriptions.filter(sub => !['canceled','incomplete_expired'].includes(sub.status))
      if (live.length > 1) throw new Error('BILLING_MULTIPLE_SUBSCRIPTIONS')
      const found = live[0] ?? subscriptions.find(sub => sub.id === account.stripe_subscription_id)
      const sub = found ? await this.stripe.request<StripeSubscription>('GET', `/subscriptions/${found.id}`, { expand: ['latest_invoice','discounts'] }) : null
      if (sub && (sub.livemode !== false || sub.customer !== account.stripe_customer_id || sub.items.has_more)) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
      const invoices = await this.stripe.list<StripeInvoice>('/invoices', { customer: account.stripe_customer_id })
      for (const invoice of invoices) {
        if (invoice.customer !== account.stripe_customer_id || invoice.currency !== 'eur') throw new Error('BILLING_INVOICE_MISMATCH')
        const saved = await this.db.from('billing_invoices').upsert({
          stripe_invoice_id: invoice.id, tenant_id: tenantId, status: invoice.status, currency: invoice.currency,
          amount_due_cents: invoice.amount_due, amount_paid_cents: invoice.amount_paid,
          paid_excluding_tax_cents: invoice.status === 'paid' ? Math.max(0, Math.min(invoice.amount_paid, invoice.total_excluding_tax ?? 0)) : 0,
          issuer_snapshot: { name: invoice.account_name ?? null, country: invoice.account_country ?? null, taxIds: invoice.account_tax_ids ?? [] },
          customer_snapshot: { name: invoice.customer_name ?? null, taxIds: invoice.customer_tax_ids ?? [], address: invoice.customer_address ?? null },
          hosted_invoice_url: invoice.hosted_invoice_url, invoice_pdf: invoice.invoice_pdf, number: invoice.number,
          created_at: iso(invoice.created), paid_at: iso(invoice.status_transitions.paid_at),
        })
        if (saved.error) throw new Error('BILLING_DB_INVOICE')
      }
      const pending = await this.db.from('billing_operations').select('*').eq('tenant_id', tenantId).in('status', ['applying','scheduled','payment_pending']).order('created_at', { ascending: false }).returns<Operation[]>()
      if (pending.error) throw new Error('BILLING_DB_OPERATION')
      // Applied calendars are no longer in-flight economic operations, but their phase
      // snapshots remain the authority until superseded. Never reconstruct them from catalog.
      let timeline: Operation | null = null
      if (account.schedule_operation_id) {
        const stored = await this.db.from('billing_operations').select('*').eq('tenant_id', tenantId).eq('id', account.schedule_operation_id).single<Operation>()
        if (stored.error) throw new Error('BILLING_DB_OPERATION')
        timeline = stored.data
      }
      const expiredIds = new Set<string>()
      const paymentInvoices = new Map<string, StripeInvoice | undefined>()
      const checkoutSubscriptions = new Map<string, string | null>()
      for (const operation of pending.data) {
        let expired = false
        if (operation.result?.checkoutId) {
          const session = await this.stripe.request<{ id: string; customer: string; livemode: boolean; mode: string; status: string; subscription: string | null; invoice: string | null; client_reference_id: string; metadata: Record<string, string> }>('GET', `/checkout/sessions/${operation.result.checkoutId}`)
          if (session.id !== operation.result.checkoutId || session.customer !== account.stripe_customer_id || session.livemode !== false || session.mode !== 'subscription'
            || session.client_reference_id !== tenantId || session.metadata.tickit_tenant_id !== tenantId || session.metadata.tickit_operation_id !== operation.id) throw new Error('BILLING_CHECKOUT_MISMATCH')
          const invoice = invoices.find(row => row.id === session.invoice)
          paymentInvoices.set(operation.id, invoice)
          checkoutSubscriptions.set(operation.id, session.subscription)
          expired = session.status === 'expired' || session.status === 'complete' && invoice?.status === 'void'
          // A completed Checkout cannot collect a retry; continue through its invoice.
          if (session.status === 'complete' && operation.status === 'payment_pending' && operation.result.url !== (invoice?.hosted_invoice_url ?? undefined)) {
            const saved = await this.db.from('billing_operations').update({ result: { ...operation.result, url: invoice?.hosted_invoice_url ?? undefined } }).eq('tenant_id', tenantId).eq('id', operation.id).eq('status', 'payment_pending')
            if (saved.error) throw new Error('BILLING_DB_PAYMENT_URL')
          }
        }
        if (operation.result?.pendingInvoiceId) {
          const invoice = invoices.find(row => row.id === operation.result?.pendingInvoiceId)
          paymentInvoices.set(operation.id, invoice)
          expired = !sub?.pending_update && invoice?.status === 'void'
        }
        if (expired && operation.status === 'payment_pending') {
          const saved = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', operation.id).eq('status', 'payment_pending')
          if (saved.error) throw new Error('BILLING_DB_PENDING_EXPIRY')
          expiredIds.add(operation.id)
        }
      }
      const candidates = pending.data.filter(op => !expiredIds.has(op.id) && !op.stripe_params.phases && (!checkoutSubscriptions.has(op.id) || checkoutSubscriptions.get(op.id) === sub?.id)).flatMap(op => [{ operation: op, contract: op.contract, restored: false }, ...(op.restore_contract ? [{ operation: op, contract: op.restore_contract, restored: true }] : [])])
      const matches = (contract: Contract) => {
        if (!sub || !matchesContract(sub.items.data, contract)) return false
        const expected = contract.exception?.discountBasisPoints ? `tickit_discount_${contract.exception.discountBasisPoints}` : null
        if (!expected) return sub.discounts.length === 0
        if (sub.discounts.length !== 1 || typeof sub.discounts[0] === 'string') return false
        const coupon = sub.discounts[0].source.coupon
        return (typeof coupon === 'string' ? coupon : coupon.id) === expected
      }
      const match = sub && candidates.find(candidate => candidate.contract && matches(candidate.contract)
        && (!candidate.operation.restore_contract || candidate.restored === (sub.metadata.tickit_exception_restored === 'true'))
        && (candidate.operation.timing !== 'period_end' || (candidate.operation.effective_at !== null && sub.items.data[0].current_period_start * 1000 >= Date.parse(candidate.operation.effective_at))))
      const phaseIndex = Number(sub?.metadata.tickit_phase)
      const phase = timeline?.id === sub?.metadata.tickit_operation_id && Number.isInteger(phaseIndex) ? timeline?.stripe_params.phases?.[phaseIndex] : null
      const phaseMatch = phase && matches(phase.contract) ? phase.contract : null
      const latest = sub?.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
      // A paid renewal cannot settle a different, still-unpaid upgrade or signup.
      const operationInvoice = match ? paymentInvoices.get(match.operation.id) : undefined
      const operationPaid = match && (paymentInvoices.has(match.operation.id) ? operationInvoice?.status === 'paid' : latest?.status === 'paid')
      let contract: Contract | null = null
      // Settlement of this invoice is independent of a later overdue renewal.
      let completedOperationId: string | null = match?.contract && operationPaid && !sub?.pending_update && paymentInvoices.has(match.operation.id) && !match.operation.restore_contract ? match.operation.id : null
      let discrepancy: string | null = null
      let sepaAuthorization: SepaAuthorization | null = null
      if (sub && latest && match?.contract && !mayProject(sub.status, Boolean(sub.pending_update), latest.status === 'paid')) {
        sepaAuthorization = await processingSepaAuthorization(this.stripe, tenantId, sub, latest, match.operation)
        if (sepaAuthorization) contract = match.contract
      }
      if (sub && mayProject(sub.status, Boolean(sub.pending_update), latest?.status === 'paid')) {
        if (phaseMatch && timeline) {
          contract = phaseMatch; completedOperationId = timeline.id
        } else if (match?.contract && operationPaid) {
          contract = match.contract
          // Keep temporary concessions pending until the standard phase has returned.
          if (!match.operation.restore_contract || match.restored) completedOperationId = match.operation.id
        } else if (account.contract && matches(account.contract)) {
          contract = account.contract
        } else discrepancy = 'UNRECOGNIZED_STRIPE_ITEMS'
      }
      const financialContract = match?.contract && (operationPaid || match.operation.stripe_params.sepaDebit && match.operation.result?.pendingInvoiceId === latest?.id) ? match.contract : phaseMatch
      const taxId = latest?.customer_tax_ids?.find(value => value.type === 'es_cif') ?? latest?.customer_tax_ids?.find(value => value.type === 'eu_vat')
      await this.transition('sync_commit', { tenantId, token, customerId: account.stripe_customer_id, subscriptionId: sub?.id ?? null, status: sub?.status ?? account.status, contract, clearSchedule: !sub?.schedule,
        financialContract: sub && !sub.pending_update && ['active','past_due','unpaid'].includes(sub.status) ? financialContract : null,
        sepaAuthorization, payer: latest ? { legalName: latest.customer_name, taxId: taxId?.value, email: latest.customer_email } : null,
        paymentStatus: sepaAuthorization ? 'processing' : operationInvoice && ['open', 'uncollectible'].includes(operationInvoice.status) ? operationInvoice.status : latest?.status ?? null, periodEnd: iso(sub?.items.data[0]?.current_period_end), cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false, completedOperationId, discrepancy })
      return { reconciled: true, discrepancy }
    } catch (error) {
      await this.transition('sync_fail', { tenantId, token })
      throw error
    }
  }
  async processEvent(event: { id: string; type: string; created: number; livemode: boolean; data: { object: { customer?: string } } }) {
    if (event.livemode !== false) throw new Error('BILLING_LIVE_MODE_FORBIDDEN')
    const supported = ['payment_intent.processing','payment_intent.succeeded','payment_intent.payment_failed','payment_intent.canceled','charge.failed','checkout.session.async_payment_failed','checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.pending_update_applied','customer.subscription.pending_update_expired','invoice.paid','invoice.payment_failed','invoice.payment_action_required','subscription_schedule.updated','subscription_schedule.completed','subscription_schedule.released','subscription_schedule.aborted']
    const customer = event.data.object.customer
    const claim = await this.transition<{ claimed: boolean }>('event_claim', { id: event.id, type: event.type, created: event.created, customer })
    if (!claim.claimed) return
    try {
      const account = customer ? await this.db.from('billing_accounts').select('tenant_id').eq('stripe_customer_id', customer).maybeSingle() : { data: null, error: null }
      if (account.error) throw new Error('BILLING_DB_EVENT')
      if (account.data && supported.includes(event.type)) await this.reconcile(account.data.tenant_id)
      await this.transition('event_finish', { id: event.id, status: account.data && supported.includes(event.type) ? 'completed' : 'ignored' })
    } catch {
      await this.transition('event_finish', { id: event.id, status: 'failed', error: 'RECONCILIATION_REQUIRED' })
      throw new Error('BILLING_EVENT_RETRY_REQUIRED')
    }
  }
}
