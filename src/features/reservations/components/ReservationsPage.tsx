import { useMemo, useState } from 'react'
import { Button as UiButton } from '../../../components/ui/Button'
import { Input as UiInput } from '../../../components/ui/Input'
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  List,
  Map as MapIcon,
  RefreshCw,
  Search,
} from 'lucide-react'
import { shiftDateKey } from '../domain/reservationAvailability'
import { isReservationLate } from '../domain/reservationStatus'
import type { useReservationsController } from '../hooks/useReservationsController'
import type { Reservation, ReservationTable } from '../types'
import { ReservationDetailPanel } from './ReservationDetailPanel'
import { ReservationFormModal } from './ReservationFormModal'
import { ReservationList } from './ReservationList'
import { ReservationMapView } from './ReservationMapView'

type Controller = ReturnType<typeof useReservationsController>
type ReservationFilter = 'all' | 'upcoming' | 'arrived' | 'late' | 'unassigned'

type Props = {
  controller: Controller
  isOnline: boolean
  onOpenOrder: (orderId: string) => void
}

function matchesFilter(reservation: Reservation, filter: ReservationFilter) {
  if (filter === 'arrived') return reservation.status === 'arrived'
  if (filter === 'late') return isReservationLate(reservation)
  if (filter === 'unassigned') {
    return ['confirmed', 'arrived'].includes(reservation.status) && reservation.tableIds.length === 0
  }
  if (filter === 'upcoming') {
    return reservation.status === 'confirmed' && new Date(reservation.endsAt) > new Date()
  }
  return true
}

export function ReservationsPage({ controller, isOnline, onOpenOrder }: Props) {
  const [filter, setFilter] = useState<ReservationFilter>('all')
  const [areaId, setAreaId] = useState('all')
  const searching = Boolean(controller.query.trim())
  const displayed = useMemo(() => {
    const source = searching ? controller.searchResults : controller.reservations
    return source.filter((reservation) => (
      matchesFilter(reservation, filter)
      && (areaId === 'all' || reservation.tables.some((table) => table.areaId === areaId))
    ))
  }, [areaId, controller.reservations, controller.searchResults, filter, searching])
  const formattedDate = new Intl.DateTimeFormat('es', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
    timeZone: controller.timeZone,
  }).format(new Date(`${controller.date}T12:00:00Z`))
  const areaNames = new Map(controller.map.areas.map((area) => [area.id, area.name]))
  const tables: ReservationTable[] = controller.map.tables.map((table) => ({
    id: table.id,
    name: table.name,
    capacity: table.capacity,
    areaId: table.areaId,
    areaName: areaNames.get(table.areaId) ?? 'Sin zona',
    sortOrder: table.sortOrder,
    isActive: table.isActive,
  }))
  const filters: Array<{ id: ReservationFilter; label: string; count?: number; urgent?: boolean }> = [
    { id: 'all', label: 'Todas', count: controller.reservations.length },
    { id: 'upcoming', label: 'Próximas', count: controller.summary.upcoming },
    { id: 'arrived', label: 'Han llegado', count: controller.summary.arrived },
    { id: 'late', label: 'Retrasadas', count: controller.summary.late, urgent: controller.summary.late > 0 },
    { id: 'unassigned', label: 'Sin mesa', count: controller.summary.unassigned, urgent: controller.summary.unassigned > 0 },
  ]

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overscroll-contain p-3 [-webkit-overflow-scrolling:touch] sm:p-4 max-[760px]:gap-0 max-[760px]:bg-[var(--background)] max-[760px]:p-0">
      <header className="flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-3 shadow-sm max-[760px]:items-stretch max-[760px]:gap-2 max-[760px]:rounded-none max-[760px]:border-x-0 max-[760px]:border-t-0 max-[760px]:shadow-none">
        <div className="flex min-w-0 items-center gap-2 max-[760px]:flex-1">
          <UiButton
            aria-label="Volver al POS"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 font-extrabold text-[var(--foreground)] disabled:opacity-45"
            onClick={controller.close}
            type="button"
          >
            <ArrowLeft size={18} /> <span className="max-[520px]:sr-only">Volver</span>
          </UiButton>
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-black sm:text-2xl">Reservas</h1>
            <p className="m-0 truncate text-xs font-semibold capitalize text-[var(--muted)]">{controller.date === controller.today ? `Hoy · ${formattedDate}` : formattedDate}</p>
          </div>
        </div>

        <div className="order-3 flex min-h-11 items-center overflow-hidden rounded-xl border border-[var(--separator)] bg-[var(--surface-secondary)] min-[761px]:order-none min-[761px]:ml-auto max-[760px]:w-full">
          <UiButton aria-label="Fecha anterior" className="grid size-11 place-items-center text-[var(--foreground)]" onClick={() => controller.setDate(shiftDateKey(controller.date, -1))} type="button">
            <ChevronLeft size={18} />
          </UiButton>
          <label className="flex min-h-11 items-center gap-2 border-x border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-bold text-[var(--foreground)] max-[760px]:flex-1 max-[760px]:justify-center">
            <CalendarDays aria-hidden="true" size={17} />
            <span className="sr-only">Ir a una fecha</span>
            <input
              aria-label="Fecha de las reservas"
              className="w-[118px] bg-transparent text-sm font-bold text-[var(--foreground)] outline-none"
              onChange={(event) => event.target.value && controller.setDate(event.target.value)}
              type="date"
              value={controller.date}
            />
          </label>
          <UiButton aria-label="Fecha siguiente" className="grid size-11 place-items-center text-[var(--foreground)]" onClick={() => controller.setDate(shiftDateKey(controller.date, 1))} type="button">
            <ChevronRight size={18} />
          </UiButton>
        </div>

        {controller.date !== controller.today ? (
          <UiButton className="order-3 min-h-11 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-extrabold text-[var(--foreground)] min-[761px]:order-none" onClick={() => controller.setDate(controller.today)} type="button">
            Hoy
          </UiButton>
        ) : null}

        {controller.canManage ? (
          <UiButton
            className="ml-auto inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45 max-[760px]:ml-0"
            disabled={!isOnline}
            onClick={() => controller.openCreate()}
            type="button"
          >
            <CalendarPlus size={18} /><span className="max-[480px]:hidden">Nueva reserva</span><span className="min-[481px]:hidden">Nueva</span>
          </UiButton>
        ) : null}
      </header>

      {!isOnline ? (
        <div className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-2.5 text-sm font-bold text-[var(--warning)]" role="status">
          Sin conexión. Puedes consultar las reservas ya cargadas, pero las acciones están deshabilitadas.
        </div>
      ) : null}

      <section aria-label="Filtros de reservas" className="flex gap-2 overflow-x-auto overscroll-x-contain pb-0.5 [-webkit-overflow-scrolling:touch] max-[760px]:px-3 max-[760px]:pt-3">
        {filters.map((item) => (
          <UiButton
            aria-pressed={filter === item.id}
            className={`inline-flex min-h-10 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-extrabold transition-colors max-[760px]:min-h-11 ${filter === item.id ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]' : item.urgent ? 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] text-[var(--warning)]' : 'border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)]'}`}
            key={item.id}
            onClick={() => setFilter(item.id)}
            type="button"
          >
            {item.label}<span className={`rounded-md px-1.5 py-0.5 text-xs ${filter === item.id ? 'bg-white/20' : 'bg-[var(--surface-secondary)]'}`}>{item.count ?? 0}</span>
          </UiButton>
        ))}
      </section>

      <section aria-label="Herramientas de reservas" className="flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-2 shadow-sm max-[760px]:m-3 max-[760px]:mb-0 max-[760px]:rounded-xl max-[760px]:shadow-none">
        <label className="flex min-h-11 min-w-[240px] flex-1 items-center gap-2 rounded-xl bg-[var(--surface-secondary)] px-3 text-[var(--muted)] focus-within:ring-2 focus-within:ring-[var(--accent)] max-[760px]:w-full max-[760px]:basis-full">
          <Search aria-hidden="true" size={18} />
          <span className="sr-only">Buscar reservas</span>
          <UiInput
            className="min-w-0 flex-1 !bg-transparent !p-0 !text-[var(--foreground)]"
            onChange={(event) => {
              controller.setQuery(event.target.value)
              if (event.target.value) {
                setFilter('all')
                setAreaId('all')
              }
            }}
            placeholder="Nombre, teléfono o mesa"
            value={controller.query}
          />
          {searching ? <small className="whitespace-nowrap text-[11px] font-bold max-[620px]:hidden">Todas las fechas</small> : null}
        </label>

        <select
          aria-label="Filtrar por zona"
          className="min-h-11 max-w-[170px] rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-bold text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)] max-[760px]:min-w-0 max-[760px]:flex-1 max-[760px]:max-w-none"
          onChange={(event) => setAreaId(event.target.value)}
          value={areaId}
        >
          <option value="all">Todas las zonas</option>
          {controller.map.areas.map((area) => <option key={area.id} value={area.id}>{area.name}</option>)}
        </select>

        <div aria-label="Vista" className="flex min-h-11 items-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] p-1">
          <UiButton aria-label="Vista de lista" aria-pressed={controller.view === 'list'} className={`grid size-9 place-items-center rounded-lg ${controller.view === 'list' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} onClick={() => controller.setView('list')} type="button"><List size={18} /></UiButton>
          <UiButton aria-label="Vista de mapa" aria-pressed={controller.view === 'map'} className={`grid size-9 place-items-center rounded-lg ${controller.view === 'map' ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--muted)]'}`} onClick={() => controller.setView('map')} type="button"><MapIcon size={18} /></UiButton>
        </div>
        <UiButton aria-label="Actualizar reservas" className="grid size-11 place-items-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] text-[var(--muted)] disabled:opacity-45" disabled={!isOnline || controller.isLoading} onClick={() => void controller.refresh()} type="button">
          <RefreshCw className={controller.isLoading ? 'animate-spin' : ''} size={18} />
        </UiButton>
      </section>

      <section className="flex min-h-[420px] flex-1 gap-3 max-[760px]:min-h-0 max-[760px]:flex-none max-[760px]:p-3">
        {controller.view === 'list' ? (
          <ReservationList
            onSelect={controller.openDetail}
            reservations={displayed}
            searchMode={searching}
            selectedId={controller.detail?.id ?? null}
          />
        ) : (
          <ReservationMapView
            date={controller.date}
            map={controller.map}
            onCreate={controller.openCreate}
            onSelectReservation={controller.openDetail}
            reservations={displayed}
          />
        )}
        {controller.detail ? (
          <ReservationDetailPanel
            canManage={controller.canManage}
            disabled={!isOnline || controller.isLoading}
            onClose={() => controller.setDetail(null)}
            onEdit={() => controller.openEdit(controller.detail!)}
            onOpenOrder={(orderId) => {
              controller.close()
              onOpenOrder(orderId)
            }}
            onSeat={() => void controller.seat(controller.detail!)}
            onStatus={(status, reason) => void controller.updateStatus(controller.detail!, status, reason)}
            reservation={controller.detail}
          />
        ) : null}
      </section>

      {controller.editor ? (
        <ReservationFormModal
          conflicts={controller.conflicts}
          date={controller.date}
          disabled={!isOnline || controller.isLoading}
          onClose={() => controller.setEditor(null)}
          onSave={controller.save}
          onTableIdsChange={controller.setSelectedTableIds}
          preselectedTableIds={controller.editor.preselectedTableIds}
          reservation={controller.editor.reservation}
          tables={tables}
          timeZone={controller.timeZone}
        />
      ) : null}
    </main>
  )
}
