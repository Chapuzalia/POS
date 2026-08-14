import assert from 'node:assert/strict'
import test from 'node:test'
import {
  getNextReservationForTable,
  reservationsOverlap,
  reconcileReservationDetail,
  sortReservations,
  totalReservationTableCapacity,
} from '../src/features/reservations/domain/reservationAvailability.ts'
import {
  formatReservationTimeDistance,
  isBlockingReservationStatus,
  isReservationLate,
  RESERVATION_GRACE_MINUTES,
  reservationTimingLabel,
} from '../src/features/reservations/domain/reservationStatus.ts'

const base = {
  id: 'reservation-1',
  startsAt: '2026-07-26T19:00:00.000Z',
  endsAt: '2026-07-26T21:00:00.000Z',
  status: 'confirmed',
  tableIds: ['table-1'],
}

test('detecta solapamientos reales y permite horarios contiguos', () => {
  assert.equal(reservationsOverlap(base, { startsAt: '2026-07-26T20:59:00.000Z', endsAt: '2026-07-26T22:00:00.000Z' }), true)
  assert.equal(reservationsOverlap(base, { startsAt: '2026-07-26T21:00:00.000Z', endsAt: '2026-07-26T22:00:00.000Z' }), false)
  assert.equal(reservationsOverlap(base, { startsAt: '2026-07-26T17:00:00.000Z', endsAt: '2026-07-26T19:00:00.000Z' }), false)
})

test('calcula el retraso con un margen centralizado de quince minutos', () => {
  assert.equal(RESERVATION_GRACE_MINUTES, 15)
  assert.equal(isReservationLate(base, new Date('2026-07-26T19:15:00.000Z')), false)
  assert.equal(isReservationLate(base, new Date('2026-07-26T19:16:00.000Z')), true)
  assert.equal(isReservationLate({ ...base, status: 'arrived' }, new Date('2026-07-26T19:30:00.000Z')), false)
})

test('encuentra la siguiente reserva de una mesa y ordena cronológicamente', () => {
  const later = { ...base, id: 'reservation-2', startsAt: '2026-07-26T22:00:00.000Z', endsAt: '2026-07-26T23:00:00.000Z' }
  const cancelled = { ...base, id: 'reservation-3', startsAt: '2026-07-26T18:00:00.000Z', status: 'cancelled' }
  assert.equal(getNextReservationForTable([later, cancelled, base], 'table-1', new Date('2026-07-26T18:00:00.000Z'))?.id, base.id)
  assert.deepEqual(sortReservations([later, base]).map((reservation) => reservation.id), [base.id, later.id])
})

test('suma capacidad sin duplicar mesas y clasifica estados bloqueantes', () => {
  const tables = [{ id: 'table-1', capacity: 2 }, { id: 'table-2', capacity: 4 }]
  assert.equal(totalReservationTableCapacity(tables, ['table-1', 'table-2']), 6)
  for (const status of ['confirmed', 'arrived', 'seated']) assert.equal(isBlockingReservationStatus(status), true)
  for (const status of ['cancelled', 'no_show', 'completed']) assert.equal(isBlockingReservationStatus(status), false)
})

test('un refresco antiguo no sustituye la reserva seleccionada', () => {
  const first = { ...base, id: 'reservation-1', customerName: 'Primera' }
  const second = { ...base, id: 'reservation-2', customerName: 'Segunda' }
  const refreshedFirst = { ...first, customerName: 'Primera actualizada' }
  const refreshedSecond = { ...second, customerName: 'Segunda actualizada' }
  assert.equal(reconcileReservationDetail(second, first.id, refreshedFirst), second)
  assert.equal(reconcileReservationDetail(second, second.id, refreshedSecond), refreshedSecond)
})

test('muestra días, horas y minutos omitiendo las unidades que no hacen falta', () => {
  assert.equal(formatReservationTimeDistance(0), '0 min')
  assert.equal(formatReservationTimeDistance(35), '35 min')
  assert.equal(formatReservationTimeDistance(60), '1 h')
  assert.equal(formatReservationTimeDistance(251), '4 h 11 min')
  assert.equal(formatReservationTimeDistance(1_440), '1 d')
  assert.equal(formatReservationTimeDistance(3_011), '2 d 2 h 11 min')

  assert.equal(
    reservationTimingLabel(base, new Date('2026-07-25T14:49:00.000Z')),
    'En 1 d 4 h 11 min',
  )
  assert.equal(
    reservationTimingLabel(base, new Date('2026-07-26T20:16:00.000Z')),
    '1 h 16 min tarde',
  )
})
