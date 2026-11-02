import type { Reservation, ReservationConflict, ReservationTable, ReservationTableOption } from '../types'
import { isBlockingReservationStatus } from './reservationStatus.ts'

export function reservationsOverlap(
  first: Pick<Reservation, 'startsAt' | 'endsAt'>,
  second: Pick<Reservation, 'startsAt' | 'endsAt'>,
) {
  return new Date(first.startsAt).getTime() < new Date(second.endsAt).getTime()
    && new Date(first.endsAt).getTime() > new Date(second.startsAt).getTime()
}

export function totalReservationTableCapacity(
  tables: Array<Pick<ReservationTable, 'id' | 'capacity'>>,
  tableIds: string[],
) {
  const selected = new Set(tableIds)
  return tables.reduce((total, table) => total + (selected.has(table.id) ? table.capacity : 0), 0)
}

export function getNextReservationForTable(
  reservations: Reservation[],
  tableId: string,
  now = new Date(),
) {
  let next: Reservation | null = null
  for (const reservation of reservations) {
    if (!reservation.tableIds.includes(tableId) || !isBlockingReservationStatus(reservation.status)) continue
    if (new Date(reservation.endsAt).getTime() <= now.getTime()) continue
    if (!next || new Date(reservation.startsAt).getTime() < new Date(next.startsAt).getTime()) next = reservation
  }
  return next
}

export function sortReservations(reservations: Reservation[], today = false) {
  return [...reservations].sort((first, second) => {
    if (today) {
      const firstArchived = ['cancelled', 'completed', 'no_show'].includes(first.status)
      const secondArchived = ['cancelled', 'completed', 'no_show'].includes(second.status)
      if (firstArchived !== secondArchived) return firstArchived ? 1 : -1
    }
    return new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime()
  })
}

export function classifyReservationTables(
  tables: ReservationTable[],
  conflicts: ReservationConflict[],
  partySize: number,
): ReservationTableOption[] {
  const conflictsByTable = new Map<string, ReservationConflict[]>()
  for (const conflict of conflicts) {
    conflictsByTable.set(conflict.tableId, [...(conflictsByTable.get(conflict.tableId) ?? []), conflict])
  }
  return tables.map((table) => {
    const tableConflicts = conflictsByTable.get(table.id) ?? []
    return {
      ...table,
      availability: !table.isActive
        ? 'inactive'
        : tableConflicts.length
          ? 'conflict'
          : table.capacity < partySize
            ? 'insufficient'
            : 'available',
      conflicts: tableConflicts,
    }
  })
}

export function reconcileReservationDetail(
  current: Reservation | null,
  requestedId: string,
  refreshed: Reservation,
) {
  return current?.id === requestedId ? refreshed : current
}

export function normalizeReservationSearch(value: string) {
  return value.trim().toLocaleLowerCase('es').replace(/\s+/g, ' ')
}

export function normalizePhoneSearch(value: string) {
  return value.replace(/[^\d+]/g, '')
}
