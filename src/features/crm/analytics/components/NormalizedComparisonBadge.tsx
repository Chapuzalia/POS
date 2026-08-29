import { Minus, TrendingDown, TrendingUp } from 'lucide-react'
import { compareNormalizedValues } from '../services/analyticsPeriod'

const comparisonFormatter = new Intl.NumberFormat('es-ES', {
  maximumFractionDigits: 1,
  minimumFractionDigits: 0,
  signDisplay: 'exceptZero',
})

export function NormalizedComparisonBadge({
  comparisonDayCount,
  comparisonLabel,
  comparisonTotal,
  currentDayCount,
  currentTotal,
  normalizeByDay = true,
}: {
  comparisonDayCount: number
  comparisonLabel: string
  comparisonTotal: number
  currentDayCount: number
  currentTotal: number
  normalizeByDay?: boolean
}) {
  const comparison = compareNormalizedValues(
    currentTotal,
    normalizeByDay ? currentDayCount : 1,
    comparisonTotal,
    normalizeByDay ? comparisonDayCount : 1,
  )
  const Icon = comparison.direction === 'up' ? TrendingUp : comparison.direction === 'down' ? TrendingDown : Minus
  const colorClass = comparison.direction === 'up'
    ? '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]'
    : comparison.direction === 'down'
      ? '!bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'
      : '!bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]'
  const text = comparison.percentage === null
    ? 'Nuevo'
    : `${comparisonFormatter.format(comparison.percentage)} %`

  return (
    <span
      className={`!inline-flex !w-fit !items-center !gap-1 !rounded-full !px-2 !py-1 !text-[10px] !font-bold !tabular-nums ${colorClass}`}
      title={`${text} frente a ${comparisonLabel}${normalizeByDay ? ' (valores por día)' : ''}`}
    >
      <Icon className="!size-3" />
      {text}
    </span>
  )
}
