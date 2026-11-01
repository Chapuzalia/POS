import { expect, it, onTestFinished } from 'vitest'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { processingSepaAuthorization, subscriptionUsesSepa } from '../../supabase/functions/_shared/billing/sepa'
import { StripeGateway } from '../../supabase/functions/_shared/billing/stripe'
import type { StripeSubscription } from '../../supabase/functions/_shared/billing/stripe'

async function begin() {
  const fixture = await createBillingService({ after: onTestFinished }, 4900)
  await fixture.db.query("update tenants set billing_activation_required=true where id=$1", [ids.tenant])
  await fixture.db.query("update billing_accounts set source='stripe',status='pending_payment' where tenant_id=$1", [ids.tenant])
  await fixture.service.saveOnboarding(ids.tenant, fixture.selection)
  const quote = await fixture.service.quote(ids.tenant, ids.owner, fixture.selection, null, 'Alta SEPA')
  await fixture.service.confirm(ids.tenant, ids.owner, quote.id)
  const pending = async () => (await fixture.db.query('select billing_activation_required pending from tenants where id=$1', [ids.tenant])).rows[0].pending
  const operation = async () => (await fixture.db.query('select * from billing_operations where id=$1', [quote.id])).rows[0]
  return { ...fixture, quote, pending, operation }
}

it('requires fiscal details in new Checkouts and uses Dashboard payment methods without changing the fixed VAT', async () => {
  const { stripe } = await begin()
  const session = [...stripe.sessions.values()][0]
  expect(session.params).toMatchObject({
    mode: 'subscription',
    tax_id_collection: { enabled: true, required: 'if_supported' },
    billing_address_collection: 'required', customer_update: { address: 'auto', name: 'auto' },
    automatic_tax: { enabled: false },
  })
  expect(session.params.payment_method_types).toBeUndefined()
  expect(session.params.allowed_payment_method_types).toBeUndefined()
  expect(session.params.subscription_data.default_tax_rates).toHaveLength(1)
})

it('activates on an authoritative processing SEPA mandate without calling it paid, and settles the same operation later', async () => {
  const { service, stripe, quote, pending, operation } = await begin()
  expect(await pending()).toBe(true)
  stripe.authorizeSepaCheckout()
  await service.reconcile(ids.tenant)
  expect(await pending()).toBe(false)
  let account = await service.account(ids.tenant)
  expect(account.contract.recurringCents).toBe(4900)
  expect(account.last_payment_status).toBe('processing')
  expect(account.sepa_authorization).toMatchObject({ customerId: 'cus_test', subscriptionId: 'sub_test', invoiceId: 'in_1', operationId: quote.id, mandateId: 'mandate_test', paymentMethodId: 'pm_sepa_test' })
  expect(JSON.stringify(account.sepa_authorization)).not.toMatch(/iban|client_secret|ip_address|user_agent/)
  expect((await operation()).status).toBe('payment_pending')
  expect((await service.overview()).metrics.paidCents).toBe(0)
  await expect(service.quote(ids.tenant, ids.owner, (await operation()).contract.selection, null, 'Cambio solapado')).rejects.toThrow('BILLING_PENDING_CHANGE')
  await service.reconcile(ids.tenant)
  expect((await operation()).status).toBe('payment_pending')
  stripe.pay()
  await service.reconcile(ids.tenant)
  account = await service.account(ids.tenant)
  expect(account.last_payment_status).toBe('paid')
  expect((await operation()).status).toBe('completed')
  expect(stripe.invoices).toHaveLength(1)
  expect((await service.overview()).metrics.paidCents).toBe(stripe.invoices[0].amount_paid)
})

it('requires the correct customer, Checkout, invoice, processing payment and active recurring mandate', async () => {
  const { stripe, service, operation, pending } = await begin()
  stripe.authorizeSepaCheckout()
  const op = await operation()
  const original = structuredClone({ sessions: stripe.sessions, subscriptions: stripe.subscriptions, invoicePayments: stripe.invoicePayments, intents: stripe.intents, mandates: stripe.mandates })
  const mutations = [
    () => { [...stripe.sessions.values()][0].status = 'open' },
    () => { [...stripe.sessions.values()][0].params.customer = 'cus_foreign' },
    () => { [...stripe.sessions.values()][0].metadata.tickit_tenant_id = ids.other },
    () => { [...stripe.sessions.values()][0].subscription = 'sub_foreign' },
    () => { [...stripe.sessions.values()][0].invoice = 'in_foreign' },
    () => { [...stripe.sessions.values()][0].livemode = true },
    () => { stripe.invoicePayments[0].invoice = 'in_foreign' },
    () => { stripe.invoicePayments[0].amount_requested = 1 },
    () => { stripe.invoicePayments[0].livemode = true },
    () => { stripe.intents.get('pi_in_1').customer = 'cus_foreign' },
    () => { stripe.intents.get('pi_in_1').status = 'requires_payment_method' },
    () => { stripe.intents.get('pi_in_1').payment_method.type = 'card' },
    () => { stripe.intents.get('pi_in_1').payment_method.customer = 'cus_foreign' },
    () => { stripe.intents.get('pi_in_1').amount = 1 },
    () => { stripe.intents.get('pi_in_1').latest_charge.failure_code = 'insufficient_funds' },
    () => { stripe.intents.get('pi_in_1').latest_charge.payment_intent = 'pi_foreign' },
    () => { stripe.mandates.get('mandate_test').status = 'inactive' },
    () => { stripe.mandates.get('mandate_test').status = 'pending' },
    () => { stripe.mandates.get('mandate_test').type = 'single_use' },
    () => { stripe.mandates.get('mandate_test').payment_method = 'pm_foreign' },
    () => { stripe.mandates.get('mandate_test').livemode = true },
    () => { stripe.mandates.get('mandate_test').customer_acceptance.accepted_at = 0 },
  ]
  for (const mutate of mutations) {
    Object.assign(stripe, structuredClone(original))
    mutate()
    const sub = stripe.subscriptions[0]
    expect(await processingSepaAuthorization(stripe, ids.tenant, sub, sub.latest_invoice, op)).toBeNull()
    expect(await pending()).toBe(true)
  }
  Object.assign(stripe, structuredClone(original))
  await service.reconcile(ids.tenant)
  expect(await pending()).toBe(false)
})

it('does not activate a rejected debit before authorization and preserves existing access after a later rejection', async () => {
  const { service, stripe, pending } = await begin()
  stripe.authorizeSepaCheckout()
  stripe.failSepa()
  await service.reconcile(ids.tenant)
  expect(await pending()).toBe(true)
  expect((await service.account(ids.tenant)).contract).toBeNull()
  stripe.subscriptions[0].status = 'active'
  stripe.intents.get('pi_in_1').status = 'processing'
  stripe.intents.get('pi_in_1').last_payment_error = null
  stripe.intents.get('pi_in_1').latest_charge.failure_code = null
  stripe.intents.get('pi_in_1').latest_charge.status = 'pending'
  await service.reconcile(ids.tenant)
  expect(await pending()).toBe(false)
  stripe.failSepa()
  await service.reconcile(ids.tenant)
  const detail = await service.detail(ids.tenant, false)
  expect(detail.account.status).toBe('past_due')
  expect(detail.account.contract.recurringCents).toBe(4900)
  expect(detail.commercialState).toBe('grace')
  expect(await pending()).toBe(false)
  expect(detail.account.last_payment_status).toBe('open')
})

it('applies immediate SEPA upgrades while the bank processes the debit, retaining one unsettled economic operation', async () => {
  const { service, stripe, selection, production, db } = await begin()
  stripe.authorizeSepaCheckout(); await service.reconcile(ids.tenant)
  stripe.pay(); await service.reconcile(ids.tenant)
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación SEPA')
  expect(quote.timing).toBe('immediate')
  expect(quote.stripe_params.sepaDebit).toBe(true)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(stripe.calls.filter(call => call.params.payment_behavior).at(-1).params).toMatchObject({ payment_behavior: 'allow_incomplete', proration_behavior: 'always_invoice' })
  const account = await service.account(ids.tenant)
  expect(account.contract.recurringCents).toBe(5900)
  expect(account.contract.features).toContain('production')
  expect(account.last_payment_status).toBe('processing')
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('payment_pending')
  await expect(service.quote(ids.tenant, ids.owner, desired, null, 'Otra ampliación')).rejects.toThrow('BILLING_PENDING_CHANGE')
})

it('keeps the real financial contract but does not grant a rejected immediate SEPA upgrade', async () => {
  const { service, stripe, selection, production } = await begin()
  stripe.authorizeSepaCheckout(); await service.reconcile(ids.tenant)
  stripe.pay(); await service.reconcile(ids.tenant)
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación rechazada')
  stripe.failPayment = true
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const account = await service.account(ids.tenant)
  expect(account.contract.recurringCents).toBe(4900)
  expect(account.contract.features).not.toContain('production')
  expect(account.billed_contract.recurringCents).toBe(5900)
  expect(account.status).toBe('past_due')
})

it('recovers a lost SEPA upgrade response with the same invoice and idempotency key', async () => {
  const { service, stripe, selection, production } = await begin()
  stripe.authorizeSepaCheckout(); await service.reconcile(ids.tenant)
  stripe.pay(); await service.reconcile(ids.tenant)
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación con respuesta perdida')
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args)
    if (args[0]?.payment_behavior === 'allow_incomplete') throw new Error('lost response')
    return result
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('lost response')
  await service.reconcile(ids.tenant)
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
  stripe.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(5900)
  expect(stripe.invoices).toHaveLength(2)
  const updates = stripe.calls.filter(call => call.params.payment_behavior === 'allow_incomplete')
  expect(updates).toHaveLength(2)
  expect(updates[0]).toEqual(updates[1])
})

it('copies authoritative fiscal snapshots and ignores stale payment event bodies', async () => {
  const { service, stripe, pending } = await begin()
  await service.processEvent({ id: 'evt_processing_early', type: 'payment_intent.processing', created: 1, livemode: false, data: { object: { customer: 'cus_test' } } })
  expect(await pending()).toBe(true)
  stripe.authorizeSepaCheckout()
  Object.assign(stripe.subscriptions[0].latest_invoice, { customer_name: 'Empresa de prueba', customer_email: 'billing@example.test', customer_tax_ids: [{ type: 'eu_vat', value: 'ESA12345674' }, { type: 'es_cif', value: 'A12345674' }] })
  await service.processEvent({ id: 'evt_processing_confirmed', type: 'payment_intent.processing', created: 2, livemode: false, data: { object: { customer: 'cus_test' } } })
  expect(await pending()).toBe(false)
  expect(await service.account(ids.tenant)).toMatchObject({ legal_name: 'Empresa de prueba', tax_id: 'A12345674', email: 'billing@example.test' })
  stripe.pay()
  await service.processEvent({ id: 'evt_old_failure', type: 'payment_intent.payment_failed', created: 1, livemode: false, data: { object: { customer: 'cus_test' } } })
  expect((await service.account(ids.tenant)).last_payment_status).toBe('paid')
})

it('rejects forged or stale authorization snapshots in PostgreSQL and denies browser writes', async () => {
  const { service, stripe, transition, db, pending, operation } = await begin()
  stripe.authorizeSepaCheckout()
  const sub = stripe.subscriptions[0], op = await operation()
  const proof = await processingSepaAuthorization(stripe, ids.tenant, sub, sub.latest_invoice, op)
  const { token } = await transition('sync_claim', { tenantId: ids.tenant })
  const snapshot = { tenantId: ids.tenant, token, customerId: 'cus_test', subscriptionId: 'sub_test', status: 'active', contract: op.contract, paymentStatus: 'processing', sepaAuthorization: proof }
  for (const patch of [{ customerId: 'cus_other' }, { operationId: ids.other }, { mandateId: null }, { acceptedAt: 0 }, { subscriptionId: 'sub_other' }]) {
    await expect(transition('sync_commit', { ...snapshot, sepaAuthorization: { ...proof, ...patch } })).rejects.toThrow('BILLING_INVALID_SEPA_AUTHORIZATION')
    expect(await pending()).toBe(true)
  }
  await expect(transition('sync_commit', { ...snapshot, token: ids.other })).rejects.toThrow('BILLING_STALE_SYNC')
  await expect(transition('sync_commit', { ...snapshot, sepaAuthorization: null })).rejects.toThrow('BILLING_INVALID_SEPA_AUTHORIZATION')
  await db.exec(`set role authenticated; set "test.uid"='${ids.owner}';`)
  await expect(db.query('update billing_accounts set sepa_authorization=$1 where tenant_id=$2', [JSON.stringify(proof), ids.tenant])).rejects.toThrow('permission denied')
  await db.exec('reset role')
  await transition('sync_fail', { tenantId: ids.tenant, token })
  await service.reconcile(ids.tenant)
  expect(await pending()).toBe(false)
})

it('rejects a changed collection method before applying a quote', async () => {
  const { service, stripe, selection, production, activate } = await createBillingService({ after: onTestFinished }, 4900)
  await activate()
  const quote = await service.quote(ids.tenant, ids.owner, { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }, null, 'Oferta con tarjeta')
  stripe.subscriptions[0].default_payment_method = { id: 'pm_sepa_test', type: 'sepa_debit', customer: 'cus_test', livemode: false }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE_STRIPE_QUOTE')
  expect(stripe.calls.filter(call => call.params.payment_behavior)).toHaveLength(0)
})

it('resolves an inherited or unexpanded default method and rejects a method from another customer', async () => {
  const sub: StripeSubscription = { id: 'sub_test', customer: 'cus_test', status: 'active', livemode: false, items: { data: [], has_more: false }, pending_update: null, cancel_at_period_end: false, latest_invoice: null, schedule: null, discounts: [], metadata: {} }
  let customer = 'cus_test'
  const stripe = new StripeGateway('sk_test_fixture', async url => Response.json(new URL(String(url)).pathname.startsWith('/v1/customers/')
    ? { id: 'cus_test', livemode: false, invoice_settings: { default_payment_method: 'pm_sepa_test' } }
    : { id: 'pm_sepa_test', livemode: false, customer, type: 'sepa_debit' }))
  expect(await subscriptionUsesSepa(stripe, sub)).toBe(true)
  expect(await subscriptionUsesSepa(stripe, { ...sub, default_payment_method: 'pm_sepa_test' })).toBe(true)
  customer = 'cus_foreign'
  await expect(subscriptionUsesSepa(stripe, sub)).rejects.toThrow('BILLING_SUBSCRIPTION_MISMATCH')
})

it('preserves old in-flight Checkout parameters while requiring a fresh quote for unconfirmed legacy offers', async () => {
  const { service, stripe, selection, transition } = await createBillingService({ after: onTestFinished }, 4900)
  const current = await service.quote(ids.tenant, ids.owner, selection, null, 'Nueva oferta')
  const { checkoutPolicy: _checkoutPolicy, ...legacyParams } = current.stripe_params
  const legacy = await transition('quote', { tenantId: ids.tenant, actorId: ids.owner, revision: (await service.account(ids.tenant)).revision, kind: 'change', contract: current.contract, restoreContract: null, timing: 'immediate', stripeParams: legacyParams, preview: current.preview, reason: 'Oferta anterior', prorationDate: current.proration_date })
  await expect(service.confirm(ids.tenant, ids.owner, legacy.id)).rejects.toThrow('BILLING_STALE_STRIPE_QUOTE')
  await transition('apply_claim', { tenantId: ids.tenant, actorId: ids.owner, operationId: legacy.id })
  await service.confirm(ids.tenant, ids.owner, legacy.id, true)
  const params = [...stripe.sessions.values()][0].params
  expect(params.payment_method_types).toBeUndefined()
  expect(params.tax_id_collection).toEqual({ enabled: true })
})

it('allows only the required Stripe resource paths and keeps the pinned API version', async () => {
  const paths: string[] = []
  const stripe = new StripeGateway('sk_test_fixture', async (url, init) => {
    paths.push(new URL(String(url)).pathname)
    expect(new Headers(init?.headers).get('Stripe-Version')).toBe('2026-09-30.endive')
    return Response.json({ id: 'fixture', livemode: false })
  })
  for (const path of ['/invoice_payments', '/payment_intents/pi_fixture', '/mandates/mandate_fixture', '/payment_methods/pm_fixture']) await stripe.request('GET', path)
  expect(paths).toHaveLength(4)
  await expect(stripe.request('GET', '/balance')).rejects.toThrow('BILLING_INVALID_STRIPE_PATH')
})
