import type { CashlogyLevel } from '../types'

export type CashlogyLevelTone = 'green' | 'orange' | 'red'

export function getVisibleCashlogyLevels(levels: CashlogyLevel[]) {
  return levels.filter((level) => !(level.state === 'ok' && level.percentage === 0))
}

export function getCashlogyLevelTone(percentage: number | null): CashlogyLevelTone {
  if (percentage !== null && percentage > 20) return 'green'
  if (percentage !== null && percentage >= 10) return 'orange'
  return 'red'
}

export function formatCashlogyLevelPercentage(percentage: number | null) {
  return percentage === null ? '—%' : `${percentage}%`
}

export function shouldShowCashlogyOperationDetails(status: string | null | undefined) {
  return status !== 'cancelled'
}
