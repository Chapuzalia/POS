import type { CrmStats } from '../../../../types/domain.ts'

export function applyCrmOpenCashSalesTotals(
  stats: CrmStats | null,
  totalsByCashSession: ReadonlyMap<string, number>,
) {
  if (!stats) return stats
  let changed = false
  const openCashSessions = stats.openCashSessions.map((current) => {
    const salesCents = totalsByCashSession.get(current.id) ?? 0
    if (salesCents === current.salesCents) return current
    changed = true
    return { ...current, salesCents }
  })

  return changed ? { ...stats, openCashSessions } : stats
}
