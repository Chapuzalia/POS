import type { CrmVenue } from '../../../../types'

export function resolveSelectedVenueId(venues: CrmVenue[], currentVenueId: string) {
  if (venues.some((venue) => venue.id === currentVenueId && venue.isActive)) return currentVenueId
  return venues.find((venue) => venue.isActive)?.id ?? ''
}

