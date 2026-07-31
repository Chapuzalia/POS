import { Button as UiButton } from '../../../components/ui/Button'
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
    return <div className="grid min-h-[220px] flex-1 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] font-extrabold text-[var(--muted)]">No se han encontrado reservas.</div>
  }
  return (
    <div className="min-w-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]" role="list">
      {reservations.map((reservation) => {
        const late = isReservationLate(reservation)
        const timing = reservationTimingLabel(reservation)
        return (
          <UiButton
            className={`grid min-h-[82px] w-full grid-cols-[78px_minmax(190px,1.2fr)_minmax(150px,0.8fr)_minmax(140px,0.7fr)_24px] items-center gap-3.5 border-0 border-b border-[var(--separator)] bg-[var(--surface)] px-4 py-3 text-left text-[var(--foreground)] last:border-b-0 hover:bg-[var(--surface-secondary)] focus-visible:bg-[var(--surface-secondary)] max-[760px]:grid-cols-[58px_minmax(0,1fr)_20px] max-[760px]:gap-2.5 [&>time]:text-lg [&>time]:font-black [&>time>small]:mt-1 [&>time>small]:block [&>time>small]:text-[11px] [&>time>small]:capitalize [&>time>small]:text-[var(--muted)] ${late ? 'shadow-[inset_4px_0_var(--warning)]' : ''} ${['cancelled', 'completed', 'no_show'].includes(reservation.status) ? 'opacity-60' : ''}`}
            key={reservation.id}
            onClick={() => onSelect(reservation)}
            role="listitem"
            type="button"
          >
            <time>
              {timeFormatter.format(new Date(reservation.startsAt))}
              {searchMode ? <small>{dateFormatter.format(new Date(reservation.startsAt))}</small> : null}
            </time>
            <span className="grid min-w-0 gap-1 [&>strong]:truncate [&>small]:flex [&>small]:items-center [&>small]:gap-1 [&>small]:text-xs [&>small]:text-[var(--muted)] [&>em]:truncate [&>em]:text-[11px] [&>em]:not-italic [&>em]:text-[var(--muted)]">
              <strong>{reservation.customerName}</strong>
              <small><Users aria-hidden="true" size={14} /> {reservation.partySize} {reservation.partySize === 1 ? 'persona' : 'personas'}</small>
              {reservation.notes ? <em>{reservation.notes}</em> : null}
            </span>
            <span className="grid min-w-0 gap-1 max-[760px]:col-start-2 [&>strong]:truncate [&>small]:flex [&>small]:items-center [&>small]:gap-1 [&>small]:text-xs [&>small]:text-[var(--muted)]">
              <strong>{reservation.tables.length ? reservation.tables.map((table) => table.name).join(' · ') : 'Sin mesa'}</strong>
              <small className="max-[760px]:!hidden">{reservation.customerPhone}</small>
            </span>
            <span className="grid min-w-0 gap-1 max-[760px]:col-start-2 max-[760px]:flex max-[760px]:flex-wrap [&>b]:inline-flex [&>b]:w-fit [&>b]:items-center [&>b]:rounded-full [&>b]:bg-[var(--accent-soft)] [&>b]:px-[9px] [&>b]:py-1 [&>b]:text-[11px] [&>b]:font-extrabold [&>small]:flex [&>small]:items-center [&>small]:gap-1 [&>small]:text-xs [&>small]:text-[var(--muted)]">
              <b>{getReservationStatusLabel(reservation.status)}</b>
              {timing && ['confirmed', 'arrived'].includes(reservation.status) ? <small className={late ? 'text-[var(--warning)]' : ''}>
                {late ? <AlertTriangle aria-hidden="true" size={13} /> : <Clock3 aria-hidden="true" size={13} />}
                {timing}
              </small> : null}
            </span>
            <ChevronRight aria-hidden="true" size={18} />
          </UiButton>
        )
      })}
    </div>
  )
}
