import { ArrowRightLeft, Check, Pencil, ShoppingBag, Unlink, Users, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { formatMoney as formatCurrency } from '../../../lib/format'
import { getReadableError } from '../../../utils/errors'
import { snapTableAlignment } from '../alignment'
import { externalLabelSize, placeExternalLabels, tableContentMode, tableVisualRect, type LabelSide } from '../external-label-layout'
import { boundsOf, compositionHasOpenOrder, findJoinProposal, getJoinedIds, separateFromComposition, translateComposition, type JoinProposal } from '../joined-layout'
import { layoutFromMap } from '../layout-service'
import { getRestaurantTableVisualStatus } from '../table-visual-status'
import type { RestaurantMap, RestaurantTableMapItem, SessionTableLayout, TableLayoutEntry } from '../types'
import { useMapViewport } from '../useMapViewport'
import { getMapPlaneSize, positionFloatingPanel, screenToMap } from '../viewport'
import { MapViewportControls } from './MapViewportControls'
import { closeOnModalBackdrop } from '../../../components/modals/modalBackdrop'
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

type DragState = { pointerId: number; tableId: string; start: { x: number; y: number }; initialTables: RestaurantTableMapItem[]; currentTables: RestaurantTableMapItem[]; memberIds: Set<string>; moved: boolean; proposal: JoinProposal<RestaurantTableMapItem> | null }
type Guidelines = { x: number | null; y: number | null }
type GroupMenu = { tableId: string; left: number; top: number }
const SNAP_TOLERANCE = .7

function elapsed(openedAt: string | null) {
  if (!openedAt) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

function statusLabel(status: RestaurantTableMapItem['status']) {
  return status === 'free' ? 'Libre' : status === 'reserved' ? 'Reservada' : 'Ocupada'
}

function withGroupMembership(tables: RestaurantTableMapItem[]) {
  const members = new Map<string, string[]>()
  tables.forEach((table) => { if (table.layoutGroupId) members.set(table.layoutGroupId, [...(members.get(table.layoutGroupId) ?? []), table.id]) })
  return tables.map((table) => ({ ...table, layoutGroupTableIds: table.layoutGroupId ? members.get(table.layoutGroupId) ?? [] : [] }))
}

export function TableMapView(props: Props) {
  const { canOpen, canQuickSale, cashSessionId, isBusy, isOnline, map, moveOrderId, onAreaChange, onCancelMove, onError, onLayoutChange, onMove, onOpen, onOpenOrder, onQuickSale, openCashPanel, selectedAreaId } = props
  const [editMode, setEditMode] = useState(false)
  const [displayTables, setDisplayTables] = useState(map.tables)
  const [pendingIds, setPendingIds] = useState<string[] | null>(null)
  const [guestCount, setGuestCount] = useState(2)
  const [dropTargetId, setDropTargetId] = useState<string | null>(null)
  const [joinPreview, setJoinPreview] = useState<JoinProposal<RestaurantTableMapItem> | null>(null)
  const [guidelines, setGuidelines] = useState<Guidelines>({ x: null, y: null })
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null)
  const [savingLayout, setSavingLayout] = useState(false)
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 })
  const canvasRef = useRef<HTMLElement>(null)
  const dragRef = useRef<DragState | null>(null)
  const previousLabelSidesRef = useRef(new Map<string, LabelSide>())
  const latestRevisionRef = useRef(map.layoutRevision ?? 0)
  const fittedAreaRef = useRef<string | null>(null)
  const viewportApi = useMapViewport(`table-map:${cashSessionId}:${selectedAreaId ?? 'default'}`)
  const { fit: fitViewport, viewport } = viewportApi
  const activeAreaId = selectedAreaId && map.areas.some((area) => area.id === selectedAreaId) ? selectedAreaId : map.areas[0]?.id
  const activeArea = map.areas.find((area) => area.id === activeAreaId)
  const mapElements = useMemo(() => activeArea?.mapElements ?? [], [activeArea?.mapElements])
  const planeSize = useMemo(
    () => getMapPlaneSize(canvasSize.width, canvasSize.height, activeArea?.canvasWidth ?? 1200, activeArea?.canvasHeight ?? 800),
    [activeArea?.canvasHeight, activeArea?.canvasWidth, canvasSize.height, canvasSize.width],
  )
  const tables = useMemo(() => displayTables.filter((table) => table.areaId === activeAreaId), [activeAreaId, displayTables])
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, RestaurantTableMapItem[]>()
    tables.forEach((table) => { if (table.layoutGroupId) groups.set(table.layoutGroupId, [...(groups.get(table.layoutGroupId) ?? []), table]) })
    return [...groups.entries()].filter(([, members]) => members.length > 1)
  }, [tables])
  const visualTables = useMemo(() => tables.map((table) => ({ table, rect: tableVisualRect(table, planeSize, viewport) })), [planeSize, tables, viewport])
  const contentModes = useMemo(() => new Map(visualTables.map(({ table, rect }) => [table.id, tableContentMode(rect, table.name)])), [visualTables])
  const externalLabels = useMemo(() => {
    const inputs = visualTables.filter(({ table }) => contentModes.get(table.id) === 'external').map(({ table, rect }) => ({ id: table.id, table: rect, label: externalLabelSize(table.name) }))
    const reserved = canvasSize.width && canvasSize.height
      ? [{ x: Math.max(8, canvasSize.width - 240), y: Math.max(8, canvasSize.height - 72), width: 232, height: 64 }, ...(groupMenu ? [{ x: groupMenu.left, y: groupMenu.top, width: Math.min(240, canvasSize.width - 16), height: 220 }] : [])]
      : []
    return placeExternalLabels(inputs, visualTables.map(({ table, rect }) => ({ id: table.id, rect })), canvasSize, reserved, previousLabelSidesRef.current, Boolean(dragRef.current))
  }, [canvasSize, contentModes, groupMenu, visualTables])
  const externalLabelTables = useMemo(() => new Map(tables.map((table) => [table.id, table])), [tables])

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const updateSize = () => {
      const bounds = canvas.getBoundingClientRect()
      setCanvasSize((current) => current.width === bounds.width && current.height === bounds.height ? current : { width: bounds.width, height: bounds.height })
    }
    updateSize()
    const observer = new ResizeObserver(updateSize)
    observer.observe(canvas)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    previousLabelSidesRef.current = new Map(externalLabels.map((label) => [label.id, label.side]))
  }, [externalLabels])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !activeAreaId || !canvasSize.width || !canvasSize.height || fittedAreaRef.current === activeAreaId) return
    fittedAreaRef.current = activeAreaId
    fitViewport(canvas, [...tables, ...mapElements], planeSize)
  }, [activeAreaId, canvasSize.height, canvasSize.width, fitViewport, mapElements, planeSize, tables])

  useEffect(() => {
    const revision = map.layoutRevision ?? 0
    if (!dragRef.current && revision >= latestRevisionRef.current) { latestRevisionRef.current = revision; setDisplayTables(map.tables) }
  }, [map])

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (dragRef.current) { dragRef.current = null; setDisplayTables(map.tables); setDropTargetId(null); setJoinPreview(null); setGuidelines({ x: null, y: null }) }
      setGroupMenu(null)
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
    const dragPlane = getMapPlaneSize(bounds.width, bounds.height, activeArea?.canvasWidth ?? 1200, activeArea?.canvasHeight ?? 800)
    const memberIds = new Set(getJoinedIds(table, displayTables))
    dragRef.current = { pointerId: event.pointerId, tableId: table.id, start: screenToMap({ x: event.clientX, y: event.clientY }, { left: bounds.left, top: bounds.top, ...dragPlane }, viewport), initialTables: displayTables, currentTables: displayTables, memberIds, moved: false, proposal: null }
    setGroupMenu(null)
  }

  function moveTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current, canvas = canvasRef.current
    if (!drag || !canvas || drag.pointerId !== event.pointerId) return
    event.preventDefault()
    const bounds = canvas.getBoundingClientRect()
    const dragPlane = getMapPlaneSize(bounds.width, bounds.height, activeArea?.canvasWidth ?? 1200, activeArea?.canvasHeight ?? 800)
    const current = screenToMap({ x: event.clientX, y: event.clientY }, { left: bounds.left, top: bounds.top, ...dragPlane }, viewport)
    const dx = current.x - drag.start.x, dy = current.y - drag.start.y
    if (Math.hypot(dx, dy) > .25) drag.moved = true
    const moved = translateComposition(drag.initialTables, drag.memberIds, dx, dy)
    const source = moved.find((table) => table.id === drag.tableId)
    const alignment = source ? snapTableAlignment(source, moved.filter((table) => table.areaId === activeAreaId && !drag.memberIds.has(table.id)), SNAP_TOLERANCE) : null
    const aligned = source && alignment
      ? translateComposition(moved, drag.memberIds, alignment.positionX - source.positionX, alignment.positionY - source.positionY)
      : moved
    const alignedSource = aligned.find((table) => table.id === drag.tableId)
    const areaProposal = findJoinProposal(moved.filter((table) => table.areaId === activeAreaId), drag.tableId, drag.memberIds)
    const proposal = areaProposal ? {
      ...areaProposal,
      tables: moved.map((table) => areaProposal.tables.find((candidate) => candidate.id === table.id) ?? table),
    } : null
    drag.proposal = proposal
    drag.currentTables = proposal ? moved : aligned
    setDropTargetId(proposal?.targetId ?? null)
    setJoinPreview(proposal)
    setGuidelines(proposal || !alignment || !alignedSource ? { x: null, y: null } : {
      x: Math.abs(alignedSource.positionX - alignment.positionX) < .01 ? alignment.guidelineX : null,
      y: Math.abs(alignedSource.positionY - alignment.positionY) < .01 ? alignment.guidelineY : null,
    })
    setDisplayTables(proposal ? moved : aligned)
  }

  async function persistTables(nextTables: RestaurantTableMapItem[]) {
    const nextMap = { ...map, tables: nextTables }
    setDisplayTables(nextTables); setSavingLayout(true)
    try {
      const saved = await onLayoutChange(layoutFromMap(nextMap), latestRevisionRef.current)
      latestRevisionRef.current = saved.revision
      setDisplayTables((current) => withGroupMembership(current.map((table) => { const entry = saved.tables[table.id]; return entry ? { ...table, positionX: entry.positionX, positionY: entry.positionY, layoutGroupId: entry.groupId } : table })))
    } catch (error) {
      setDisplayTables(map.tables)
      onError(getReadableError(error))
    } finally { setSavingLayout(false) }
  }

  function finishTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    dragRef.current = null; setDropTargetId(null); setJoinPreview(null); setGuidelines({ x: null, y: null })
    if (!drag.moved) {
      const table = displayTables.find((item) => item.id === drag.tableId)
      const canvas = canvasRef.current
      if (table?.layoutGroupId && canvas) {
        const bounds = canvas.getBoundingClientRect()
        const pointerX = event.clientX - bounds.left
        const pointerY = event.clientY - bounds.top
        const menuWidth = Math.min(230, bounds.width - 16)
        const menuHeight = compositionHasOpenOrder(table, displayTables) ? 216 : 146
        const position = positionFloatingPanel({ x: pointerX, y: pointerY }, bounds, { width: menuWidth, height: menuHeight })
        setGroupMenu({
          tableId: table.id,
          left: position.x,
          top: position.y,
        })
      }
      return
    }
    let nextTables = drag.proposal?.tables ?? drag.currentTables
    if (drag.proposal) {
      const source = nextTables.find((table) => table.id === drag.tableId), target = nextTables.find((table) => table.id === drag.proposal?.targetId)
      if (source && target) {
        if (compositionHasOpenOrder(source, nextTables) || compositionHasOpenOrder(target, nextTables)) {
          onError('No se puede modificar una composicion con una comanda abierta.')
          setDisplayTables(map.tables)
          return
        }
        const memberIds = new Set([source.id, target.id, ...(source.layoutGroupTableIds ?? []), ...(target.layoutGroupTableIds ?? [])])
        const occupiedOrders = new Set(nextTables.filter((table) => memberIds.has(table.id) && table.orderId).map((table) => table.orderId))
        if (occupiedOrders.size > 1) { onError('No se pueden unir mesas con comandas distintas.'); setDisplayTables(map.tables); return }
        const groupId = target.layoutGroupId ?? source.layoutGroupId ?? crypto.randomUUID()
        nextTables = withGroupMembership(nextTables.map((table) => memberIds.has(table.id) ? { ...table, layoutGroupId: groupId } : table))
      }
    }
    void persistTables(nextTables)
  }

  function separate(tableId: string, all: boolean) {
    const selected = displayTables.find((table) => table.id === tableId); if (!selected?.layoutGroupId) return
    if (compositionHasOpenOrder(selected, displayTables)) {
      setGroupMenu(null)
      onError('No se pueden separar mesas con una comanda abierta.')
      return
    }
    const next = withGroupMembership(separateFromComposition(displayTables, tableId, all))
    setGroupMenu(null); void persistTables(next)
  }

  async function confirmOpen() { if (!pendingIds) return; await onOpen(pendingIds, guestCount); setPendingIds(null) }

  const groupMenuTable = groupMenu ? displayTables.find((table) => table.id === groupMenu.tableId) : null
  const groupMenuLocked = groupMenuTable ? compositionHasOpenOrder(groupMenuTable, displayTables) : false

  return <main className="table-map-screen">
    <header className="table-map-toolbar">
      <div><h1>Mapa de mesas</h1><p>{editMode ? 'Mueve, une o separa mesas. El viewport sigue siendo local a este dispositivo.' : 'Selecciona una mesa para abrir o recuperar su comanda.'}</p></div>
      <div className="table-map-actions">
        <button className={`table-action secondary${editMode ? ' active' : ''}`} disabled={!isOnline || isBusy || Boolean(moveOrderId)} onClick={() => { setEditMode((value) => !value); setGroupMenu(null) }} type="button">{editMode ? <Check size={18} /> : <Pencil size={18} />}{editMode ? 'Finalizar edicion' : 'Editar mesas'}</button>
        {canQuickSale ? <button className="table-action primary" onClick={onQuickSale} type="button"><ShoppingBag size={18} /> Venta rapida</button> : null}
      </div>
    </header>
    {!isOnline ? <div className="table-offline-warning">La gestion de mesas requiere conexion. La venta rapida sigue disponible.</div> : null}
    {!canOpen ? <div className="table-offline-warning">Abre una caja para poder abrir o cobrar comandas.</div> : null}
    {!canOpen && openCashPanel ? <div className="table-open-cash">{openCashPanel}</div> : null}
    {moveOrderId ? <div className="table-mode-banner"><ArrowRightLeft size={18} /><span>Selecciona una mesa libre como destino.</span><button onClick={onCancelMove} type="button"><X size={16} /> Cancelar</button></div> : null}
    <nav className="table-area-tabs" aria-label="Zonas">{map.areas.map((area) => <button className={area.id === activeAreaId ? 'active' : ''} key={area.id} onClick={() => onAreaChange(area.id)} type="button">{area.name}</button>)}</nav>
    <section className={`table-map-canvas${editMode ? ' editing' : ''}${viewport.zoom < .75 ? ' compact-labels' : ''}`} onPointerDown={viewportApi.startBackgroundPointer} onPointerMove={(event) => { moveTableDrag(event); viewportApi.moveBackgroundPointer(event) }} onPointerUp={(event) => { finishTableDrag(event); viewportApi.endBackgroundPointer(event) }} onPointerCancel={(event) => { finishTableDrag(event); viewportApi.endBackgroundPointer(event) }} onWheel={viewportApi.onWheel} ref={canvasRef}>
      <svg aria-hidden="true" className="table-label-connectors">
        {externalLabels.map((label) => {
          const table = externalLabelTables.get(label.id)
          return <g className={`status-${table ? getRestaurantTableVisualStatus(table) : 'free'}`} key={label.id}><line x1={label.connector.from.x} x2={label.connector.to.x} y1={label.connector.from.y} y2={label.connector.to.y} /><circle cx={label.connector.from.x} cy={label.connector.from.y} r="2.5" /></g>
        })}
      </svg>
      <div className="map-transform-layer" style={{ width: planeSize.width * viewport.zoom, height: planeSize.height * viewport.zoom, left: viewport.panX, top: viewport.panY }}>
        {mapElements.map((element) => <div aria-hidden="true" className={`table-map-element kind-${element.kind}`} key={element.id} style={{ left: `${element.positionX}%`, top: `${element.positionY}%`, width: `${element.width}%`, height: `${element.height}%` }}>{element.kind === 'text' ? <span>{element.text}</span> : null}</div>)}
        {guidelines.x !== null ? <div aria-hidden="true" className="table-map-guideline vertical" style={{ left: `${guidelines.x}%` }} /> : null}
        {guidelines.y !== null ? <div aria-hidden="true" className="table-map-guideline horizontal" style={{ top: `${guidelines.y}%` }} /> : null}
        {layoutGroups.map(([groupId, members]) => { const bounds = boundsOf(members); return <div aria-hidden="true" className="table-group-outline" key={groupId} style={{ left: `${bounds.left}%`, top: `${bounds.top}%`, width: `${bounds.right - bounds.left}%`, height: `${bounds.bottom - bounds.top}%` }} /> })}
        {joinPreview ? joinPreview.tables.filter((table) => dragRef.current?.memberIds.has(table.id)).map((table) => <div aria-hidden="true" className="table-join-preview" key={`preview-${table.id}`} style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }} />) : null}
        {tables.map((table) => {
          const mode = contentModes.get(table.id) ?? 'full'
          const visualStatus = getRestaurantTableVisualStatus(table)
          return <button aria-label={`${table.name}, ${statusLabel(table.status)}${table.layoutGroupId ? ', juntada' : ''}`} className={`pos-table content-${mode} status-${visualStatus} shape-${table.shape}${dropTargetId === table.id || (table.layoutGroupId && displayTables.find((item) => item.id === dropTargetId)?.layoutGroupId === table.layoutGroupId) ? ' drop-target' : ''}${moveOrderId && table.status !== 'free' ? ' unavailable' : ''}`} key={table.id} onClick={() => chooseTable(table)} onPointerDown={(event) => startTableDrag(event, table)} style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }} type="button">
            {mode !== 'external' ? <span className="pos-table-content">
              <span className="pos-table-primary"><strong title={table.name}>{table.name}</strong><span className="pos-table-status">{statusLabel(table.status)}</span></span>
              {mode === 'full' && table.status === 'occupied' ? <><b>{formatCurrency(table.totalCents)}</b><small><Users aria-hidden="true" size={14} /> {table.guestCount} comensales · {elapsed(table.orderOpenedAt)}</small><small>{table.pendingUnits ? `${table.pendingUnits} por servir` : 'Todo servido'}</small></> : mode === 'full' ? <small><Users aria-hidden="true" size={14} /> {table.capacity} plazas</small> : null}
              {dropTargetId === table.id ? <em className="drop-message">Soltar para juntar</em> : null}
            </span> : <span aria-hidden="true" className="pos-table-status-mark" />}
          </button>
        })}
        {!tables.length ? <div className="table-map-empty">No hay mesas activas en esta zona.</div> : null}
      </div>
      <div aria-hidden="true" className="table-external-label-layer">
        {externalLabels.map((label) => {
          const table = externalLabelTables.get(label.id)
          if (!table) return null
          return <div className={`table-external-label status-${getRestaurantTableVisualStatus(table)} side-${label.side}${label.forced ? ' forced' : ''}`} key={label.id} style={{ left: label.rect.x, top: label.rect.y, width: label.rect.width, height: label.rect.height }}>
            <strong title={table.name}>{table.name}</strong><span>{statusLabel(table.status)}</span>
          </div>
        })}
      </div>
      <MapViewportControls zoom={viewport.zoom} onFit={() => canvasRef.current && viewportApi.fit(canvasRef.current, [...tables, ...mapElements], planeSize)} onReset={() => viewportApi.setViewport({ zoom: 1, panX: 0, panY: 0 })} onZoomIn={() => canvasRef.current && viewportApi.zoomBy(1.2, canvasRef.current)} onZoomOut={() => canvasRef.current && viewportApi.zoomBy(1 / 1.2, canvasRef.current)} />
      {editMode && groupMenu ? <div className="table-group-menu" style={{ left: groupMenu.left, top: groupMenu.top }}><strong>{groupMenuTable?.name}</strong>{groupMenuLocked ? <p>La comanda esta abierta. Cobra o cancela la comanda antes de separar las mesas.</p> : null}<button disabled={groupMenuLocked} onClick={() => separate(groupMenu.tableId, false)} type="button"><Unlink size={16} /> Separar esta mesa</button><button disabled={groupMenuLocked} onClick={() => separate(groupMenu.tableId, true)} type="button"><Unlink size={16} /> Separar todas las mesas</button></div> : null}
    </section>
    {pendingIds ? <div className="table-modal-backdrop" onClick={(event) => closeOnModalBackdrop(event, () => setPendingIds(null), isBusy)}><section className="table-modal"><h2>{pendingIds.length > 1 ? `Abrir ${pendingIds.length} mesas juntas` : map.tables.find((table) => table.id === pendingIds[0])?.name}</h2><p>La comanda se guardara automaticamente y quedara disponible para los dispositivos del local.</p><label>Numero de comensales<input autoFocus min="1" onChange={(event) => setGuestCount(Math.max(1, Number(event.target.value)))} type="number" value={guestCount} /></label><div><button className="table-action secondary" onClick={() => setPendingIds(null)} type="button">Cancelar</button><button className="table-action primary" disabled={isBusy || !isOnline || !canOpen} onClick={() => void confirmOpen()} type="button">Abrir mesa</button></div></section></div> : null}
  </main>
}
