import { describe, expect, it } from 'vitest'
import { applyCrmOpenCashSalesTotals } from '../../src/features/crm/analytics/services/analyticsModel'
import type { CrmStats } from '../../src/types'

const stats = (sessions: Array<{ id: string; salesCents: number }>) => ({ openCashSessions: sessions }) as unknown as CrmStats

describe('open cash sales totals', () => {
  it('keep the loaded total of sessions the refresh did not ask about', () => {
    // A realtime refresh started before the sessions loaded asks for no session.
    const current = stats([{ id: 'barra', salesCents: 11740 }])
    expect(applyCrmOpenCashSalesTotals(current, new Map())).toBe(current)
  })

  it('apply refreshed totals, including zero for a requested session without sales', () => {
    const result = applyCrmOpenCashSalesTotals(stats([{ id: 'barra', salesCents: 100 }, { id: 'terraza', salesCents: 300 }]), new Map([['barra', 250], ['terraza', 0]]))
    expect(result?.openCashSessions.map((session) => session.salesCents)).toEqual([250, 0])
  })
})
