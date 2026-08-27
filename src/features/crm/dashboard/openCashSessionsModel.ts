import type { CrmStats } from '../../../types/domain.ts'

type OpenCashSession = CrmStats['openCashSessions'][number]

export type OpenCashSessionVenueGroup = {
  venueId: string
  venueName: string
  sessions: OpenCashSession[]
  totalSalesCents: number
}

export function groupOpenCashSessionsByVenue(
  sessions: OpenCashSession[],
): OpenCashSessionVenueGroup[] {
  const groups = new Map<string, OpenCashSessionVenueGroup>()

  sessions.forEach((session) => {
    const current = groups.get(session.venueId) ?? {
      venueId: session.venueId,
      venueName: session.venueName,
      sessions: [],
      totalSalesCents: 0,
    }
    current.sessions.push(session)
    current.totalSalesCents += session.salesCents
    groups.set(session.venueId, current)
  })

  return [...groups.values()]
}
