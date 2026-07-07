import type { LucideIcon } from 'lucide-react'
import { cx } from '../../utils/cx'

type ChipProps = {
  children?: string
  icon?: LucideIcon
  tone?: 'default' | 'success' | 'danger' | 'warning'
}

export function Chip({ children, icon: Icon, tone = 'default' }: ChipProps) {
  return (
    <span
      className={cx(
        'inline-flex min-h-8 items-center gap-1.5 rounded-[var(--radius)] border px-2.5 text-xs font-bold',
        tone === 'default' && 'border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--foreground)]',
        tone === 'success' && 'border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]',
        tone === 'danger' && 'border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]',
        tone === 'warning' && 'border-[var(--warning)] bg-[var(--surface-secondary)] text-[var(--warning)]',
      )}
    >
      {Icon ? <Icon className="h-4 w-4" /> : null}
      {children?children : null}
    </span>
  )
}
