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
    <div className="reservation-map-view">
      <nav aria-label="Zonas" className="table-area-tabs">
        {props.map.areas.map((candidate) => <button className={candidate.id === area?.id ? 'active' : ''} key={candidate.id} onClick={() => {
          setAreaId(candidate.id)
          setSelectedTableId(null)
        }} type="button">{candidate.name}</button>)}
      </nav>
      <div className="reservation-map-layout">
        <section
          className="reservation-map-canvas table-map-canvas"
          onPointerDown={viewportApi.startBackgroundPointer}
          onPointerMove={viewportApi.moveBackgroundPointer}
          onPointerUp={viewportApi.endBackgroundPointer}
          onPointerCancel={viewportApi.endBackgroundPointer}
          onWheel={viewportApi.onWheel}
          ref={canvasRef}
        >
          <div className="map-transform-layer" style={{ width: planeSize.width * viewport.zoom, height: planeSize.height * viewport.zoom, left: viewport.panX, top: viewport.panY }}>
            {tables.map((table) => {
              const tableReservations = props.reservations.filter((reservation) => reservation.tableIds.includes(table.id))
              const next = getNextReservationForTable(tableReservations, table.id, new Date(0))
              const operational = table as RestaurantTableMapItem
              const primary = next?.tables[0]?.id === table.id
              return <button
                className={`reservation-map-table shape-${table.shape}${selectedTableId === table.id ? ' selected' : ''}${props.map.operationalMap && operational.status ? ` operational-${operational.status}` : ''}`}
                key={table.id}
                onClick={() => setSelectedTableId(table.id)}
                style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }}
                type="button"
              >
                <strong>{table.name}</strong>
                <small><Users size={13} /> {table.capacity}</small>
                {next ? <span>{primary ? `${new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(next.startsAt))} · ${next.customerName.split(' ')[0]}` : 'Vinculada'}{tableReservations.length > 1 ? <b>+{tableReservations.length - 1}</b> : null}</span> : null}
                {props.map.operationalMap && operational.status === 'occupied' ? <em>Ocupada ahora</em> : null}
              </button>
            })}
          </div>
          {!tables.length ? <div className="table-map-empty">No hay mesas activas en esta zona.</div> : null}
          <MapViewportControls
            onFit={() => canvasRef.current && viewportApi.fit(canvasRef.current, tables, planeSize)}
            onReset={() => viewportApi.setViewport({ zoom: 1, panX: 0, panY: 0 })}
            onZoomIn={() => canvasRef.current && viewportApi.zoomBy(1.2, canvasRef.current)}
            onZoomOut={() => canvasRef.current && viewportApi.zoomBy(1 / 1.2, canvasRef.current)}
            zoom={viewport.zoom}
          />
        </section>
        <aside className="reservation-map-sidebar">
          {selectedTableId ? <>
            <header>
              <div><h3>{tables.find((table) => table.id === selectedTableId)?.name}</h3><span>{selectedReservations.length} reservas</span></div>
              <button className="table-action primary" onClick={() => props.onCreate([selectedTableId])} type="button"><CalendarPlus /> Nueva</button>
            </header>
            {selectedReservations.map((reservation) => <button key={reservation.id} onClick={() => props.onSelectReservation(reservation)} type="button">
              <time>{new Intl.DateTimeFormat('es', { hour: '2-digit', minute: '2-digit' }).format(new Date(reservation.startsAt))}</time>
              <span><strong>{reservation.customerName}</strong><small>{reservation.partySize} personas</small></span>
            </button>)}
            {!selectedReservations.length ? <p>Esta mesa no tiene reservas para la fecha seleccionada.</p> : null}
          </> : <p>Selecciona una mesa para consultar sus reservas o crear una nueva.</p>}
        </aside>
      </div>
    </div>
  )
}
