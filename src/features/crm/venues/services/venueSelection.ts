import type { CrmVenue } from '../../../../types'

export function resolveSelectedVenueId(venues: CrmVenue[], currentVenueId: string) {
  // An inactive venue stays selected only if chosen explicitly; the default is the first active one.
  if (venues.some((venue) => venue.id === currentVenueId)) return currentVenueId
  return venues.find((venue) => venue.isActive)?.id ?? ''
}

