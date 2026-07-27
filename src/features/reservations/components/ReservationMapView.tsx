import { Button as UiButton } from '../../../components/ui/Button'
import { CalendarPlus, Users } from 'lucide-react'
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
}

export function ReservationMapView(props: Props) {
  const [areaId, setAreaId] = useState(props.map.areas[0]?.id)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLElement>(null)
  const area = props.map.areas.find((candidate) => candidate.id === areaId) ?? props.map.areas[0]
  const sourceTables = props.map.operationalMap?.tables ?? props.map.tables
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

  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2.5">
      <nav aria-label="Zonas" className="flex gap-2 overflow-x-auto pb-0.5 [&>button]:min-h-[42px] [&>button]:whitespace-nowrap [&>button]:rounded-full [&>button]:border [&>button]:border-[var(--separator)] [&>button]:bg-[var(--surface)] [&>button]:px-[18px] [&>button]:font-extrabold [&>button]:text-[var(--foreground)]">
        {props.map.areas.map((candidate) => <UiButton className={candidate.id === area?.id ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]' : ''} key={candidate.id} onClick={() => {
          setAreaId(candidate.id)
          setSelectedTableId(null)
        }} type="button">{candidate.name}</UiButton>)}
      </nav>
      <div className="flex min-h-[450px] flex-1 gap-3 max-[760px]:flex-col">
        <section
          className="relative min-h-[450px] flex-1 touch-none cursor-grab overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[radial-gradient(var(--separator)_1px,transparent_1px)] bg-[length:22px_22px] bg-[var(--surface-secondary)] shadow-[var(--shadow)] active:cursor-grabbing max-[760px]:min-h-[420px]"
          onPointerDown={viewportApi.startBackgroundPointer}
          onPointerMove={viewportApi.moveBackgroundPointer}
          onPointerUp={viewportApi.endBackgroundPointer}
          onPointerCancel={viewportApi.endBackgroundPointer}
          onWheel={viewportApi.onWheel}
          ref={canvasRef}
        >
          <div className="absolute z-[2]" style={{ width: planeSize.width * viewport.zoom, height: planeSize.height * viewport.zoom, left: viewport.panX, top: viewport.panY }}>
            {tables.map((table) => {
              const tableReservations = props.reservations.filter((reservation) => reservation.tableIds.includes(table.id))
              const next = getNextReservationForTable(tableReservations, table.id, new Date(0))
              const operational = table as RestaurantTableMapItem
              const primary = next?.tables[0]?.id === table.id
              return <UiButton
                className={`absolute flex min-h-[60px] min-w-[70px] flex-col items-center justify-center gap-[3px] overflow-hidden border-2 border-[var(--separator)] bg-[var(--surface)] p-1.5 text-[var(--foreground)] shadow-[0_5px_14px_rgba(17,24,39,0.11)] [&>strong]:truncate [&>span]:truncate [&>small]:truncate [&>em]:truncate [&>small]:flex [&>small]:items-center [&>small]:gap-[3px] [&>small]:text-[var(--muted)] [&>span]:flex [&>span]:items-center [&>span]:gap-1 [&>span]:rounded-[5px] [&>span]:bg-[color-mix(in_srgb,var(--warning)_13%,var(--surface))] [&>span]:px-[5px] [&>span]:py-[3px] [&>span]:text-[10px] [&>span]:font-extrabold [&>em]:text-[9px] [&>em]:not-italic [&>em]:font-extrabold [&>em]:text-[var(--danger)] ${table.shape === 'round' ? 'rounded-full' : table.shape === 'square' ? 'rounded-[10px]' : 'rounded-[7px]'} ${selectedTableId === table.id ? 'outline-[4px] outline-[color-mix(in_srgb,var(--accent)_35%,transparent)]' : ''} ${props.map.operationalMap && operational.status === 'occupied' ? 'border-[var(--danger)]' : ''}`}
                key={table.id}
                onClick={() => setSelectedTableId(table.id)}
                style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }}
                type="button"
              >
                <strong>{table.name}</strong>
                <small><Users size={13} /> {table.capacity}</small>
                {next ? <span>{primary ? `${new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(next.startsAt))} · ${next.customerName.split(' ')[0]}` : 'Vinculada'}{tableReservations.length > 1 ? <b>+{tableReservations.length - 1}</b> : null}</span> : null}
                {props.map.operationalMap && operational.status === 'occupied' ? <em>Ocupada ahora</em> : null}
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
        <aside className="w-[280px] overflow-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 max-[1000px]:w-60 max-[760px]:max-h-[220px] max-[760px]:w-full [&>header]:flex [&>header]:items-center [&>header]:justify-between [&>header]:gap-2 [&>header]:border-b [&>header]:border-[var(--separator)] [&>header]:pb-2.5 [&_h3]:m-0 [&_p]:m-0 [&_p]:text-xs [&_p]:text-[var(--muted)] [&>header_span]:text-xs [&>header_span]:text-[var(--muted)] [&>button]:grid [&>button]:w-full [&>button]:grid-cols-[56px_1fr] [&>button]:gap-2 [&>button]:border-0 [&>button]:border-b [&>button]:border-[var(--separator)] [&>button]:bg-transparent [&>button]:px-1 [&>button]:py-3 [&>button]:text-left [&>button]:text-[var(--foreground)] [&>button_time]:font-black [&>button_span]:grid [&>button_span]:gap-[3px] [&>button_small]:text-[var(--muted)]">
          {selectedTableId ? <>
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
