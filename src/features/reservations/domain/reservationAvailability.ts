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

export function localDateKey(value: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).format(value)
}

export function shiftDateKey(dateKey: string, days: number) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day + days))
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

export function getDateRange(dateKey: string, timeZone: string) {
  return {
    from: zonedLocalToUtc(dateKey, '00:00', timeZone),
    to: zonedLocalToUtc(shiftDateKey(dateKey, 1), '00:00', timeZone),
  }
}

export function zonedLocalToUtc(dateKey: string, time: string, timeZone: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const [hour, minute] = time.split(':').map(Number)
  const localEpoch = Date.UTC(year, month - 1, day, hour, minute)
  let candidate = localEpoch
  const formatter = new Intl.DateTimeFormat('en-US-u-ca-iso8601-nu-latn', {
    day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit',
    month: '2-digit', second: '2-digit', timeZone, year: 'numeric',
  })
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(candidate))
      .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
    const represented = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
    const adjusted = localEpoch - (represented - candidate)
    if (adjusted === candidate) return new Date(adjusted).toISOString()
    candidate = adjusted
  }
  return new Date(candidate).toISOString()
}
