import { AlertTriangle, ChevronRight, Clock3, Users } from 'lucide-react'
import { getReservationStatusLabel, isReservationLate, reservationTimingLabel } from '../domain/reservationStatus'
import type { Reservation } from '../types'

type Props = {
  onSelect: (reservation: Reservation) => void
  reservations: Reservation[]
  searchMode: boolean
}

const timeFormatter = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' })
const dateFormatter = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' })

export function ReservationList({ onSelect, reservations, searchMode }: Props) {
  if (!reservations.length) {
    return <div className="reservation-empty">No se han encontrado reservas.</div>
  }
  return (
    <div className="reservation-list" role="list">
      {reservations.map((reservation) => {
        const late = isReservationLate(reservation)
        const timing = reservationTimingLabel(reservation)
        return (
          <button
            className={`reservation-row status-${reservation.status}${late ? ' is-late' : ''}`}
            key={reservation.id}
            onClick={() => onSelect(reservation)}
            role="listitem"
            type="button"
          >
            <time>
              {timeFormatter.format(new Date(reservation.startsAt))}
              {searchMode ? <small>{dateFormatter.format(new Date(reservation.startsAt))}</small> : null}
            </time>
            <span className="reservation-row-main">
              <strong>{reservation.customerName}</strong>
              <small><Users aria-hidden="true" size={14} /> {reservation.partySize} {reservation.partySize === 1 ? 'persona' : 'personas'}</small>
              {reservation.notes ? <em>{reservation.notes}</em> : null}
            </span>
            <span className="reservation-row-table">
              <strong>{reservation.tables.length ? reservation.tables.map((table) => table.name).join(' · ') : 'Sin mesa'}</strong>
              <small className="reservation-phone">{reservation.customerPhone}</small>
            </span>
            <span className="reservation-row-state">
              <b>{getReservationStatusLabel(reservation.status)}</b>
              {timing && ['confirmed', 'arrived'].includes(reservation.status) ? <small className={late ? 'late' : ''}>
                {late ? <AlertTriangle aria-hidden="true" size={13} /> : <Clock3 aria-hidden="true" size={13} />}
                {timing}
              </small> : null}
            </span>
            <ChevronRight aria-hidden="true" size={18} />
          </button>
        )
      })}
    </div>
  )
}
