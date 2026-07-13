import { ArrowRightLeft, Link2, ShoppingBag, Users, X } from 'lucide-react'
import { useMemo, useState, type ReactNode } from 'react'
import { formatMoney as formatCurrency } from '../../../lib/format'
import type { RestaurantMap, RestaurantTableMapItem } from '../types'
import '../tables.css'

type Props = {
  canOpen: boolean
  isBusy: boolean
  isOnline: boolean
  map: RestaurantMap
  onAreaChange: (areaId: string) => void
  onGroup: (tableIds: string[], guestCount: number) => Promise<void>
  onMove: (tableId: string) => Promise<void>
  onOpen: (tableIds: string[], guestCount: number) => Promise<void>
  onOpenOrder: (orderId: string) => void
  onQuickSale: () => void
  selectedAreaId?: string
  moveOrderId: string | null
  onCancelMove: () => void
  openCashPanel?: ReactNode
}

function elapsed(openedAt: string | null) {
  if (!openedAt) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000))
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`
}

export function TableMapView(props: Props) {
  const { canOpen, isBusy, isOnline, map, moveOrderId, onAreaChange, onCancelMove, onGroup, onMove, onOpen, onOpenOrder, onQuickSale, openCashPanel, selectedAreaId } = props
  const [groupMode, setGroupMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [pendingIds, setPendingIds] = useState<string[] | null>(null)
  const [guestCount, setGuestCount] = useState(2)
  const activeAreaId = selectedAreaId && map.areas.some((area) => area.id === selectedAreaId) ? selectedAreaId : map.areas[0]?.id
  const tables = useMemo(() => map.tables.filter((table) => table.areaId === activeAreaId), [activeAreaId, map.tables])
  const occupiedOrders = new Set(selectedIds.map((id) => map.tables.find((table) => table.id === id)?.orderId).filter(Boolean))

  function chooseTable(table: RestaurantTableMapItem) {
    if (!isOnline || isBusy) return
    if (moveOrderId) {
      if (table.status === 'free') void onMove(table.id)
      return
    }
    if (groupMode) {
      if (table.status === 'reserved') return
      setSelectedIds((current) => current.includes(table.id) ? current.filter((id) => id !== table.id) : [...current, table.id])
      return
    }
    if (table.status === 'occupied' && table.orderId) onOpenOrder(table.orderId)
    else if (table.status === 'free' && canOpen) {
      setPendingIds([table.id])
      setGuestCount(Math.max(1, table.capacity))
    }
  }

  async function confirmOpen() {
    if (!pendingIds) return
    if (pendingIds.length > 1) await onGroup(pendingIds, guestCount)
    else await onOpen(pendingIds, guestCount)
    setPendingIds(null)
    setSelectedIds([])
    setGroupMode(false)
  }

  return (
    <main className="table-map-screen">
      <header className="table-map-toolbar">
        <div><h1>Mapa de mesas</h1><p>Selecciona una mesa para abrir o recuperar su comanda.</p></div>
        <div className="table-map-actions">
          <button className="table-action secondary" disabled={!isOnline || isBusy || Boolean(moveOrderId)} onClick={() => { setGroupMode((value) => !value); setSelectedIds([]) }} type="button"><Link2 size={18} /> {groupMode ? 'Cancelar agrupacion' : 'Agrupar mesas'}</button>
          <button className="table-action primary" onClick={onQuickSale} type="button"><ShoppingBag size={18} /> Venta rapida</button>
        </div>
      </header>
      {!isOnline ? <div className="table-offline-warning">La gestion de mesas requiere conexion. La venta rapida sigue disponible.</div> : null}
      {!canOpen ? <div className="table-offline-warning">Abre una caja para poder abrir o cobrar comandas.</div> : null}
      {!canOpen && openCashPanel ? <div className="table-open-cash">{openCashPanel}</div> : null}
      {moveOrderId ? <div className="table-mode-banner"><ArrowRightLeft size={18} /><span>Selecciona una mesa libre como destino.</span><button onClick={onCancelMove} type="button"><X size={16} /> Cancelar</button></div> : null}
      {groupMode ? <div className="table-mode-banner"><Link2 size={18} /><span>Selecciona dos o mas mesas. Solo una puede estar ocupada.</span><button disabled={selectedIds.length < 2 || occupiedOrders.size > 1 || !canOpen} onClick={() => { setPendingIds(selectedIds); setGuestCount(Math.max(2, selectedIds.reduce((total, id) => total + (map.tables.find((table) => table.id === id)?.capacity ?? 0), 0))) }} type="button">Continuar ({selectedIds.length})</button></div> : null}
      <nav className="table-area-tabs" aria-label="Zonas">{map.areas.map((area) => <button className={area.id === activeAreaId ? 'active' : ''} key={area.id} onClick={() => onAreaChange(area.id)} type="button">{area.name}</button>)}</nav>
      <section className="table-map-canvas">
        {tables.map((table) => (
          <button
            aria-label={`${table.name}, ${table.status}`}
            className={`pos-table status-${table.status} shape-${table.shape}${selectedIds.includes(table.id) ? ' selected' : ''}${moveOrderId && table.status !== 'free' ? ' unavailable' : ''}`}
            key={table.id}
            onClick={() => chooseTable(table)}
            style={{ left: `${table.positionX}%`, top: `${table.positionY}%`, width: `${table.width}%`, height: `${table.height}%` }}
            type="button"
          >
            <strong>{table.name}</strong>
            <span>{table.status === 'free' ? 'Libre' : table.status === 'reserved' ? 'Reservada' : 'Ocupada'}</span>
            {table.status === 'occupied' ? <>
              <b>{formatCurrency(table.totalCents)}</b>
              <small><Users size={12} /> {table.guestCount} - {elapsed(table.orderOpenedAt)}</small>
              <small>{table.pendingUnits ? `${table.pendingUnits} por servir` : 'Todo servido OK'}</small>
              {table.groupTableIds.length > 1 ? <em>Grupo de {table.groupTableIds.length}</em> : null}
            </> : <small><Users size={12} /> {table.capacity}</small>}
          </button>
        ))}
        {!tables.length ? <div className="table-map-empty">No hay mesas activas en esta zona.</div> : null}
      </section>
      {pendingIds ? <div className="table-modal-backdrop"><section className="table-modal"><h2>{pendingIds.length > 1 ? `Agrupar ${pendingIds.length} mesas` : map.tables.find((table) => table.id === pendingIds[0])?.name}</h2><p>La comanda se guardara automaticamente y quedara disponible para los dispositivos del local.</p><label>Numero de comensales<input autoFocus min="1" onChange={(event) => setGuestCount(Math.max(1, Number(event.target.value)))} type="number" value={guestCount} /></label><div><button className="table-action secondary" onClick={() => setPendingIds(null)} type="button">Cancelar</button><button className="table-action primary" disabled={isBusy || !isOnline || !canOpen} onClick={() => void confirmOpen()} type="button">{pendingIds.length > 1 ? 'Confirmar agrupacion' : 'Abrir mesa'}</button></div></section></div> : null}
    </main>
  )
}
