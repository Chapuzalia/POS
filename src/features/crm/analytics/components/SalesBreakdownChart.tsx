import { useState } from 'react'
import { formatMoney } from '../../../../lib/format'
import type { CrmStats } from '../../../../types'

type BreakdownMode = 'categories' | 'products'
type BreakdownItem = CrmStats['salesByCategory'][number]

type ChartSegment = BreakdownItem & {
  color: string
  percentage: number
}

const chartColors = [
  '#1478ed',
  '#16b865',
  '#f5b942',
  '#e73567',
  '#8b5cf6',
  '#06a9c7',
  '#f97316',
  '#64748b',
]

const percentFormatter = new Intl.NumberFormat('es-ES', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
})

function groupSmallSegments(items: BreakdownItem[]) {
  const maximumNamedSegments = 7
  if (items.length <= maximumNamedSegments + 1) return items

  const namedItems = items.slice(0, maximumNamedSegments)
  const groupedItems = items.slice(maximumNamedSegments)
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
  return label.length > 21 ? `${label.slice(0, 20)}…` : label
}

export function SalesBreakdownChart({ stats }: { stats: CrmStats | null }) {
  const [mode, setMode] = useState<BreakdownMode>('categories')
  const [activeSegmentId, setActiveSegmentId] = useState<string | null>(null)
  const items = mode === 'categories' ? stats?.salesByCategory ?? [] : stats?.salesByProduct ?? []
  const groupedItems = groupSmallSegments(items)
  const totalCents = groupedItems.reduce((total, item) => total + item.totalCents, 0)
  const segments: ChartSegment[] = groupedItems.map((item, index) => ({
    ...item,
    color: chartColors[index % chartColors.length] ?? '#64748b',
    percentage: totalCents > 0 ? (item.totalCents / totalCents) * 100 : 0,
  }))
  const activeSegment = segments.find((segment) => segment.id === activeSegmentId) ?? null
  let accumulatedPercentage = 0

  const selectMode = (nextMode: BreakdownMode) => {
    setMode(nextMode)
    setActiveSegmentId(null)
  }

  return (
    <div className="!px-[18px] !pb-[18px] md:!px-[22px] md:!pb-[22px]">
      <div className="!mb-4 !flex !flex-wrap !items-center !justify-between !gap-3">
        <span className="!text-lg !font-bold !text-[var(--crm-text)]">Distribución de ventas</span>
        <div className="!flex !items-center !gap-2.5" aria-label="Agrupar ventas" role="group">
          <span className={mode === 'categories' ? '!text-xs !font-bold !text-[var(--crm-text)]' : '!text-xs !font-semibold !text-[var(--crm-text-muted)]'}>
            Categorías
          </span>
          <button
            aria-checked={mode === 'products'}
            aria-label="Cambiar entre categorías y productos"
            className="!relative !h-7 !w-12 !shrink-0 !rounded-full !border-0 !bg-[var(--crm-blue)] !p-0 !shadow-inner !outline-none !transition-colors focus-visible:!ring-2 focus-visible:!ring-[var(--crm-blue)] focus-visible:!ring-offset-2 focus-visible:!ring-offset-[var(--crm-surface)]"
            onClick={() => selectMode(mode === 'categories' ? 'products' : 'categories')}
            role="switch"
            type="button"
          >
            <span className={mode === 'products' ? '!absolute !top-1 !left-6 !size-5 !rounded-full !bg-white !shadow-sm !transition-[left]' : '!absolute !top-1 !left-1 !size-5 !rounded-full !bg-white !shadow-sm !transition-[left]'} />
          </button>
          <span className={mode === 'products' ? '!text-xs !font-bold !text-[var(--crm-text)]' : '!text-xs !font-semibold !text-[var(--crm-text-muted)]'}>
            Productos
          </span>
        </div>
      </div>

      {!totalCents ? (
        <div className="!grid !min-h-64 !place-items-center !rounded-xl !bg-[var(--crm-surface-soft)] !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
          No hay ventas de productos en el período actual.
        </div>
      ) : (
        <div className="!grid !grid-cols-1 !items-center !gap-7 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4 sm:!p-6 md:!grid-cols-[minmax(240px,0.8fr)_minmax(0,1.2fr)] lg:!gap-10">
          <div className="!relative !mx-auto !aspect-square !w-full !max-w-[280px]">
            <svg
              aria-label={`Ventas por ${mode === 'categories' ? 'categoría' : 'producto'}`}
              className="!h-full !w-full !overflow-visible"
              role="img"
              viewBox="0 0 220 220"
            >
              <circle cx="110" cy="110" fill="none" r="76" stroke="var(--crm-surface)" strokeWidth="31" />
              {segments.map((segment) => {
                const startPercentage = accumulatedPercentage
                accumulatedPercentage += segment.percentage
                const visiblePercentage = segments.length === 1
                  ? segment.percentage
                  : segment.percentage - Math.min(0.55, segment.percentage * 0.18)
                const isInactive = activeSegmentId !== null && activeSegmentId !== segment.id
                return (
                  <circle
                    aria-label={`${segment.label}: ${formatMoney(segment.totalCents)}, ${percentFormatter.format(segment.percentage)} %`}
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
                    strokeDasharray={`${visiblePercentage} ${100 - visiblePercentage}`}
                    strokeDashoffset={-startPercentage}
                    strokeLinecap="butt"
                    strokeWidth={activeSegmentId === segment.id ? 35 : 31}
                    style={{ opacity: isInactive ? 0.42 : 1, transform: 'rotate(-90deg)', transformOrigin: '110px 110px' }}
                    tabIndex={0}
                  />
                )
              })}
              <text fill="var(--crm-text-muted)" fontSize="11" fontWeight="600" textAnchor="middle" x="110" y="101">
                {activeSegment ? truncateLabel(activeSegment.label) : 'Total vendido'}
              </text>
              <text fill="var(--crm-text)" fontSize="17" fontWeight="800" textAnchor="middle" x="110" y="124">
                {formatMoney(activeSegment?.totalCents ?? totalCents)}
              </text>
              {activeSegment ? (
                <text fill="var(--crm-text-muted)" fontSize="10" fontWeight="700" textAnchor="middle" x="110" y="141">
                  {percentFormatter.format(activeSegment.percentage)} % del total
                </text>
              ) : null}
            </svg>
          </div>

          <div className="!grid !min-w-0 !grid-cols-1 !gap-2 sm:!grid-cols-2">
            {segments.map((segment) => (
              <div
                className={activeSegmentId === segment.id ? '!flex !min-h-[58px] !min-w-0 !items-center !gap-3 !rounded-[10px] !bg-[var(--crm-surface)] !px-3 !py-2.5 !shadow-sm' : '!flex !min-h-[58px] !min-w-0 !items-center !gap-3 !rounded-[10px] !px-3 !py-2.5 !transition-colors hover:!bg-[var(--crm-surface)]'}
                key={segment.id}
                onMouseEnter={() => setActiveSegmentId(segment.id)}
                onMouseLeave={() => setActiveSegmentId(null)}
              >
                <span className="!size-3 !shrink-0 !rounded-full" style={{ backgroundColor: segment.color }} />
                <div className="!grid !min-w-0 !flex-1 !gap-0.5">
                  <strong className="!truncate !text-[13px] !font-semibold !text-[var(--crm-text)]">{segment.label}</strong>
                  <span className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">{percentFormatter.format(segment.percentage)} % · {segment.quantity.toLocaleString('es-ES')} uds</span>
                </div>
                <b className="!shrink-0 !text-[13px] !font-bold !tabular-nums !text-[var(--crm-text)]">{formatMoney(segment.totalCents)}</b>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
