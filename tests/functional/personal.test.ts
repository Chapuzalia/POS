import { describe, expect, it } from 'vitest'
import { hasTenantAddon } from '../../src/features/platform/tenantFeatureAccess'
import { personalCacheKey, readPersonalCache, savePersonalCache } from '../../src/features/personal/cache'
import { staffSnapshotSchema } from '../../apps/api/src/personal-contracts'
import { assertStaffDiscount, staffCan, verifyStaffPin, withPersonalStaff } from '../../src/features/personal/permissions'
import type { AppliedDiscount } from '../../src/types'

import { employeeSnapshot, personalContext, personalIds } from '../helpers/personal'

describe('Personal permissions and offline authentication', () => {
  it('keeps the legacy POS transparent and never enables Personal for old caches', () => {
    expect(hasTenantAddon({ features: undefined }, 'tickit_personal')).toBe(false)
    expect(staffCan({ ...personalContext, features: [] }, 'pos.refund')).toBe(true)
  })
  it('retains last known permissions beyond upstream expiry and intersects device capabilities', () => {
    const context = withPersonalStaff({ ...personalContext, canTakePayments: false }, employeeSnapshot)
    expect(context.canTakeOrders).toBe(true)
    expect(context.canTakePayments).toBe(false)
    expect(context.canManageCash).toBe(false)
    expect(context.userId).toBe(personalIds.user)
    expect(context.role).toBe('cashier')
    expect(staffCan(context, 'pos.order.create')).toBe(true)
    expect(staffCan(context, 'pos.refund')).toBe(false)
  })
  it('denies unselected, deactivated and wrong-venue employees', () => {
    for (const employee of [null, { ...employeeSnapshot, status: 'inactive' as const }, { ...employeeSnapshot, venue_ids: [personalIds.venueB] }]) {
      expect(staffCan(withPersonalStaff(personalContext, employee), 'pos.order.create')).toBe(false)
    }
  })
  it('checks percentage and actual discount cents, including a changed ticket after selection', () => {
    const context = withPersonalStaff(personalContext, employeeSnapshot)
    const discount: AppliedDiscount = { discountId: null, name: 'Manual', type: 'manual', calculationType: 'percentage', value: 10, roundingIncrementCents: null, color: null }
    expect(() => assertStaffDiscount(context, discount, [{ id: 'line', grossCents: 5000 }])).not.toThrow()
    expect(() => assertStaffDiscount(context, discount, [{ id: 'line', grossCents: 6000 }])).toThrow('permiso')
    expect(() => assertStaffDiscount(context, { ...discount, value: 11 }, [{ id: 'line', grossCents: 100 }])).toThrow('permiso')
  })
  it('verifies the Personal PIN locally and rejects missing or malformed verifiers', async () => {
    expect(await verifyStaffPin(employeeSnapshot, '123456')).toBe(true)
    expect(await verifyStaffPin(employeeSnapshot, '123457')).toBe(false)
    expect(await verifyStaffPin(employeeSnapshot, '123')).toBe(false)
    expect(await verifyStaffPin({ ...employeeSnapshot, pin_verifier: null }, '123456')).toBe(false)
    expect(staffSnapshotSchema.safeParse({ ...employeeSnapshot, pin_verifier: { ...employeeSnapshot.pin_verifier, iterations: 1 } }).success).toBe(false)
  })
  it('scopes persisted workers by route, tenant, venue, device and account, and rejects corrupted data', () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const key = personalCacheKey(personalContext)
    const state = { enabled: true, connectionId: personalIds.connection, staff: [employeeSnapshot] }
    savePersonalCache(storage, key, state)
    expect(readPersonalCache(storage, key)).toEqual(state)
    for (const field of ['tenantId', 'venueId', 'deviceId', 'userId'] as const) expect(readPersonalCache(storage, personalCacheKey({ ...personalContext, [field]: personalIds.other }))).toBeNull()
    values.set(key, '{broken')
    expect(readPersonalCache(storage, key)).toBeNull()
  })
})
