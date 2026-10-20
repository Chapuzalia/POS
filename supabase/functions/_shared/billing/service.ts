import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.115.0'
import { buildContract, changeTiming, commercialState, matchesContract, mayProject, recurringMetrics, stripeItems } from './domain.ts'
import type { CommercialException, Contract, Product, Selection, Version } from './domain.ts'
import { StripeGateway, StripeRequestError } from './stripe.ts'
import type { StripeInvoice, StripeSubscription } from './stripe.ts'

export type Account = {
  tenant_id: string; stripe_customer_id: string | null; stripe_subscription_id: string | null
  source: string; status: string; legal_name: string | null; tax_id: string | null; email: string | null
  contract: Contract | null; billed_contract: Contract | null; revision: number; period_end: string | null; cancel_at_period_end: boolean
  delinquent_since: string | null; grace_days: number; last_payment_status: string | null
  last_reconciled_at: string | null; sync_error: string | null; created_at: string
}
export type Operation = {
  id: string; tenant_id: string; actor_id: string; kind: 'change' | 'cancel' | 'cancel_now'
  status: string; contract: Contract | null; restore_contract: Contract | null
  timing: 'immediate' | 'period_end'; preview: { amountDueCents: number; recurringCents: number; renewalCents?: number | null; currency: string; effectiveAt: string | null; details: string }
  stripe_params: { subscriptionId: string | null; items?: ReturnType<typeof stripeItems>; discounts?: Array<{ coupon: string }> | ''; scheduleId?: string; baseline?: string }
  result: { url?: string; checkoutId?: string; scheduleId?: string; pendingInvoiceId?: string | null } | null; created_at: string; proration_date: number; effective_at: string | null
}
type VersionRow = { id: string; product_key: string; interval: 'month' | 'year'; amount_cents: number; features: string[]; limits: Version['limits']; included: Record<string, number>; maximum: number | null; requires: string[]; stripe_price_id: string | null; published: boolean }
type ProductRow = { key: string; kind: Product['kind']; name: string; description: string; scope: Product['scope']; feature_key: string | null; resource: Product['resource']; active: boolean; sort_order: number }
type StripePrice = { id: string; unit_amount: number; currency: string; recurring: { interval: string }; active: boolean; metadata: Record<string, string> }
const iso = (seconds: number | undefined | null) => seconds ? new Date(seconds * 1000).toISOString() : null
const subscriptionBaseline = (sub: StripeSubscription) => JSON.stringify({ status: sub.status, items: sub.items.data.map(item => [item.id,item.price.id,item.quantity,item.current_period_start,item.current_period_end]), pending: sub.pending_update, schedule: sub.schedule, cancellation: sub.cancel_at_period_end, discounts: sub.discounts, invoice: typeof sub.latest_invoice === 'object' ? sub.latest_invoice?.id : sub.latest_invoice })

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
      const known = ['BILLING_STALE','BILLING_FORBIDDEN','BILLING_SYNC_BUSY','BILLING_EVENT_BUSY','BILLING_PRODUCT_IDENTITY_IMMUTABLE']
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
    const [tenant, venues, devices, invoices, operations, audit] = await Promise.all([
      this.db.from('tenants').select('id,name,max_venues,max_devices').eq('id', tenantId).single(),
      this.db.from('venues').select('id,name,is_active').eq('tenant_id', tenantId),
      this.db.from('devices').select('id,name,venue_id,is_active').eq('tenant_id', tenantId).eq('is_active', true),
      this.db.from('billing_invoices').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100),
      this.db.from('billing_operations').select('id,kind,status,timing,preview,result,reason,created_at,effective_at').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(50),
      admin ? this.db.from('billing_audit').select('*').eq('tenant_id', tenantId).order('created_at', { ascending: false }).limit(100) : Promise.resolve({ data: [], error: null }),
    ])
    if ([tenant, venues, devices, invoices, operations, audit].some(result => result.error)) throw new Error('BILLING_DB_DETAIL')
    return { account, tenant: tenant.data, venues: venues.data, devices: devices.data, invoices: invoices.data, operations: operations.data, audit: audit.data, commercialState: commercialState(account.status, account.delinquent_since, account.grace_days) }
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
  async subscription(account: Account) {
    if (!account.stripe_subscription_id) return null
    const sub = await this.stripe.request<StripeSubscription>('GET', `/subscriptions/${account.stripe_subscription_id}`, { expand: ['latest_invoice','discounts'] })
    if (sub.customer !== account.stripe_customer_id || sub.livemode !== false || sub.items.has_more) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
    return sub
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
    if (commercialState(account.status, account.delinquent_since, account.grace_days) === 'restricted' && !['canceled','incomplete_expired'].includes(account.status)) throw new Error('BILLING_PAYMENT_REQUIRED')
    const { products, versions } = await this.catalog()
    const existingContract = account.billed_contract ?? account.contract
    if (!isSuperadmin) {
      if (exception) throw new Error('BILLING_FORBIDDEN')
      exception = existingContract?.exception ?? null
      const existing = account.billed_contract ?? account.contract
      const retained = new Set([existing?.selection.planVersionId, ...(existing?.selection.addons.map(addon => addon.versionId) ?? [])])
      const current = new Map<string, string>()
      for (const version of versions) if (version.published && !current.has(`${version.productKey}:${version.interval}`)) current.set(`${version.productKey}:${version.interval}`,version.id)
      for (const id of [selection.planVersionId,...selection.addons.map(addon => addon.versionId)]) {
        const version = versions.find(row => row.id === id)
        if (!version || (!retained.has(id) && current.get(`${version.productKey}:${version.interval}`) !== id)) throw new Error('BILLING_INVALID_HISTORICAL_TARIFF')
      }
    }
    const effectiveProducts = products.map(product => {
      if (product.active) return product
      const existingPlan = existingContract && versions.find(version => version.id === existingContract.selection.planVersionId)
      if (existingPlan?.productKey === product.key && selection.planVersionId === existingPlan.id) return { ...product, active: true }
      const previous = existingContract?.selection.addons.find(addon => addon.key === product.key)
      const requested = selection.addons.find(addon => addon.key === product.key)
      return previous && requested && previous.versionId === requested.versionId && requested.quantity <= previous.quantity ? { ...product, active: true } : product
    })
    const next = buildContract(effectiveProducts, versions, selection, exception)
    await this.validateSelection(tenantId, next)
    const linkedSubscription = await this.subscription(account)
    const subscription = linkedSubscription && !['canceled','incomplete_expired'].includes(linkedSubscription.status) ? linkedSubscription : null
    if (subscription?.pending_update || subscription?.schedule || subscription?.cancel_at_period_end || (subscription && !['active','trialing'].includes(subscription.status))) throw new Error('BILLING_PENDING_CHANGE')
    // Fixed-term concessions use schedule phases; only at renewal, never an ad-hoc expiry cron.
    const timing = exception?.cycles ? 'period_end' : subscription && account.contract ? changeTiming(account.contract, next) : 'immediate'
    if (exception?.cycles && !subscription) throw new Error('BILLING_TEMPORARY_REQUIRES_SUBSCRIPTION')
    const restore = exception?.cycles ? buildContract(effectiveProducts, versions, selection) : null
    const discounts = await this.materialize(next, tenantId)
    if (restore) await this.materialize(restore, tenantId)
    const prorationDate = Math.floor(Date.now() / 1000)
    const items = subscription ? stripeItems(subscription.items.data, next.lines) : next.lines.map(line => ({ price: line.stripePriceId ?? undefined, quantity: line.quantity }))
    const preview = await this.stripe.request<StripeInvoice>('POST', '/invoices/create_preview', { customer: account.stripe_customer_id ?? undefined, ...(subscription ? { subscription: subscription.id } : {}), ...(timing === 'period_end' ? { preview_mode: 'recurring' } : {}), subscription_details: { items, proration_behavior: timing === 'immediate' && subscription ? 'always_invoice' : undefined, proration_date: timing === 'immediate' && subscription ? prorationDate : undefined }, discounts })
    if (preview && preview.currency !== 'eur') throw new Error('BILLING_CURRENCY_MISMATCH')
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: 'change', contract: next, restoreContract: restore, timing, stripeParams: { subscriptionId: subscription?.id ?? null, items, discounts, baseline: subscription ? subscriptionBaseline(subscription) : undefined }, preview: { amountDueCents: timing === 'immediate' ? preview.amount_due : 0, renewalCents: timing === 'period_end' ? preview.amount_due : null, recurringCents: next.recurringCents, currency: 'eur', effectiveAt: timing === 'period_end' ? account.period_end : null, details: timing === 'period_end' ? 'Cambio al vencimiento; sin cargo inmediato. Vista previa de renovación calculada por Stripe.' : 'Vista previa de Stripe; incluye los ajustes e impuestos configurados.' }, reason, prorationDate })
  }
  async quoteCancel(tenantId: string, actorId: string, immediate: boolean, reason: string) {
    const account = await this.account(tenantId)
    const sub = await this.subscription(account)
    if (!sub || sub.schedule || sub.pending_update) throw new Error('BILLING_PENDING_CHANGE')
    return this.transition<Operation>('quote', { tenantId, actorId, revision: account.revision, kind: immediate ? 'cancel_now' : 'cancel', contract: null, restoreContract: null, timing: immediate ? 'immediate' : 'period_end', stripeParams: { subscriptionId: sub.id }, preview: { amountDueCents: 0, recurringCents: 0, currency: 'eur', effectiveAt: immediate ? new Date().toISOString() : account.period_end, details: 'No se reembolsan periodos pagados. Se conserva la información y la continuidad operativa.' }, reason, prorationDate: Math.floor(Date.now() / 1000) })
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
    if (before.data.status !== 'quoted' && !retry) return { operation: before.data, url: before.data.result?.url }
    if (retry && (before.data.status !== 'applying' || Date.now() - Date.parse(before.data.created_at) > 23 * 3600_000)) throw new Error('BILLING_MANUAL_RECONCILIATION_REQUIRED')
    if (!retry && before.data.stripe_params.baseline) {
      const account = await this.account(tenantId)
      const sub = await this.subscription(account)
      if (!sub || subscriptionBaseline(sub) !== before.data.stripe_params.baseline) throw new Error('BILLING_STALE_STRIPE_QUOTE')
    }
    if (!retry && before.data.kind === 'change') {
      const account = await this.account(tenantId)
      const immediate = before.data.timing === 'immediate'
      const subId = before.data.stripe_params.subscriptionId
      const preview = await this.stripe.request<StripeInvoice>('POST', '/invoices/create_preview', {
        customer: account.stripe_customer_id ?? undefined,
        subscription: subId ?? undefined,
        preview_mode: immediate ? undefined : 'recurring',
        subscription_details: { items: before.data.stripe_params.items, proration_behavior: immediate && subId ? 'always_invoice' : undefined, proration_date: immediate && subId ? before.data.proration_date : undefined },
        discounts: before.data.stripe_params.discounts,
      })
      const expected = immediate ? before.data.preview.amountDueCents : before.data.preview.renewalCents
      if (preview.currency !== 'eur' || preview.amount_due !== expected) throw new Error('BILLING_STALE_STRIPE_QUOTE')
    }
    if (before.data.contract) await this.validateSelection(tenantId, before.data.contract)
    // Cross-terminal serialization is enforced in the DB, including duplicate button presses.
    const op = retry ? before.data : await this.transition<Operation>('apply_claim', { tenantId, actorId, operationId })
    if (op.status !== 'applying') return { operation: op, url: op.result?.url }
    const account = await this.account(tenantId)
    const idempotencyKey = `tickit:${op.id}`
    let result: Operation['result'] = {}
    let status = 'payment_pending'
    // A retry may follow earlier effects: only a first, definitively rejected mutation can release.
    if (op.kind === 'cancel_now' || op.kind === 'cancel') {
      if (!op.stripe_params.subscriptionId) throw new Error('BILLING_SUBSCRIPTION_REQUIRED')
      await this.applyStripeMutation(op, () => this.stripe.request(op.kind === 'cancel_now' ? 'DELETE' : 'POST', `/subscriptions/${op.stripe_params.subscriptionId}`, op.kind === 'cancel_now' ? { prorate: false, invoice_now: false } : { cancel_at_period_end: true }, idempotencyKey), !retry)
      status = 'completed'
    } else if (!op.stripe_params.subscriptionId) {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const contract = op.contract
      let customerId = account.stripe_customer_id
      if (!customerId) {
        const customer = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string }>('POST', '/customers', { name: account.legal_name ?? undefined, email: account.email ?? undefined, metadata: { tickit_tenant_id: tenantId } }, `${idempotencyKey}:customer`), !retry)
        customerId = customer.id
        await this.transition('link_customer', { tenantId, customerId })
      }
      const existing = await this.stripe.list<StripeSubscription>('/subscriptions', { customer: customerId, status: 'all' })
      if (existing.some(sub => !['canceled','incomplete_expired'].includes(sub.status))) throw new Error('BILLING_EXISTING_SUBSCRIPTION')
      const checkout = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string; url: string }>('POST', '/checkout/sessions', {
        customer: customerId, mode: 'subscription',
        billing_address_collection: 'required', tax_id_collection: { enabled: true }, customer_update: { address: 'auto', name: 'auto' },
        client_reference_id: tenantId, metadata: { tickit_operation_id: op.id, tickit_tenant_id: tenantId },
        subscription_data: { metadata: { tickit_operation_id: op.id, tickit_tenant_id: tenantId } },
        line_items: contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity })),
        discounts: op.stripe_params.discounts || undefined,
        success_url: `${this.appUrl}/crm?billing=success`, cancel_url: `${this.appUrl}/crm?billing=cancelled`,
      }, idempotencyKey), !retry)
      result = { checkoutId: checkout.id, url: checkout.url }
    } else if (op.timing === 'period_end') {
      if (!op.contract) throw new Error('BILLING_CONTRACT_REQUIRED')
      const sub = await this.subscription(account)
      if (!sub || sub.pending_update || (sub.schedule && !retry)) throw new Error('BILLING_PENDING_CHANGE')
      const schedule = await this.applyStripeMutation(op, () => this.stripe.request<{ id: string; current_phase: { start_date: number; end_date: number } }>('POST', '/subscription_schedules', { from_subscription: sub.id }, `${idempotencyKey}:schedule`), !retry)
      const basePhase = { start_date: schedule.current_phase.start_date, end_date: schedule.current_phase.end_date, items: sub.items.data.map(item => ({ price: item.price.id, quantity: item.quantity })), proration_behavior: 'none', discounts: account.contract?.exception?.discountBasisPoints ? [{ coupon: `tickit_discount_${account.contract.exception.discountBasisPoints}` }] : '' }
      const nextPhase = { items: op.contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity })), discounts: op.stripe_params.discounts, proration_behavior: 'none', metadata: { tickit_operation_id: op.id, tickit_exception_restored: '' }, duration: { interval: op.contract.interval, interval_count: op.contract.exception?.cycles ?? 1 } }
      const phases = [basePhase, nextPhase, ...(op.restore_contract ? [{ items: op.restore_contract.lines.map(line => ({ price: line.stripePriceId, quantity: line.quantity })), discounts: '', proration_behavior: 'none', duration: { interval: op.restore_contract.interval, interval_count: 1 }, metadata: { tickit_operation_id: op.id, tickit_exception_restored: 'true' } }] : [])]
      // A schedule already exists. Even a definitive phase rejection must retain the lock.
      await this.applyStripeMutation(op, () => this.stripe.request('POST', `/subscription_schedules/${schedule.id}`, { end_behavior: 'release', proration_behavior: 'none', phases }, `${idempotencyKey}:phases`), false)
      result = { scheduleId: schedule.id }; status = 'scheduled'
    } else {
      const updated = await this.applyStripeMutation(op, () => this.stripe.request<StripeSubscription>('POST', `/subscriptions/${op.stripe_params.subscriptionId}`, { items: op.stripe_params.items, discounts: op.stripe_params.discounts, payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice', proration_date: op.proration_date }, idempotencyKey), !retry)
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
      for (const operation of pending.data) {
        if ((!sub || ['canceled','incomplete_expired'].includes(sub.status)) && operation.result?.checkoutId) {
          const session = await this.stripe.request<{ status: string }>('GET', `/checkout/sessions/${operation.result.checkoutId}`)
          if (session.status === 'expired') {
            const expired = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', operation.id).eq('status', 'payment_pending')
            if (expired.error) throw new Error('BILLING_DB_CHECKOUT_EXPIRY')
          }
        }
        if (sub && !sub.pending_update && operation.status === 'payment_pending' && operation.result?.pendingInvoiceId) {
          const invoice = invoices.find(row => row.id === operation.result?.pendingInvoiceId)
          if (invoice && ['void','uncollectible'].includes(invoice.status)) {
            const expired = await this.db.from('billing_operations').update({ status: 'expired', updated_at: new Date().toISOString() }).eq('id', operation.id).eq('status', 'payment_pending')
            if (expired.error) throw new Error('BILLING_DB_PENDING_EXPIRY')
          }
        }
      }
      const candidates = pending.data.flatMap(op => [{ operation: op, contract: op.contract, restored: false }, ...(op.restore_contract ? [{ operation: op, contract: op.restore_contract, restored: true }] : [])])
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
      const latest = sub?.latest_invoice && typeof sub.latest_invoice === 'object' ? sub.latest_invoice : null
      let contract: Contract | null = null
      let completedOperationId: string | null = null
      let discrepancy: string | null = null
      if (sub && mayProject(sub.status, Boolean(sub.pending_update), latest?.status === 'paid')) {
        if (match?.contract) {
          contract = match.contract
          // Keep temporary concessions pending until the standard phase has returned.
          if (!match.operation.restore_contract || match.restored) completedOperationId = match.operation.id
        } else if (account.contract && matches(account.contract)) {
          contract = account.contract
        } else discrepancy = 'UNRECOGNIZED_STRIPE_ITEMS'
      }
      await this.transition('sync_commit', { tenantId, token, customerId: account.stripe_customer_id, subscriptionId: sub?.id ?? null, status: sub?.status ?? account.status, contract, paymentStatus: latest?.status ?? null, periodEnd: iso(sub?.items.data[0]?.current_period_end), cancelAtPeriodEnd: sub?.cancel_at_period_end ?? false, completedOperationId, discrepancy })
      return { reconciled: true, discrepancy }
    } catch (error) {
      await this.transition('sync_fail', { tenantId, token })
      throw error
    }
  }
  async processEvent(event: { id: string; type: string; created: number; livemode: boolean; data: { object: { customer?: string } } }) {
    if (event.livemode !== false) throw new Error('BILLING_LIVE_MODE_FORBIDDEN')
    const supported = ['checkout.session.completed','checkout.session.expired','checkout.session.async_payment_succeeded','customer.subscription.created','customer.subscription.updated','customer.subscription.deleted','customer.subscription.pending_update_applied','customer.subscription.pending_update_expired','invoice.paid','invoice.payment_failed','invoice.payment_action_required','subscription_schedule.updated','subscription_schedule.completed','subscription_schedule.released','subscription_schedule.aborted']
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
