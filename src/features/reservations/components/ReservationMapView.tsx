import { Button as UiButton } from '../../../components/ui/Button'
import { Armchair, CalendarPlus, Check, CircleCheck, ShieldAlert, Users, X } from 'lucide-react'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
    hasActiveConflicts: boolean
    onChange: (tableIds: string[]) => void
    partySize: number
    selectedCapacity: number
    selectedTableIds: string[]
  }
}

export function ReservationMapView(props: Props) {
  const [areaId, setAreaId] = useState(props.map.areas[0]?.id)
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const canvasRef = useRef<HTMLElement>(null)
  const area = props.map.areas.find((candidate) => candidate.id === areaId) ?? props.map.areas[0]
  const sourceTables = props.selection ? props.map.tables : props.map.operationalMap?.tables ?? props.map.tables
  const tables = useMemo(() => sourceTables.filter((table) => table.areaId === area?.id), [area?.id, sourceTables])
  const mapElements = useMemo(() => area?.mapElements ?? [], [area?.mapElements])
  const fittedItems = useMemo(() => [...tables, ...mapElements], [mapElements, tables])
  const viewportApi = useMapViewport(`reservation-map:${props.date}:${area?.id ?? 'default'}`)
  const viewport = viewportApi.viewport
  const fitViewport = viewportApi.fit
  const autoFit = Boolean(props.selection)
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
  const capacityInsufficient = Boolean(
    props.selection?.selectedTableIds.length
      && props.selection.selectedCapacity < props.selection.partySize,
  )
  const conflictTableIds = new Set(props.selection?.conflictTableIds ?? [])
  const fitSelectionToCanvas = useCallback(() => {
    const canvas = canvasRef.current
    if (!autoFit || !canvas || !fittedItems.length) return
    const fittedPlaneSize = getMapPlaneSize(
      canvas.clientWidth,
      canvas.clientHeight,
      area?.canvasWidth ?? 1200,
      area?.canvasHeight ?? 800,
    )
    fitViewport(canvas, fittedItems, fittedPlaneSize)
  }, [area?.canvasHeight, area?.canvasWidth, autoFit, fitViewport, fittedItems])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!autoFit || !canvas) return
    fitSelectionToCanvas()
    let animationFrame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(fitSelectionToCanvas)
    })
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(animationFrame)
      observer.disconnect()
    }
  }, [autoFit, fitSelectionToCanvas])

  function selectTable(tableId: string) {
    setSelectedTableId(tableId)
    if (!props.selection) return
    const next = props.selection.selectedTableIds.includes(tableId)
      ? props.selection.selectedTableIds.filter((id) => id !== tableId)
      : [...props.selection.selectedTableIds, tableId]
    props.selection.onChange(next)
  }

  return (
    <div className={`flex min-h-0 min-w-0 flex-1 gap-3 ${props.selection ? 'max-md:flex-col' : 'flex-col'}`}>
      <nav
        aria-label="Zonas"
        className={`flex shrink-0 gap-2 [&>button]:shrink-0 [&>button]:border [&>button]:border-[var(--separator)] [&>button]:bg-[var(--surface)] [&>button]:font-extrabold [&>button]:text-[var(--foreground)] ${props.selection ? 'overflow-x-auto rounded-xl border border-[var(--separator)] bg-[var(--surface)] p-2 max-md:w-full max-md:border-0 max-md:bg-transparent max-md:p-0 md:w-19 md:flex-col md:overflow-hidden [&>button]:min-h-15 [&>button]:w-full [&>button]:min-w-0 [&>button]:flex-col [&>button]:gap-1 [&>button]:overflow-hidden [&>button]:rounded-xl [&>button]:px-1 [&>button]:text-xs' : 'overflow-x-auto pb-0.5 [&>button]:min-h-[42px] [&>button]:whitespace-nowrap [&>button]:rounded-full [&>button]:px-[18px]'}`}
      >
        {props.selection ? (
          <span className="px-1 pb-1 pt-0.5 text-center text-[10px] font-black uppercase tracking-wider text-[var(--muted)] max-md:hidden">
            Zonas
          </span>
        ) : null}
        {props.map.areas.map((candidate) => <UiButton className={candidate.id === area?.id ? 'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]' : ''} key={candidate.id} onClick={() => {
          setAreaId(candidate.id)
          setSelectedTableId(null)
        }} type="button">
          {props.selection ? <Armchair aria-hidden="true" size={17} /> : null}
          <span className={props.selection ? 'max-w-full truncate' : undefined}>{candidate.name}</span>
        </UiButton>)}
      </nav>
      <div className={`flex min-w-0 flex-1 gap-3 max-md:flex-col ${props.selection ? 'min-h-112 md:min-h-0' : 'min-h-112'}`}>
        <section
          className={`relative flex-1 overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[radial-gradient(var(--separator)_1px,transparent_1px)] bg-[length:22px_22px] bg-[var(--surface-secondary)] shadow-[var(--shadow)] ${props.selection ? 'min-h-105 cursor-default md:min-h-0' : 'min-h-105 touch-none cursor-grab active:cursor-grabbing md:min-h-112'}`}
          onPointerDown={props.selection ? undefined : viewportApi.startBackgroundPointer}
          onPointerMove={props.selection ? undefined : viewportApi.moveBackgroundPointer}
          onPointerUp={props.selection ? undefined : viewportApi.endBackgroundPointer}
          onPointerCancel={props.selection ? undefined : viewportApi.endBackgroundPointer}
          onWheel={props.selection ? undefined : viewportApi.onWheel}
          ref={canvasRef}
        >
          <div className="map-transform-layer absolute z-[2]" style={{ width: planeSize.width * viewport.zoom, height: planeSize.height * viewport.zoom, left: viewport.panX, top: viewport.panY }}>
            {mapElements.map((element) => <div
              aria-hidden="true"
              className={`pointer-events-none absolute z-0 ${element.kind === 'wall' ? 'rounded-[3px] bg-[repeating-linear-gradient(90deg,#64748b_0_18px,#94a3b8_18px_20px)] shadow-[inset_0_0_0_1px_rgba(15,23,42,.28)]' : element.kind === 'column' ? 'box-border rounded-full border-[3px] border-[#64748b] bg-[repeating-linear-gradient(45deg,#cbd5e1_0_5px,#94a3b8_5px_7px)]' : 'flex items-center justify-center overflow-hidden text-center font-black tracking-[.04em] text-[var(--muted)] [&>span]:truncate'}`}
              key={element.id}
              style={{ left: `${element.positionX}%`, top: `${element.positionY}%`, width: `${element.width}%`, height: `${element.height}%` }}
            >
              {element.kind === 'text' ? <span>{element.text}</span> : null}
            </div>)}
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
          {!props.selection ? <MapViewportControls
            onFit={() => canvasRef.current && fitViewport(canvasRef.current, fittedItems, planeSize)}
            onReset={() => viewportApi.setViewport({ zoom: 1, panX: 0, panY: 0 })}
            onZoomIn={() => canvasRef.current && viewportApi.zoomBy(1.2, canvasRef.current)}
            onZoomOut={() => canvasRef.current && viewportApi.zoomBy(1 / 1.2, canvasRef.current)}
            zoom={viewport.zoom}
          /> : null}
        </section>
        <aside className={`w-full max-h-64 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 md:max-h-none md:w-64 lg:w-72 [&>header]:flex [&>header]:items-center [&>header]:justify-between [&>header]:gap-2 [&>header]:border-b [&>header]:border-[var(--separator)] [&>header]:pb-2.5 [&_h3]:m-0 [&_p]:m-0 [&_p]:text-xs [&_p]:text-[var(--muted)] [&>header_span]:text-xs [&>header_span]:text-[var(--muted)] [&>button]:grid [&>button]:w-full [&>button]:gap-2 [&>button]:rounded-none [&>button]:border-0 [&>button]:border-b [&>button]:border-[var(--separator)] [&>button]:bg-transparent [&>button]:px-1 [&>button]:py-3 [&>button]:text-left [&>button]:text-[var(--foreground)] [&>button_time]:font-black [&>button_span]:grid [&>button_span]:gap-1 [&>button_small]:text-[var(--muted)] ${props.selection ? '[&>button]:min-h-14 [&>button]:grid-cols-[minmax(0,1fr)_auto] [&>button]:items-center [&>button_span]:min-w-0 [&>button_svg]:justify-self-end' : '[&>button]:grid-cols-[3.5rem_1fr]'}`}>
          {props.selection ? <>
            <header>
              <div><h3>Mesas seleccionadas</h3><span>{selectedTables.length} elegidas</span></div>
            </header>
            <div className="grid gap-2 border-b border-[var(--separator)] py-3">
              <div className={`rounded-xl border p-3 ${capacityInsufficient ? 'border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] text-[var(--warning)]' : 'border-[var(--separator)] bg-[var(--background)] text-[var(--foreground)]'}`}>
                <strong className="flex items-center gap-2 text-[13px]">
                  <Users size={16} />
                  {selectedTables.length
                    ? `${props.selection.selectedCapacity} plazas para ${props.selection.partySize}`
                    : 'Sin mesa asignada'}
                </strong>
                <p className="mt-1! font-semibold opacity-80">
                  {capacityInsufficient
                    ? `Faltan ${props.selection.partySize - props.selection.selectedCapacity} plazas.`
                    : selectedTables.length
                      ? 'Puedes combinar varias mesas desde el plano.'
                      : 'Puedes guardar y asignar mesa más tarde.'}
                </p>
              </div>
              <div className={`flex min-h-9 items-center gap-2 rounded-lg px-3 text-xs font-extrabold ${props.selection.hasActiveConflicts ? 'bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] text-[var(--warning)]' : 'bg-[color-mix(in_srgb,var(--success)_9%,var(--surface))] text-[var(--success)]'}`}>
                {props.selection.hasActiveConflicts ? <ShieldAlert size={16} /> : <CircleCheck size={16} />}
                {props.selection.hasActiveConflicts
                  ? 'La selección tiene conflictos'
                  : 'Sin conflictos en la selección'}
              </div>
            </div>
            {selectedTables.length ? selectedTables.map((table) => (
              <UiButton aria-label={`Quitar ${table.name}`} disabled={props.selection?.disabled} key={table.id} onClick={() => selectTable(table.id)} type="button">
                <span className="min-w-0"><strong className="truncate">{table.name}</strong><small className="truncate">{props.map.areas.find((candidate) => candidate.id === table.areaId)?.name ?? "Sin zona"} · {table.capacity} plazas</small></span>
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
