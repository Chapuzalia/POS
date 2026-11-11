import { createId } from './format.ts'
import type { SaleCreatedPayload } from '../types'

/** Parse keypad/keyboard input without rounding fractional cents. */
export function parsePaymentAmount(value: string): number | null {
  const match = /^(\d+)(?:[.,](\d{0,2}))?$/.exec(value.trim())
  if (!match) return null
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  return Number.isSafeInteger(cents) ? cents : null
}

export function assertCustomCashAmount(totalCents: number, cashCents: number) {
  if (!Number.isSafeInteger(totalCents) || !Number.isSafeInteger(cashCents) || cashCents <= 0 || cashCents >= totalCents) {
    throw new Error('Indica un importe en efectivo y otro en tarjeta que sumen el total.')
  }
}

export function withCustomPayments(payload: SaleCreatedPayload, cashCents: number, totalCents = payload.sale.totalCents): SaleCreatedPayload {
  assertCustomCashAmount(totalCents, cashCents)
  const base = { tenantId: payload.sale.tenantId, saleId: payload.sale.id, changeCents: 0 }
  return {
    ...payload,
    sale: { ...payload.sale, paymentMethod: null },
    payment: null,
    payments: [
      { ...base, id: createId(), method: 'cash', amountCents: cashCents, receivedCents: cashCents },
      { ...base, id: createId(), method: 'card', amountCents: totalCents - cashCents, receivedCents: null },
    ],
  }
}

export function getPayloadPayments(payload: SaleCreatedPayload) {
  return payload.payments ?? (payload.payment ? [payload.payment] : [])
}
