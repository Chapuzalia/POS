import type { AppliedDiscount, TenantContext } from '../../types'
import { UserFacingError } from '../../utils/UserFacingError.ts'
import { calculateDiscountForLines } from '../../lib/discounts.ts'
import type { StaffSnapshot } from '../../../apps/api/src/personal-contracts'

export function staffCan(context: TenantContext | null, capability: string, percent = 0, cents = 0) {
  if (!context?.personalStaff) return true
  const { employee, venueId } = context.personalStaff
  const rule = employee?.policies[venueId]?.[capability]
  // Last known permissions remain usable offline, including after policy_expires_at.
  return Boolean(employee?.status === 'active' && employee.venue_ids.includes(venueId) && rule?.allow
    && Number.isFinite(percent) && percent >= 0 && percent <= 100 && Number.isSafeInteger(cents) && cents >= 0
    && (rule.max_percent === undefined || percent <= rule.max_percent)
    && (rule.max_cents === undefined || cents <= rule.max_cents))
}

export function withPersonalStaff(context: TenantContext, employee: StaffSnapshot | null): TenantContext {
  const next = { ...context, personalStaff: { employee, venueId: context.venueId, deviceCanManageCash: context.canManageCash === true } }
  return {
    ...next,
    canTakeOrders: Boolean(context.canTakeOrders && staffCan(next, 'pos.order.create')),
    canTakePayments: Boolean(context.canTakePayments && staffCan(next, 'pos.payment.take')),
    canOpenCashSession: Boolean(context.canOpenCashSession && staffCan(next, 'pos.cash.open')),
    canCloseCashSession: Boolean(context.canCloseCashSession && staffCan(next, 'pos.cash.close')),
    canManageCash: Boolean(context.canManageCash && staffCan(next, 'pos.cash.move')),
  }
}

export function assertStaffPermission(context: TenantContext | null, capability: string, percent = 0, cents = 0) {
  if (!staffCan(context, capability, percent, cents)) throw new UserFacingError('El trabajador seleccionado no tiene permiso para esta operación. Cambia a un trabajador autorizado.')
}

export function assertStaffDiscount(context: TenantContext | null, discount: AppliedDiscount | null, lines: Parameters<typeof calculateDiscountForLines>[0]) {
  if (!context?.personalStaff || !discount || discount.automatic) return
  const { discountAmountCents } = calculateDiscountForLines(lines, discount)
  const subtotalCents = lines.reduce((total, line) => total + line.grossCents, 0)
  assertStaffPermission(context, discount.discountId ? 'pos.promotion.apply' : 'pos.discount.manual',
    discount.calculationType === 'percentage' ? discount.value : subtotalCents > 0 ? discountAmountCents * 100 / subtotalCents : 0, discountAmountCents)
}

export async function verifyStaffPin(employee: StaffSnapshot, pin: string) {
  const verifier = employee.pin_verifier
  if (!verifier || !/^\d{6,12}$/.test(pin)) return false
  const bytes = (value: string) => Uint8Array.from(value.match(/../g) ?? [], part => parseInt(part, 16))
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits'])
  const result = new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: bytes(verifier.salt), iterations: verifier.iterations }, key, 256))
  const expected = bytes(verifier.hash)
  return result.reduce((difference, byte, index) => difference | (byte ^ expected[index]), 0) === 0
}
