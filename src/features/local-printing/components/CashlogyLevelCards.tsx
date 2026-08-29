import { Coins } from 'lucide-react'
import { formatMoney } from '../../../lib/format'
import {
  formatCashlogyLevelPercentage,
  getCashlogyLevelTone,
  getVisibleCashlogyLevels,
  type CashlogyLevelTone,
} from '../cashlogy/cashlogyPresentation'
import type { CashlogyLevel } from '../types'

const toneClasses: Record<CashlogyLevelTone, string> = {
  green: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  orange: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  red: 'bg-red-500/15 text-red-700 dark:text-red-300',
}

export function CashlogyLevelCards({ levels, variant }: { levels: CashlogyLevel[]; variant: 'accounting' | 'payment' }) {
  const visibleLevels = getVisibleCashlogyLevels(levels)
  if (!visibleLevels.length) return null

  return <div className={variant === 'payment'
    ? 'mt-4 rounded-[var(--radius)] border border-[var(--separator)] p-4'
    : 'border-t border-[var(--separator)] p-4'}>
    {variant === 'payment'
      ? <h3 className="font-black">Niveles</h3>
      : <h4 className="font-black">Niveles</h4>}
    <div className="mt-2 flex flex-wrap gap-2">
      {visibleLevels.map((level) => <span
        className={`rounded-full px-3 py-1 text-xs font-bold ${toneClasses[getCashlogyLevelTone(level.percentage)]}`}
        key={level.index}
      >
        <Coins className="mr-1 inline h-3.5 w-3.5" />
        {formatMoney(level.valueCents)} - {formatCashlogyLevelPercentage(level.percentage)}
      </span>)}
    </div>
  </div>
}
