import { expect, it, onTestFinished } from 'vitest'
import { StripeGateway } from '../../supabase/functions/_shared/billing/stripe.ts'
import { spanishVatRate } from '../../supabase/functions/_shared/billing/taxes.ts'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'

const rate = { id: 'txr_es_vat', active: true, percentage: 21, inclusive: false, country: 'ES', tax_type: 'vat', metadata: { tickit_tax_policy: 'es_vat_21_exclusive_v1' } }
const concession = { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason: 'Condición de prueba' }
const setup = () => createBillingService({ after: onTestFinished }, 4900)

it('creates a named, exclusive Spanish VAT rate through the Stripe gateway with an idempotency key', async () => {
  const requests: Array<{ url: string; init: RequestInit }> = []
  const stripe = new StripeGateway('sk_test_fixture', async (input, init = {}) => {
    requests.push({ url: String(input), init })
    return Response.json(init.method === 'GET' ? { data: [], has_more: false } : rate)
  })
  expect(await spanishVatRate(stripe)).toBe(rate.id)
  const create = requests[1]
  expect(create.url).toBe('https://api.stripe.com/v1/tax_rates')
  const form = new URLSearchParams(String(create.init.body))
  expect(Object.fromEntries(form)).toMatchObject({ display_name: 'IVA', percentage: '21', inclusive: 'false', country: 'ES', tax_type: 'vat' })
  expect(new Headers(create.init.headers).get('Idempotency-Key')).toBe('tickit:tax:es_vat_21_exclusive_v1')
})

it('paginates rates, rejects unsuitable matches and reuses the existing rate without creating another', async () => {
  const requests: string[] = []
  const stripe = new StripeGateway('sk_test_fixture', async (input, init = {}) => {
    expect(init.method).toBe('GET')
    requests.push(String(input))
    return Response.json(requests.length === 1
      ? { data: [{ ...rate, id: 'txr_inclusive', inclusive: true }, { ...rate, id: 'txr_other', percentage: 10 }], has_more: true }
      : { data: [rate], has_more: false })
  })
  expect(await spanishVatRate(stripe)).toBe(rate.id)
  expect(new URL(requests[1]).searchParams.get('starting_after')).toBe('txr_other')
})

it('stops if Stripe returns an invalid tax rate', async () => {
  const stripe = new StripeGateway('sk_test_fixture', async (_input, init = {}) => Response.json(
    init.method === 'GET' ? { data: [], has_more: false } : { ...rate, active: false },
  ))
  await expect(spanishVatRate(stripe)).rejects.toThrow('BILLING_STRIPE_TAX_MISMATCH')
})

it('quotes 49 euros plus 21 percent, carries VAT through Checkout and renewals, and keeps net recurring metrics', async () => {
  const { service, stripe, selection } = await setup()
  stripe.previewRecurring = true
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta con IVA')
  expect(quote.preview.amountDueCents).toBe(5929)
  expect(quote.preview.recurringCents).toBe(4900)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const session = [...stripe.sessions.values()][0]
  expect(session.params.subscription_data.default_tax_rates).toEqual([quote.stripe_params.taxRateId])
  expect(session.params.automatic_tax).toEqual({ enabled: false })
  stripe.completeCheckout()
  await service.reconcile(ids.tenant)
  expect((await service.account(ids.tenant)).billed_contract.recurringCents).toBe(4900)
  expect(stripe.invoices[0]).toMatchObject({ amount_paid: 5929, total_excluding_tax: 4900 })
  stripe.advanceTo(stripe.subscriptions[0].items.data[0].current_period_end)
  expect(stripe.invoices.at(-1)).toMatchObject({ amount_paid: 5929, total_excluding_tax: 4900 })
  expect(stripe.taxRates).toHaveLength(1)
})

it('applies VAT after discounts to the base and addons, without adding tax to the stored contract', async () => {
  const { service, stripe, selection, production } = await setup()
  stripe.previewRecurring = true
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 2, venueIds: [ids.venue, ids.venueB], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, { ...concession, discountBasisPoints: 1000 }, 'Descuento', true)
  expect(quote.preview.recurringCents).toBe(6210)
  expect(quote.preview.amountDueCents).toBe(7514)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout()
  expect(stripe.invoices[0]).toMatchObject({ amount_paid: 7514, total_excluding_tax: 6210 })
})

it('configures legacy tax settings without invoicing, preserves payment-gated upgrades and retries the same charge', async () => {
  const { service, stripe, selection, production, activate } = await setup()
  await activate()
  const sub = stripe.subscriptions[0]
  sub.default_tax_rates = []
  sub.automatic_tax = { enabled: true }
  sub.items.data[0].tax_rates = [{ id: 'txr_legacy' }]
  stripe.customerTaxExempt = 'reverse'
  stripe.previewRecurring = true
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación con IVA')
  expect(quote.preview.amountDueCents).toBe(7139)
  const original = stripe.request.bind(stripe)
  stripe.failPayment = true
  stripe.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args)
    if (method === 'POST' && path === '/subscriptions/sub_test' && args[0].payment_behavior) throw new Error('lost charge response')
    return result
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('lost charge response')
  expect(stripe.customerTaxExempt).toBe('none')
  expect(sub.default_tax_rates).toEqual([{ id: quote.stripe_params.taxRateId }])
  expect(sub.items.data[0].tax_rates).toEqual([])
  expect((await service.account(ids.tenant)).contract.addons).toHaveLength(0)
  const config = stripe.calls.find(call => call.idempotencyKey?.endsWith(':vat-subscription'))
  expect(config.params).toMatchObject({ proration_behavior: 'none', automatic_tax: { enabled: false } })
  expect(config.params.payment_behavior).toBeUndefined()
  stripe.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  const charges = stripe.calls.filter(call => call.params.payment_behavior === 'pending_if_incomplete')
  expect(charges).toHaveLength(2)
  expect(charges[0]).toEqual(charges[1])
  expect(charges[0].params.default_tax_rates).toBeUndefined()
  stripe.pay()
  await service.reconcile(ids.tenant)
  expect((await service.account(ids.tenant)).contract.addons).toHaveLength(1)
  expect(stripe.invoices.at(-1)).toMatchObject({ amount_paid: 7139, total_excluding_tax: 5900 })
})

it('retains VAT in temporary discounts and the full-price restoration phase', async () => {
  const { service, stripe, selection, activate } = await setup()
  await activate()
  stripe.previewRecurring = true
  const quote = await service.quote(ids.tenant, ids.owner, selection, { ...concession, discountBasisPoints: 1000, cycles: 2 }, 'Descuento temporal', true)
  expect(quote.preview.renewalCents).toBe(5336)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const update = stripe.calls.find(call => call.path.startsWith('/subscription_schedules/') && call.method === 'POST')
  expect(update.params.phases).toHaveLength(3)
  for (const phase of update.params.phases) {
    expect(phase.default_tax_rates).toEqual([quote.stripe_params.taxRateId])
    expect(phase.automatic_tax).toEqual({ enabled: false })
    expect(phase.items.every(item => item.tax_rates === '')).toBe(true)
  }
  stripe.advancePhase(2)
  expect(stripe.invoices.at(-1)).toMatchObject({ amount_paid: 5929, total_excluding_tax: 4900 })
})

it('retains VAT during addon promotions and their first paid renewal', async () => {
  const { service, stripe, selection, production, activate } = await setup()
  await activate()
  stripe.previewRecurring = true
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const promotion = { id: '40000000-0000-4000-8000-000000000001', key: 'production', freeUnits: 1, start: 'renewal', durationUnit: 'cycles', duration: 1, consent: 'Un ciclo gratuito y después tarifa habitual' }
  const quote = await service.quote(ids.tenant, ids.owner, desired, { ...concession, promotions: [promotion] }, 'Promoción', true)
  expect(quote.preview.renewalCents).toBe(5929)
  expect(quote.preview.promotions[0].firstInvoiceCents).toBe(7139)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const schedule = stripe.schedules.get(stripe.subscriptions[0].schedule)
  expect(schedule.phases.every(phase => phase.default_tax_rates[0] === quote.stripe_params.taxRateId)).toBe(true)
  expect(stripe.taxRates).toHaveLength(1)
})

it('requires a new quote for untaxed offers and preserves an in-flight legacy Checkout on retry', async () => {
  const { service, stripe, selection, transition } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Oferta antigua')
  const { taxRateId: _taxRateId, ...legacyParams } = quote.stripe_params
  const legacy = await transition('quote', { tenantId: ids.tenant, actorId: ids.owner, revision: (await service.account(ids.tenant)).revision, kind: 'change', contract: quote.contract, restoreContract: null, timing: 'immediate', stripeParams: legacyParams, preview: { ...quote.preview, amountDueCents: 500 }, reason: 'Oferta anterior al IVA', prorationDate: quote.proration_date })
  await expect(service.confirm(ids.tenant, ids.owner, legacy.id)).rejects.toThrow('BILLING_STALE_STRIPE_QUOTE')
  expect(stripe.sessions.size).toBe(0)
  await transition('apply_claim', { tenantId: ids.tenant, actorId: ids.owner, operationId: legacy.id })
  await service.confirm(ids.tenant, ids.owner, legacy.id, true)
  expect([...stripe.sessions.values()][0].params.subscription_data.default_tax_rates).toBeUndefined()
})
