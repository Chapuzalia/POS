import assert from 'node:assert/strict'
import test from 'node:test'
import { reconcileReservationDetail } from '../src/features/reservations/domain/reservationAvailability.ts'

const base = {
  id: 'reservation-1',
  startsAt: '2026-07-26T19:00:00.000Z',
  endsAt: '2026-07-26T21:00:00.000Z',
  status: 'confirmed',
  tableIds: ['table-1'],
}

test('un refresco antiguo no sustituye la reserva seleccionada', () => {
  const first = { ...base, id: 'reservation-1', customerName: 'Primera' }
  const second = { ...base, id: 'reservation-2', customerName: 'Segunda' }
  const refreshedFirst = { ...first, customerName: 'Primera actualizada' }
  const refreshedSecond = { ...second, customerName: 'Segunda actualizada' }
  assert.equal(reconcileReservationDetail(second, first.id, refreshedFirst), second)
  assert.equal(reconcileReservationDetail(second, second.id, refreshedSecond), refreshedSecond)
})
