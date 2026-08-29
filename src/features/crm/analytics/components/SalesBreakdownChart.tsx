import { useState } from 'react'
import { formatMoney } from '../../../../lib/format'
import type { CrmStats } from '../../../../types'

type BreakdownMode = 'categories' | 'products'
type BreakdownMetric = 'amount' | 'quantity'
type BreakdownItem = CrmStats['salesByCategory'][number]

type ChartSegment = BreakdownItem & {
  color: string
  comparisonPercentage: number | null
  comparisonValue: number | null
  percentage: number
}

const chartColors = ['#1478ed', '#16b865', '#f5b942', '#e73567', '#8b5cf6', '#06a9c7', '#f97316', '#64748b']
const percentFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, minimumFractionDigits: 0 })
const signedPercentFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1, signDisplay: 'exceptZero' })

function getBreakdownValue(item: BreakdownItem, metric: BreakdownMetric) {
  return metric === 'amount' ? item.totalCents : item.quantity
}

function groupSmallSegments(items: BreakdownItem[], metric: BreakdownMetric) {
  const maximumNamedSegments = 7
  const sortedItems = items.toSorted((left, right) => getBreakdownValue(right, metric) - getBreakdownValue(left, metric))
  if (sortedItems.length <= maximumNamedSegments + 1) return sortedItems
  const namedItems = sortedItems.slice(0, maximumNamedSegments)
  const groupedItems = sortedItems.slice(maximumNamedSegments)
  return [
    ...namedItems,
    {
      id: 'other',
      label: 'Otros',
      quantity: groupedItems.reduce((total, item) => total + item.quantity, 0),
      totalCents: groupedItems.reduce((total, item) => total + item.totalCents, 0),
    },
  ]
}

function truncateLabel(label: string) {
  return label.length > 21 ? label.slice(0, 20) + '…' : label
}

function Toggle({
  checked,
  checkedLabel,
  label,
  onToggle,
  uncheckedLabel,
}: {
  checked: boolean
  checkedLabel: string
  label: string
  onToggle: () => void
  uncheckedLabel: string
}) {
  return (
    <div className="!flex !items-center !gap-2" aria-label={label} role="group">
      <span className={!checked ? '!text-xs !font-bold !text-[var(--crm-text)]' : '!text-xs !font-semibold !text-[var(--crm-text-muted)]'}>{uncheckedLabel}</span>
      <button aria-checked={checked} aria-label={label} className="!relative !h-7 !w-12 !shrink-0 !rounded-full !border-0 !bg-[var(--crm-blue)] !p-0 !shadow-inner !outline-none focus-visible:!ring-2 focus-visible:!ring-[var(--crm-blue)]" onClick={onToggle} role="switch" type="button">
        <span className={checked ? '!absolute !top-1 !left-6 !size-5 !rounded-full !bg-white !shadow-sm !transition-[left]' : '!absolute !top-1 !left-1 !size-5 !rounded-full !bg-white !shadow-sm !transition-[left]'} />
      </button>
      <span className={checked ? '!text-xs !font-bold !text-[var(--crm-text)]' : '!text-xs !font-semibold !text-[var(--crm-text-muted)]'}>{checkedLabel}</span>
    </div>
  )
}

export function SalesBreakdownChart({ comparisonLabel, comparisonStats, stats }: { comparisonLabel: string; comparisonStats: CrmStats | null; stats: CrmStats | null }) {
  const [mode, setMode] = useState<BreakdownMode>('categories')
  const [metric, setMetric] = useState<BreakdownMetric>('amount')
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null)
  const items = mode === 'categories' ? stats?.salesByCategory ?? [] : stats?.salesByProduct ?? []
  const comparisonItems = mode === 'categories' ? comparisonStats?.salesByCategory ?? [] : comparisonStats?.salesByProduct ?? []
  const groupedItems = groupSmallSegments(items, metric)
  const groupedComparisonItems = groupSmallSegments(comparisonItems, metric)
  const total = groupedItems.reduce((sum, item) => sum + getBreakdownValue(item, metric), 0)
  const comparisonTotal = groupedComparisonItems.reduce((sum, item) => sum + getBreakdownValue(item, metric), 0)
  const comparisonById = new Map(groupedComparisonItems.map((item) => [item.id, item]))
  const segments: ChartSegment[] = groupedItems.map((item, index) => {
    const comparisonItem = comparisonById.get(item.id)
    return {
      ...item,
      color: chartColors[index % chartColors.length] ?? '#64748b',
      comparisonPercentage: comparisonItem && comparisonTotal > 0 ? (getBreakdownValue(comparisonItem, metric) / comparisonTotal) * 100 : comparisonStats ? 0 : null,
      comparisonValue: comparisonItem ? getBreakdownValue(comparisonItem, metric) : comparisonStats ? 0 : null,
      percentage: total > 0 ? (getBreakdownValue(item, metric) / total) * 100 : 0,
    }
  })
  const activeSegment = segments.find((segment) => segment.id === activeSegmentId) ?? null
  let accumulatedPercentage = 0

  const selectMode = (nextMode: BreakdownMode) => {
    setMode(nextMode)
    setActiveSegmentId(null)
  }
  const selectMetric = (nextMetric: BreakdownMetric) => {
    setMetric(nextMetric)
    setActiveSegmentId(null)
  }
  const formatValue = (item: BreakdownItem | null, fallback: number) => metric === 'amount'
    ? formatMoney(item?.totalCents ?? fallback)
    : (item?.quantity ?? fallback).toLocaleString('es-ES') + ' uds'

  return (
    <div className="!px-[18px] !pb-[18px] md:!px-[22px] md:!pb-[22px]">
      <div className="!mb-4 !flex !flex-wrap !items-start !justify-between !gap-3">
        <div>
          <span className="!text-lg !font-bold !text-[var(--crm-text)]">Distribución de ventas</span>
          {comparisonStats ? <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">La variación se muestra en puntos porcentuales de cuota.</p> : null}
        </div>
        <div className="!flex !flex-wrap !items-center !gap-x-5 !gap-y-2">
          <Toggle checked={mode === 'products'} checkedLabel="Productos" label="Cambiar entre categorías y productos" onToggle={() => selectMode(mode === 'categories' ? 'products' : 'categories')} uncheckedLabel="Categorías" />
          <Toggle checked={metric === 'quantity'} checkedLabel="Cantidad" label="Cambiar entre importe y cantidad" onToggle={() => selectMetric(metric === 'amount' ? 'quantity' : 'amount')} uncheckedLabel="Importe" />
        </div>
      </div>

      {!total ? (
        <div className="!grid !min-h-64 !place-items-center !rounded-xl !bg-[var(--crm-surface-soft)] !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
          No hay ventas de productos en el período actual.
        </div>
      ) : (
        <div className="!grid !grid-cols-1 !items-center !gap-7 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4 sm:!p-6 md:!grid-cols-[minmax(240px,0.8fr)_minmax(0,1.2fr)] lg:!gap-10">
          <div className="!relative !mx-auto !aspect-square !w-full !max-w-[280px]">
            <svg aria-label={'Ventas por ' + (mode === 'categories' ? 'categoría' : 'producto') + ' según ' + (metric === 'amount' ? 'importe' : 'cantidad')} className="!h-full !w-full !overflow-visible" role="img" viewBox="0 0 220 220">
              <circle cx="110" cy="110" fill="none" r="76" stroke="var(--crm-surface)" strokeWidth="31" />
              {segments.map((segment) => {
                const startPercentage = accumulatedPercentage
                accumulatedPercentage += segment.percentage
                const visiblePercentage = segments.length === 1 ? segment.percentage : segment.percentage - Math.min(0.55, segment.percentage * 0.18)
                const isInactive = activeSegmentId !== null && activeSegmentId !== segment.id
                return (
                  <circle
                    aria-label={segment.label + ': ' + formatValue(segment, 0) + ', ' + percentFormatter.format(segment.percentage) + ' %'}
                    className="!outline-none !transition-[opacity,stroke-width] !duration-150 focus-visible:!opacity-100"
                    cx="110"
                    cy="110"
                    fill="none"
                    key={segment.id}
                    onBlur={() => setActiveSegmentId(null)}
                    onFocus={() => setActiveSegmentId(segment.id)}
                    onMouseEnter={() => setActiveSegmentId(segment.id)}
                    onMouseLeave={() => setActiveSegmentId(null)}
                    pathLength="100"
                    r="76"
                    role="img"
                    stroke={segment.color}
                    strokeDasharray={String(visiblePercentage) + ' ' + String(100 - visiblePercentage)}
                    strokeDashoffset={-startPercentage}
                    strokeLinecap="butt"
                    strokeWidth={activeSegmentId === segment.id ? 35 : 31}
                    style={{ opacity: isInactive ? 0.42 : 1, transform: 'rotate(-90deg)', transformOrigin: '110px 110px' }}
                    tabIndex={0}
                  />
                )
              })}
              <text fill="var(--crm-text-muted)" fontSize="11" fontWeight="600" textAnchor="middle" x="110" y="101">{activeSegment ? truncateLabel(activeSegment.label) : metric === 'amount' ? 'Total vendido' : 'Unidades vendidas'}</text>
              <text fill="var(--crm-text)" fontSize="17" fontWeight="800" textAnchor="middle" x="110" y="124">{formatValue(activeSegment, total)}</text>
              {activeSegment ? <text fill="var(--crm-text-muted)" fontSize="10" fontWeight="700" textAnchor="middle" x="110" y="141">{percentFormatter.format(activeSegment.percentage)} % del total</text> : null}
            </svg>
          </div>

          <div className="!grid !min-w-0 !grid-cols-1 !gap-2 sm:!grid-cols-2">
            {segments.map((segment) => {
              const shareChange = segment.comparisonPercentage === null ? null : segment.percentage - segment.comparisonPercentage
              const shareColor = shareChange === null || Math.abs(shareChange) < 0.05
                ? '!bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]'
                : shareChange > 0
                  ? '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]'
                  : '!bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'
              return (
                <div className={activeSegmentId === segment.id ? '!flex !min-h-[66px] !min-w-0 !items-center !gap-3 !rounded-[10px] !bg-[var(--crm-surface)] !px-3 !py-2.5 !shadow-sm' : '!flex !min-h-[66px] !min-w-0 !items-center !gap-3 !rounded-[10px] !px-3 !py-2.5 !transition-colors hover:!bg-[var(--crm-surface)]'} key={segment.id} onMouseEnter={() => setActiveSegmentId(segment.id)} onMouseLeave={() => setActiveSegmentId(null)}>
                  <span className="!size-3 !shrink-0 !rounded-full" style={{ backgroundColor: segment.color }} />
                  <div className="!grid !min-w-0 !flex-1 !gap-0.5">
                    <strong className="!truncate !text-[13px] !font-semibold !text-[var(--crm-text)]">{segment.label}</strong>
                    <span className="!flex !flex-wrap !items-center !gap-1.5 !text-[11px] !font-medium !text-[var(--crm-text-muted)]">
                      {percentFormatter.format(segment.percentage)} % · {segment.quantity.toLocaleString('es-ES')} uds
                      {shareChange !== null ? <b className={'!rounded-full !px-1.5 !py-0.5 !text-[9px] !font-bold !tabular-nums ' + shareColor}>{signedPercentFormatter.format(shareChange)} pp</b> : null}
                    </span>
                    {segment.comparisonValue !== null && segment.comparisonPercentage !== null ? (
                      <small className="!text-[10px] !font-semibold !text-[var(--crm-text-secondary)]">
                        {comparisonLabel}: {metric === 'amount' ? formatMoney(segment.comparisonValue) : segment.comparisonValue.toLocaleString('es-ES') + ' uds'} · {percentFormatter.format(segment.comparisonPercentage)} %
                      </small>
                    ) : null}
                  </div>
                  <b className="!shrink-0 !text-[13px] !font-bold !tabular-nums !text-[var(--crm-text)]">{metric === 'amount' ? formatMoney(segment.totalCents) : segment.quantity.toLocaleString('es-ES')}</b>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
