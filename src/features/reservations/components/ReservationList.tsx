import { useState, type KeyboardEvent } from 'react'
import { AlertTriangle, ChevronDown, ChevronRight, Clock3, Users } from 'lucide-react'
import { getReservationStatusLabel, isReservationLate, reservationTimingLabel } from '../domain/reservationStatus'
import type { Reservation, ReservationStatus } from '../types'

type Props = {
  onSelect: (reservation: Reservation) => void
  reservations: Reservation[]
  searchMode: boolean
  selectedId: string | null
}

const archivedStatuses = new Set<ReservationStatus>(['cancelled', 'completed', 'no_show'])
const timeFormatter = new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' })
const dateFormatter = new Intl.DateTimeFormat('es', { day: 'numeric', month: 'short' })

function statusClass(status: ReservationStatus, late: boolean) {
  if (late) return 'bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] text-[var(--warning)]'
  if (status === 'arrived' || status === 'seated') return 'bg-[var(--success-soft)] text-[var(--success)]'
  if (status === 'cancelled' || status === 'no_show') return 'bg-[var(--danger-soft)] text-[var(--danger)]'
  if (status === 'completed') return 'bg-[var(--surface-secondary)] text-[var(--muted)]'
  return 'bg-[var(--accent-soft)] text-[var(--accent)]'
}

function ReservationRow({ onSelect, reservation, searchMode, selected }: {
  onSelect: (reservation: Reservation) => void
  reservation: Reservation
  searchMode: boolean
  selected: boolean
}) {
  const late = isReservationLate(reservation)
  const timing = reservationTimingLabel(reservation)
  const unassigned = ['confirmed', 'arrived'].includes(reservation.status) && reservation.tableIds.length === 0
  const tableNames = reservation.tables.length
    ? reservation.tables.map((table) => table.name).join(' · ')
    : 'Sin mesa asignada'
  const selectReservation = () => onSelect(reservation)
  const handleKeyDown = (event: KeyboardEvent<HTMLTableRowElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    selectReservation()
  }

  return (
    <tr
      aria-current={selected ? 'true' : undefined}
      className={`group cursor-pointer border-b border-[var(--separator)] text-[var(--foreground)] transition-colors last:border-b-0 hover:bg-[var(--surface-secondary)] focus-visible:bg-[var(--surface-secondary)] focus-visible:outline-2 focus-visible:outline-[var(--accent)] focus-visible:outline-offset-[-2px] max-[760px]:grid max-[760px]:grid-cols-[58px_minmax(0,1fr)_18px] max-[760px]:gap-x-2.5 max-[760px]:gap-y-1 max-[760px]:rounded-2xl max-[760px]:border max-[760px]:border-[var(--separator)] max-[760px]:bg-[var(--surface)] max-[760px]:p-3 max-[760px]:shadow-sm ${selected ? 'bg-[var(--accent-soft)] shadow-[inset_4px_0_var(--accent)]' : 'bg-[var(--surface)]'} ${late ? 'shadow-[inset_4px_0_var(--warning)]' : ''}`}
      onClick={selectReservation}
      onKeyDown={handleKeyDown}
      tabIndex={0}
    >
      <td className="w-[70px] px-4 py-3 align-middle max-[760px]:row-span-3 max-[760px]:w-auto max-[760px]:border-r max-[760px]:border-[var(--separator)] max-[760px]:p-0 max-[760px]:pr-2 max-[760px]:pt-0.5">
        <time className={`text-lg font-black ${late ? 'text-[var(--warning)]' : ''}`}>
          {timeFormatter.format(new Date(reservation.startsAt))}
          {searchMode ? <small className="mt-1 block text-[11px] font-bold capitalize text-[var(--muted)]">{dateFormatter.format(new Date(reservation.startsAt))}</small> : null}
        </time>
      </td>
      <td className="min-w-0 px-4 py-3 align-middle max-[760px]:col-start-2 max-[760px]:p-0">
        <div className="grid min-w-0 gap-0.5">
          <strong className="truncate">{reservation.customerName}</strong>
          <small className="flex items-center gap-1 text-xs text-[var(--muted)]">
            <Users aria-hidden="true" size={13} />
            {reservation.partySize} {reservation.partySize === 1 ? 'persona' : 'personas'}
            <span className="max-[480px]:hidden">· {reservation.customerPhone}</span>
          </small>
          {reservation.notes ? <em className="truncate text-[11px] not-italic text-[var(--muted)] max-[760px]:hidden">{reservation.notes}</em> : null}
        </div>
      </td>
      <td className="min-w-0 px-4 py-3 align-middle max-[760px]:col-start-2 max-[760px]:row-start-2 max-[760px]:p-0">
        <div className="grid min-w-0 gap-0.5">
          <strong className={`whitespace-normal break-words ${unassigned ? 'text-[var(--warning)]' : ''}`}>{tableNames}</strong>
          <small className="text-[11px] text-[var(--muted)] max-[760px]:hidden">{reservation.tables[0]?.areaName ?? 'Cualquier zona'}</small>
        </div>
      </td>
      <td className="min-w-0 px-4 py-3 align-middle max-[760px]:col-start-2 max-[760px]:row-start-3 max-[760px]:p-0">
        <div className="flex flex-wrap items-center gap-1">
          <b className={`inline-flex w-fit items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-extrabold ${statusClass(reservation.status, late)}`}>
            {late ? <AlertTriangle aria-hidden="true" size={12} /> : null}{getReservationStatusLabel(reservation.status)}
          </b>
          {timing && ['confirmed', 'arrived'].includes(reservation.status) ? (
            <small className={`flex items-center gap-1 text-xs font-semibold ${late ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}`}>
              {late ? <AlertTriangle aria-hidden="true" size={12} /> : <Clock3 aria-hidden="true" size={12} />}{timing}
            </small>
          ) : null}
        </div>
      </td>
      <td className="w-10 px-3 py-3 align-middle text-[var(--muted)] max-[760px]:col-start-3 max-[760px]:row-span-3 max-[760px]:row-start-1 max-[760px]:w-auto max-[760px]:self-center max-[760px]:p-0">
        <ChevronRight aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" size={18} />
      </td>
    </tr>
  )
}

export function ReservationList({ onSelect, reservations, searchMode, selectedId }: Props) {
  const [showArchived, setShowArchived] = useState(false)
  if (!reservations.length) {
    return <div className="grid min-h-[220px] flex-1 place-items-center rounded-2xl border border-dashed border-[var(--separator)] bg-[var(--surface)] px-5 text-center font-extrabold text-[var(--muted)]">No se han encontrado reservas con estos filtros.</div>
  }

  const active = reservations.filter((reservation) => !archivedStatuses.has(reservation.status))
  const archived = reservations.filter((reservation) => archivedStatuses.has(reservation.status))

  return (
    <div className="w-full min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-[var(--separator)] bg-[var(--surface)] shadow-sm [-webkit-overflow-scrolling:touch] max-[760px]:flex-none max-[760px]:overflow-visible max-[760px]:rounded-none max-[760px]:border-0 max-[760px]:bg-transparent max-[760px]:shadow-none">
      <table className="w-full table-fixed border-collapse max-[760px]:block">
        <colgroup className="max-[760px]:hidden">
          <col className="w-[70px]" />
          <col className="w-[38%]" />
          <col className="w-[28%]" />
          <col />
          <col className="w-10" />
        </colgroup>
        <thead className="bg-[var(--surface-secondary)] text-left text-[10px] font-black uppercase tracking-wider text-[var(--muted)] max-[760px]:hidden">
          <tr>
            <th className="px-4 py-2.5" scope="col">Hora</th>
            <th className="px-4 py-2.5" scope="col">Cliente</th>
            <th className="px-4 py-2.5" scope="col">Mesa / zona</th>
            <th className="px-4 py-2.5" scope="col">Estado</th>
            <th aria-label="Abrir reserva" scope="col" />
          </tr>
        </thead>
        <tbody className="max-[760px]:block max-[760px]:space-y-2">
          {active.map((reservation) => <ReservationRow key={reservation.id} onSelect={onSelect} reservation={reservation} searchMode={searchMode} selected={selectedId === reservation.id} />)}
          {!active.length ? <tr><td className="px-4 py-8 text-center text-sm font-bold text-[var(--muted)]" colSpan={5}>No hay reservas activas.</td></tr> : null}
          {archived.length ? (
            <tr className="max-[760px]:block">
              <td className="p-0 max-[760px]:block" colSpan={5}>
                <button
                  aria-expanded={showArchived}
                  className="flex min-h-11 w-full items-center justify-between border-0 border-y border-[var(--separator)] bg-[var(--surface-secondary)] px-4 text-left text-xs font-black uppercase tracking-wider text-[var(--muted)] max-[760px]:rounded-xl max-[760px]:border"
                  onClick={() => setShowArchived((current) => !current)}
                  type="button"
                >
                  Historial del día · {archived.length}
                  <ChevronDown className={`transition-transform ${showArchived ? 'rotate-180' : ''}`} size={17} />
                </button>
              </td>
            </tr>
          ) : null}
          {showArchived ? archived.map((reservation) => <ReservationRow key={reservation.id} onSelect={onSelect} reservation={reservation} searchMode={searchMode} selected={selectedId === reservation.id} />) : null}
        </tbody>
      </table>
    </div>
  )
}
