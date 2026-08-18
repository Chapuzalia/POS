import type { TicketLineComponent } from '../../types'
import { formatMoney } from '../../lib/format'

type Props = {
  components: readonly TicketLineComponent[]
  className?: string
  compact?: boolean
}

export function MenuComponentDetails({ components, className = '', compact = false }: Props) {
  const menuComponents = components
    .filter((component) => component.type === 'menu_component')
    .toSorted((left, right) => left.sortOrder - right.sortOrder)

  if (!menuComponents.length) return null

  return (
    <ul className={`mt-2 grid gap-1 border-l-2 border-[var(--separator)] pl-3 text-[var(--muted)] ${compact ? 'text-xs' : 'text-sm'} ${className}`}>
      {menuComponents.map((component) => (
        <li key={component.id}>
          <div className="flex min-w-0 items-baseline justify-between gap-2">
            <span className="min-w-0">
              <strong className="font-semibold text-[var(--foreground)]">{component.selectionGroupName}</strong>
              {' · '}{component.quantity > 1 ? `${component.quantity} × ` : ''}{component.productName}
              {component.variantName ? ` (${component.variantName})` : ''}
            </span>
            {component.priceDeltaCents ? (
              <span className="shrink-0 font-mono tabular-nums">
                {component.priceDeltaCents > 0 ? '+' : ''}{formatMoney(component.priceDeltaCents * component.quantity)}
              </span>
            ) : null}
          </div>
          {component.modifiers?.length ? (
            <span className="block text-[0.92em]">{component.modifiers.map((modifier) => modifier.name).join(' · ')}</span>
          ) : null}
        </li>
      ))}
    </ul>
  )
}
