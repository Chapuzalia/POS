import type { CrmVenue, TenantContext } from '../../../../types'

export function buildCrmVenueContext(context: TenantContext, venue: CrmVenue | undefined): TenantContext {
  if (!venue) return context
  return {
    ...context,
    venueId: venue.id,
    venueName: venue.name,
    venueLegalName: venue.legalName,
    venueTaxId: venue.taxId,
    venueAddress: venue.address,
    venueTimeZone: venue.timeZone,
    venueDefaultTaxRate: venue.defaultTaxRate,
  }
}

export function resolveSelectedVenueId(venues: CrmVenue[], currentVenueId: string) {
  // An inactive venue stays selected only if chosen explicitly; the default is the first active one.
  if (venues.some((venue) => venue.id === currentVenueId)) return currentVenueId
  return venues.find((venue) => venue.isActive)?.id ?? ''
}

