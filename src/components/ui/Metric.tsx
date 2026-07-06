import { cx } from '../../utils/cx'

type MetricProps = {
  label: string
  value: string
  tone?: 'default' | 'success' | 'danger'
}

export function Metric({ label, tone = 'default', value }: MetricProps) {
  return (
    <div
      className={cx(
        'rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3',
        tone === 'success' && 'border-[var(--success)] bg-[var(--success-soft)]',
        tone === 'danger' && 'border-[var(--danger)] bg-[var(--danger-soft)]',
      )}
    >
      <p className="text-xs font-semibold uppercase tracking-normal text-[var(--muted)]">{label}</p>
      <p className="mt-1 font-mono text-xl font-bold tabular-nums text-[var(--foreground)]">{value}</p>
    </div>
  )
}
