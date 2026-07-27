import { ProgressBar as HeroProgressBar } from '@heroui/react'

export type ProgressBarProps = {
  'aria-label'?: string
  className?: string
  labelPosition?: 'right' | 'bottom'
  max?: number
  min?: number
  progressClassName?: string
  value: number
  valueFormatter?: (value: number, percentage: number) => string | number
}

function getPercentage(value: number, min: number, max: number) {
  if (max <= min) return 0
  return Math.min(100, Math.max(0, ((value - min) * 100) / (max - min)))
}

export function ProgressBarBase({
  'aria-label': ariaLabel = 'Progreso',
  className = '',
  max = 100,
  min = 0,
  progressClassName = '',
  value,
}: Omit<ProgressBarProps, 'labelPosition' | 'valueFormatter'>) {
  return (
    <HeroProgressBar aria-label={ariaLabel} className={className} color="success" maxValue={max} minValue={min} value={Math.min(max, Math.max(min, value))}>
      <HeroProgressBar.Track className="!h-2 !w-full !rounded-full !bg-[var(--crm-surface-soft)]">
        <HeroProgressBar.Fill className={`!rounded-full !bg-[var(--crm-green)] ${progressClassName}`} />
      </HeroProgressBar.Track>
    </HeroProgressBar>
  )
}

export function ProgressBar({
  labelPosition,
  max = 100,
  min = 0,
  value,
  valueFormatter,
  ...baseProps
}: ProgressBarProps) {
  const percentage = getPercentage(value, min, max)
  const formattedValue = valueFormatter ? valueFormatter(value, percentage) : `${percentage.toFixed(0)}%`
  const bar = <ProgressBarBase {...baseProps} max={max} min={min} value={value} />

  if (labelPosition === 'right') {
    return <div className="!flex !items-center !gap-3">
      {bar}
      <span className="!w-10 !shrink-0 !text-right !text-sm !font-semibold !tabular-nums !text-[var(--crm-text-muted)]">{formattedValue}</span>
    </div>
  }

  if (labelPosition === 'bottom') {
    return <div>
      {bar}
      <div className="!mt-1 !text-right !text-sm !font-semibold !tabular-nums !text-[var(--crm-text-muted)]">{formattedValue}</div>
    </div>
  }

  return bar
}