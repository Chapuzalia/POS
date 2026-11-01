import { expect, it, onTestFinished } from 'vitest'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'
import { StripeGateway, StripeRequestError } from '../../supabase/functions/_shared/billing/stripe'

it('opens Checkout through the pinned Stripe gateway without the removed payment_method_types parameter', async () => {
  const { service, stripe, selection } = await createBillingService({ after: onTestFinished }, 4900)
  const original = stripe.request.bind(stripe)
  let requests = 0
  stripe.request = async (method, path, ...args) => {
    if (path !== '/checkout/sessions') return original(method, path, ...args)
    const gateway = new StripeGateway('sk_test_fixture', async (_url, init) => {
      requests++
      expect(new Headers(init?.headers).get('Stripe-Version')).toBe('2026-09-30.endive')
      const form = new URLSearchParams(String(init?.body))
      // Endive rejects the retired field before a Checkout session is created.
      if ([...form.keys()].some(key => key.startsWith('payment_method_types'))) {
        return Response.json({ error: { type: 'invalid_request_error', param: 'payment_method_types' } }, { status: 400 })
      }
      expect([...form.keys()].some(key => key.startsWith('allowed_payment_method_types'))).toBe(false)
      expect(form.get('tax_id_collection[required]')).toBe('if_supported')
      expect(form.get('subscription_data[default_tax_rates][0]')).toBeTruthy()
      return Response.json(await original(method, path, ...args))
    })
    return gateway.request(method, path, ...args)
  }
  const quote = await service.quote(ids.tenant, ids.owner, selection, null, 'Alta compatible con Endive')
  expect(quote.stripe_params.checkoutPolicy).toBe('fiscal_sepa_v2')
  const result = await service.confirm(ids.tenant, ids.owner, quote.id)
  expect(requests).toBe(1)
  expect(result.operation.status).toBe('payment_pending')
  expect(result.url).toBe('https://checkout.stripe.com/test')
})

it.each(['fiscal_sepa_v1', 'fiscal_sepa_v2'])('recovers a lost %s Checkout response using exactly the original parameters and idempotency key', async policy => {
  const { service, stripe, selection, transition, db } = await createBillingService({ after: onTestFinished }, 4900)
  const current = await service.quote(ids.tenant, ids.owner, selection, null, 'Oferta actual')
  const quote = await transition('quote', {
    tenantId: ids.tenant, actorId: ids.owner, revision: (await service.account(ids.tenant)).revision,
    kind: 'change', contract: current.contract, timing: 'immediate',
    stripeParams: { ...current.stripe_params, checkoutPolicy: policy },
    preview: current.preview, reason: 'Compatibilidad de Checkout', prorationDate: current.proration_date,
  })
  if (policy === 'fiscal_sepa_v1') {
    await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('BILLING_STALE_STRIPE_QUOTE')
    // Simulate an operation already claimed by the previous deployed implementation.
    await transition('apply_claim', { tenantId: ids.tenant, actorId: ids.owner, operationId: quote.id })
  }
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args)
    if (path === '/checkout/sessions') throw new Error('lost Checkout response')
    return result
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id, policy === 'fiscal_sepa_v1')).rejects.toThrow('lost Checkout response')
  expect((await db.query('select status from billing_operations where id=$1', [quote.id])).rows[0].status).toBe('applying')
  stripe.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  const calls = stripe.calls.filter(call => call.path === '/checkout/sessions')
  expect(calls).toHaveLength(2)
  expect(calls[0]).toEqual(calls[1])
  expect(calls[0].params.payment_method_types).toEqual(policy === 'fiscal_sepa_v1' ? ['card', 'sepa_debit'] : undefined)
  expect(calls[0].params.allowed_payment_method_types).toBeUndefined()
  expect(stripe.sessions.size).toBe(1)
})

it('can release an externally verified v1 rejection through the audited transition and start a fresh v2 operation', async () => {
  const { service, stripe, selection, transition, db } = await createBillingService({ after: onTestFinished }, 4900)
  const current = await service.quote(ids.tenant, ids.owner, selection, null, 'Oferta actual')
  const old = await transition('quote', {
    tenantId: ids.tenant, actorId: ids.owner, revision: (await service.account(ids.tenant)).revision,
    kind: 'change', contract: current.contract, timing: 'immediate',
    stripeParams: { ...current.stripe_params, checkoutPolicy: 'fiscal_sepa_v1' },
    preview: current.preview, reason: 'Oferta v1 rechazada', prorationDate: current.proration_date,
  })
  await transition('apply_claim', { tenantId: ids.tenant, actorId: ids.owner, operationId: old.id })
  const rejection = new StripeRequestError(400, { type: 'invalid_request_error', param: 'payment_method_types' }, 'req_fixture')
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    if (path === '/checkout/sessions') throw rejection
    return original(method, path, ...args)
  }
  await expect(service.confirm(ids.tenant, ids.owner, old.id, true)).rejects.toThrow('STRIPE_HTTP_400')
  const stored = (await db.query('select * from billing_operations where id=$1', [old.id])).rows[0]
  expect(stored.status).toBe('applying')
  expect(stored.result).toEqual({ stripeError: rejection.diagnostic })
  // Represents the runbook's external verification, never automatic release on error.
  expect(stripe.sessions.size).toBe(0)
  expect(stripe.subscriptions).toHaveLength(0)
  expect(stripe.invoices).toHaveLength(0)
  const released = await transition('apply_error', {
    tenantId: ids.tenant, operationId: old.id, error: rejection.diagnostic, release: true,
  })
  expect(released.status).toBe('failed')
  expect((await db.query("select id from billing_audit where tenant_id=$1 and action='apply_error' and details->>'operationId'=$2", [ids.tenant, old.id])).rows.length).toBeGreaterThan(0)
  stripe.request = original
  const fresh = await service.quote(ids.tenant, ids.owner, selection, null, 'Nueva oferta tras rechazo verificado')
  expect(fresh.id).not.toBe(old.id)
  expect(fresh.stripe_params.checkoutPolicy).toBe('fiscal_sepa_v2')
  await expect(service.confirm(ids.tenant, ids.owner, fresh.id)).resolves.toMatchObject({ url: 'https://checkout.stripe.com/test' })
  expect(stripe.sessions.size).toBe(1)
})
