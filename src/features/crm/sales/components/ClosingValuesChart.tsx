import { useEffect, useMemo, useRef, useState } from 'react'
import { formatMoney } from '../../../../lib/format'
import type { CashClosingDailyValue } from '../services/cashClosingReportModel'
import { buildClosingChart, buildClosingTrend, type ClosingChartGrouping } from '../services/cashClosingChartModel'

const dateLabel = (date: string) => new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
const monthLabel = (date: string) => new Intl.DateTimeFormat('es-ES', { month: 'short', year: '2-digit', timeZone: 'UTC' }).format(new Date(`${date}T00:00:00Z`))
const axisMoney = (cents: number) => new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', notation: 'compact', maximumFractionDigits: 1 }).format(cents / 100)
const labels = { day: 'día', week: 'semana', month: 'mes' }

export function ClosingValuesChart({ values }: { values: CashClosingDailyValue[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [containerWidth, setContainerWidth] = useState(360)
  const [page, setPage] = useState<number | null>(null)
  useEffect(() => {
    const element = containerRef.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => setContainerWidth(entry.contentRect.width))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const [grouping, setGrouping] = useState<ClosingChartGrouping>('auto')
  const [showTrend, setShowTrend] = useState(false)
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const { resolution, periods } = useMemo(() => buildClosingChart(values, grouping), [values, grouping])
  const trendWindow = resolution === 'day' ? 7 : 3
  const trend = useMemo(() => buildClosingTrend(periods, trendWindow), [periods, trendWindow])
  const total = values.reduce((sum, value) => sum + value.totalCents, 0)
  const count = values.reduce((sum, value) => sum + value.closingCount, 0)
  const periodLabel = (period: typeof periods[number]) => resolution === 'month' ? monthLabel(period.date) : resolution === 'week' ? `${dateLabel(period.date)} – ${dateLabel(period.endDate)}` : dateLabel(period.date)
  const width = Math.max(240, containerWidth)
  const height = 280
  const left = width < 500 ? 55 : 75
  const plotWidth = width - left - 20
  const capacity = Math.max(1, Math.floor(plotWidth / 16))
  const pageCount = Math.max(1, Math.ceil(periods.length / capacity))
  const currentPage = Math.min(page ?? pageCount - 1, pageCount - 1)
  const pageSize = Math.ceil(periods.length / pageCount)
  const visiblePeriods = periods.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const selected = visiblePeriods.find(period => period.date === selectedDate)
  const slot = plotWidth / Math.max(visiblePeriods.length, 1)
  const rawMax = Math.max(0, ...periods.map(period => period.totalCents))
  const rawMin = Math.min(0, ...periods.map(period => period.totalCents))
  const rawStep = Math.max((rawMax - rawMin) / 4, 1)
  const magnitude = 10 ** Math.floor(Math.log10(rawStep))
  const step = [1, 2, 2.5, 5, 10].map(value => value * magnitude).find(value => value >= rawStep)!
  const minimum = Math.floor(rawMin / step) * step
  const maximum = Math.max(Math.ceil(rawMax / step) * step, minimum + step)
  const y = (value: number) => 220 - (value - minimum) / (maximum - minimum) * 195
  const ticks = Array.from({ length: Math.round((maximum - minimum) / step) + 1 }, (_, index) => minimum + index * step)
  const labelStep = Math.max(1, Math.ceil((width < 500 ? 78 : 105) / slot))
  const visibleTrend = trend.slice(currentPage * pageSize, (currentPage + 1) * pageSize)
  const trendPath = visibleTrend.map((value, index) => value === null ? '' :
    `${index === 0 || visibleTrend[index - 1] === null ? 'M' : 'L'} ${left + slot * (index + .5)} ${y(value)}`).join(' ')

  return <div ref={containerRef} className="!min-w-0">
    <div className="!mb-4 !flex !flex-wrap !items-center !justify-between !gap-3">
      <p className="!text-xs !text-[var(--crm-text-muted)]">Total por {labels[resolution]} · {periods.length} periodos</p>
      <div aria-label="Agrupación del gráfico" role="group" className="!grid !w-full !grid-cols-4 !gap-1 !rounded-xl sm:!w-auto !bg-[var(--crm-surface-soft)] !p-1">
        {([['auto', 'Automático'], ['day', 'Días'], ['week', 'Semanas'], ['month', 'Meses']] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={grouping === value} onClick={() => { setGrouping(value); setSelectedDate(null); setPage(null) }} className={`!min-h-11 !rounded-lg !px-2 !text-xs !font-semibold focus-visible:!outline-2 focus-visible:!outline-[var(--crm-blue)] ${grouping === value ? '!bg-[var(--crm-blue)] !text-white' : '!text-[var(--crm-text-muted)]'}`}>{label}</button>)}
      </div>
    </div>
    {!values.length ? <div className="!grid !min-h-64 !place-items-center !text-sm !text-[var(--crm-text-muted)]">No hay cierres en el período seleccionado.</div> : <>
      <div className="!mb-3 !grid !grid-cols-2 !gap-2 sm:!grid-cols-3">
        {[
          ['Total del periodo', formatMoney(total)],
          ['Media / día con cierres', formatMoney(Math.round(total / values.length))],
        ].map(([label, value]) => <div key={label} className="!min-w-0 !rounded-xl !bg-[var(--crm-surface-soft)] !px-3 !py-2.5"><span className="!block !text-[11px] !text-[var(--crm-text-muted)]">{label}</span><strong className="!mt-1 !block !text-base !tabular-nums sm:!text-lg">{value}</strong></div>)}
        <div className="!col-span-2 !rounded-xl !bg-[var(--crm-surface-soft)] !px-3 !py-2.5 !text-xs sm:!col-span-1"><strong>{count} cierres</strong><span className="!ml-2 !text-[var(--crm-text-muted)]">· {values.length} días con datos</span></div>
      </div>
      <div className="!mb-2 !flex !flex-wrap !items-center !gap-x-4 !gap-y-1">
        <label className="!inline-flex !min-h-11 !cursor-pointer !items-center !gap-2 !text-xs !font-semibold">
          <input type="checkbox" checked={showTrend} onChange={event => setShowTrend(event.target.checked)} className="!size-4 !accent-[var(--crm-blue)]" />
          <span aria-hidden="true" className="!h-0.5 !w-5 !bg-amber-500" />
          Mostrar tendencia
        </label>
        {showTrend && <span className="!text-xs !text-[var(--crm-text-muted)]">Media móvil de {trendWindow} {resolution === 'day' ? 'días operativos' : resolution === 'week' ? 'semanas' : 'meses'} · sin periodos vacíos</span>}
      </div>
      {pageCount > 1 && <div className="!mb-2 !flex !items-center !justify-between !gap-2 !text-xs">
        <button type="button" aria-label="Ver periodos anteriores" disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); setSelectedDate(null) }} className="!min-h-11 !rounded-lg !bg-[var(--crm-surface-soft)] !px-3 disabled:!opacity-40">← Anteriores</button>
        <span className="!text-[var(--crm-text-muted)]">{currentPage + 1} / {pageCount}</span>
        <button type="button" aria-label="Ver periodos siguientes" disabled={currentPage === pageCount - 1} onClick={() => { setPage(currentPage + 1); setSelectedDate(null) }} className="!min-h-11 !rounded-lg !bg-[var(--crm-surface-soft)] !px-3 disabled:!opacity-40">Siguientes →</button>
      </div>}
      <div className="!min-w-0">
        <svg role="group" aria-label={`Importe de cierres por ${labels[resolution]}. Cada barra permite consultar su detalle.`} viewBox={`0 0 ${width} ${height}`} className="!block !w-full !h-auto">
          {ticks.map(value => <g key={value}><line x1={left} x2={width - 20} y1={y(value)} y2={y(value)} stroke="var(--crm-border-subtle)" /><text x={left - 10} y={y(value) + 4} textAnchor="end" fill="var(--crm-text-muted)" fontSize="11">{axisMoney(value)}</text></g>)}
          {visiblePeriods.map((period, index) => {
            const x = left + slot * index
            const active = period.date === selectedDate
            const description = `${periodLabel(period)}: ${period.days ? `${formatMoney(period.totalCents)}, ${period.closingCount} cierres, ${period.days} días con datos` : 'Sin cierres registrados'}`
            return <g key={period.date}>
              <rect x={x + slot * .2} y={Math.min(y(0), y(period.totalCents))} width={slot * .6} height={Math.max(2, Math.abs(y(0) - y(period.totalCents)))} rx="3" fill={period.days ? 'var(--crm-blue)' : 'var(--crm-text-muted)'} opacity={active ? 1 : period.days ? .7 : .25} />
              <rect x={x} y="20" width={slot} height="205" fill={active ? 'var(--crm-blue)' : 'transparent'} fillOpacity={active ? .08 : 0} stroke={active ? 'var(--crm-blue)' : 'none'} strokeDasharray="3 3" role="button" tabIndex={0} aria-label={description} aria-pressed={active} className="!cursor-pointer !outline-none" onMouseEnter={() => setSelectedDate(period.date)} onFocus={() => setSelectedDate(period.date)} onClick={() => setSelectedDate(period.date)} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedDate(period.date) } }}><title>{description}</title></rect>
              {index % labelStep === 0 && <text x={Math.min(width - 38, Math.max(left + 22, x + slot / 2))} y="250" textAnchor="middle" fontSize="11" fill="var(--crm-text-muted)">{resolution === 'month' ? monthLabel(period.date) : dateLabel(period.date)}</text>}
            </g>
          })}
          {showTrend && <g pointerEvents="none" role="img" aria-label={`Tendencia de facturación: media móvil de ${trendWindow} periodos con datos disponibles`}>
            <path d={trendPath} fill="none" stroke="#f59e0b" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
            {visibleTrend.map((value, index) => value !== null &&
              (index === 0 || visibleTrend[index - 1] === null) &&
              (index === visibleTrend.length - 1 || visibleTrend[index + 1] === null)
              ? <circle key={index} cx={left + slot * (index + .5)} cy={y(value)} r="3" fill="#f59e0b" /> : null)}
          </g>}
        </svg>
      </div>
      <div role="status" aria-live="polite" className="!min-h-12 !flex !flex-wrap !items-center !gap-x-3 !gap-y-1 !rounded-xl !bg-[var(--crm-surface-soft)] !px-3 !py-3 !text-xs sm:!text-sm">
        {selected ? <><strong>{periodLabel(selected)}</strong><span>{selected.days ? `${formatMoney(selected.totalCents)} · ${selected.closingCount} cierres · ${selected.days} días con datos` : 'Sin cierres registrados'}</span></> : <span className="!text-[var(--crm-text-muted)]">Toca una barra para ver el detalle. También puedes usar el teclado.</span>}
      </div>
      <p className="!mt-2 !mb-3 !text-xs !text-[var(--crm-text-muted)]">{dateLabel(values[0].date)} – {dateLabel(values[values.length - 1].date)} · {resolution === 'day' ? 'Solo se muestran días operativos con cierres registrados.' : 'Solo se suman cierres registrados; los huecos indican periodos sin datos. Las semanas empiezan el lunes.'}</p>
    </>}
  </div>
}
