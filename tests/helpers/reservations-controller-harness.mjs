import { readFile } from 'node:fs/promises'

import { createCompiledHookRunner } from './component-harness.mjs'

const source = await readFile(new URL('../../src/features/reservations/hooks/useReservationsController.ts', import.meta.url), 'utf8')

export function createReservationsControllerHarness({ services: overrides = {}, tableService: tableOverrides = {} } = {}) {
  const calls = { errors: [], openOrders: [], operationalRefreshes: 0 }
  const services = {
    changeReservationStatus: async (reservationId, status) => ({ id: reservationId, status }),
    loadReservation: async (_context, reservationId) => ({ id: reservationId, tableIds: ['table-1'] }),
    loadReservationConflicts: async () => [],
    loadReservationsForDate: async () => [],
    loadReservationVenueSettings: async () => ({ timeZone: 'UTC' }),
    ReservationConflictError: class ReservationConflictError extends Error {},
    saveReservation: async (_context, draft) => ({ reservation: draft }),
    searchReservations: async () => [],
    seatReservation: async () => 'order-1',
    ...overrides,
  }
  const modules = {
    sileo: { sileo: { success() {} } },
    '../../../utils/errors': { getReadableError: (error) => error?.message ?? String(error) },
    '../../tables/service': { loadRestaurantMap: async () => ({ areas: [], tables: [] }), ...tableOverrides },
    '../domain/reservationAvailability': {
      localDateKey: () => '2026-09-12',
      normalizePhoneSearch: (value) => String(value ?? '').replace(/\D/g, ''),
      normalizeReservationSearch: (value) => String(value ?? '').toLowerCase(),
      reconcileReservationDetail: (_current, _requestedId, refreshed) => refreshed,
      sortReservations: (reservations) => reservations,
    },
    '../domain/reservationStatus': { isReservationLate: () => false },
    '../services/reservationService': services,
    './useReservationsRealtime': { useReservationsRealtime() {} },
  }
  const runner = createCompiledHookRunner(source, 'useReservationsController', modules, {
    window: { clearTimeout() {}, setTimeout() { return 1 } },
  })
  const options = {
    cashSession: { id: 'cash-session' },
    context: { canTakeOrders: true, deviceId: 'device', role: 'cashier', tenantId: 'tenant', venueId: 'venue' },
    enabled: true,
    isOnline: true,
    onError: (error) => calls.errors.push(error),
    onOpenOrder: async (orderId) => { calls.openOrders.push(orderId) },
    operationalMap: { areas: [], tables: [] },
    refreshOperationalMap: async () => { calls.operationalRefreshes += 1 },
  }
  return { calls, options, render: () => runner.render(options), runner, services }
}
