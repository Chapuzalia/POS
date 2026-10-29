import type { ReactNode } from 'react'
import { formatMoney } from '../../lib/format'

type Props = {
  name: string
  variantName: string
  supplementCents: number
  selected: boolean
  disabled: boolean
  hasModifiers: boolean
  onSelect: () => void
  controls: ReactNode
  children?: ReactNode
}

export function MenuOptionCard({ name, variantName, supplementCents, selected, disabled, hasModifiers, onSelect, controls, children }: Props) {
  return <article aria-label={`Plato ${name}`} className={`min-w-0 self-start overflow-hidden rounded-[12px] border ${selected ? 'border-[var(--accent)]' : 'border-[var(--separator)]'} bg-[var(--background)]`}>
    <div className={`flex items-center gap-1 p-2 ${selected ? 'bg-[var(--accent-soft)]/40' : ''}`}>
      <button aria-label={`Pedir ${name}`} aria-pressed={selected} className="min-h-14 min-w-0 flex-1 cursor-pointer rounded-[8px] px-2 py-1 text-left disabled:cursor-default disabled:opacity-50" disabled={disabled} onClick={onSelect} type="button">
        <strong className="block text-sm">{name}</strong>
        <span className="text-xs text-[var(--muted)]">{variantName}{variantName ? ' · ' : ''}{supplementCents ? `${supplementCents > 0 ? '+' : ''}${formatMoney(supplementCents)}` : 'Incluido'}</span>
        {hasModifiers ? <span className="block text-xs font-semibold text-[var(--accent)]">Elegir preparación</span> : null}
      </button>
      <div className="flex shrink-0 items-center">{controls}</div>
    </div>
    {children}
  </article>
}
