import { Calendar } from 'lucide-react'
import type { KeyboardEvent, MouseEvent } from 'react'
import type { RestaurantTableReservation } from '../../tables/types'

type Props = {
  compact?: boolean
  count?: number
  onClick: (event: MouseEvent<HTMLSpanElement>) => void
  reservation: RestaurantTableReservation
}

export function ReservationTableBadge({ compact = false, count = 1, onClick, reservation }: Props) {
  const time = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' })
    .format(new Date(reservation.startsAt))

  return (
    <span
      aria-label={`Abrir reserva de ${reservation.customerName}`}
      className={compact
        ? "pointer-events-auto absolute right-0 top-0 z-10 inline-flex size-5 -translate-y-1/3 translate-x-1/3 items-center justify-center rounded-full border border-[color-mix(in_srgb,var(--accent)_45%,var(--separator))] bg-[var(--accent-soft)] p-0 text-[var(--accent)] shadow-sm"
        : "pointer-events-auto absolute bottom-0 left-1/2 z-10 inline-flex h-6 min-w-max -translate-x-1/2 translate-y-1/2 items-center gap-1 whitespace-nowrap rounded-full border border-[color-mix(in_srgb,var(--accent)_45%,var(--separator))] bg-[var(--accent-soft)] px-2 text-[10px] font-extrabold leading-none text-[var(--accent)] shadow-sm [&>b]:ml-0.5 [&>b]:rounded-full [&>b]:bg-[var(--surface)] [&>b]:px-1 [&>b]:py-0.5 [&>b]:text-[8px] [&>b]:font-black"}
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
      <Calendar aria-hidden="true" className="shrink-0" size={compact ? 11 : 12} />
      {compact ? null : <span>{time}</span>}
      {!compact && count > 1 ? <b>+{count - 1}</b> : null}
    </span>
  )
}
