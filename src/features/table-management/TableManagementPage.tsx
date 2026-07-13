import { Armchair, Copy, Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { TenantContext } from '../../types/domain'
import { createDiningArea, createRestaurantTable, loadDiningAreas, loadRestaurantTables, loadVenueTablesEnabled, setVenueTablesEnabled, updateDiningArea, updateRestaurantTable } from '../tables/service'
import type { DiningArea, RestaurantTable, RestaurantTableShape } from '../tables/types'
import './table-management.css'

type Props = { context: TenantContext; disabled: boolean; venueId: string; onError: (message: string | null) => void }
type DragState = { tableId: string; mode: 'move' | 'resize'; startX: number; startY: number; initial: RestaurantTable; latest: RestaurantTable }

export function TableManagementPage({ context, disabled, venueId, onError }: Props) {
  const [enabled, setEnabled] = useState(false)
  const [areas, setAreas] = useState<DiningArea[]>([])
  const [tables, setTables] = useState<RestaurantTable[]>([])
  const [selectedAreaId, setSelectedAreaId] = useState('')
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null)
  const [areaName, setAreaName] = useState('')
  const [busy, setBusy] = useState(false)
  const canvasRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<DragState | null>(null)

  const refresh = useCallback(async () => {
    if (!venueId) return
    const [nextEnabled, nextAreas, nextTables] = await Promise.all([
      loadVenueTablesEnabled(context, venueId), loadDiningAreas(context, venueId, true), loadRestaurantTables(context, venueId, true),
    ])
    setEnabled(nextEnabled)
    setAreas(nextAreas)
    setTables(nextTables)
    setSelectedAreaId((current) => nextAreas.some((area) => area.id === current) ? current : (nextAreas[0]?.id ?? ''))
  }, [context, venueId])

  useEffect(() => { setSelectedTableId(null); void refresh().catch((error: unknown) => onError(error instanceof Error ? error.message : 'No se pudo cargar la configuracion de mesas.')) }, [onError, refresh])

  const selectedArea = areas.find((area) => area.id === selectedAreaId)
  const selectedTable = tables.find((table) => table.id === selectedTableId)
  const areaTables = useMemo(() => tables.filter((table) => table.areaId === selectedAreaId), [selectedAreaId, tables])

  async function run(action: () => Promise<void>) {
    setBusy(true); onError(null)
    try { await action() } catch (error) { onError(error instanceof Error ? error.message : 'No se pudo guardar la configuracion.') } finally { setBusy(false) }
  }

  async function addArea() {
    const name = areaName.trim()
    if (!name) return
    await run(async () => { const area = await createDiningArea(context, { venueId, name, sortOrder: areas.length }); setAreaName(''); await refresh(); setSelectedAreaId(area.id) })
  }

  async function addTable(source?: RestaurantTable) {
    if (!selectedArea) return
    await run(async () => {
      const created = await createRestaurantTable(context, { venueId, areaId: selectedArea.id, name: source ? `${source.name} copia` : `Mesa ${areaTables.length + 1}`, capacity: source?.capacity ?? 2, shape: source?.shape ?? 'square', positionX: Math.min((source?.positionX ?? 6) + (source ? 3 : 0), 84), positionY: Math.min((source?.positionY ?? 8) + (source ? 3 : 0), 84), width: source?.width ?? 12, height: source?.height ?? 12, sortOrder: tables.length })
      await refresh(); setSelectedTableId(created.id)
    })
  }

  async function saveSelectedTable() {
    if (!selectedTable) return
    await run(async () => { await updateRestaurantTable(context, selectedTable.id, selectedTable); await refresh() })
  }

  function patchSelectedTable(patch: Partial<RestaurantTable>) {
    if (!selectedTableId) return
    setTables((current) => current.map((table) => table.id === selectedTableId ? { ...table, ...patch } : table))
  }

  function startDrag(event: ReactPointerEvent, table: RestaurantTable, mode: DragState['mode']) {
    if (disabled || busy) return
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = { tableId: table.id, mode, startX: event.clientX, startY: event.clientY, initial: table, latest: table }
    setSelectedTableId(table.id)
  }

  function drag(event: ReactPointerEvent) {
    const state = dragRef.current; const canvas = canvasRef.current
    if (!state || !canvas) return
    const bounds = canvas.getBoundingClientRect(); const dx = (event.clientX - state.startX) / bounds.width * 100; const dy = (event.clientY - state.startY) / bounds.height * 100
    const patch = state.mode === 'move'
      ? { positionX: Math.max(0, Math.min(100 - state.initial.width, state.initial.positionX + dx)), positionY: Math.max(0, Math.min(100 - state.initial.height, state.initial.positionY + dy)) }
      : { width: Math.max(4, Math.min(100 - state.initial.positionX, state.initial.width + dx)), height: Math.max(4, Math.min(100 - state.initial.positionY, state.initial.height + dy)) }
    state.latest = { ...state.initial, ...patch }
    setTables((current) => current.map((table) => table.id === state.tableId ? { ...table, ...patch } : table))
  }

  function finishDrag() {
    const state = dragRef.current
    if (!state) return
    dragRef.current = null
    const table = state.latest
    if (table) void run(() => updateRestaurantTable(context, table.id, { positionX: table.positionX, positionY: table.positionY, width: table.width, height: table.height }))
  }

  return (
    <div className="tables-admin">
      <section className="crm-panel tables-admin-settings">
        <div><h2>Gestion de mesas</h2><p>Activa el mapa y las comandas persistentes solo para este local.</p></div>
        <label className="tables-toggle"><input checked={enabled} disabled={disabled || busy} onChange={(event) => { const value = event.target.checked; void run(async () => { await setVenueTablesEnabled(venueId, value); setEnabled(value) }) }} type="checkbox" /><span>{enabled ? 'Addon activado' : 'Addon desactivado'}</span></label>
      </section>

      <section className="crm-panel tables-area-panel">
        <div className="crm-panel-header"><div><h2>Zonas</h2><p>Ordena y selecciona la zona que quieres editar.</p></div></div>
        <form className="tables-area-create" onSubmit={(event) => { event.preventDefault(); void addArea() }}><input className="crm-input" onChange={(event) => setAreaName(event.target.value)} placeholder="Nueva zona" value={areaName} /><button className="crm-primary-button" disabled={disabled || busy || !areaName.trim()}><Plus size={16} /> Crear zona</button></form>
        <div className="tables-area-list">
          {areas.map((area, index) => (
            <div className={area.id === selectedAreaId ? 'tables-area active' : 'tables-area'} key={area.id} onClick={() => { setSelectedAreaId(area.id); setSelectedTableId(null) }} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { setSelectedAreaId(area.id); setSelectedTableId(null) } }} role="button" tabIndex={0}>
              <span>{area.name}</span>
              <small>{tables.filter((table) => table.areaId === area.id && table.isActive).length} mesas</small>
              <span className={area.isActive ? 'crm-status-pill crm-status-pill-active' : 'crm-status-pill crm-status-pill-muted'}>{area.isActive ? 'Activa' : 'Inactiva'}</span>
              <span className="tables-order-actions">
                <button aria-label="Subir zona" disabled={index === 0 || busy} onClick={(event) => { event.stopPropagation(); void run(async () => { await Promise.all([updateDiningArea(context, area.id, { sortOrder: index - 1 }), updateDiningArea(context, areas[index - 1].id, { sortOrder: index })]); await refresh() }) }} type="button">↑</button>
                <button aria-label="Bajar zona" disabled={index === areas.length - 1 || busy} onClick={(event) => { event.stopPropagation(); void run(async () => { await Promise.all([updateDiningArea(context, area.id, { sortOrder: index + 1 }), updateDiningArea(context, areas[index + 1].id, { sortOrder: index })]); await refresh() }) }} type="button">↓</button>
              </span>
            </div>
          ))}
        </div>
      </section>

      {selectedArea ? <section className="crm-panel tables-editor-panel">
        <div className="tables-editor-toolbar"><div><input aria-label="Nombre de zona" className="crm-input" onBlur={(event) => void run(() => updateDiningArea(context, selectedArea.id, { name: event.target.value }))} onChange={(event) => setAreas((current) => current.map((area) => area.id === selectedArea.id ? { ...area, name: event.target.value } : area))} value={selectedArea.name} /><button className="crm-state-button" onClick={() => void run(async () => { await updateDiningArea(context, selectedArea.id, { isActive: !selectedArea.isActive }); await refresh() })} type="button">{selectedArea.isActive ? 'Desactivar zona' : 'Activar zona'}</button></div><button className="crm-primary-button" disabled={disabled || busy} onClick={() => void addTable()} type="button"><Plus size={16} /> Nueva mesa</button></div>
        <div className="tables-editor-layout">
          <div className="tables-canvas" onPointerMove={drag} onPointerUp={finishDrag} ref={canvasRef}>
            {areaTables.map((table) => <button className={`tables-canvas-table shape-${table.shape}${table.id === selectedTableId ? ' selected' : ''}${table.isActive ? '' : ' inactive'}`} key={table.id} onPointerDown={(event) => startDrag(event, table, 'move')} style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }} type="button"><Armchair size={16} /><strong>{table.name}</strong><small>{table.capacity} pax</small><span className="tables-resize" onPointerDown={(event) => { event.stopPropagation(); startDrag(event, table, 'resize') }} /></button>)}
            {!areaTables.length ? <div className="tables-canvas-empty">Crea la primera mesa de esta zona.</div> : null}
          </div>
          <aside className="tables-inspector">{selectedTable ? <><h3>{selectedTable.name}</h3><label>Nombre<input className="crm-input" onChange={(event) => patchSelectedTable({ name: event.target.value })} value={selectedTable.name} /></label><label>Capacidad<input className="crm-input" min="1" onChange={(event) => patchSelectedTable({ capacity: Number(event.target.value) })} type="number" value={selectedTable.capacity} /></label><label>Forma<select className="crm-input" onChange={(event) => patchSelectedTable({ shape: event.target.value as RestaurantTableShape })} value={selectedTable.shape}><option value="square">Cuadrada</option><option value="rectangle">Rectangular</option><option value="round">Redonda</option></select></label><div className="tables-inspector-actions"><button className="crm-save-button" disabled={busy} onClick={() => void saveSelectedTable()} type="button"><Save size={16} /> Guardar</button><button className="crm-secondary-button" disabled={busy} onClick={() => void addTable(selectedTable)} type="button"><Copy size={16} /> Duplicar</button><button className="crm-danger-button" disabled={busy} onClick={() => void run(async () => { await updateRestaurantTable(context, selectedTable.id, { isActive: !selectedTable.isActive }); await refresh() })} type="button"><Trash2 size={16} /> {selectedTable.isActive ? 'Desactivar' : 'Activar'}</button></div></> : <p>Selecciona una mesa para editar sus datos, moverla o cambiar su tamano.</p>}</aside>
        </div>
      </section> : null}
    </div>
  )
}
