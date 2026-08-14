import type { Reservation, ReservationStatus } from '../types'

export const RESERVATION_GRACE_MINUTES = 15

const labels: Record<ReservationStatus, string> = {
  confirmed: 'Confirmada',
  arrived: 'Ha llegado',
  seated: 'Sentada',
  completed: 'Finalizada',
  cancelled: 'Cancelada',
  no_show: 'No presentada',
}

export function getReservationStatusLabel(status: ReservationStatus) {
  return labels[status]
}

export function isReservationLate(reservation: Pick<Reservation, 'startsAt' | 'status'>, now = new Date()) {
  return reservation.status === 'confirmed'
    && now.getTime() > new Date(reservation.startsAt).getTime() + RESERVATION_GRACE_MINUTES * 60_000
}

export function minutesUntilReservation(startsAt: string, now = new Date()) {
  return Math.ceil((new Date(startsAt).getTime() - now.getTime()) / 60_000)
}

export function formatReservationTimeDistance(totalMinutes: number) {
  const minutes = Math.max(0, Math.floor(totalMinutes))
  const days = Math.floor(minutes / 1_440)
  const hours = Math.floor((minutes % 1_440) / 60)
  const remainingMinutes = minutes % 60
  const parts: string[] = []

  if (days > 0) parts.push(`${days} d`)
  if (hours > 0) parts.push(`${hours} h`)
  if (remainingMinutes > 0 || parts.length === 0) parts.push(`${remainingMinutes} min`)

  return parts.join(' ')
}

export function isBlockingReservationStatus(status: ReservationStatus) {
  return status === 'confirmed' || status === 'arrived' || status === 'seated'
}

export function getAllowedReservationActions(reservation: Reservation, now = new Date()) {
  const readOnly = ['cancelled', 'completed', 'no_show'].includes(reservation.status)
  return {
    arrive: reservation.status === 'confirmed',
    call: true,
    cancel: reservation.status === 'confirmed' || reservation.status === 'arrived',
    edit: reservation.status === 'confirmed' || reservation.status === 'arrived',
    noShow: reservation.status === 'confirmed' && now.getTime() >= new Date(reservation.startsAt).getTime(),
    openOrder: reservation.status === 'seated' && Boolean(reservation.orderId),
    seat: reservation.status === 'confirmed' || reservation.status === 'arrived',
    viewOnly: readOnly || reservation.status === 'seated',
  }
}

export function reservationTimingLabel(reservation: Reservation, now = new Date()) {
  if (reservation.status === 'arrived') return 'Ha llegado'
  if (isReservationLate(reservation, now)) {
    const lateMinutes = Math.max(1, -minutesUntilReservation(reservation.startsAt, now))
    return `${formatReservationTimeDistance(lateMinutes)} tarde`
  }
  const minutes = minutesUntilReservation(reservation.startsAt, now)
  if (minutes >= 0) return `En ${formatReservationTimeDistance(minutes)}`
  return null
}
