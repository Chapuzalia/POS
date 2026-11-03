import { expect, it, onTestFinished } from 'vitest'
import { StripeRequestError } from '../../supabase/functions/_shared/billing/stripe.ts'
import { createBillingService } from '../helpers/billing-service.mjs'
import { billingIds as ids } from '../helpers/billing-db.mjs'

async function setup(cycles: number | null = null) {
  const fixture = await createBillingService({ after: onTestFinished }, 4900)
  await fixture.activate()
  const change = await fixture.service.quote(ids.tenant, ids.owner, fixture.selection, {
    freeUnits: {}, limits: {}, discountBasisPoints: 1000, customAmounts: {}, cycles, reason: 'Descuento al renovar',
  }, 'Cambio futuro', true)
  await fixture.service.confirm(ids.tenant, ids.owner, change.id)
  const operation = async (id: string) => (await fixture.db.query('select * from billing_operations where id=$1', [id])).rows[0]
  return { ...fixture, change, operation }
}

it.each([false, true])('cancels a subscription with its own scheduled plan change (immediate=%s)', async immediate => {
  const { service, stripe, change, operation } = await setup()
  const before = await service.account(ids.tenant)
  const invoiceCount = stripe.invoices.length
  const quote = await service.quoteCancel(ids.tenant, ids.owner, immediate, 'Baja solicitada')
  expect(quote.stripe_params.supersededOperationId).toBe(change.id)
  expect((await operation(change.id)).status).toBe('scheduled')
  const start = stripe.calls.length
  expect((await service.confirm(ids.tenant, ids.owner, quote.id)).operation.status).toBe('completed')
  expect(await operation(change.id)).toMatchObject({ status: 'expired', result: { scheduleId: 'sub_sched_test', supersededByOperationId: quote.id } })
  const mutations = stripe.calls.slice(start).filter(call => call.method !== 'GET')
  expect(mutations.map(call => call.path)).toEqual(['/subscription_schedules/sub_sched_test/release', '/subscriptions/sub_test'])
  expect(mutations[0].params).toEqual({ preserve_cancel_date: false })
  expect(mutations[1]).toMatchObject({ method: immediate ? 'DELETE' : 'POST', params: immediate ? { prorate: false, invoice_now: false } : { cancel_at_period_end: true } })
  expect(stripe.subscriptions[0].schedule).toBeNull()
  expect(await service.account(ids.tenant)).toMatchObject({ status: immediate ? 'canceled' : 'active', cancel_at_period_end: !immediate, contract: before.contract, sync_error: null })
  expect(stripe.invoices).toHaveLength(invoiceCount)
  const audit = await service.detail(ids.tenant, true)
  expect(audit.audit.some(row => row.action === 'supersede_scheduled_change')).toBe(true)
})

it('removes a legacy temporary discount and its restoration when cancellation replaces it', async () => {
  const { service, stripe, change, operation } = await setup(2)
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja antes de promoción')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect((await operation(change.id)).status).toBe('expired')
  expect(stripe.schedules.get('sub_sched_test').status).toBe('released')
  expect(stripe.subscriptions[0].cancel_at_period_end).toBe(true)
})

it('retains the current discounted contract when cancelling during a legacy promotion', async () => {
  const { service, stripe, change, operation } = await setup(2)
  stripe.advancePhase(1)
  await service.reconcile(ids.tenant)
  const current = (await service.account(ids.tenant)).contract
  expect(current.recurringCents).toBe(4410)
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja durante promoción')
  await service.confirm(ids.tenant, ids.owner, quote.id)
  expect((await operation(change.id)).status).toBe('expired')
  expect(await service.account(ids.tenant)).toMatchObject({ contract: current, sync_error: null, cancel_at_period_end: true })
})

it.each(['foreign_phase', 'missing_owner', 'foreign_subscription', 'foreign_schedule'])('keeps unrecognized schedules blocked (%s)', async tamper => {
  const { service, stripe, change, db, operation } = await setup()
  const schedule = stripe.schedules.get('sub_sched_test')
  if (tamper === 'foreign_phase') schedule.phases[0].metadata = { tickit_operation_id: ids.other }
  if (tamper === 'missing_owner') schedule.phases.forEach(phase => { phase.metadata = {} })
  if (tamper === 'foreign_subscription') schedule.subscription = 'sub_other'
  if (tamper === 'foreign_schedule') await db.query("update billing_operations set result=jsonb_build_object('scheduleId','sub_sched_other') where id=$1", [change.id])
  const start = stripe.calls.length
  await expect(service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')).rejects.toThrow('BILLING_PENDING_CHANGE')
  expect(stripe.calls.slice(start).every(call => call.method === 'GET')).toBe(true)
  expect((await operation(change.id)).status).toBe('scheduled')
})

it('restores the scheduled change if Stripe definitively rejects the first release', async () => {
  const { service, stripe, change, operation } = await setup()
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    if (path.endsWith('/release')) throw new StripeRequestError(400, { type: 'invalid_request_error', code: 'resource_missing' }, 'req_test')
    return original(method, path, ...args)
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('STRIPE_HTTP_400')
  expect((await operation(quote.id)).status).toBe('failed')
  expect((await operation(change.id))).toMatchObject({ status: 'scheduled', result: { scheduleId: 'sub_sched_test' } })
  expect((await operation(change.id)).result.supersededByOperationId).toBeUndefined()
  expect(stripe.subscriptions[0]).toMatchObject({ schedule: 'sub_sched_test', cancel_at_period_end: false })
  stripe.request = original
  const next = await service.quoteCancel(ids.tenant, ids.owner, false, 'Reintentar baja')
  await service.confirm(ids.tenant, ids.owner, next.id)
  expect((await operation(next.id)).status).toBe('completed')
})

it.each(['release', 'cancel'])('recovers a lost %s response using the same operation and Stripe keys', async lost => {
  const { service, stripe, change, operation } = await setup()
  const invoiceCount = stripe.invoices.length
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')
  const original = stripe.request.bind(stripe)
  stripe.request = async (method, path, ...args) => {
    const result = await original(method, path, ...args)
    if (method === 'POST' && path === (lost === 'release' ? '/subscription_schedules/sub_sched_test/release' : '/subscriptions/sub_test')) throw new Error('lost reply')
    return result
  }
  await expect(service.confirm(ids.tenant, ids.owner, quote.id)).rejects.toThrow('lost reply')
  expect((await operation(quote.id)).status).toBe('applying')
  expect((await operation(change.id)).status).toBe('expired')
  await expect(service.quoteCancel(ids.tenant, ids.owner, true, 'Otra baja')).rejects.toThrow('BILLING_PENDING_CHANGE')
  stripe.request = original
  await service.confirm(ids.tenant, ids.owner, quote.id, true)
  expect((await operation(quote.id)).status).toBe('completed')
  const releases = stripe.calls.filter(call => call.path.endsWith('/release'))
  expect(releases).toHaveLength(2)
  expect(releases[0]).toEqual(releases[1])
  expect(stripe.invoices).toHaveLength(invoiceCount)
})

it('rejects another tenant claiming the scheduled operation, without expiring it', async () => {
  const { service, transition, change, operation } = await setup()
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')
  const foreign = await transition('quote', { tenantId: ids.other, actorId: ids.stranger, revision: 0, kind: 'cancel', timing: 'period_end', stripeParams: quote.stripe_params, preview: quote.preview, reason: 'Otra empresa', prorationDate: quote.proration_date })
  await expect(transition('apply_claim', { tenantId: ids.other, actorId: ids.stranger, operationId: foreign.id })).rejects.toThrow('BILLING_PENDING_CHANGE')
  expect((await operation(change.id)).status).toBe('scheduled')
  expect((await operation(foreign.id)).status).toBe('quoted')
})

it('rechecks the pending lock atomically when another operation begins after the cancellation preview', async () => {
  const { service, transition, change, operation, db, stripe } = await setup()
  const quote = await service.quoteCancel(ids.tenant, ids.owner, false, 'Baja')
  await db.query("update billing_operations set status='payment_pending' where id=$1", [change.id])
  await expect(transition('apply_claim', { tenantId: ids.tenant, actorId: ids.owner, operationId: quote.id })).rejects.toThrow('BILLING_PENDING_CHANGE')
  await expect(service.quoteCancel(ids.tenant, ids.owner, true, 'Otra baja')).rejects.toThrow('BILLING_PENDING_CHANGE')
  expect((await operation(change.id)).status).toBe('payment_pending')
  expect((await operation(quote.id)).status).toBe('quoted')
  expect(stripe.subscriptions[0]).toMatchObject({ schedule: 'sub_sched_test', cancel_at_period_end: false })
})
