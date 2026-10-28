import { ChevronRight, RefreshCw } from 'lucide-react'
import { useDeferredValue, useMemo, useRef, useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import { DataTable } from '../../../../components/ui/DataTable'
import { formatMoney } from '../../../../lib/format'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import { formatInventoryQuantity } from '../inventoryModel'
import { buildStockRows, filterStockRows, prioritizeStockAlerts, stockCoverage, stockStateLabels, summarizeStock, type StockActivity, type StockFilter, type StockRow } from '../stockControlModel'
import type { InventorySnapshot } from '../types'

type Props = {
  snapshot: InventorySnapshot
  disabled: boolean
  onOpen: (itemId: string, warehouseId?: string) => void
  onRefresh: () => void
  onReplenish: (row: StockRow) => void
}

function ReplenishButton({ row, disabled, onReplenish }: { row: StockRow; disabled: boolean; onReplenish: Props['onReplenish'] }) {
  if (!row.controlled || !row.warehouse || !row.unit) return null
  return <Button aria-label={`Reponer ${row.item.name} en ${row.warehouse.name}`} disabled={disabled} onClick={() => onReplenish(row)} size="sm" type="button" variant="secondary">Reponer</Button>
}

export function StockStatus({ row }: { row: StockRow }) {
  const color = row.state === 'negative' ? 'bg-[var(--crm-red-soft)] text-[var(--crm-red)]'
    : row.state === 'replenish' ? 'bg-[var(--crm-yellow-soft)] text-[var(--crm-text)]'
      : row.state === 'healthy' ? 'bg-[var(--crm-green-soft)] text-[var(--crm-green)]'
        : 'bg-[var(--crm-surface-soft)] text-[var(--crm-text-muted)]'
  return <span className={`inline-flex rounded-[var(--crm-radius-sm)] px-2 py-1 text-xs font-semibold ${color}`}>{stockStateLabels[row.state]}</span>
}

export function StockCoverage({ row }: { row: StockRow }) {
  const coverage = stockCoverage(row.quantity, row.target)
  const color = !coverage ? 'bg-[var(--crm-surface-soft)] text-[var(--crm-text-muted)]'
    : coverage.tone === 'red' ? 'bg-[var(--crm-red-soft)] text-[var(--crm-red)]'
      : coverage.tone === 'orange' ? 'bg-[var(--crm-orange-soft)] text-[var(--crm-orange)]'
        : 'bg-[var(--crm-green-soft)] text-[var(--crm-green)]'
  return <span className={`inline-flex rounded-[var(--crm-radius-sm)] px-2 py-1 text-xs font-semibold tabular-nums ${color}`} title="Existencias disponibles respecto al objetivo del almacén">{coverage ? `${coverage.percentage.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %` : row.target === 0 ? 'Objetivo 0 · Sin porcentaje' : 'Sin objetivo'}</span>
}

export function StockQuantity({ row, quantity = row.quantity }: { row: StockRow; quantity?: number }) {
  return <span className="font-mono tabular-nums">{formatInventoryQuantity(quantity, row.unit?.decimalPlaces ?? 6)} {row.unit?.symbol}</span>
}

export function StockTarget({ row }: { row: StockRow }) {
  return <div className="grid gap-2">
    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--crm-text-muted)]">
      <span>Disponible <strong className="text-[var(--crm-text)]"><StockQuantity row={row} /></strong></span>
      <span>Objetivo {row.target === null ? 'sin configurar' : <StockQuantity quantity={row.target} row={row} />}</span>
    </div>
    {row.target !== null && row.target > 0 ? <div aria-label={`Existencias respecto al objetivo de ${row.item.name}`} aria-valuemax={row.target} aria-valuemin={0} aria-valuenow={Math.max(0, Math.min(row.quantity, row.target))} aria-valuetext={`${formatInventoryQuantity(row.quantity, row.unit?.decimalPlaces ?? 6)} de ${formatInventoryQuantity(row.target, row.unit?.decimalPlaces ?? 6)} ${row.unit?.symbol ?? ''}`} className="h-1.5 overflow-hidden rounded-full bg-[var(--crm-border-subtle)]" role="progressbar"><div className={`h-full rounded-full ${row.state === 'negative' ? 'bg-[var(--crm-red)]' : row.shortage > 0 ? 'bg-[var(--crm-yellow)]' : 'bg-[var(--crm-green)]'}`} style={{ width: `${Math.max(0, Math.min(100, row.quantity / row.target * 100))}%` }} /></div> : null}
    {row.shortage > 0 ? <p className="m-0 text-xs text-[var(--crm-text-muted)]">Faltan <strong className="text-[var(--crm-text)]"><StockQuantity quantity={row.shortage} row={row} /></strong> para alcanzar el objetivo.</p> : null}
  </div>
}

const filters: Array<{ value: StockFilter; label: string }> = [
  { value: 'all', label: 'Todos' }, { value: 'replenish', label: 'Por reponer' },
  { value: 'negative', label: 'Stock negativo' }, { value: 'no-target', label: 'Sin objetivo' },
  { value: 'valued', label: 'Con valoración' }, { value: 'unknown-cost', label: 'Sin coste' },
  { value: 'controlled', label: 'Controlados' },
]

export function StockOverview({ snapshot, disabled, onOpen, onRefresh, onReplenish }: Props) {
  const [filter, setFilter] = useState<StockFilter>('all')
  const [query, setQuery] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [kind, setKind] = useState('')
  const [activity, setActivity] = useState<StockActivity>('all')
  const [limit, setLimit] = useState(50)
  const listRef = useRef<HTMLElement>(null)
  const deferredQuery = useDeferredValue(query)
  const rows = useMemo(() => buildStockRows(snapshot), [snapshot])
  const summary = useMemo(() => summarizeStock(rows), [rows])
  const visibleRows = useMemo(() => filterStockRows(rows, filter, deferredQuery, warehouseId, kind, activity), [rows, filter, deferredQuery, warehouseId, kind, activity])
  const alerts = useMemo(() => prioritizeStockAlerts(rows), [rows])

  function showFilter(next: StockFilter) {
    setFilter(next)
    setQuery('')
    setWarehouseId('')
    setKind('')
    setActivity('all')
    setLimit(50)
    listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const metrics: Array<{ label: string; value: string | number; detail: string; filter: StockFilter }> = [
    { label: 'Artículos por reponer', value: summary.replenishCount, detail: 'Por debajo de su objetivo en algún almacén', filter: 'replenish' },
    { label: 'Existencias negativas', value: summary.negativeCount, detail: 'Artículos que requieren revisión', filter: 'negative' },
    { label: 'Valor estimado', value: summary.valueCents === null ? 'Sin valoración' : `≈ ${formatMoney(summary.valueCents)}`, detail: `${summary.partial ? 'Parcial · ' : ''}${summary.valuedCount} de ${summary.heldCount} artículos con saldo y coste conocido`, filter: 'valued' },
    { label: 'Artículos controlados', value: summary.controlledCount, detail: 'Artículos activos con almacenes habilitados', filter: 'controlled' },
  ]

  return <div className="grid min-w-0 gap-5">
    <div aria-label="Resumen de inventario" className="grid grid-cols-2 gap-3 xl:grid-cols-4">{metrics.map((metric) => <button className="grid min-w-0 gap-2 rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] p-4 text-left sm:p-5 shadow-[var(--crm-shadow-card)] transition-shadow hover:ring-1 hover:ring-[var(--crm-blue)] focus-visible:outline-2 focus-visible:outline-[var(--crm-blue)]" key={metric.label} onClick={() => showFilter(metric.filter)} type="button"><span className="text-xs font-bold text-[var(--crm-text-muted)]">{metric.label}</span><strong className="break-words text-xl font-black tabular-nums sm:text-2xl">{metric.value}</strong><span className="text-xs text-[var(--crm-text-muted)]">{metric.detail}</span></button>)}</div>
    <p className="m-0 text-xs text-[var(--crm-text-muted)]">Valoración por coste medio; en su ausencia, última compra o referencia. Incluye saldos negativos. Los costes desconocidos no se consideran cero.</p>

    <section className="min-w-0 rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3"><div><h3 className="m-0 text-base font-bold">Necesitan atención</h3><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">{alerts.length ? `${alerts.length} situaciones por artículo y almacén. Primero, el mayor porcentaje por reponer; los saldos sin objetivo positivo se muestran después.` : 'No hay saldos negativos ni faltantes respecto a los objetivos configurados.'}</p></div><Button onClick={() => showFilter('replenish')} type="button" variant="secondary">Ver artículos por reponer</Button></div>
      <div className="grid gap-3 lg:grid-cols-2">{alerts.slice(0, 6).map((row) => <article className="grid min-w-0 gap-3 rounded-[var(--crm-radius-md)] border border-[var(--crm-border-subtle)] p-4" key={row.key}><div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><button className="min-h-10 break-words text-left font-bold hover:text-[var(--crm-blue)]" onClick={() => onOpen(row.item.id, row.warehouse?.id)} type="button">{row.item.name}</button><p className="m-0 text-xs text-[var(--crm-text-muted)]">{row.warehouse?.name ?? 'Almacén no disponible'}{!row.controlled ? ' · Fuera de control activo' : ''}</p></div><StockStatus row={row} /></div><StockTarget row={row} /><div className="flex flex-wrap gap-2"><Button onClick={() => onOpen(row.item.id, row.warehouse?.id)} size="sm" type="button" variant="tertiary">Ver artículo <ChevronRight className="size-4" /></Button><ReplenishButton disabled={disabled} onReplenish={onReplenish} row={row} /></div></article>)}</div>
      {alerts.length > 6 ? <Button className="mt-4" onClick={() => showFilter('negative')} type="button" variant="tertiary">Ver saldos negativos</Button> : null}
      {alerts.length > 6 ? <Button className="mt-4" onClick={() => showFilter('replenish')} type="button" variant="tertiary">Ver todos los faltantes</Button> : null}
    </section>

    <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]" ref={listRef}>
      <div className="grid gap-4 p-5"><div className="flex items-center justify-between gap-3"><div><h3 className="m-0 text-base font-bold">Todas las existencias</h3><p aria-live="polite" className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">{visibleRows.length} posiciones de stock · una fila por artículo y almacén</p></div><Button aria-label="Actualizar inventario" disabled={disabled} onClick={onRefresh} type="button" variant="tertiary"><RefreshCw className="size-4" /></Button></div>
        <div aria-label="Estado del inventario" className="flex flex-wrap gap-2" role="group">{filters.map((entry) => <Button active={filter === entry.value} aria-pressed={filter === entry.value} key={entry.value} onClick={() => { setFilter(entry.value); setLimit(50) }} size="sm" type="button" variant="tertiary">{entry.label}</Button>)}</div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><Input aria-label="Buscar artículo o almacén" onChange={(event) => { setQuery(event.target.value); setLimit(50) }} placeholder="Buscar artículo o almacén…" value={query} /><CrmSelect ariaLabel="Filtrar por almacén" onChange={(value) => { setWarehouseId(value === 'all' ? '' : value); setLimit(50) }} options={[{ label: 'Todos los almacenes', value: 'all' }, ...snapshot.warehouses.map((warehouse) => ({ label: warehouse.name, value: warehouse.id }))]} value={warehouseId || 'all'} /><CrmSelect ariaLabel="Filtrar por tipo de artículo" onChange={(value) => { setKind(value === 'all' ? '' : value); setLimit(50) }} options={[{ label: 'Todos los tipos', value: 'all' }, { label: 'Artículo', value: 'item' }, { label: 'Elaboración', value: 'preparation' }]} value={kind || 'all'} /><CrmSelect ariaLabel="Filtrar artículos activos o inactivos" onChange={(value) => { setActivity(value === 'active' ? 'active' : value === 'inactive' ? 'inactive' : 'all'); setLimit(50) }} options={[{ label: 'Activos e inactivos', value: 'all' }, { label: 'Solo activos', value: 'active' }, { label: 'Solo inactivos', value: 'inactive' }]} value={activity} /></div>
      </div>
      {!rows.length ? <div className="p-5"><EmptyList message="Todavía no hay artículos. Usa Nuevo artículo para configurar el primero y sus almacenes." /></div> : !visibleRows.length ? <div className="p-5"><EmptyList message="No hay artículos que coincidan con estos filtros." /></div> : <>
        <div className="grid gap-3 px-5 pb-5 lg:hidden">{visibleRows.slice(0, limit).map((row) => <article className="grid min-w-0 gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4" key={row.key}><div className="flex flex-wrap justify-between gap-2"><button className="min-h-11 break-words text-left font-bold" onClick={() => onOpen(row.item.id, row.warehouse?.id)} type="button">{row.item.name}</button><StockCoverage row={row} /></div><p className="m-0 text-xs text-[var(--crm-text-muted)]">{row.warehouse?.name ?? 'Sin almacén configurado'} · {row.isPreparation ? 'Elaboración' : 'Artículo'}{!row.item.active ? ' · Inactivo' : ''}{!row.controlled ? ' · Fuera de control activo' : ''}</p><StockTarget row={row} /><ReplenishButton disabled={disabled} onReplenish={onReplenish} row={row} /><Button onClick={() => onOpen(row.item.id, row.warehouse?.id)} type="button" variant="tertiary">Ver artículo <ChevronRight className="size-4" /></Button></article>)}</div>
        <div className="hidden lg:block"><DataTable aria-label="Stock por artículo y almacén" className="!w-full !border-collapse" filterable={false}><thead><tr><th>Artículo</th><th>Disponible</th><th>Objetivo</th><th>Estado</th><th>Almacén</th><th aria-label="Acciones" data-sortable="false" /></tr></thead><tbody>{visibleRows.slice(0, limit).map((row) => <tr key={row.key}><td data-sort-value={row.item.name}><button className="min-h-11 text-left font-bold" onClick={() => onOpen(row.item.id, row.warehouse?.id)} type="button">{row.item.name}<small className="block font-normal text-[var(--crm-text-muted)]">{row.isPreparation ? 'Elaboración' : 'Artículo'}{!row.item.active ? ' · Inactivo' : ''}{!row.controlled ? ' · Fuera de control activo' : ''}</small></button></td><td data-sort-value={row.quantity}><strong className={row.quantity < 0 ? 'text-[var(--crm-red)]' : ''}><StockQuantity row={row} /></strong></td><td data-sort-value={row.target ?? -1}>{row.target === null ? 'Sin objetivo' : <StockQuantity quantity={row.target} row={row} />}</td><td data-sort-value={stockCoverage(row.quantity, row.target)?.percentage ?? Number.NEGATIVE_INFINITY}><StockCoverage row={row} /></td><td>{row.warehouse?.name ?? 'Sin almacén configurado'}</td><td><div className="flex items-center gap-2"><ReplenishButton disabled={disabled} onReplenish={onReplenish} row={row} /><Button aria-label={`Ver stock de ${row.item.name} en ${row.warehouse?.name ?? 'almacén'}`} onClick={() => onOpen(row.item.id, row.warehouse?.id)} size="sm" type="button" variant="tertiary"><ChevronRight className="size-4" /></Button></div></td></tr>)}</tbody></DataTable></div>
        {visibleRows.length > limit ? <div className="p-4 text-center"><Button onClick={() => setLimit((current) => current + 50)} type="button" variant="secondary">Mostrar más ({Math.min(limit, visibleRows.length)} de {visibleRows.length})</Button></div> : null}
      </>}
    </section>
  </div>
}
