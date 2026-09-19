import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { formatMoney } from '../../../../lib/format'
import { getOperationalPeriodRangeIso } from '../../../../lib/operationalDay'
import type { CatalogData } from '../../../catalog/domain/types'
import type { CrmStatsPeriod, TenantContext } from '../../../../types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { createCrmStatsPeriod, getDefaultCrmStatsPeriod } from '../services/analyticsPeriod'
import { loadCurrentProductProfitability, loadProfitabilityReport, type CurrentProductProfitability, type ProfitabilityMetricRow, type ProfitabilityReport } from '../services/profitabilityService'

const emptyReport: ProfitabilityReport = { summary: { net_sales_cents: 0, gross_sales_cents: 0, discounts_cents: 0, theoretical_cost_cents: 0, known_net_sales_cents: 0, known_gross_sales_cents: 0, known_lines: 0, line_count: 0 }, products: [], categories: [], timeline: [] }
const number = (value: unknown) => Number(value ?? 0)
const percent = (top: number, bottom: number) => bottom > 0 ? `${(top / bottom * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %` : 'Sin datos'
const visualMarginScale = (value: number) => Math.pow(Math.max(0, Math.min(1, value)), 2)
const periodInputClass = 'h-11 rounded-[10px] border border-transparent bg-[var(--crm-input-bg)] px-3 text-sm font-semibold text-[var(--crm-text)] outline-none'

type Props = { catalog: CatalogData | null; context: TenantContext; dayChangeTime: string | null; disabled: boolean; timeZone: string; venueId: string }

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]"><p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">{label}</p><p className="my-2 text-2xl font-black">{value}</p>{detail ? <p className="m-0 text-xs text-[var(--crm-text-muted)]">{detail}</p> : null}</article>
}

function ProductMarginQuadrant({ perspective, products, onSelect }: { perspective: 'net' | 'gross'; products: ProfitabilityMetricRow[]; onSelect: (row: ProfitabilityMetricRow) => void }) {
  const [limit, setLimit] = useState('30')
  const [ranking, setRanking] = useState<'sales' | 'margin'>('sales')
  const salesKey = perspective === 'net' ? 'net_sales_cents' : 'gross_sales_cents'
  const knownSalesKey = perspective === 'net' ? 'known_net_sales_cents' : 'known_gross_sales_cents'
  const availablePoints = products.filter((row) => number(row[knownSalesKey]) > 0)
  const points = [...availablePoints].sort((left, right) => {
    const leftKnownSales = number(left[knownSalesKey])
    const rightKnownSales = number(right[knownSalesKey])
    const leftValue = ranking === 'sales' ? number(left[salesKey]) : (leftKnownSales - number(left.theoretical_cost_cents)) / leftKnownSales
    const rightValue = ranking === 'sales' ? number(right[salesKey]) : (rightKnownSales - number(right.theoretical_cost_cents)) / rightKnownSales
    return rightValue - leftValue || number(right[salesKey]) - number(left[salesKey]) || left.label.localeCompare(right.label, 'es')
  }).slice(0, limit === 'all' ? undefined : Number(limit))
  const maxSales = Math.max(1, ...points.map((row) => number(row[salesKey])))
  const maxUnits = Math.max(1, ...points.map((row) => number(row.units)))

  return <section className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="m-0 text-base font-black">Productos: ventas y margen</h2><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">Derecha: más ventas · Arriba: más margen, en una escala visual reforzada de 0 % a 100 % · El tamaño representa unidades vendidas.</p></div><div className="flex flex-wrap items-end gap-3"><label className="grid min-w-[160px] gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">Ordenar por<CrmSelect ariaLabel="Orden del cuadrante" compact onChange={(value) => setRanking(value as 'sales' | 'margin')} options={[{ label: 'Más ventas', value: 'sales' }, { label: 'Mejor margen', value: 'margin' }]} value={ranking}/></label><label className="grid min-w-[145px] gap-1 text-[10px] font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">Mostrar<CrmSelect ariaLabel="Productos visibles" compact onChange={setLimit} options={[{ label: 'Top 15', value: '15' }, { label: 'Top 30', value: '30' }, { label: 'Top 50', value: '50' }, { label: 'Todos', value: 'all' }]} value={limit}/></label></div></div>
    <p className="mt-2 mb-0 text-xs text-[var(--crm-text-muted)]">Mostrando {points.length} de {availablePoints.length} productos con datos de coste.</p>
    {points.length ? <div className="mt-4 overflow-x-auto"><svg aria-label="Cuadrante de ventas y margen por producto" className="min-w-[560px] w-full" role="img" viewBox="0 0 800 330"><line stroke="var(--crm-border-subtle)" strokeWidth="1" x1="62" x2="770" y1="275" y2="275"/><line stroke="var(--crm-border-subtle)" strokeWidth="1" x1="62" x2="62" y1="24" y2="275"/><line stroke="var(--crm-border-subtle)" strokeDasharray="4 4" strokeWidth="1" x1="62" x2="770" y1="149" y2="149"/><text fill="var(--crm-text-muted)" fontSize="11" x="8" y="28">100 %</text><text fill="var(--crm-text-muted)" fontSize="11" x="8" y="275">0 %</text><text fill="var(--crm-text-muted)" fontSize="11" x="62" y="302">Menos ventas</text><text fill="var(--crm-text-muted)" fontSize="11" textAnchor="end" x="770" y="302">Más ventas</text>{points.map((row) => { const sales = number(row[salesKey]); const knownSales = number(row[knownSalesKey]); const marginPercentage = (knownSales - number(row.theoretical_cost_cents)) / knownSales; const x = 62 + sales / maxSales * 708; const y = 275 - visualMarginScale(marginPercentage) * 251; const radius = 8 + number(row.units) / maxUnits * 18; const fill = marginPercentage >= 0.6 ? 'var(--crm-green)' : marginPercentage >= 0.35 ? 'var(--crm-blue)' : 'var(--crm-red)'; return <g className="cursor-pointer" key={row.id} onClick={() => onSelect(row)}><title>{`${row.label} · Ventas: ${formatMoney(sales)} · Margen: ${percent(knownSales - number(row.theoretical_cost_cents), knownSales)} · Unidades: ${number(row.units).toLocaleString('es-ES')}`}</title><circle cx={x} cy={y} fill={fill} fillOpacity="0.8" r={radius} stroke="var(--crm-surface)" strokeWidth="2"/><text fill="var(--crm-text)" fontSize="10" textAnchor="middle" x={x} y={y + 3}>{row.label.slice(0, 12)}</text></g> })}</svg></div> : <div className="mt-4 grid h-44 place-items-center rounded-xl bg-[var(--crm-input-bg)] text-sm text-[var(--crm-text-muted)]">Aún no hay productos con datos de coste.</div>}
    <p className="mt-3 mb-0 text-xs text-[var(--crm-text-muted)]">Pulsa un producto para abrir su detalle. Verde: margen alto · Azul: margen medio · Rojo: margen bajo.</p>
  </section>
}

function ProfitabilityEvolution({ report, perspective }: { report: ProfitabilityReport; perspective: 'net' | 'gross' }) {
  const salesKey = perspective === 'net' ? 'net_sales_cents' : 'gross_sales_cents'
  const knownSalesKey = perspective === 'net' ? 'known_net_sales_cents' : 'known_gross_sales_cents'
  const maximum = Math.max(1, ...report.timeline.map((point) => number(point[salesKey])))
  const labelEvery = Math.max(1, Math.ceil(report.timeline.length / 8))
  const [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [hoveredDay, setHoveredDay] = useState<string | null>(null)
  const activeDay = selectedDay ?? hoveredDay
  const selectedPoint = report.timeline.find((point) => point.day === activeDay)
  const selectedTotal = number(selectedPoint?.[salesKey])
  const selectedKnown = number(selectedPoint?.[knownSalesKey])
  const selectedCost = Math.min(number(selectedPoint?.theoretical_cost_cents), selectedKnown)
  const selectedMargin = Math.max(0, selectedKnown - selectedCost)
  const selectedUnknown = Math.max(0, selectedTotal - selectedKnown)

  return <section className="min-w-0 max-w-full overflow-hidden rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="m-0 text-base font-black">Composición de la rentabilidad</h2><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">Cada barra representa las ventas del día y separa coste, margen y ventas sin datos de coste.</p></div><div className="flex flex-wrap gap-3 text-xs font-semibold"><span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-[var(--crm-red)]"/>Coste producto</span><span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-[var(--crm-green)]"/>Margen</span><span className="flex items-center gap-1.5"><i className="size-2.5 rounded-sm bg-[var(--crm-text-muted)] opacity-35"/>Sin datos</span></div></div>
    {report.timeline.length ? <div className="mt-5 w-full max-w-full overflow-hidden pb-5"><div className="flex h-56 w-full min-w-0 items-end gap-1 border-b border-[var(--crm-border-subtle)] px-1">
      {report.timeline.map((point, index) => { const total = number(point[salesKey]); const known = number(point[knownSalesKey]); const cost = Math.min(number(point.theoretical_cost_cents), known); const margin = Math.max(0, known - cost); const unknown = Math.max(0, total - known); const height = total / maximum * 100; return <button aria-label={`Ver rentabilidad del ${point.day}`} className="group relative flex h-full min-w-[5px] flex-1 flex-col justify-end !border-0 !bg-transparent p-0 shadow-none outline-none focus-visible:!ring-0" key={point.day} onBlur={() => setHoveredDay(null)} onClick={() => setSelectedDay((current) => current === point.day ? null : point.day)} onMouseEnter={() => setHoveredDay(point.day)} onMouseLeave={() => setHoveredDay(null)} type="button"><div className={`flex w-full flex-col-reverse overflow-hidden rounded-t-sm transition-[opacity,filter] ${activeDay === point.day ? 'ring-2 ring-inset ring-[var(--crm-blue)]/55' : 'group-hover:opacity-80'}`} style={{ height: `${Math.max(2, height)}%` }}><span className="w-full bg-[var(--crm-red)]" style={{ height: `${total ? cost / total * 100 : 0}%` }}/><span className="w-full bg-[var(--crm-green)]" style={{ height: `${total ? margin / total * 100 : 0}%` }}/><span className="w-full bg-[var(--crm-text-muted)] opacity-35" style={{ height: `${total ? unknown / total * 100 : 0}%` }}/></div>{activeDay === point.day ? <span className="hidden absolute bottom-[calc(100%+8px)] left-1/2 z-20 w-44 -translate-x-1/2 rounded-xl border border-[var(--crm-popover-border)] bg-[var(--crm-popover-bg)] p-3 text-left text-[11px] text-[var(--crm-popover-text)] shadow-[var(--crm-shadow-floating)] hidden"><strong className="mb-1.5 block text-xs">{new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(new Date(`${point.day}T12:00:00`))}</strong><span className="block">Ventas: {formatMoney(total)}</span><span className="block">Coste producto: {formatMoney(cost)}</span><span className="block">Margen: {formatMoney(margin)}</span><span className="block">Sin datos: {formatMoney(unknown)}</span><span className="mt-1 block font-bold">Margen: {percent(margin, known)}</span></span> : null}{index % labelEvery === 0 ? <span className="absolute top-full mt-1 text-[9px] text-[var(--crm-text-muted)]">{point.day.slice(5)}</span> : null}</button> })}
     </div></div> : <div className="mt-4 grid h-44 place-items-center rounded-xl bg-[var(--crm-input-bg)] text-sm text-[var(--crm-text-muted)]">No hay ventas en el periodo seleccionado.</div>}
    {selectedPoint ? <div className="mt-2 rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3 text-sm"><strong className="block">{new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(new Date(`${selectedPoint.day}T12:00:00`))}</strong><div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs text-[var(--crm-text-muted)]"><span>Ventas: {formatMoney(selectedTotal)}</span><span>Coste: {formatMoney(selectedCost)}</span><span>Margen: {formatMoney(selectedMargin)}</span><span>Sin datos: {formatMoney(selectedUnknown)}</span></div><p className="mt-2 mb-0 text-xs font-bold">Margen: {percent(selectedMargin, selectedKnown)}</p></div> : null}
    <p className="mt-6 mb-0 text-xs text-[var(--crm-text-muted)]">Pasa el cursor o toca una barra para consultar sus importes.</p>
  </section>
}

export function ProfitabilityCrm({ catalog, context, dayChangeTime, disabled, timeZone, venueId }: Props) {
  const operationalDayConfig = useMemo(() => ({ dayChangeTime, timeZone }), [dayChangeTime, timeZone])
  const today = new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date())
  const [period, setPeriod] = useState<CrmStatsPeriod>(() => getDefaultCrmStatsPeriod('month', today))
  const [perspective, setPerspective] = useState<'net' | 'gross'>('net')
  const [view, setView] = useState<'products' | 'categories'>('products')
  const [categoryId, setCategoryId] = useState('')
  const [productId, setProductId] = useState('')
  const [report, setReport] = useState(emptyReport)
  const [loading, setLoading] = useState(false)
  const [sort, setSort] = useState<keyof ProfitabilityMetricRow>('gross_sales_cents')
  const [detail, setDetail] = useState<{ row: ProfitabilityMetricRow; current: CurrentProductProfitability | null } | null>(null)
  const salesKey = perspective === 'net' ? 'net_sales_cents' : 'gross_sales_cents'
  const knownSalesKey = perspective === 'net' ? 'known_net_sales_cents' : 'known_gross_sales_cents'
  const summary = report.summary
  const sales = number(summary[salesKey])
  const knownSales = number(summary[knownSalesKey])
  const cost = number(summary.theoretical_cost_cents)

  useEffect(() => {
    if (!venueId) return
    let active = true
    setLoading(true)
    void loadProfitabilityReport(context, venueId, getOperationalPeriodRangeIso(operationalDayConfig, period.startDate, period.endDate), { categoryId, productId })
      .then((next) => { if (active) setReport(next) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [categoryId, context, operationalDayConfig, period, productId, venueId])

  const rows = useMemo(() => [...report[view]].sort((left, right) => {
    const leftValue = number(left[sort])
    const rightValue = number(right[sort])
    return rightValue - leftValue || left.label.localeCompare(right.label, 'es')
  }), [report, sort, view])
  const categories = catalog?.categories ?? []
  const products = catalog?.products ?? []

  const openDetail = async (row: ProfitabilityMetricRow) => {
    if (view !== 'products' || row.id.startsWith('deleted:')) return
    setDetail({ row, current: null })
    try {
      const current = await loadCurrentProductProfitability(context, venueId, row.id, getOperationalPeriodRangeIso(operationalDayConfig, period.startDate, period.endDate))
      setDetail((detail) => detail?.row.id === row.id ? { row, current } : detail)
    } catch {
      setDetail((detail) => detail?.row.id === row.id ? { row, current: null } : detail)
    }
  }

  return <div className="grid gap-4">
    <section className="grid gap-3 rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)] md:w-full md:grid-cols-6 md:items-end">
      <label className="grid gap-1 text-xs font-bold">Desde<input className={periodInputClass} disabled={disabled} type="date" value={period.startDate} onChange={(event) => setPeriod(createCrmStatsPeriod('period', event.target.value, period.endDate < event.target.value ? event.target.value : period.endDate))}/></label>
      <label className="grid gap-1 text-xs font-bold">Hasta<input className={periodInputClass} disabled={disabled} type="date" value={period.endDate} onChange={(event) => setPeriod(createCrmStatsPeriod('period', period.startDate > event.target.value ? event.target.value : period.startDate, event.target.value))}/></label>
      <CrmSelect ariaLabel="Categoría" disabled={disabled} onChange={setCategoryId} options={[{ label: 'Todas las categorías', value: '' }, ...categories.map((item) => ({ label: item.name, value: item.id }))]} searchable value={categoryId}/>
      <CrmSelect ariaLabel="Producto" disabled={disabled} onChange={setProductId} options={[{ label: 'Todos los productos', value: '' }, ...products.map((item) => ({ label: item.name, value: item.id }))]} searchable value={productId}/>
      <CrmSelect ariaLabel="Perspectiva" disabled={disabled} onChange={(value) => setPerspective(value as 'net' | 'gross')} options={[{ label: 'Con descuentos', value: 'net' }, { label: 'Sin descuentos', value: 'gross' }]} value={perspective}/>
      <CrmSelect ariaLabel="Vista" disabled={disabled} onChange={(value) => setView(value as 'products' | 'categories')} options={[{ label: 'Por producto', value: 'products' }, { label: 'Por categoría', value: 'categories' }]} value={view}/>
    </section>
    <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Metric label="Ventas" value={formatMoney(sales)} detail={`Descuentos: ${formatMoney(number(summary.discounts_cents))}`}/>
      <Metric label="Coste teórico" value={knownSales ? formatMoney(cost) : 'Sin datos'} detail={`${number(summary.known_lines)} de ${number(summary.line_count)} líneas con coste`}/>
      <Metric label="Margen bruto" value={knownSales ? formatMoney(knownSales - cost) : 'Sin datos'} detail={`Cobertura de los datos: ${percent(knownSales, sales)}`}/>
      <Metric label="Margen %" value={percent(knownSales - cost, knownSales)}/>
      <Metric label="Coste producto" value={percent(cost, knownSales)}/>
    </section>
    <ProfitabilityEvolution perspective={perspective} report={report}/>
    <ProductMarginQuadrant onSelect={(row) => void openDetail(row)} perspective={perspective} products={report.products}/>
    <section className="overflow-x-auto rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
      <table className="w-full min-w-[800px] text-sm"><thead><tr className="text-left text-xs uppercase text-[var(--crm-text-muted)]">{[['label','Producto / categoría'],['units','Unidades'],[salesKey,'Ventas'],['theoretical_cost_cents','Coste'],['known_net_sales_cents','Margen'],['known_lines','Cobertura de los datos']].map(([key,label]) => <th className={`px-4 py-3 ${key === 'known_lines' ? 'w-[110px] max-w-[110px]' : ''}`} key={key}><button className="max-w-full whitespace-normal text-left font-bold leading-tight" onClick={() => setSort(key as keyof ProfitabilityMetricRow)}>{label}</button></th>)}<th className="px-4 py-3">Margen %</th><th className="px-4 py-3">Coste producto</th></tr></thead>
      <tbody>{rows.map((row) => { const rowSales = number(row[salesKey]); const rowKnownSales = number(row[knownSalesKey]); const rowCost = number(row.theoretical_cost_cents); return <tr className="border-t border-[var(--crm-border-subtle)]" key={`${row.dimension}:${row.id}`}><td className="px-4 py-3 font-bold"><button className="flex items-center gap-1 text-left" onClick={() => void openDetail(row)}>{row.label}{view === 'products' ? <ChevronRight className="size-4"/> : null}</button></td><td className="px-4 py-3">{number(row.units).toLocaleString('es-ES')}</td><td className="px-4 py-3">{formatMoney(rowSales)}</td><td className="px-4 py-3">{rowKnownSales ? formatMoney(rowCost) : 'Sin datos'}</td><td className="px-4 py-3">{rowKnownSales ? formatMoney(rowKnownSales - rowCost) : 'Sin datos'}</td><td className="px-4 py-3">{row.known_lines}/{row.line_count}</td><td className="px-4 py-3">{percent(rowKnownSales - rowCost, rowKnownSales)}</td><td className="px-4 py-3">{percent(rowCost, rowKnownSales)}</td></tr> })}</tbody></table>
      {loading ? <p className="p-4 text-sm text-[var(--crm-text-muted)]">Cargando rentabilidad…</p> : null}
    </section>
    {detail ? <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/60 p-0 sm:p-4" onClick={() => setDetail(null)}><aside className="h-full w-full max-w-3xl overflow-y-auto rounded-none border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-4 shadow-2xl sm:rounded-3xl sm:p-6" onClick={(event) => event.stopPropagation()}><div className="sticky top-0 z-10 -mx-4 -mt-4 flex items-center justify-between border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] px-4 py-4 sm:-mx-6 sm:-mt-6 sm:px-6"><div><p className="m-0 text-xs font-bold uppercase tracking-[0.18em] text-[var(--crm-text-muted)]">Ficha de rentabilidad</p><h2 className="mt-1 text-2xl font-black">{detail.row.label}</h2></div><Button aria-label="Cerrar detalle" onClick={() => setDetail(null)}><X className="size-5"/></Button></div><section className="mt-6 rounded-2xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-4"><div className="flex flex-wrap items-end justify-between gap-3"><div><p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">Resultado del periodo</p><p className="mt-1 mb-0 text-sm text-[var(--crm-text-muted)]">{period.startDate} — {period.endDate}</p></div><p className="m-0 text-3xl font-black text-[var(--crm-green)]">{formatMoney(number(detail.row[knownSalesKey]) - number(detail.row.theoretical_cost_cents))}</p></div><div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4"><div><p className="m-0 text-xs font-bold uppercase text-[var(--crm-text-muted)]">Ventas</p><p className="mt-1 mb-0 text-lg font-black">{formatMoney(number(detail.row[salesKey]))}</p></div><div><p className="m-0 text-xs font-bold uppercase text-[var(--crm-text-muted)]">Unidades</p><p className="mt-1 mb-0 text-lg font-black">{number(detail.row.units).toLocaleString('es-ES')}</p></div><div><p className="m-0 text-xs font-bold uppercase text-[var(--crm-text-muted)]">Coste</p><p className="mt-1 mb-0 text-lg font-black">{formatMoney(number(detail.row.theoretical_cost_cents))}</p></div><div><p className="m-0 text-xs font-bold uppercase text-[var(--crm-text-muted)]">Margen</p><p className="mt-1 mb-0 text-lg font-black">{percent(number(detail.row[knownSalesKey]) - number(detail.row.theoretical_cost_cents), number(detail.row[knownSalesKey]))}</p></div></div><p className="mt-4 mb-0 text-xs text-[var(--crm-text-muted)]">Coste disponible en {detail.row.known_lines} de {detail.row.line_count} líneas · Descuentos: {formatMoney(number(detail.row.discounts_cents))}</p></section><section className="mt-6"><div className="flex items-baseline justify-between gap-3"><div><h3 className="m-0 text-lg font-black">Cómo se ha vendido</h3><p className="mt-1 mb-0 text-sm text-[var(--crm-text-muted)]">Formatos, mixers y rentabilidad de cada combinación.</p></div></div><div className="mt-4 grid gap-3">{detail.current?.breakdown.map((breakdown) => <article className="rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3" key={`${breakdown.variantId}:${breakdown.formatName}`}><div className="flex items-start justify-between gap-3"><div><p className="m-0 font-bold">{breakdown.formatName}</p><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">{number(breakdown.units).toLocaleString('es-ES')} unidades · {breakdown.knownLines}/{breakdown.lineCount} líneas con coste</p></div><strong>{formatMoney(number(perspective === 'net' ? breakdown.netSalesCents : breakdown.grossSalesCents))}</strong></div><div className="mt-3 grid grid-cols-2 gap-2 text-xs"><span>Coste: {breakdown.knownNetSalesCents ? formatMoney(breakdown.theoreticalCostCents) : 'Sin datos'}</span><span>Margen: {breakdown.knownNetSalesCents ? formatMoney(breakdown.knownNetSalesCents - breakdown.theoreticalCostCents) : 'Sin datos'}</span></div>{breakdown.mixers.length ? <div className="mt-3 border-t border-[var(--crm-border-subtle)] pt-3"><p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">Mixers</p><div className="mt-2 grid gap-1">{breakdown.mixers.map((mixer) => <div className="flex justify-between gap-3 text-sm" key={mixer.name}><span>{mixer.name}</span><span className="text-[var(--crm-text-muted)]">{number(mixer.units).toLocaleString('es-ES')} uds.</span></div>)}</div></div> : <p className="mt-3 mb-0 text-xs text-[var(--crm-text-muted)]">Sin mixer registrado; puede ser un chupito u otro formato.</p>}</article>)}{detail.current?.breakdown.length ? null : <p className="m-0 text-sm text-[var(--crm-text-muted)]">No hay ventas en el periodo seleccionado.</p>}</div></section><section className="mt-6 border-t border-[var(--crm-border-subtle)] pt-6"><div><h3 className="m-0 text-lg font-black">Combinaciones vendidas</h3><p className="mt-1 mb-0 text-sm text-[var(--crm-text-muted)]">Despliega una combinación para consultar sus ventas, coste y margen.</p></div><div className="mt-4 grid gap-2">{detail.current?.combinations.map((combination) => { const combinationSales = number(perspective === 'net' ? combination.netSalesCents : combination.grossSalesCents); const combinationKnownSales = number(perspective === 'net' ? combination.knownNetSalesCents : combination.knownGrossSalesCents); const combinationMargin = combinationKnownSales - number(combination.theoreticalCostCents); return <details className="group rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)]" key={`${combination.variantId}:${combination.formatName}:${combination.name}`}><summary className="flex cursor-pointer list-none items-center justify-between gap-3 p-3"><div><p className="m-0 font-bold">{combination.name}</p><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">{combination.formatName} · {number(combination.units).toLocaleString('es-ES')} unidades · {combination.lineCount} ventas</p></div><strong>{formatMoney(combinationSales)}</strong></summary><div className="grid grid-cols-2 gap-3 border-t border-[var(--crm-border-subtle)] p-3 text-sm sm:grid-cols-4"><div><p className="m-0 text-xs text-[var(--crm-text-muted)]">Ventas</p><strong>{formatMoney(combinationSales)}</strong></div><div><p className="m-0 text-xs text-[var(--crm-text-muted)]">Coste</p><strong>{combinationKnownSales ? formatMoney(number(combination.theoreticalCostCents)) : 'Sin datos'}</strong></div><div><p className="m-0 text-xs text-[var(--crm-text-muted)]">Margen</p><strong>{combinationKnownSales ? formatMoney(combinationMargin) : 'Sin datos'}</strong></div><div><p className="m-0 text-xs text-[var(--crm-text-muted)]">Margen %</p><strong>{percent(combinationMargin, combinationKnownSales)}</strong></div></div>{combination.selections.length ? <div className="flex flex-wrap gap-1 border-t border-[var(--crm-border-subtle)] px-3 py-2">{combination.selections.map((selection, index) => <span className="rounded-full bg-[var(--crm-surface)] px-2 py-1 text-xs" key={`${selection.type}:${selection.name}:${index}`}>{selection.type === 'mixer' ? 'Mixer: ' : 'Modificador: '}{selection.name}</span>)}</div> : null}</details> })}{detail.current?.combinations.length ? null : <p className="m-0 rounded-xl bg-[var(--crm-input-bg)] p-3 text-sm text-[var(--crm-text-muted)]">No hay combinaciones registradas en el periodo seleccionado.</p>}</div></section><section className="mt-6 border-t border-[var(--crm-border-subtle)] pt-6"><div><h3 className="m-0 text-lg font-black">Escandallos actuales</h3><p className="mt-1 mb-0 text-sm text-[var(--crm-text-muted)]">Coste configurado hoy para cada formato; no modifica el coste histórico anterior.</p></div><div className="mt-4 grid gap-3">{detail.current?.variants.map((variant) => <article className="rounded-xl bg-[var(--crm-input-bg)] p-3" key={variant.variantId}><div className="flex items-start justify-between gap-3"><div><p className="m-0 font-bold">{variant.variantName}</p><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">{variant.formatName ?? 'Sin formato'} · PVP {formatMoney(variant.priceCents)}</p></div><span className="text-sm font-bold">{variant.costKnown && variant.costCents != null ? formatMoney(variant.costCents) : 'Sin datos'}</span></div><div className="mt-2 grid gap-2">{variant.components.map((component, index) => <div className="rounded-lg border border-[var(--crm-border-subtle)] p-2 text-sm" key={`${component.inventoryItemId}:${index}`}><p className="m-0 font-bold">{component.name ?? 'Componente'}</p><p className="mb-0 text-xs text-[var(--crm-text-muted)]">Cantidad: {number(component.quantity).toLocaleString('es-ES')} · Coste unitario: {component.known && component.unitCost != null ? `${component.unitCost.toLocaleString('es-ES', { maximumFractionDigits: 4 })} €` : 'Sin datos'} · Aporta: {number(component.cost).toLocaleString('es-ES', { maximumFractionDigits: 4 })} €</p></div>)}</div></article>)}</div>{detail.current ? null : <div className="mt-4 rounded-xl border border-dashed border-[var(--crm-border-subtle)] p-4 text-sm text-[var(--crm-text-muted)]">No se ha podido cargar el desglose por formatos todavía. El resumen del periodo sigue siendo correcto.</div>}</section></aside></div> : null}
  </div>
}
