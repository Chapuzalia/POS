import { expect, it, onTestFinished } from 'vitest'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'

async function setup() {
  const fixture = await createBillingService({ after: onTestFinished }, 4900)
  const operation = async (id: string) => (await fixture.db.query('select * from billing_operations where id=$1', [id])).rows[0]
  return { ...fixture, operation }
}

it('keeps an incomplete first payment pending without granting the new contract', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta incompleta')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout(false)
  await service.reconcile(ids.tenant)
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'incomplete', contract: null, last_payment_status: 'open' })
  expect((await operation(quote.id)).status).toBe('payment_pending')
  expect((await service.overview()).metrics.paidCents).toBe(0)
})

it('releases an expired incomplete signup even when its Checkout was completed, and allows a new attempt', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta caducada')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout(false)
  stripe.subscriptions[0].status = 'incomplete_expired'
  stripe.subscriptions[0].latest_invoice.status = 'void'
  await service.reconcile(ids.tenant)
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('expired')
  expect((await service.account(ids.tenant)).contract).toBeNull()
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE')
  const replacement = await service.quote(ids.tenant, ids.owner, selection, null, 'Nuevo intento')
  await service.confirm(ids.tenant, ids.owner, replacement.id)
  expect(stripe.sessions.size).toBe(2)
})

it('does not call an expired or definitively failed operation successful or return its obsolete Checkout URL', async () => {
  const { service, stripe, selection, db } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Checkout caducado')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const session = [...stripe.sessions.values()][0]
  session.status = 'expired'
  await service.reconcile(ids.tenant)
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE')
  await db.query("update billing_operations set status='failed' where id=$1", [quote.id])
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE')
})

it('does not reopen a completed Checkout when the same confirmation is repeated', async () => {
  const { service, stripe, selection } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta pagada')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout()
  await service.reconcile(ids.tenant)
  const repeat = await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(repeat.operation.status).toBe('completed')
  expect(repeat.url).toBeUndefined()
  expect(stripe.sessions.size).toBe(1)
})

it('continues an incomplete payment through its own invoice instead of reopening a completed Checkout', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Completar pago pendiente')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.completeCheckout(false)
  stripe.subscriptions[0].latest_invoice.hosted_invoice_url = 'https://invoice.stripe.com/pending'
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('payment_pending')
  const repeated = await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(repeated.url).toBe('https://invoice.stripe.com/pending')
  stripe.pay()
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('completed')
  expect(stripe.invoices).toHaveLength(1)
})

it('keeps a failed card upgrade pending, preserves access, and expires it once Stripe voids that invoice', async () => {
  const { service, stripe, selection, production, activate, operation } = await setup()
  await activate()
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación rechazada')
  stripe.failPayment = true
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect((await operation(quote.id)).status).toBe('payment_pending')
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
  expect((await service.account(ids.tenant)).contract.features).not.toContain('production')
  stripe.subscriptions[0].pending_update = null
  stripe.subscriptions[0].latest_invoice.status = 'void'
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('expired')
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
})

it('recovers a declined card upgrade by paying its original invoice once, including duplicate and out-of-order events', async () => {
  const { service, stripe, selection, production, activate, operation } = await setup()
  await activate()
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Tarjeta requiere otro intento')
  stripe.failPayment = true
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const invoiceId = stripe.subscriptions[0].latest_invoice.id
  const customer = { customer: 'cus_test' }
  await service.processEvent({ id: 'evt_declined', type: 'invoice.payment_failed', created: 1, livemode: false, data: { object: customer } })
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
  stripe.pay()
  await service.processEvent({ id: 'evt_paid', type: 'invoice.paid', created: 2, livemode: false, data: { object: customer } })
  await service.processEvent({ id: 'evt_paid', type: 'invoice.paid', created: 2, livemode: false, data: { object: customer } })
  await service.processEvent({ id: 'evt_old_decline', type: 'invoice.payment_failed', created: 1, livemode: false, data: { object: customer } })
  expect(stripe.subscriptions[0].latest_invoice.id).toBe(invoiceId)
  expect(stripe.invoices).toHaveLength(2)
  expect((await operation(quote.id)).status).toBe('completed')
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(5900)
  expect((await service.account(ids.tenant)).last_payment_status).toBe('paid')
})

it('does not settle an unpaid SEPA upgrade just because a later renewal is paid', async () => {
  const { service, stripe, selection, production, activate, operation } = await setup()
  await activate()
  stripe.sepa = true
  stripe.subscriptions[0].default_payment_method = { id: 'pm_sepa_test', type: 'sepa_debit', customer: 'cus_test', livemode: false }
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación SEPA pendiente')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const unpaid = stripe.subscriptions[0].latest_invoice
  stripe.subscriptions[0].latest_invoice = stripe.invoice(true)
  await service.reconcile(ids.tenant)
  expect(unpaid.status).toBe('open')
  expect((await operation(quote.id)).status).toBe('payment_pending')
  expect((await service.account(ids.tenant)).last_payment_status).toBe('open')
  expect(stripe.invoices).toHaveLength(3)
})

it('settles the paid upgrade itself even if a later renewal becomes past due', async () => {
  const { service, stripe, selection, production, activate, operation } = await setup()
  await activate()
  stripe.sepa = true
  stripe.subscriptions[0].default_payment_method = { id: 'pm_sepa_test', type: 'sepa_debit', customer: 'cus_test', livemode: false }
  const desired = { ...selection, addons: [{ key: 'production', versionId: production.id, quantity: 1, venueIds: [ids.venue], deviceIds: [] }] }
  const quote = await service.quote(ids.tenant, ids.owner, desired, null, 'Ampliación liquidada')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.pay()
  stripe.subscriptions[0].latest_invoice = stripe.invoice(false)
  stripe.subscriptions[0].status = 'past_due'
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('completed')
  expect(await service.account(ids.tenant)).toMatchObject({ status: 'past_due', last_payment_status: 'open' })
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(5900)
})

it('releases a terminally rejected asynchronous Checkout without calling it paid or removing prior authorized access', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta SEPA')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.authorizeSepaCheckout()
  await service.reconcile(ids.tenant)
  stripe.failSepa()
  stripe.subscriptions[0].status = 'active'
  stripe.subscriptions[0].latest_invoice.status = 'void'
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('expired')
  expect((await service.account(ids.tenant)).last_payment_status).toBe('void')
  expect((await service.account(ids.tenant)).contract.recurringCents).toBe(4900)
  expect((await service.overview()).metrics.paidCents).toBe(0)
})

it('keeps uncollectible debt pending until its own invoice is paid or voided', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta con deuda recuperable')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  stripe.authorizeSepaCheckout()
  await service.reconcile(ids.tenant)
  stripe.subscriptions[0].latest_invoice.status = 'uncollectible'
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('payment_pending')
  expect((await service.account(ids.tenant)).last_payment_status).toBe('uncollectible')
  expect((await service.overview()).metrics.paidCents).toBe(0)
  const invoice = stripe.subscriptions[0].latest_invoice
  Object.assign(invoice, { status: 'paid', amount_paid: invoice.amount_due, status_transitions: { paid_at: stripe.now } })
  await service.reconcile(ids.tenant)
  expect((await operation(quote.id)).status).toBe('completed')
  expect((await service.account(ids.tenant)).last_payment_status).toBe('paid')
})

it('retains an uncertain operation and requires recovery instead of acknowledging a repeated confirmation as success', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Respuesta perdida')
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args)
    if (path === '/checkout/sessions') throw new Error('lost response')
    return result
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('lost response')
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_ACTION_REQUIRED')
  expect((await operation(quote.id)).status).toBe('applying')
  stripe.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  expect(stripe.sessions.size).toBe(1)
})

it('does not release a pending operation using a Checkout belonging to a different tenant', async () => {
  const { service, stripe, selection, operation } = await setup()
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Sesión ajena')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  const session = [...stripe.sessions.values()][0]
  session.metadata.tickit_tenant_id = ids.other
  session.status = 'expired'
  await expect(service.reconcile(ids.tenant)).rejects.toThrow('BILLING_CHECKOUT_MISMATCH')
  expect((await operation(quote.id)).status).toBe('payment_pending')
  expect((await service.account(ids.tenant)).contract).toBeNull()
})
