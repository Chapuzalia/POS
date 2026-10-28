import { useEffect, useMemo, useRef, useState } from 'react'
import { Button } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { formatInventoryQuantity } from '../inventoryModel'
import { consumptionComparison, inventoryHistoryPeriod, movementLabel, recordedStockSegments } from '../stockHistoryModel'
import { loadInventoryItemConsumption, loadInventoryItemMovements } from '../services/inventoryService'
import type { InventoryConsumptionReport, InventoryItem, InventorySnapshot, InventoryStockMovement } from '../types'

type Props = {
  item: InventoryItem
  snapshot: InventorySnapshot
  context: TenantContext
  venueId: string
  initialWarehouseId?: string
  dayChangeTime: string | null
  timeZone: string
}

function RecordedStockChart({ movements, warehouseId, unitId, unitLabel, decimals, timeZone }: {
  movements: InventoryStockMovement[]; warehouseId: string; unitId: string; unitLabel: string; decimals: number; timeZone: string
}) {
  const segments = recordedStockSegments(movements, warehouseId, unitId)
  const points = segments.flat()
  if (!warehouseId) return <p className="text-sm text-[var(--crm-text-muted)]">Selecciona un almacén para consultar sus saldos registrados.</p>
  if (points.length < 2) return <p className="text-sm text-[var(--crm-text-muted)]">No hay suficientes movimientos con la misma unidad para mostrar la evolución. No se estima el stock anterior.</p>
  const values = points.map((point) => point.after)
  const min = Math.min(0, ...values)
  const max = Math.max(1, ...values)
  const first = new Date(points[0].createdAt).getTime()
  const last = new Date(points[points.length - 1].createdAt).getTime()
  const x = (point: InventoryStockMovement) => 64 + (new Date(point.createdAt).getTime() - first) / Math.max(1, last - first) * 600
  const y = (value: number) => 150 - (value - min) / (max - min) * 125
  const date = (value: string) => new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(new Date(value))
  return <div className="min-w-0"><svg aria-label={`Saldos registrados en ${unitLabel}. De ${date(points[0].createdAt)} a ${date(points[points.length - 1].createdAt)}`} className="h-auto w-full text-[var(--crm-blue)]" role="img" viewBox="0 0 700 190"><title>Evolución de saldos registrados ({unitLabel})</title>{[min, max].map((value) => <g key={value}><line className="stroke-[var(--crm-border-subtle)]" x1="64" x2="664" y1={y(value)} y2={y(value)} /><text className="fill-[var(--crm-text-muted)] text-[11px]" x="58" y={y(value) + 4} textAnchor="end">{formatInventoryQuantity(value, decimals)}</text></g>)}{segments.map((segment) => <g key={segment[0].id}>{segment.length > 1 ? <path d={segment.map((point, index) => index === 0 ? `M ${x(point)} ${y(point.after)}` : `H ${x(point)} V ${y(point.after)}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="2" /> : null}{segment.map((point) => <circle cx={x(point)} cy={y(point.after)} fill="currentColor" key={point.id} r="3"><title>{date(point.createdAt)}: {formatInventoryQuantity(point.after, decimals)} {unitLabel}</title></circle>)}</g>)}<text className="fill-[var(--crm-text-muted)] text-[10px]" x="64" y="179">{date(points[0].createdAt)}</text><text className="fill-[var(--crm-text-muted)] text-[10px]" x="664" y="179" textAnchor="end">{date(points[points.length - 1].createdAt)}</text></svg><p className="m-0 text-xs text-[var(--crm-text-muted)]">{unitLabel} · Solo saldos del historial cargado. Los tramos sin continuidad verificable quedan separados; no se extrapola hasta el stock actual.</p></div>
}

export function InventoryItemHistory({ item, snapshot, context, venueId, initialWarehouseId, dayChangeTime, timeZone }: Props) {
  const [days, setDays] = useState(7)
  const [warehouseId, setWarehouseId] = useState(initialWarehouseId ?? '')
  const [movements, setMovements] = useState<InventoryStockMovement[]>([])
  const [report, setReport] = useState<InventoryConsumptionReport | null>(null)
  const [historyError, setHistoryError] = useState<string | null>(null)
  const [reportError, setReportError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  const [asOf, setAsOf] = useState(() => new Date())
  const period = useMemo(() => inventoryHistoryPeriod(days, { dayChangeTime, timeZone }, asOf), [days, dayChangeTime, timeZone, asOf])
  const requestKey = `${context.tenantId}:${venueId}:${item.id}:${warehouseId}:${period.nowIso}`
  const activeRequest = useRef(requestKey)
  activeRequest.current = requestKey
  const [loadedKey, setLoadedKey] = useState('')
  const unit = snapshot.units.find((candidate) => candidate.id === item.baseUnitId)
  const quantity = (value: number) => `${formatInventoryQuantity(value, unit?.decimalPlaces ?? 6)} ${unit?.symbol ?? ''}`
  const comparison = report && loadedKey === requestKey ? consumptionComparison(report, period.currentStartDay, period.today) : null
  const dateTime = new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone })

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setHistoryError(null)
    setReportError(null)
    setMovements([])
    setReport(null)
    setHasMore(false)
    setLoadedKey(requestKey)
    void loadInventoryItemMovements(context, venueId, item.id, period.currentStartIso, period.nowIso, warehouseId || null)
      .then((data) => { if (!cancelled) { setMovements(data); setHasMore(data.length === 50) } })
      .catch(() => { if (!cancelled) setHistoryError('No se pudo cargar el historial. Vuelve a intentarlo.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    void loadInventoryItemConsumption(context, venueId, item.id, period.startIso, period.endIso, warehouseId || null)
      .then((data) => { if (!cancelled) setReport(data) })
      .catch((cause) => { if (!cancelled) setReportError(cause instanceof Error ? cause.message : 'No se pudo consultar el consumo.') })
    return () => { cancelled = true }
  }, [context, item.id, period, requestKey, venueId, warehouseId])

  async function loadMore() {
    setLoadingMore(true)
    setHistoryError(null)
    try {
      const data = await loadInventoryItemMovements(context, venueId, item.id, period.currentStartIso, period.nowIso, warehouseId || null, movements.length)
      if (activeRequest.current !== requestKey) return
      setMovements((current) => [...current, ...data])
      setHasMore(data.length === 50)
    } catch { if (activeRequest.current === requestKey) setHistoryError('No se pudieron cargar más movimientos. Vuelve a intentarlo.') }
    finally { setLoadingMore(false) }
  }

  return <section className="grid min-w-0 gap-4 border-t border-[var(--crm-border-subtle)] p-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="m-0 text-base font-bold">Consumo y movimientos</h3><Button disabled={loading || loadingMore} onClick={() => setAsOf(new Date())} size="sm" type="button" variant="tertiary">Actualizar historial</Button></div>
    <div className="grid gap-3 sm:grid-cols-2"><CrmSelect ariaLabel="Periodo de inventario" disabled={loadingMore} onChange={(value) => setDays(Number(value))} options={[7, 30, 90].map((value) => ({ label: `${value} días`, value: String(value) }))} value={String(days)} /><CrmSelect ariaLabel="Almacén del historial" disabled={loadingMore} onChange={(value) => setWarehouseId(value === 'all' ? '' : value)} options={[{ label: 'Todos los almacenes', value: 'all' }, ...snapshot.warehouses.map((warehouse) => ({ label: warehouse.name, value: warehouse.id }))]} value={warehouseId || 'all'} /></div>
    <div className="rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4"><p className="m-0 text-xs font-bold text-[var(--crm-text-muted)]">Consumo físico registrado por ventas · últimos {days} días operativos completos</p><p className="my-2 text-2xl font-black">{comparison ? quantity(comparison.current) : reportError ? 'No disponible' : 'Consultando…'}</p>{comparison ? <p className="m-0 text-xs text-[var(--crm-text-muted)]">Periodo anterior: {quantity(comparison.previous)}{comparison.percent !== null ? ` · ${comparison.percent > 0 ? '+' : ''}${comparison.percent.toLocaleString('es-ES', { maximumFractionDigits: 1 })} %` : ' · Sin comparación porcentual fiable'}</p> : null}<p className="mt-2 mb-0 text-xs text-[var(--crm-text-muted)]">Excluye hoy, compras, ajustes y consumo para elaboraciones. Las cantidades se expresan en la unidad física del artículo. Zona horaria: {timeZone}.</p></div>
    {reportError ? <p className="m-0 rounded-[var(--crm-radius-md)] bg-[var(--crm-red-soft)] p-3 text-sm text-[var(--crm-red)]" role="alert">{reportError}</p> : null}
    {report && (report.failureCount > 0 || report.incompatibleCount > 0) ? <p className="m-0 rounded-[var(--crm-radius-md)] bg-[var(--crm-yellow-soft)] p-3 text-xs text-[var(--crm-text)]" role="status">Cobertura parcial: {report.failureCount} incidencias de consumo registradas en el local durante ambos periodos; no se pueden atribuir con seguridad a este artículo. {report.incompatibleCount} movimientos con otra unidad excluidos. El consumo registrado puede ser inferior al real.</p> : null}
    {report && comparison && report.daily.some((day) => day.day >= period.currentStartDay) ? <div><h4 className="mb-2 text-sm font-bold">Consumo por día operativo</h4><div aria-label="Consumo diario registrado" className="grid max-h-52 gap-2 overflow-auto">{report.daily.filter((day) => day.day >= period.currentStartDay && day.day < period.today).map((day) => { const max = Math.max(...report.daily.map((entry) => entry.quantity), 1); return <div className="grid grid-cols-[80px_minmax(0,1fr)_auto] items-center gap-2 text-xs" key={day.day}><span>{new Intl.DateTimeFormat('es-ES', { day: '2-digit', month: 'short', timeZone: 'UTC' }).format(new Date(`${day.day}T12:00:00Z`))}</span><div className="h-2 overflow-hidden rounded-full bg-[var(--crm-border-subtle)]"><div className="h-full rounded-full bg-[var(--crm-blue)]" style={{ width: `${day.quantity / max * 100}%` }} /></div><span className="font-mono">{quantity(day.quantity)}</span></div> })}</div><p className="mt-2 mb-0 text-xs text-[var(--crm-text-muted)]">Se muestran los días con consumo registrado; sin movimiento registrado no implica ausencia de ventas.</p></div> : null}
    <div><h4 className="mb-2 text-sm font-bold">Evolución de existencias</h4>{!loading && loadedKey === requestKey ? <RecordedStockChart decimals={unit?.decimalPlaces ?? 6} movements={movements} timeZone={timeZone} unitId={item.baseUnitId} unitLabel={unit?.symbol ?? ''} warehouseId={warehouseId} /> : <p className="text-sm text-[var(--crm-text-muted)]">Cargando saldos…</p>}</div>
    <div><h4 className="mb-2 text-sm font-bold">Historial de movimientos</h4><p className="mb-3 text-xs text-[var(--crm-text-muted)]">Desde {period.currentStartDay}, incluye hoy. Los ajustes anteriores a la migración de trazabilidad y algunos traslados antiguos pueden no estar registrados.</p>
      {loading ? <p role="status">Cargando movimientos…</p> : !movements.length && !historyError ? <p className="text-sm text-[var(--crm-text-muted)]">No hay movimientos registrados en este periodo.</p> : <ol className="m-0 grid list-none gap-2 p-0">{movements.map((movement) => { const movementUnit = snapshot.units.find((candidate) => candidate.id === movement.unitId); const reference = movement.ticketLineId ?? movement.productionId ?? movement.sourceId; return <li className="grid gap-2 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]" key={movement.id}><div className="min-w-0"><strong className="block">{movementLabel(movement)}</strong><span className="block text-xs text-[var(--crm-text-muted)]">{dateTime.format(new Date(movement.createdAt))} · {snapshot.warehouses.find((warehouse) => warehouse.id === movement.warehouseId)?.name ?? 'Almacén histórico'}</span>{reference ? <details className="mt-1 text-xs text-[var(--crm-text-muted)]"><summary className="min-h-8 cursor-pointer">Referencia de origen</summary><span className="break-all">{reference}</span></details> : null}</div><div className="text-right font-mono"><strong>{movement.delta > 0 ? '+' : ''}{formatInventoryQuantity(movement.delta, movementUnit?.decimalPlaces ?? 6)} {movementUnit?.symbol ?? 'unidad histórica'}</strong><small className="block text-[var(--crm-text-muted)]">{formatInventoryQuantity(movement.before, movementUnit?.decimalPlaces ?? 6)} → {formatInventoryQuantity(movement.after, movementUnit?.decimalPlaces ?? 6)}</small></div></li> })}</ol>}
      {historyError ? <p className="text-sm text-[var(--crm-red)]" role="alert">{historyError}</p> : null}
      {hasMore ? <Button className="mt-3" disabled={loadingMore} onClick={() => void loadMore()} type="button" variant="secondary">{loadingMore ? 'Cargando…' : 'Cargar más movimientos'}</Button> : null}
    </div>
  </section>
}
