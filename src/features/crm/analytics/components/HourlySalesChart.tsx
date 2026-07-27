import { useState } from 'react'
import { formatMoney } from '../../../../lib/format'
import type { CrmStats } from '../../../../types'

type HourlyMetric = 'tickets' | 'revenue'
type HourlySalesPoint = CrmStats['hourlySales'][number]

const compactCurrencyFormatter = new Intl.NumberFormat('es-ES', {
  currency: 'EUR',
  currencyDisplay: 'narrowSymbol',
  maximumFractionDigits: 1,
  notation: 'compact',
  style: 'currency',
})

function formatHour(hour: number) {
  return `${String(hour).padStart(2, '0')}:00`
}

function getMetricValue(point: HourlySalesPoint, metric: HourlyMetric) {
  return metric === 'tickets' ? point.ticketCount : point.totalCents
}

function formatMetricValue(value: number, metric: HourlyMetric) {
  return metric === 'tickets'
    ? `${value} ${value === 1 ? 'ticket' : 'tickets'}`
    : formatMoney(value)
}

function formatAxisValue(value: number, metric: HourlyMetric) {
  return metric === 'tickets'
    ? String(Math.round(value))
    : compactCurrencyFormatter.format(value / 100)
}

function findPeak(points: HourlySalesPoint[], metric: HourlyMetric) {
  return points.reduce<HourlySalesPoint | null>((peak, point) => {
    if (!peak || getMetricValue(point, metric) > getMetricValue(peak, metric)) return point
    return peak
  }, null)
}

export function HourlySalesChart({ points }: { points: HourlySalesPoint[] }) {
  const [metric, setMetric] = useState<HourlyMetric>('tickets')
  const [hoveredHour, setHoveredHour] = useState<number | null>(null)
  const ticketPeak = findPeak(points, 'tickets')
  const revenuePeak = findPeak(points, 'revenue')
  const hasSales = points.some((point) => point.ticketCount > 0)

  if (!hasSales) {
    return (
      <div className="!px-[18px] !pb-[18px] md:!px-[22px] md:!pb-[22px]">
        <div className="!grid !min-h-64 !place-items-center !rounded-xl !bg-[var(--crm-surface-soft)] !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
          No hay tickets pagados en el periodo actual.
        </div>
      </div>
    )
  }

  const width = 1000
  const height = 300
  const padding = { bottom: 42, left: 72, right: 26, top: 24 }
  const chartWidth = width - padding.left - padding.right
  const chartHeight = height - padding.top - padding.bottom
  const maximum = Math.max(...points.map((point) => getMetricValue(point, metric)), 1)
  const chartPoints = points.map((point) => ({
    ...point,
    x: padding.left + (point.hour / 23) * chartWidth,
    y: padding.top + chartHeight - (getMetricValue(point, metric) / maximum) * chartHeight,
  }))
  const hoveredPoint = hoveredHour === null ? null : chartPoints.find((point) => point.hour === hoveredHour) ?? null
  const linePoints = chartPoints.map(({ x, y }) => `${x},${y}`).join(' ')
  const areaPoints = `${padding.left},${padding.top + chartHeight} ${linePoints} ${padding.left + chartWidth},${padding.top + chartHeight}`
  const color = metric === 'tickets' ? 'var(--crm-blue)' : 'var(--crm-green)'
  const gridStepCount = metric === 'tickets' ? Math.min(4, maximum) : 4

  return (
    <div className="!px-[18px] !pb-[18px] md:!px-[22px] md:!pb-[22px]">
      <div className="!mb-4 !grid !grid-cols-1 !gap-3 sm:!grid-cols-2">
        <div className="!rounded-xl !bg-[var(--crm-blue-soft)] !p-4">
          <span className="!block !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-blue)]">Más tickets</span>
          <strong className="!mt-1 !block !text-lg">{ticketPeak ? `${formatHour(ticketPeak.hour)} · ${formatMetricValue(ticketPeak.ticketCount, 'tickets')}` : 'Sin datos'}</strong>
        </div>
        <div className="!rounded-xl !bg-[var(--crm-green-soft)] !p-4">
          <span className="!block !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-green)]">Mayor facturación</span>
          <strong className="!mt-1 !block !text-lg">{revenuePeak ? `${formatHour(revenuePeak.hour)} · ${formatMoney(revenuePeak.totalCents)}` : 'Sin datos'}</strong>
        </div>
      </div>

      <div className="!mb-3 !flex !w-fit !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-1" role="group" aria-label="Métrica del gráfico">
        <button
          aria-pressed={metric === 'tickets'}
          className={metric === 'tickets' ? '!min-h-9 !rounded-lg !border-0 !bg-[var(--crm-surface)] !px-4 !text-xs !font-bold !text-[var(--crm-blue)] !shadow-sm' : '!min-h-9 !rounded-lg !border-0 !bg-transparent !px-4 !text-xs !font-semibold !text-[var(--crm-text-muted)]'}
          onClick={() => setMetric('tickets')}
          type="button"
        >
          Tickets
        </button>
        <button
          aria-pressed={metric === 'revenue'}
          className={metric === 'revenue' ? '!min-h-9 !rounded-lg !border-0 !bg-[var(--crm-surface)] !px-4 !text-xs !font-bold !text-[var(--crm-green)] !shadow-sm' : '!min-h-9 !rounded-lg !border-0 !bg-transparent !px-4 !text-xs !font-semibold !text-[var(--crm-text-muted)]'}
          onClick={() => setMetric('revenue')}
          type="button"
        >
          Facturación
        </button>
      </div>

      <div className="!overflow-x-auto">
        <svg
          aria-label={`Actividad por hora según ${metric === 'tickets' ? 'número de tickets' : 'facturación'}`}
          className="!h-auto !min-w-[700px] !w-full"
          role="img"
          viewBox={`0 0 ${width} ${height}`}
        >
          <defs>
            <linearGradient id="hourly-sales-chart-area" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity="0.24" />
              <stop offset="100%" stopColor={color} stopOpacity="0.02" />
            </linearGradient>
            <filter height="170%" id="hourly-sales-tooltip-shadow" width="150%" x="-25%" y="-35%">
              <feDropShadow dx="0" dy="4" floodColor="#000000" floodOpacity="0.22" stdDeviation="6" />
            </filter>
          </defs>

          {Array.from({ length: gridStepCount + 1 }, (_, index) => index / gridStepCount).map((ratio) => {
            const y = padding.top + chartHeight - ratio * chartHeight
            return (
              <g key={ratio}>
                <line stroke="var(--crm-border-subtle)" strokeWidth="1" x1={padding.left} x2={padding.left + chartWidth} y1={y} y2={y} />
                <text fill="var(--crm-text-muted)" fontSize="12" textAnchor="end" x={padding.left - 12} y={y + 4}>
                  {formatAxisValue(maximum * ratio, metric)}
                </text>
              </g>
            )
          })}

          <polygon fill="url(#hourly-sales-chart-area)" points={areaPoints} />
          <polyline fill="none" points={linePoints} stroke={color} strokeLinecap="round" strokeLinejoin="round" strokeWidth="4" />

          {chartPoints.map((point) => (
            <g key={point.hour}>
              <circle cx={point.x} cy={point.y} fill="var(--crm-surface)" r="4.5" stroke={color} strokeWidth="3" />
              <circle
                aria-label={`${formatHour(point.hour)}, ${formatMetricValue(point.ticketCount, 'tickets')}, ${formatMoney(point.totalCents)}`}
                className="!cursor-pointer !outline-none"
                cx={point.x}
                cy={point.y}
                fill="transparent"
                onBlur={() => setHoveredHour(null)}
                onFocus={() => setHoveredHour(point.hour)}
                onMouseEnter={() => setHoveredHour(point.hour)}
                onMouseLeave={() => setHoveredHour(null)}
                r="15"
                tabIndex={0}
              />
              {point.hour % 3 === 0 || point.hour === 23 ? (
                <text fill="var(--crm-text-muted)" fontSize="12" textAnchor="middle" x={point.x} y={height - 12}>
                  {String(point.hour).padStart(2, '0')}h
                </text>
              ) : null}
            </g>
          ))}

          {hoveredPoint ? (() => {
            const tooltipWidth = 210
            const tooltipHeight = 72
            const tooltipX = Math.min(
              width - padding.right - tooltipWidth,
              Math.max(padding.left, hoveredPoint.x - tooltipWidth / 2),
            )
            const tooltipY = hoveredPoint.y > padding.top + tooltipHeight + 18
              ? hoveredPoint.y - tooltipHeight - 16
              : hoveredPoint.y + 16
            return (
              <g filter="url(#hourly-sales-tooltip-shadow)" pointerEvents="none" role="status">
                <rect fill="var(--crm-surface)" height={tooltipHeight} rx="10" stroke="var(--crm-border)" width={tooltipWidth} x={tooltipX} y={tooltipY} />
                <text fill="var(--crm-text-muted)" fontSize="12" fontWeight="600" x={tooltipX + 14} y={tooltipY + 23}>
                  {formatHour(hoveredPoint.hour)}–{String((hoveredPoint.hour + 1) % 24).padStart(2, '0')}:00
                </text>
                <text fill="var(--crm-text)" fontSize="16" fontWeight="800" x={tooltipX + 14} y={tooltipY + 51}>
                  {formatMetricValue(hoveredPoint.ticketCount, 'tickets')} · {formatMoney(hoveredPoint.totalCents)}
                </text>
              </g>
            )
          })() : null}
        </svg>
      </div>
    </div>
  )
}
