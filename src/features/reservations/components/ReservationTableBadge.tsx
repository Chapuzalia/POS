import { CalendarClock } from 'lucide-react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { RestaurantTableReservation } from '../../tables/types'
import { isReservationLate, minutesUntilReservation } from '../domain/reservationStatus'

type Props = {
  count?: number
  onClick: (event: MouseEvent<HTMLSpanElement>) => void
  reservation: RestaurantTableReservation
}

export function ReservationTableBadge({ count = 1, onClick, reservation }: Props) {
  const minutes = minutesUntilReservation(reservation.startsAt)
  const time = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' })
    .format(new Date(reservation.startsAt))
  const timing = reservation.status === 'arrived'
    ? 'Ha llegado'
    : isReservationLate(reservation)
      ? `${Math.max(1, -minutes)} min tarde`
      : minutes <= 15
        ? `${time} · ${Math.max(0, minutes)} min`
        : `${time} · ${reservation.customerName.split(' ')[0]}`
  return (
    <span
      aria-label={`Abrir reserva de ${reservation.customerName}`}
      className={`reservation-table-badge${minutes <= 60 ? ' soon' : ''}${minutes <= 15 || reservation.status === 'arrived' || isReservationLate(reservation) ? ' urgent' : ''}`}
      onClick={(event) => {
        event.stopPropagation()
        onClick(event)
      }}
      onPointerDown={(event) => event.stopPropagation()}
      role="button"
      tabIndex={0}
      onKeyDown={(event: KeyboardEvent<HTMLSpanElement>) => {
        if (event.key !== 'Enter' && event.key !== ' ') return
        event.preventDefault()
        event.currentTarget.click()
      }}
    >
      <CalendarClock aria-hidden="true" size={12} />
      <span>{timing}</span>
      {count > 1 ? <b>+{count - 1}</b> : null}
    </span>
  )
}
