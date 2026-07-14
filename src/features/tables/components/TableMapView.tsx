import { ArrowRightLeft, Check, Pencil, ShoppingBag, Unlink, Users, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatMoney as formatCurrency } from '../../../lib/format'
import { layoutFromMap } from '../layout-service'
import type { RestaurantMap, RestaurantTableMapItem, SessionTableLayout, TableLayoutEntry } from '../types'
import { useMapViewport } from '../useMapViewport'
import { clamp, intersectionRatio, screenToMap } from '../viewport'
import { MapViewportControls } from './MapViewportControls'
import '../tables.css'

type Props = {
  canOpen: boolean
  canQuickSale: boolean
  cashSessionId: string
  isBusy: boolean
  isOnline: boolean
  map: RestaurantMap
  onAreaChange: (areaId: string) => void
  onLayoutChange: (tables: Record<string, TableLayoutEntry>, expectedRevision: number) => Promise<SessionTableLayout>
  onError: (message: string) => void
  onMove: (tableId: string) => Promise<void>
  onOpen: (tableIds: string[], guestCount: number) => Promise<void>
  onOpenOrder: (orderId: string) => void
  onQuickSale: () => void
  selectedAreaId?: string
  moveOrderId: string | null
  onCancelMove: () => void
  openCashPanel?: ReactNode
}

type DragState = { pointerId: number; tableId: string; start: { x: number; y: number }; initial: RestaurantTableMapItem; moved: boolean; targetId: string | null }

function elapsed(openedAt: string | null) {
  if (!openedAt) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function groupBounds(tables: RestaurantTableMapItem[]) {
  return { left: Math.min(...tables.map((table) => table.positionX)), top: Math.min(...tables.map((table) => table.positionY)), right: Math.max(...tables.map((table) => table.positionX + table.width)), bottom: Math.max(...tables.map((table) => table.positionY + table.height)) }
}

export function TableMapView(props: Props) {
  const { canOpen, canQuickSale, cashSessionId, isBusy, isOnline, map, moveOrderId, onAreaChange, onCancelMove, onError, onLayoutChange, onMove, onOpen, onOpenOrder, onQuickSale, openCashPanel, selectedAreaId } = props
  const [editMode, setEditMode] = useState(false)
  const [displayTables, setDisplayTables] = useState(map.tables)
  const [pendingIds, setPendingIds] = useState<string[] | null>(null)
  const [guestCount, setGuestCount] = useState(2)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [menuTableId, setMenuTableId] = useState<string | null>(null)
  const [savingLayout, setSavingLayout] = useState(false)
  const canvasRef = useRef<HTMLElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const latestRevisionRef = useRef(map.layoutRevision ?? 0)
  const viewportApi = useMapViewport(`table-map:${cashSessionId}:${selectedAreaId ?? 'default'}`)
  const { viewport } = viewportApi
  const activeAreaId = selectedAreaId && map.areas.some((area) => area.id === selectedAreaId) ? selectedAreaId : map.areas[0]?.id
  const tables = useMemo(() => displayTables.filter((table) => table.areaId === activeAreaId), [activeAreaId, displayTables])
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, RestaurantTableMapItem[]>()
    tables.forEach((table) => { if (table.layoutGroupId) groups.set(table.layoutGroupId, [...(groups.get(table.layoutGroupId) ?? []), table]) })
    return [...groups.entries()].filter(([, members]) => members.length > 1)
  }, [tables])

  useEffect(() => {
    const revision = map.layoutRevision ?? 0
    if (!dragRef.current && revision >= latestRevisionRef.current) { latestRevisionRef.current = revision; setDisplayTables(map.tables) }
  }, [map])

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (dragRef.current) { dragRef.current = null; setDisplayTables(map.tables); setDropTargetId(null) }
      setMenuTableId(null)
    }
    window.addEventListener('keydown', cancel)
    return () => window.removeEventListener('keydown', cancel)
  }, [map.tables])

  function chooseTable(table: RestaurantTableMapItem) {
    if (!isOnline || isBusy || editMode) return
    if (moveOrderId) { if (table.status === 'free') void onMove(table.id); return }
    if (table.status === 'occupied' && table.orderId) onOpenOrder(table.orderId)
    else if (table.status === 'free' && canOpen) {
      const ids = table.layoutGroupTableIds?.length ? table.layoutGroupTableIds : [table.id]
      setPendingIds(ids)
      setGuestCount(Math.max(1, ids.reduce((total, id) => total + (displayTables.find((item) => item.id === id)?.capacity ?? 0), 0)))
    }
  }

  function startTableDrag(event: ReactPointerEvent<HTMLButtonElement>, table: RestaurantTableMapItem) {
    if (!editMode || savingLayout || !isOnline) return
    event.preventDefault(); event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId)
    const bounds = canvasRef.current?.getBoundingClientRect(); if (!bounds) return
    dragRef.current = { pointerId: event.pointerId, tableId: table.id, start: screenToMap({ x: event.clientX, y: event.clientY }, bounds, viewport), initial: table, moved: false, targetId: null }
    setMenuTableId(null)
  }

  function moveTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current, canvas = canvasRef.current
    if (!drag || !canvas || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const current = screenToMap({ x: event.clientX, y: event.clientY }, canvas.getBoundingClientRect(), viewport)
    const dx = current.x - drag.start.x, dy = current.y - drag.start.y
    if (Math.hypot(dx, dy) > .25) drag.moved = true
    const moved = { ...drag.initial, positionX: clamp(drag.initial.positionX + dx, 0, 100 - drag.initial.width), positionY: clamp(drag.initial.positionY + dy, 0, 100 - drag.initial.height) }
    const sourceGroup = new Set(drag.initial.layoutGroupTableIds ?? [])
    const target = displayTables.filter((table) => table.areaId === activeAreaId && table.id !== moved.id && !sourceGroup.has(table.id))
      .map((table) => ({ table, ratio: intersectionRatio(moved, table) })).filter((item) => item.ratio >= .45).sort((a, b) => b.ratio - a.ratio)[0]?.table ?? null
    drag.targetId = target?.id ?? null
    setDropTargetId(target?.id ?? null)
    setDisplayTables((currentTables) => currentTables.map((table) => table.id === moved.id ? moved : table))
  }

  async function persistTables(nextTables: RestaurantTableMapItem[]) {
    const nextMap = { ...map, tables: nextTables }
    setDisplayTables(nextTables); setSavingLayout(true)
    try {
      const saved = await onLayoutChange(layoutFromMap(nextMap), latestRevisionRef.current)
      latestRevisionRef.current = saved.revision
      setDisplayTables((current) => current.map((table) => { const entry = saved.tables[table.id]; return entry ? { ...table, positionX: entry.positionX, positionY: entry.positionY, layoutGroupId: entry.groupId } : table }))
    } catch (error) {
      setDisplayTables(map.tables)
      onError(error instanceof Error ? error.message : 'No se pudo guardar la distribucion de mesas.')
    } finally { setSavingLayout(false) }
  }

  function finishTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null; setDropTargetId(null)
    if (!drag.moved) { const table = displayTables.find((item) => item.id === drag.tableId); if (table?.layoutGroupId) setMenuTableId(table.id); return }
    let nextTables = displayTables
    if (drag.targetId) {
      const source = nextTables.find((table) => table.id === drag.tableId), target = nextTables.find((table) => table.id === drag.targetId)
      if (source && target) {
        const memberIds = new Set([source.id, target.id, ...(source.layoutGroupTableIds ?? []), ...(target.layoutGroupTableIds ?? [])])
        const occupiedOrders = new Set(nextTables.filter((table) => memberIds.has(table.id) && table.orderId).map((table) => table.orderId))
        if (occupiedOrders.size > 1) { onError('No se pueden unir mesas con comandas distintas.'); setDisplayTables(map.tables); return }
        const groupId = target.layoutGroupId ?? source.layoutGroupId ?? crypto.randomUUID()
        nextTables = nextTables.map((table) => memberIds.has(table.id) ? { ...table, layoutGroupId: groupId, layoutGroupTableIds: [...memberIds] } : table)
      }
    }
    void persistTables(nextTables)
  }

  function separate(tableId: string, all: boolean) {
    const selected = displayTables.find((table) => table.id === tableId); if (!selected?.layoutGroupId) return
    const members = displayTables.filter((table) => table.layoutGroupId === selected.layoutGroupId)
    const clearIds = new Set(all || members.length === 2 ? members.map((table) => table.id) : [tableId])
    const next = displayTables.map((table) => clearIds.has(table.id) ? { ...table, layoutGroupId: null, layoutGroupTableIds: [], positionX: table.id === tableId && !all ? clamp(table.positionX + 2, 0, 100 - table.width) : table.positionX, positionY: table.id === tableId && !all ? clamp(table.positionY + 2, 0, 100 - table.height) : table.positionY } : table)
    setMenuTableId(null); void persistTables(next)
  }

  async function confirmOpen() { if (!pendingIds) return; await onOpen(pendingIds, guestCount); setPendingIds(null) }

  return <main className="table-map-screen">
    <header className="table-map-toolbar">
      <div><h1>Mapa de mesas</h1><p>{editMode ? 'Mueve, une o separa mesas. El viewport sigue siendo local a este dispositivo.' : 'Selecciona una mesa para abrir o recuperar su comanda.'}</p></div>
      <div className="table-map-actions">
        <button className={`table-action secondary${editMode ? ' active' : ''}`} disabled={!isOnline || isBusy || Boolean(moveOrderId)} onClick={() => { setEditMode((value) => !value); setMenuTableId(null) }} type="button">{editMode ? <Check size={18} /> : <Pencil size={18} />}{editMode ? 'Finalizar edicion' : 'Editar mesas'}</button>
        {canQuickSale ? <button className="table-action primary" onClick={onQuickSale} type="button"><ShoppingBag size={18} /> Venta rapida</button> : null}
      </div>
    </header>
    {!isOnline ? <div className="table-offline-warning">La gestion de mesas requiere conexion. La venta rapida sigue disponible.</div> : null}
    {!canOpen ? <div className="table-offline-warning">Abre una caja para poder abrir o cobrar comandas.</div> : null}
    {!canOpen && openCashPanel ? <div className="table-open-cash">{openCashPanel}</div> : null}
    {moveOrderId ? <div className="table-mode-banner"><ArrowRightLeft size={18} /><span>Selecciona una mesa libre como destino.</span><button onClick={onCancelMove} type="button"><X size={16} /> Cancelar</button></div> : null}
    <nav className="table-area-tabs" aria-label="Zonas">{map.areas.map((area) => <button className={area.id === activeAreaId ? 'active' : ''} key={area.id} onClick={() => onAreaChange(area.id)} type="button">{area.name}</button>)}</nav>
    <section className={`table-map-canvas${editMode ? ' editing' : ''}${viewport.zoom < .75 ? ' compact-labels' : ''}`} onPointerDown={viewportApi.startBackgroundPointer} onPointerMove={(event) => { moveTableDrag(event); viewportApi.moveBackgroundPointer(event) }} onPointerUp={(event) => { finishTableDrag(event); viewportApi.endBackgroundPointer(event) }} onPointerCancel={(event) => { finishTableDrag(event); viewportApi.endBackgroundPointer(event) }} onWheel={viewportApi.onWheel} ref={canvasRef}>
      <div className="map-transform-layer" style={{ transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})` }}>
        {layoutGroups.map(([groupId, members]) => { const bounds = groupBounds(members); return <div aria-hidden="true" className="table-group-outline" key={groupId} style={{ left: `${bounds.left}%`, top: `${bounds.top}%`, width: `${bounds.right - bounds.left}%`, height: `${bounds.bottom - bounds.top}%` }}><span>Grupo {members.length}</span></div> })}
        {tables.map((table) => <button aria-label={`${table.name}, ${table.status}${table.layoutGroupId ? ', agrupada' : ''}`} className={`pos-table status-${table.status} shape-${table.shape}${dropTargetId === table.id || (table.layoutGroupId && displayTables.find((item) => item.id === dropTargetId)?.layoutGroupId === table.layoutGroupId) ? ' drop-target' : ''}${moveOrderId && table.status !== 'free' ? ' unavailable' : ''}`} key={table.id} onClick={() => chooseTable(table)} onPointerDown={(event) => startTableDrag(event, table)} style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }} type="button">
          <strong>{table.name}</strong><span>{table.status === 'free' ? 'Libre' : table.status === 'reserved' ? 'Reservada' : 'Ocupada'}</span>
          {table.status === 'occupied' ? <><b>{formatCurrency(table.totalCents)}</b><small><Users size={12} /> {table.guestCount} - {elapsed(table.orderOpenedAt)}</small><small>{table.pendingUnits ? `${table.pendingUnits} por servir` : 'Todo servido'}</small></> : <small><Users size={12} /> {table.capacity}</small>}
          {dropTargetId === table.id ? <em className="drop-message">Soltar para unir</em> : table.layoutGroupId ? <em>Agrupada</em> : null}
        </button>)}
        {!tables.length ? <div className="table-map-empty">No hay mesas activas en esta zona.</div> : null}
      </div>
      <MapViewportControls zoom={viewport.zoom} onFit={() => canvasRef.current && viewportApi.fit(canvasRef.current, tables)} onReset={() => viewportApi.setViewport({ zoom: 1, panX: 0, panY: 0 })} onZoomIn={() => canvasRef.current && viewportApi.zoomBy(1.2, canvasRef.current)} onZoomOut={() => canvasRef.current && viewportApi.zoomBy(1 / 1.2, canvasRef.current)} />
      {editMode && menuTableId ? <div className="table-group-menu"><strong>{displayTables.find((table) => table.id === menuTableId)?.name}</strong><button onClick={() => separate(menuTableId, false)} type="button"><Unlink size={16} /> Separar esta mesa</button><button onClick={() => separate(menuTableId, true)} type="button"><Unlink size={16} /> Separar todas las mesas</button></div> : null}
    </section>
    {pendingIds ? <div className="table-modal-backdrop"><section className="table-modal"><h2>{pendingIds.length > 1 ? `Abrir ${pendingIds.length} mesas agrupadas` : map.tables.find((table) => table.id === pendingIds[0])?.name}</h2><p>La comanda se guardara automaticamente y quedara disponible para los dispositivos del local.</p><label>Numero de comensales<input autoFocus min="1" onChange={(event) => setGuestCount(Math.max(1, Number(event.target.value)))} type="number" value={guestCount} /></label><div><button className="table-action secondary" onClick={() => setPendingIds(null)} type="button">Cancelar</button><button className="table-action primary" disabled={isBusy || !isOnline || !canOpen} onClick={() => void confirmOpen()} type="button">Abrir mesa</button></div></section></div> : null}
  </main>
}
