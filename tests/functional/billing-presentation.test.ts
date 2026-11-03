import { expect, it } from 'vitest'
import { billingAccountState, billingStatusLabel } from '../../src/features/billing/presentation'

const base = { status: 'active', last_payment_status: 'paid', sync_error: null, cancel_at_period_end: false }

it.each([
  [{ status: 'incomplete', last_payment_status: 'open' }, 'Alta pendiente', true],
  [{ status: 'pending_payment', last_payment_status: null }, 'Alta pendiente', true],
  [{ status: 'incomplete_expired', last_payment_status: 'void' }, 'Alta caducada', true],
  [{ status: 'past_due', last_payment_status: 'open' }, 'Revisar pago', true],
  [{ status: 'unpaid' }, 'Revisar pago', true],
  [{ last_payment_status: 'uncollectible' }, 'Revisar pago', true],
  [{ last_payment_status: 'processing' }, 'Cobro en trámite', false],
  [{ status: 'canceled', last_payment_status: 'open' }, 'Pago pendiente', true],
  [{ status: 'canceled' }, 'Cancelada', false],
  [{ cancel_at_period_end: true }, 'Baja programada', false],
  [{ sync_error: 'RECONCILIATION_REQUIRED' }, 'Comprobar estado', true],
  [{ sync_error: 'ENTITLEMENTS_PENDING_OPERATIONAL_CLOSE' }, 'Al día', false],
  [{ status: 'manual', last_payment_status: null }, 'Gestión manual', false],
] as const)('describes billing state %j without hiding unpaid invoices or labelling processing SEPA paid', (override, label, needsAttention) => {
  expect(billingAccountState({ ...base, ...override })).toMatchObject({ label, needsAttention })
})

it('translates operation states and tolerates an unknown future state', () => {
  expect(billingStatusLabel('payment_pending')).toBe('Pago pendiente')
  expect(billingStatusLabel('new_status')).toBe('Sin clasificar')
})
