import { Button as UiButton } from '../../../components/ui/Button'
import { CalendarPlus, Check, Users, X } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import type { RestaurantTableMapItem } from '../../tables/types'
import { MapViewportControls } from '../../tables/components/MapViewportControls'
import { useMapViewport } from '../../tables/useMapViewport'
import { getMapPlaneSize } from '../../tables/viewport'
import { getNextReservationForTable } from '../domain/reservationAvailability'
import type { Reservation, ReservationMap } from '../types'

type Props = {
  date: string
  map: ReservationMap
  onCreate: (tableIds: string[]) => void
  onSelectReservation: (reservation: Reservation) => void
  reservations: Reservation[]
  selection?: {
    conflictTableIds: string[]
    disabled: boolean
    onChange: (tableIds: string[]) => void
    selectedTableIds: string[]
  }
}

export function ReservationMapView(props: Props) {
  const [areaId, setAreaId] = useState(props.map.areas[0]?.id)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLElement>(null)
  const area = props.map.areas.find((candidate) => candidate.id === areaId) ?? props.map.areas[0]
  const sourceTables = props.selection ? props.map.tables : props.map.operationalMap?.tables ?? props.map.tables
  const tables = sourceTables.filter((table) => table.areaId === area?.id)
  const viewportApi = useMapViewport(`reservation-map:${props.date}:${area?.id ?? 'default'}`)
  const viewport = viewportApi.viewport
  const planeSize = getMapPlaneSize(
    canvasRef.current?.clientWidth ?? 1200,
    canvasRef.current?.clientHeight ?? 700,
    area?.canvasWidth ?? 1200,
    area?.canvasHeight ?? 800,
  )
  const selectedReservations = useMemo(() => props.reservations
    .filter((reservation) => selectedTableId && reservation.tableIds.includes(selectedTableId))
    .sort((first, second) => new Date(first.startsAt).getTime() - new Date(second.startsAt).getTime()), [props.reservations, selectedTableId])
  const selectedTables = useMemo(() => props.map.tables.filter((table) => (
    props.selection?.selectedTableIds.includes(table.id)
  )), [props.map.tables, props.selection?.selectedTableIds])
  const conflictTableIds = new Set(props.selection?.conflictTableIds ?? [])

  function selectTable(tableId: string) {
    setSelectedTableId(tableId)
    if (!props.selection) return
    const next = props.selection.selectedTableIds.includes(tableId)
      ? props.selection.selectedTableIds.filter((id) => id !== tableId)
      : [...props.selection.selectedTableIds, tableId]
    props.selection.onChange(next)
  }

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <nav aria-label="Zonas" className="flex gap-2 overflow-x-auto pb-0.5 [&>button]:min-h-[42px] [&>button]:whitespace-nowrap [&>button]:rounded-full [&>button]:border [&>button]:border-[var(--separator)] [&>button]:bg-[var(--surface)] [&>button]:px-[18px] [&>button]:font-extrabold [&>button]:text-[var(--foreground)]">
        {props.map.areas.map((candidate) => <UiButton className={candidate.id === area?.id ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]' : ''} key={candidate.id} onClick={() => {
          setAreaId(candidate.id)
          setSelectedTableId(null)
        }} type="button">{candidate.name}</UiButton>)}
      </nav>
      <div className="flex min-h-112 flex-1 gap-3 max-md:flex-col">
        <section
          className="relative min-h-105 flex-1 touch-none cursor-grab overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[radial-gradient(var(--separator)_1px,transparent_1px)] bg-[length:22px_22px] bg-[var(--surface-secondary)] shadow-[var(--shadow)] active:cursor-grabbing md:min-h-112"
          onPointerDown={viewportApi.startBackgroundPointer}
          onPointerMove={viewportApi.moveBackgroundPointer}
          onPointerUp={viewportApi.endBackgroundPointer}
          onPointerCancel={viewportApi.endBackgroundPointer}
          onWheel={viewportApi.onWheel}
          ref={canvasRef}
        >
          <div className="map-transform-layer absolute z-[2]" style={{ width: planeSize.width * viewport.zoom, height: planeSize.height * viewport.zoom, left: viewport.panX, top: viewport.panY }}>
            {tables.map((table) => {
              const tableReservations = props.reservations.filter((reservation) => reservation.tableIds.includes(table.id))
              const next = getNextReservationForTable(tableReservations, table.id, new Date(0))
              const operational = table as RestaurantTableMapItem
              const primary = next?.tables[0]?.id === table.id
              const selected = props.selection?.selectedTableIds.includes(table.id) ?? selectedTableId === table.id
              const conflict = conflictTableIds.has(table.id)
              return <UiButton
                aria-pressed={props.selection ? selected : undefined}
                className={`absolute flex min-h-15 min-w-18 flex-col items-center justify-center gap-1 overflow-hidden border-2 border-[var(--separator)] bg-[var(--surface)] p-1.5 text-[var(--foreground)] shadow-[0_5px_14px_rgba(17,24,39,0.11)] disabled:opacity-40 [&>strong]:truncate [&>span]:truncate [&>small]:truncate [&>em]:truncate [&>small]:flex [&>small]:items-center [&>small]:gap-1 [&>small]:text-[var(--muted)] [&>span]:flex [&>span]:items-center [&>span]:gap-1 [&>span]:rounded-md [&>span]:bg-[color-mix(in_srgb,var(--warning)_13%,var(--surface))] [&>span]:px-1.5 [&>span]:py-1 [&>span]:text-[10px] [&>span]:font-extrabold [&>em]:text-[9px] [&>em]:not-italic [&>em]:font-extrabold [&>em]:text-[var(--danger)] ${table.shape === 'round' ? 'rounded-full' : table.shape === 'square' ? 'rounded-xl' : 'rounded-lg'} ${selected ? 'outline-4 outline-[color-mix(in_srgb,var(--accent)_35%,transparent)]' : ''} ${conflict ? 'border-[var(--warning)]' : ''} ${!props.selection && props.map.operationalMap && operational.status === 'occupied' ? 'border-[var(--danger)]' : ''}`}
                disabled={props.selection?.disabled || !table.isActive}
                key={table.id}
                onClick={() => selectTable(table.id)}
                style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }}
                type="button"
              >
                <strong className="flex items-center gap-1">{selected && props.selection ? <Check size={13} /> : null}{table.name}</strong>
                <small><Users size={13} /> {table.capacity}</small>
                {next ? <span>{primary ? `${new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(next.startsAt))} · ${next.customerName.split(' ')[0]}` : 'Vinculada'}{tableReservations.length > 1 ? <b>+{tableReservations.length - 1}</b> : null}</span> : null}
                {conflict ? <em>Conflicto</em> : null}
                {!props.selection && props.map.operationalMap && operational.status === 'occupied' ? <em>Ocupada ahora</em> : null}
              </UiButton>
            })}
          </div>
          {!tables.length ? <div className="absolute inset-0 grid place-items-center font-extrabold text-[var(--muted)]">No hay mesas activas en esta zona.</div> : null}
          <MapViewportControls
            onFit={() => canvasRef.current && viewportApi.fit(canvasRef.current, tables, planeSize)}
            onReset={() => viewportApi.setViewport({ zoom: 1, panX: 0, panY: 0 })}
            onZoomIn={() => canvasRef.current && viewportApi.zoomBy(1.2, canvasRef.current)}
            onZoomOut={() => canvasRef.current && viewportApi.zoomBy(1 / 1.2, canvasRef.current)}
            zoom={viewport.zoom}
          />
        </section>
        <aside className="w-full max-h-56 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 md:max-h-none md:w-60 lg:w-72 [&>header]:flex [&>header]:items-center [&>header]:justify-between [&>header]:gap-2 [&>header]:border-b [&>header]:border-[var(--separator)] [&>header]:pb-2.5 [&_h3]:m-0 [&_p]:m-0 [&_p]:text-xs [&_p]:text-[var(--muted)] [&>header_span]:text-xs [&>header_span]:text-[var(--muted)] [&>button]:grid [&>button]:w-full [&>button]:grid-cols-[3.5rem_1fr] [&>button]:gap-2 [&>button]:border-0 [&>button]:border-b [&>button]:border-[var(--separator)] [&>button]:bg-transparent [&>button]:px-1 [&>button]:py-3 [&>button]:text-left [&>button]:text-[var(--foreground)] [&>button_time]:font-black [&>button_span]:grid [&>button_span]:gap-1 [&>button_small]:text-[var(--muted)]">
          {props.selection ? <>
            <header>
              <div><h3>Mesas seleccionadas</h3><span>{selectedTables.length} elegidas</span></div>
            </header>
            {selectedTables.length ? selectedTables.map((table) => (
              <UiButton aria-label={`Quitar ${table.name}`} disabled={props.selection?.disabled} key={table.id} onClick={() => selectTable(table.id)} type="button">
                <span><strong>{table.name}</strong><small>{props.map.areas.find((candidate) => candidate.id === table.areaId)?.name ?? "Sin zona"} · {table.capacity} plazas</small></span>
                <X aria-hidden="true" size={16} />
              </UiButton>
            )) : <p>Pulsa una o varias mesas del plano para reservarlas.</p>}
          </> : selectedTableId ? <>
            <header>
              <div><h3>{tables.find((table) => table.id === selectedTableId)?.name}</h3><span>{selectedReservations.length} reservas</span></div>
              <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45" onClick={() => props.onCreate([selectedTableId])} type="button"><CalendarPlus /> Nueva</UiButton>
            </header>
            {selectedReservations.map((reservation) => <UiButton key={reservation.id} onClick={() => props.onSelectReservation(reservation)} type="button">
              <time>{new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(reservation.startsAt))}</time>
              <span><strong>{reservation.customerName}</strong><small>{reservation.partySize} personas</small></span>
            </UiButton>)}
            {!selectedReservations.length ? <p>Esta mesa no tiene reservas para la fecha seleccionada.</p> : null}
          </> : <p>Selecciona una mesa para consultar sus reservas o crear una nueva.</p>}
        </aside>
      </div>
    </div>
  )
}
