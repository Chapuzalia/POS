import { expect, it } from 'vitest'
import { invoiceServiceSnapshot } from '../../supabase/functions/_shared/billing/invoice-description'
import type { InvoiceServiceSnapshot } from '../../supabase/functions/_shared/billing/invoice-description'
import type { Contract } from '../../supabase/functions/_shared/billing/domain'
import type { MolliePayment, MollieSubscription } from '../../supabase/functions/_shared/billing/mollie'
import type { Operation } from '../../supabase/functions/_shared/billing/service'

const contract: Contract = { planName: 'Tickit POS Pro', interval: 'month', selection: { planVersionId: 'version', addons: [] }, lines: [], addons: [], features: [], limits: { venues: 1, devices: 2 }, recurringCents: 4900, exception: null }
const operation = (overrides: Partial<Operation> = {}): Operation => ({ id: 'signup', tenant_id: 'tenant', actor_id: 'owner', kind: 'change', reason: 'Alta', status: 'completed', contract, restore_contract: null, timing: 'immediate', preview: { amountDueCents: 5929, recurringCents: 4900, currency: 'eur', effectiveAt: null, details: '' }, stripe_params: { subscriptionId: null }, result: { paymentId: 'tr_first' }, created_at: '2026-01-20T10:00:00Z', proration_date: Date.parse('2026-01-20T10:00:00Z') / 1000, effective_at: null, ...overrides })
const payment = (overrides: Partial<MolliePayment> = {}): MolliePayment => ({ id: 'tr_first', mode: 'test', status: 'paid', amount: { currency: 'EUR', value: '59.29' }, sequenceType: 'first', method: 'creditcard', description: 'Tickit Tickit POS Pro · alta abcdef', createdAt: '2026-01-20T10:00:00Z', paidAt: '2026-01-21T10:00:00Z', metadata: { tickit_kind: 'first', tickit_operation_id: 'signup' }, _links: {}, ...overrides })
const subscription: MollieSubscription = { id: 'sub_1', customerId: 'customer', mode: 'test', status: 'active', amount: { currency: 'EUR', value: '59.29' }, interval: '1 month', startDate: '2026-02-21', nextPaymentDate: '2026-04-21', metadata: { tickit_operation_id: 'signup' } }
const describe = (charge: MolliePayment, ops = [operation()], sub = subscription, existing = new Map<string, InvoiceServiceSnapshot | null>()) => invoiceServiceSnapshot(charge, [payment(), charge], [sub], ops, existing)

it('describes the plan and actual first paid period without internal IDs or duplicated branding', () => {
  expect(describe(payment())).toEqual({ kind: 'first', periodStart: '2026-01-21', periodEnd: '2026-02-21', description: 'Suscripción Tickit POS Pro — mensual\nPeríodo: del 21/01/2026 al 20/02/2026' })
})

it('does not invent the first service period while Checkout is still open', () => {
  expect(describe(payment({ status: 'open', paidAt: null }))).toEqual({ kind: 'first', description: 'Suscripción Tickit POS Pro — mensual\nPeríodo pendiente de activación' })
})

it('uses the renewal cycle even when SEPA settles later and nextPaymentDate has advanced', () => {
  const charge = payment({ id: 'tr_renewal', subscriptionId: 'sub_1', createdAt: '2026-02-21T07:00:00Z', paidAt: '2026-03-02T07:00:00Z', metadata: null })
  expect(describe(charge)).toMatchObject({ kind: 'renewal', periodStart: '2026-02-21', periodEnd: '2026-03-21' })
})

it('preserves the monthly anchor at month-end', () => {
  const charge = payment({ id: 'tr_renewal', subscriptionId: 'sub_1', createdAt: '2026-02-28T07:00:00Z', metadata: null })
  expect(describe(charge, [operation()], { ...subscription, startDate: '2026-01-31' })).toMatchObject({ periodStart: '2026-02-28', periodEnd: '2026-03-31' })
})

it('handles an annual first period starting on a leap day', () => {
  expect(describe(payment({ paidAt: '2024-02-29T10:00:00Z' }), [operation({ contract: { ...contract, interval: 'year' } })])).toMatchObject({ periodStart: '2024-02-29', periodEnd: '2025-02-28', description: expect.stringContaining('anual') })
})

it('uses the accepted quote window for an upgrade, not its later payment date', () => {
  const op = operation({ id: 'upgrade', stripe_params: { subscriptionId: 'sub_1', baseline: JSON.stringify({ next: '2026-03-21' }) }, proration_date: Date.parse('2026-03-10T10:00:00Z') / 1000 })
  expect(describe(payment({ paidAt: '2026-03-12T10:00:00Z', metadata: { tickit_kind: 'proration', tickit_operation_id: 'upgrade' } }), [op])).toMatchObject({ kind: 'proration', periodStart: '2026-03-10', periodEnd: '2026-03-21', description: expect.stringContaining('Ampliación de suscripción') })
})

it('keeps an arrears payment tied to the original billed period', () => {
  const original = describe(payment())
  const charge = payment({ id: 'tr_arrears', createdAt: '2026-04-10T10:00:00Z', metadata: { tickit_kind: 'arrears', tickit_covers: 'tr_first' } })
  expect(describe(charge, [operation()], subscription, new Map([['tr_first', original]]))).toEqual({ ...original, kind: 'arrears', description: `Regularización de cuota\n${original.description}` })
})

it('selects the contract effective at the charge, not a future plan change', () => {
  const upgrade = operation({ id: 'upgrade', contract: { ...contract, planName: 'Tickit POS Premium' }, stripe_params: { subscriptionId: 'sub_1' }, effective_at: '2026-03-21', result: null })
  const charge = payment({ id: 'tr_renewal', subscriptionId: 'sub_1', createdAt: '2026-02-21T07:00:00Z', metadata: null })
  expect(describe(charge, [operation(), upgrade]).description).toContain('POS Pro')
  expect(describe({ ...charge, createdAt: '2026-03-21T07:00:00Z' }, [operation(), upgrade]).description).toContain('POS Premium')
})

it('requires review when the billing period cannot be established', () => {
  expect(describe(payment({ metadata: null }))).toEqual({})
  expect(describe(payment({ metadata: { tickit_kind: 'arrears', tickit_covers: 'missing' } }))).toEqual({})
  expect(describe(payment({ paidAt: 'invalid' }))).toEqual({})
})
