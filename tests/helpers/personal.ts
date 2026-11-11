import { pbkdf2Sync } from 'node:crypto'
import { staffSnapshotSchema } from '../../apps/api/src/personal-contracts'
import type { TenantContext } from '../../src/types'

export const personalIds = {
  tenant: '10000000-0000-4000-8000-000000000001', other: '10000000-0000-4000-8000-000000000002',
  venue: '20000000-0000-4000-8000-000000000001', venueB: '20000000-0000-4000-8000-000000000002',
  personalVenue: '30000000-0000-4000-8000-000000000001', personalOrg: '30000000-0000-4000-8000-000000000002',
  employee: '40000000-0000-4000-8000-000000000001', device: '50000000-0000-4000-8000-000000000001',
  user: '60000000-0000-4000-8000-000000000001', connection: '70000000-0000-4000-8000-000000000001',
}
export const personalContext: TenantContext = {
  tenantId: personalIds.tenant, venueId: personalIds.venue, deviceId: personalIds.device, userId: personalIds.user,
  tenantName: 'Test', tenantSlug: 'test', venueName: 'Venue', deviceName: 'Device', userName: 'Device account', role: 'cashier',
  canTakeOrders: true, canTakePayments: true, canOpenCashSession: true, canCloseCashSession: true, canManageCash: true,
  features: ['tickit_personal'],
}
const salt = '0123456789abcdef0123456789abcdef'
export const employeeSnapshot = staffSnapshotSchema.parse({
  employee_id: personalIds.employee, full_name: 'Test Employee', status: 'active', version: 1, role_id: null,
  venue_ids: [personalIds.venue], policy_expires_at: '2020-01-01T00:00:00Z',
  policies: { [personalIds.venue]: {
    'pos.order.create': { allow: true }, 'pos.payment.take': { allow: true },
    'pos.discount.manual': { allow: true, max_percent: 10, max_cents: 500 },
    'pos.cash.move': { allow: false },
  } },
  pin_verifier: { algorithm: 'PBKDF2-SHA256', iterations: 210000, salt, hash: pbkdf2Sync('123456', Buffer.from(salt, 'hex'), 210000, 32, 'sha256').toString('hex') },
})

