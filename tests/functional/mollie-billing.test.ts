import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createBillingService, payer, sepa } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { MollieGateway, cents, grossCents, money, normalizeIban } from '../../supabase/functions/_shared/billing/mollie'
import { prorationNet } from '../../supabase/functions/_shared/billing/service'
import { buildContract } from '../../supabase/functions/_shared/billing/domain'

afterEach(() => { vi.useRealTimers() })
const at = (date: string) => vi.setSystemTime(new Date(date))

async function setup(amount = 4900) {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-11-10T10:00:00Z')
  const fixture = await createBillingService({ after: onTestFinished }, amount)
  await fixture.db.query('update tenants set billing_activation_required=true where id=$1', [ids.tenant])
  const operation = async (id: string) => (await fixture.db.query('select * from billing_operations where id=$1', [id])).rows[0]
  const tenant = async () => (await fixture.db.query('select billing_activation_required from tenants where id=$1', [ids.tenant])).rows[0]
  const withProduction = { ...fixture.selection, addons: [{ key: 'production', versionId: fixture.production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  return { ...fixture, operation, tenant, withProduction }
}

it('formats integer cents, adds 21 % VAT and validates IBAN checksums', () => {
  expect(money(5929)).toEqual({ currency: 'EUR', value: '59.29' })
  expect(cents({ currency: 'EUR', value: '59.29' })).toBe(5929)
  expect(() => cents({ currency: 'USD', value: '1.00' })).toThrow('BILLING_CURRENCY_MISMATCH')
  expect(grossCents(4900)).toBe(5929)
  expect(normalizeIban('es91 2100 0418 4502 0005 1332')).toBe('ES9121000418450200051332')
  expect(() => normalizeIban('ES91 2100 0418 4502 0005 1333')).toThrow('BILLING_INVALID_IBAN')
  expect(() => new MollieGateway('access_abcdefghijklmnopqrstuvwxyz')).toThrow('BILLING_INVALID_API_KEY')
  expect(new MollieGateway('live_abcdefghijklmnopqrstuvwxyz').mode).toBe('live')
  expect(new MollieGateway('test_abcdefghijklmnopqrstuvwxyz').mode).toBe('test')
})

it('creates the SEPA mandate, charges the first period by card and renews by SEPA one month later', async () => {
  const { service, mollie, selection, operation, tenant } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta')
  expect(quote.preview.amountDueCents).toBe(5929)
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_SEPA_REQUIRED')
  const first = await service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer })
  expect(first.url).toMatch(/^https:\/\/www\.mollie\.com\/checkout\//)
  const payment = mollie.payment('first')
  expect(payment).toMatchObject({ sequenceType: 'first', method: 'creditcard', amount: { value: '59.29' }, metadata: { tickit_tenant_id: ids.tenant, tickit_operation_id: quote.id } })
  expect(mollie.mandates).toHaveLength(1)
  expect(mollie.mandates[0]).toMatchObject({ method: 'directdebit', details: { consumerAccount: 'ES9121000418450200051332' } })
  // Nothing is unlocked before Mollie confirms the card payment.
  await service.reconcile(ids.tenant)
  expect(await service.account(ids.tenant)).toMatchObject({ contract: null, legal_name: payer.legalName, tax_id: payer.taxId })
  expect((await tenant()).billing_activation_required).toBe(true)

  mollie.payFirst()
  await service.handleWebhook(payment.id)
  const [sub] = mollie.subscriptions
  expect(sub).toMatchObject({ startDate: '2026-12-10', interval: '1 month', amount: { value: '59.29' }, mandateId: mollie.mandates[0].id, metadata: { tickit_operation_id: quote.id } })
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', last_payment_status: 'paid', stripe_subscription_id: sub.id, period_end: new Date('2026-12-10T00:00:00.000Z') })
  expect((await service.account(ids.tenant)).contract.planName).toBe('Synthetic base')
  expect((await operation(quote.id)).status).toBe('completed')
  expect((await tenant()).billing_activation_required).toBe(false)
  // Duplicated webhooks never open a second subscription.
  await service.handleWebhook(payment.id); await service.reconcile(ids.tenant)
  expect(mollie.subscriptions).toHaveLength(1)
  expect((await service.detail(ids.tenant, false)).invoices[0]).toMatchObject({ stripe_invoice_id: payment.id, status: 'paid', amount_paid_cents: 5929, paid_excluding_tax_cents: 4900, fiscal_export_status: 'pending_review' })
})

it('keeps the plan while an accepted SEPA renewal is in transit and blocks new changes until it settles', async () => {
  const { service, mollie, activate, withProduction } = await setup()
  await activate()
  at('2026-12-10T06:00:00Z')
  const renewal = mollie.renew('pending')
  await service.handleWebhook(renewal.id)
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', last_payment_status: 'pending', delinquent_since: null })
  expect((await service.account(ids.tenant)).contract).not.toBeNull()
  expect((await service.detail(ids.tenant, false)).commercialState).toBe('current')
  await expect(service.quote(ids.tenant, ids.owner, withProduction, null, 'Ampliar')).rejects.toThrow('BILLING_PENDING_CHANGE')
  at('2026-12-14T06:00:00Z')
  mollie.settle(renewal)
  await service.handleWebhook(renewal.id)
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', last_payment_status: 'paid', period_end: new Date('2027-01-10T00:00:00.000Z') })
  await expect(service.quote(ids.tenant, ids.owner, withProduction, null, 'Ampliar')).resolves.toBeTruthy()
})

it('marks a returned SEPA renewal past due and resolves it with a card payment for that charge', async () => {
  const { service, mollie, activate } = await setup()
  await activate()
  at('2026-12-10T06:00:00Z')
  const renewal = mollie.renew('pending')
  await service.reconcile(ids.tenant)
  mollie.settle(renewal, 'failed')
  await service.handleWebhook(renewal.id)
  const account = await service.account(ids.tenant)
  expect(account).toMatchObject({ status: 'past_due', last_payment_status: 'failed' })
  expect(account.delinquent_since).not.toBeNull()
  const { url } = await service.portal(ids.tenant)
  expect(url).toMatch(/^https:\/\/www\.mollie\.com\//)
  expect((await service.portal(ids.tenant)).url).toBe(url)
  const arrears = mollie.payment('arrears')
  expect(arrears).toMatchObject({ amount: renewal.amount, metadata: { tickit_covers: renewal.id } })
  mollie.settle(arrears)
  await service.handleWebhook(arrears.id)
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', delinquent_since: null })
  await expect(service.portal(ids.tenant)).rejects.toThrow('BILLING_NOTHING_DUE')
})

it('treats a charge-back of a settled renewal as debt', async () => {
  const { service, mollie, activate } = await setup()
  await activate()
  at('2026-12-10T06:00:00Z')
  const renewal = mollie.renew('paid')
  await service.reconcile(ids.tenant)
  mollie.chargeBack(renewal)
  await service.handleWebhook(renewal.id)
  expect((await service.account(ids.tenant)).status).toBe('past_due')
  expect((await service.detail(ids.tenant, false)).invoices.find(row => row.stripe_invoice_id === renewal.id)).toMatchObject({ status: 'uncollectible', amount_paid_cents: 0, paid_excluding_tax_cents: 0 })
})

it('charges the prorated increase of an immediate upgrade by SEPA and grants access while it is in transit', async () => {
  const { service, mollie, activate, withProduction, operation } = await setup()
  await activate()
  at('2026-11-25T00:00:00Z')
  const quote = await service.quote(ids.tenant, ids.owner, withProduction, null, 'Añadir producción')
  expect(quote.timing).toBe('immediate')
  // 10 € net more for 15 of 30 days -> 5 € + 21 % VAT.
  expect(quote.preview.amountDueCents).toBe(605)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const charge = mollie.payment('proration')
  expect(charge).toMatchObject({ sequenceType: 'recurring', mandateId: mollie.mandates[0].id, amount: { value: '6.05' }, status: 'pending' })
  expect(mollie.subscriptions[0].amount).toEqual({ currency: 'EUR', value: '71.39' })
  const pending = await service.account(ids.tenant)
  expect(pending.contract.features).toContain('production')
  expect(pending.billed_contract.recurringCents).toBe(4900)
  expect(pending.last_payment_status).toBe('pending')
  expect((await operation(quote.id)).status).toBe('payment_pending')
  mollie.settle(charge)
  await service.handleWebhook(charge.id)
  expect((await service.account(ids.tenant)).billed_contract.recurringCents).toBe(5900)
  expect((await operation(quote.id)).status).toBe('completed')
})

it('withdraws an upgrade whose SEPA charge fails and restores the previous amount', async () => {
  const { service, mollie, activate, withProduction, operation } = await setup()
  await activate()
  at('2026-11-25T10:00:00Z')
  const quote = await service.quote(ids.tenant, ids.owner, withProduction, null, 'Añadir producción')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const charge = mollie.settle(mollie.payment('proration'), 'failed')
  await service.handleWebhook(charge.id)
  const account = await service.account(ids.tenant)
  expect(account.contract.features).not.toContain('production')
  expect(account).toMatchObject({ status: 'active', delinquent_since: null })
  expect((await operation(quote.id)).status).toBe('expired')
  expect(mollie.subscriptions[0].amount.value).toBe('59.29')
})

it('schedules a downgrade at renewal: Mollie charges the new amount, access changes only on that date', async () => {
  const { service, mollie, db, base, withProduction, operation } = await setup()
  const quote0 = await service.quote(ids.tenant, ids.owner, withProduction, null, 'Alta')
  await service.confirm(ids.tenant, ids.owner, quote0.id, false, { sepa, payer }); mollie.payFirst(); await service.reconcile(ids.tenant)
  at('2026-11-20T10:00:00Z')
  const quote = await service.quote(ids.tenant, ids.owner, { planVersionId: base.id, addons: [] }, null, 'Quitar producción')
  expect(quote).toMatchObject({ timing: 'period_end', preview: { amountDueCents: 0, renewalCents: 5929, effectiveAt: '2026-12-10T00:00:00.000Z' } })
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(mollie.subscriptions[0].amount.value).toBe('59.29')
  expect((await operation(quote.id)).status).toBe('scheduled')
  expect((await service.account(ids.tenant)).contract.features).toContain('production')
  await expect(service.quote(ids.tenant, ids.owner, withProduction, null, 'Otro')).rejects.toThrow('BILLING_PENDING_CHANGE')
  at('2026-12-10T06:00:00Z')
  const renewal = mollie.renew('pending')
  await service.handleWebhook(renewal.id)
  expect((await service.account(ids.tenant)).contract.features).not.toContain('production')
  expect((await operation(quote.id)).status).toBe('completed')
  expect((await db.query("select 1 from tenant_feature_assignments where tenant_id=$1 and feature_key='production'", [ids.tenant])).rows).toHaveLength(0)
})

it('cancels at period end: no more charges, access until the paid period ends, then cancelled', async () => {
  const { service, mollie, activate, operation } = await setup()
  await activate()
  at('2026-11-20T10:00:00Z')
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')
  expect(quote.preview.effectiveAt).toBe('2026-12-10T00:00:00.000Z')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(mollie.subscriptions[0].status).toBe('canceled')
  expect((await operation(quote.id)).status).toBe('completed')
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'active', cancel_at_period_end: true, period_end: new Date('2026-12-10T00:00:00.000Z') })
  // A new signup inside the paid period would charge it twice.
  await expect(service.quote(ids.tenant, ids.owner, (await service.account(ids.tenant)).contract.selection, null, 'Volver')).rejects.toThrow('BILLING_PENDING_CHANGE')
  at('2026-12-10T01:00:00Z')
  await service.reconcile(ids.tenant)
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'canceled', cancel_at_period_end: false })
})

it('keeps a pending SEPA renewal collectable after an immediate cancellation and supersedes a scheduled change', async () => {
  const { service, mollie, base, withProduction, operation } = await setup()
  const quote0 = await service.quote(ids.tenant, ids.owner, withProduction, null, 'Alta')
  await service.confirm(ids.tenant, ids.owner, quote0.id, false, { sepa, payer }); mollie.payFirst(); await service.reconcile(ids.tenant)
  const downgrade = await service.quote(ids.tenant, ids.owner, { planVersionId: base.id, addons: [] }, null, 'Bajar')
  await service.confirm(ids.tenant, ids.owner, downgrade.id)
  const cancel = await service.quoteCancel(ids.tenant, ids.owner, true, 'Baja inmediata')
  await service.confirm(ids.tenant, ids.owner, cancel.id)
  expect((await operation(downgrade.id)).status).toBe('expired')
  expect((await service.account(ids.tenant)).status).toBe('canceled')
  expect(mollie.calls.some(call => call.method === 'DELETE' && call.path.startsWith('/payments/'))).toBe(false)
})

it('moves a monthly plan to yearly by starting a new subscription exactly at renewal on the same SEPA mandate', async () => {
  const { service, mollie, activate, transition, operation } = await setup()
  await activate()
  const yearly = await transition('catalog_save', { actorId: ids.owner, product: { key: 'base', kind: 'plan', name: 'Synthetic base', description: '', scope: 'tenant', featureKey: null, resource: null, active: true, sortOrder: 0 }, version: { interval: 'year', amountCents: 49000, features: ['restaurant'], limits: { venues: 3, devices: 5 }, included: {}, maximum: null, requires: [] }, reason: 'Anual' })
  await service.publish(yearly.id)
  const quote = await service.quote(ids.tenant, ids.owner, { planVersionId: yearly.id, addons: [] }, null, 'Anual')
  expect(quote.timing).toBe('period_end')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const [old, next] = mollie.subscriptions
  expect(old.status).toBe('canceled')
  expect(next).toMatchObject({ status: 'active', interval: '12 months', startDate: '2026-12-10', mandateId: old.mandateId, amount: { value: '592.90' } })
  expect((await service.account(ids.tenant)).stripe_subscription_id).toBe(next.id)
  at('2026-12-10T06:00:00Z')
  await service.handleWebhook(mollie.renew('pending').id)
  expect((await service.account(ids.tenant)).contract.interval).toBe('year')
  expect((await operation(quote.id)).status).toBe('completed')
})

it('applies a temporary discount for the agreed cycles and restores the standard amount afterwards', async () => {
  const { service, mollie, activate, selection, operation } = await setup()
  await activate()
  const exception = { freeUnits: {}, limits: {}, discountBasisPoints: 5000, customAmounts: {}, cycles: 2, reason: 'Lanzamiento' }
  const quote = await service.quote(ids.tenant, ids.owner, selection, exception, 'Descuento', true)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(mollie.subscriptions[0].amount.value).toBe('29.65')
  at('2026-12-10T06:00:00Z'); await service.handleWebhook(mollie.renew('paid').id)
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(2450)
  at('2027-01-10T06:00:00Z'); await service.handleWebhook(mollie.renew('paid').id)
  // The renewal after the second discounted cycle is charged at the standard amount.
  expect(mollie.subscriptions[0].amount.value).toBe('59.29')
  at('2027-02-10T06:00:00Z'); await service.handleWebhook(mollie.renew('paid').id)
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
  expect((await operation(quote.id)).status).toBe('completed')
})

it('grants free addon units now and charges them from the renewal after the promotion ends', async () => {
  const { service, mollie, activate, withProduction, operation } = await setup()
  await activate()
  const promotion = { id: '40000000-0000-4000-8000-000000000001', key: 'production', freeUnits: 1, start: 'immediate' as const, durationUnit: 'cycles' as const, duration: 1, consent: 'Aceptado por email' }
  const exception = { freeUnits: {}, limits: {}, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason: 'Promo', promotions: [promotion] }
  const quote = await service.quote(ids.tenant, ids.owner, withProduction, exception, 'Promo', true)
  expect(quote.preview.amountDueCents).toBe(0)
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect((await service.account(ids.tenant)).contract.features).toContain('production')
  expect(mollie.payments.filter(row => row.metadata?.tickit_kind === 'proration')).toHaveLength(0)
  expect(mollie.subscriptions[0].amount.value).toBe('59.29')
  expect((await operation(quote.id)).status).toBe('completed')
  at('2026-12-10T06:00:00Z'); await service.handleWebhook(mollie.renew('paid').id)
  expect(mollie.subscriptions[0].amount.value).toBe('71.39')
})

it('only abandons a signup checkout once Mollie confirms it can no longer be paid', async () => {
  const { service, mollie, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta')
  await service.confirm(ids.tenant, ids.owner, quote.id, false, { sepa, payer })
  await expect(service.restartCheckout(ids.tenant)).rejects.toThrow('BILLING_PENDING_CHANGE')
  mollie.payFirst('expired')
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('expired')
  await expect(service.restartCheckout(ids.tenant)).resolves.toEqual({ editable: true })
  const retry = await service.quote(ids.tenant, ids.owner, selection, null, 'Nuevo intento')
  await service.confirm(ids.tenant, ids.owner, retry.id, false, { sepa, payer })
  expect(mollie.payments.filter(row => row.metadata?.tickit_kind === 'first')).toHaveLength(2)
})

it('recovers an uncertain Mollie failure on retry without a second charge', async () => {
  const { service, mollie, activate, withProduction, operation } = await setup()
  await activate()
  const quote = await service.quote(ids.tenant, ids.owner, withProduction, null, 'Ampliar')
  const original = mollie.request.bind(mollie)
  mollie.request = async (method: string, path: string, ...args: unknown[]) => {
    if (method === 'PATCH') throw new Error('network offline')
    return original(method, path, ...args)
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('offline')
  expect((await operation(quote.id)).status).toBe('applying')
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_ACTION_REQUIRED')
  mollie.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  expect(mollie.payments.filter(row => row.metadata?.tickit_kind === 'proration')).toHaveLength(1)
})

it('rejects Mollie resources that belong to another tenant and ignores unknown webhooks', async () => {
  const { service, mollie, activate } = await setup()
  await activate()
  mollie.subscriptions[0].metadata = { ...mollie.subscriptions[0].metadata, tickit_tenant_id: ids.other }
  await expect(service.reconcile(ids.tenant)).rejects.toThrow('BILLING_SUBSCRIPTION_MISMATCH')
  await expect(service.handleWebhook('tr_unknown')).resolves.toBeUndefined()
})

it('prorates only increases, over the remaining share of the period', () => {
  const product = { key: 'base', kind: 'plan' as const, name: 'B', description: '', scope: 'tenant' as const, featureKey: null, resource: null, active: true, sortOrder: 0 }
  const version = (id: string, amountCents: number) => ({ id, productKey: 'base', interval: 'month' as const, amountCents, stripePriceId: null, features: [], limits: { venues: 1, devices: 1 }, included: {}, maximum: null, requires: [], published: true })
  const low = buildContract([product], [version('a', 1000)], { planVersionId: 'a', addons: [] })
  const high = buildContract([product], [version('b', 4000)], { planVersionId: 'b', addons: [] })
  const end = Date.UTC(2026, 11, 10) / 1000
  expect(prorationNet(low, high, end, Date.UTC(2026, 10, 25) / 1000)).toBe(1500)
  expect(prorationNet(high, low, end, Date.UTC(2026, 10, 25) / 1000)).toBe(0)
  expect(prorationNet(low, high, end, end + 10)).toBe(0)
})

it('rejects Mollie resources whose mode does not match the API key', async () => {
  const reply = (mode: string) => async () => Response.json({ id: 'tr_1', mode })
  await expect(new MollieGateway('live_abcdefghijklmnopqrstuvwxyz', reply('test')).request('GET', '/payments/tr_1')).rejects.toThrow('BILLING_MODE_MISMATCH')
  await expect(new MollieGateway('live_abcdefghijklmnopqrstuvwxyz', reply('live')).request('GET', '/payments/tr_1')).resolves.toMatchObject({ id: 'tr_1' })
  await expect(new MollieGateway('test_abcdefghijklmnopqrstuvwxyz', reply('live')).request('GET', '/payments/tr_1')).rejects.toThrow('BILLING_MODE_MISMATCH')
})
