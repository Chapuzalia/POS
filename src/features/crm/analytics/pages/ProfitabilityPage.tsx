import { useEffect, useMemo, useState } from 'react'
import { ChevronRight, X } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { formatMoney } from '../../../../lib/format'
import type { CatalogData } from '../../../catalog/domain/types'
import type { CrmStatsPeriod, TenantContext } from '../../../../types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { createCrmStatsPeriod, getDefaultCrmStatsPeriod } from '../services/analyticsPeriod'
import { loadCurrentProductProfitability, loadProfitabilityReport, profitabilityRange, type CurrentProductProfitability, type ProfitabilityMetricRow, type ProfitabilityReport } from '../services/profitabilityService'

const emptyReport: ProfitabilityReport = { summary: { net_sales_cents: 0, gross_sales_cents: 0, discounts_cents: 0, theoretical_cost_cents: 0, known_net_sales_cents: 0, known_gross_sales_cents: 0, known_lines: 0, line_count: 0 }, products: [], categories: [], timeline: [] }
const number = (value: unknown) => Number(value ?? 0)
const percent = (top: number, bottom: number) => bottom > 0 ? `${(top / bottom * 100).toLocaleString('es-ES', { maximumFractionDigits: 1 })} %` : 'Sin datos'
const periodInputClass = 'h-11 rounded-[10px] border border-transparent bg-[var(--crm-input-bg)] px-3 text-sm font-semibold text-[var(--crm-text)] outline-none'

type Props = { catalog: CatalogData | null; context: TenantContext; disabled: boolean; timeZone: string; venueId: string }

function Metric({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return <article className="rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]"><p className="m-0 text-xs font-bold uppercase tracking-wide text-[var(--crm-text-muted)]">{label}</p><p className="my-2 text-2xl font-black">{value}</p>{detail ? <p className="m-0 text-xs text-[var(--crm-text-muted)]">{detail}</p> : null}</article>
}

export function ProfitabilityCrm({ catalog, context, disabled, timeZone, venueId }: Props) {
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
    void loadProfitabilityReport(context, venueId, profitabilityRange(period, timeZone), { categoryId, productId })
      .then((next) => { if (active) setReport(next) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [categoryId, context, period, productId, timeZone, venueId])

  const rows = useMemo(() => [...report[view]].sort((left, right) => {
    const leftValue = number(left[sort])
    const rightValue = number(right[sort])
    return rightValue - leftValue || left.label.localeCompare(right.label, 'es')
  }), [report, sort, view])
  const categories = catalog?.categories ?? []
  const products = catalog?.products ?? []

  const openDetail = async (row: ProfitabilityMetricRow) => {
    if (view !== 'products' || row.id.startsWith('deleted:')) return
    const current = await loadCurrentProductProfitability(context, venueId, row.id)
    setDetail({ row, current })
  }

  return <div className="grid gap-4">
    <section className="grid gap-3 rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)] md:grid-cols-6">
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
    <section className="rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)]">
      <h2 className="mt-0 text-base font-black">Evolución temporal</h2>
      <div className="flex h-44 items-end gap-1 border-b border-[var(--crm-border-subtle)]">
        {report.timeline.map((point) => { const pointSales = number(point[salesKey]); const max = Math.max(1, ...report.timeline.map((item) => number(item[salesKey]))); return <div className="group flex min-w-0 flex-1 items-end gap-px" key={point.day} title={`${point.day}: ${formatMoney(pointSales)}`}><span className="w-1/2 rounded-t bg-[var(--crm-blue)]" style={{ height: `${Math.max(2, pointSales / max * 100)}%` }}/><span className="w-1/2 rounded-t bg-[var(--crm-red)]" style={{ height: `${Math.max(2, number(point.theoretical_cost_cents) / max * 100)}%` }}/></div> })}
      </div>
      <p className="mb-0 text-xs text-[var(--crm-text-muted)]">Azul: ventas · Rojo: coste teórico con snapshot</p>
    </section>
    <section className="overflow-x-auto rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
      <table className="w-full min-w-[800px] text-sm"><thead><tr className="text-left text-xs uppercase text-[var(--crm-text-muted)]">{[['label','Producto / categoría'],['units','Unidades'],[salesKey,'Ventas'],['theoretical_cost_cents','Coste'],['known_net_sales_cents','Margen'],['known_lines','Cobertura de los datos']].map(([key,label]) => <th className={`px-4 py-3 ${key === 'known_lines' ? 'w-[110px] max-w-[110px]' : ''}`} key={key}><button className="max-w-full whitespace-normal text-left font-bold leading-tight" onClick={() => setSort(key as keyof ProfitabilityMetricRow)}>{label}</button></th>)}<th className="px-4 py-3">Margen %</th><th className="px-4 py-3">Coste producto</th></tr></thead>
      <tbody>{rows.map((row) => { const rowSales = number(row[salesKey]); const rowKnownSales = number(row[knownSalesKey]); const rowCost = number(row.theoretical_cost_cents); return <tr className="border-t border-[var(--crm-border-subtle)]" key={`${row.dimension}:${row.id}`}><td className="px-4 py-3 font-bold"><button className="flex items-center gap-1 text-left" onClick={() => void openDetail(row)}>{row.label}{view === 'products' ? <ChevronRight className="size-4"/> : null}</button></td><td className="px-4 py-3">{number(row.units).toLocaleString('es-ES')}</td><td className="px-4 py-3">{formatMoney(rowSales)}</td><td className="px-4 py-3">{rowKnownSales ? formatMoney(rowCost) : 'Sin datos'}</td><td className="px-4 py-3">{rowKnownSales ? formatMoney(rowKnownSales - rowCost) : 'Sin datos'}</td><td className="px-4 py-3">{row.known_lines}/{row.line_count}</td><td className="px-4 py-3">{percent(rowKnownSales - rowCost, rowKnownSales)}</td><td className="px-4 py-3">{percent(rowCost, rowKnownSales)}</td></tr> })}</tbody></table>
      {loading ? <p className="p-4 text-sm text-[var(--crm-text-muted)]">Cargando rentabilidad…</p> : null}
    </section>
    {detail ? <div className="fixed inset-0 z-50 flex justify-end bg-black/45" onClick={() => setDetail(null)}><aside className="h-full w-full max-w-xl overflow-y-auto bg-[var(--crm-surface)] p-5" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between"><h2 className="text-xl font-black">{detail.row.label}</h2><Button aria-label="Cerrar detalle" onClick={() => setDetail(null)}><X className="size-5"/></Button></div><div className="grid gap-3 sm:grid-cols-2"><Metric label="PVP actual" value={detail.current ? formatMoney(detail.current.priceCents) : 'Sin datos'}/><Metric label="Coste actual" value={detail.current?.costKnown && detail.current.costCents != null ? formatMoney(detail.current.costCents) : 'Sin datos'}/><Metric label="Food cost actual" value={detail.current?.costKnown && detail.current.costCents != null ? percent(detail.current.costCents, detail.current.priceCents) : 'Sin datos'}/><Metric label="Descuentos del periodo" value={formatMoney(number(detail.row.discounts_cents))}/></div><h3 className="mt-6">Resultado del periodo</h3><p>Ventas con coste: {formatMoney(number(detail.row[knownSalesKey]))} · Coste: {formatMoney(number(detail.row.theoretical_cost_cents))} · Margen: {formatMoney(number(detail.row[knownSalesKey]) - number(detail.row.theoretical_cost_cents))}</p><h3 className="mt-6">Escandallo actual</h3><div className="grid gap-2">{detail.current?.components.map((component, index) => <div className="rounded-xl bg-[var(--crm-input-bg)] p-3" key={`${component.inventoryItemId}:${index}`}><p className="m-0 font-bold">{component.name ?? 'Componente'}</p><p className="mb-0 text-sm text-[var(--crm-text-muted)]">Cantidad: {number(component.quantity).toLocaleString('es-ES')} · Coste unitario: {component.known && component.unitCost != null ? `${component.unitCost.toLocaleString('es-ES', { maximumFractionDigits: 4 })} €` : 'Sin datos'} · Aporta: {(number(component.cost)).toLocaleString('es-ES', { maximumFractionDigits: 4 })} €</p></div>) ?? <p>Sin escandallo.</p>}</div></aside></div> : null}
  </div>
}
