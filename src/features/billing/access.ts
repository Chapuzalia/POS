import type { BillingCatalog, BillingDetail, CommercialException, Selection } from './types'

// Venues/devices the owner switches off (downgrade, at renewal) or back on (upgrade) with a plan change.
export type AccessChoice = { deactivateVenueIds: string[]; deactivateDeviceIds: string[]; reactivateVenueIds: string[] }
export const emptyAccessChoice: AccessChoice = { deactivateVenueIds: [], deactivateDeviceIds: [], reactivateVenueIds: [] }

// Same capacity rule as the billing contract: plan limits + resource addons, unless an exception fixes them.
export function selectionLimits(catalog: BillingCatalog, selection: Selection, exception: CommercialException | null) {
  const plan = catalog.versions.find(version => version.id === selection.planVersionId)
  if (!plan) return null
  const limits = { ...plan.limits }
  for (const addon of selection.addons) {
    const resource = catalog.products.find(product => product.key === addon.key)?.resource
    if (resource) limits[resource] += addon.quantity
  }
  for (const resource of ['venues', 'devices'] as const) {
    const fixed = exception?.limits[resource]
    if (fixed !== undefined) limits[resource] = fixed
  }
  return limits
}

export function accessNeeds(detail: BillingDetail, limits: { venues: number; devices: number }, choice: AccessChoice) {
  const activeVenues = detail.venues.filter(venue => venue.is_active)
  const inactiveVenues = detail.venues.filter(venue => !venue.is_active)
  // Terminals of a venue being switched off go with it.
  const activeDevices = detail.devices.filter(device => device.is_active && !choice.deactivateVenueIds.includes(device.venue_id))
  const venuesAfter = activeVenues.length - choice.deactivateVenueIds.length + choice.reactivateVenueIds.length
  const devicesAfter = activeDevices.filter(device => !choice.deactivateDeviceIds.includes(device.id)).length
  return {
    activeVenues, inactiveVenues, activeDevices,
    venuesToDeactivate: Math.max(0, activeVenues.length - limits.venues),
    devicesToDeactivate: Math.max(0, activeDevices.length - limits.devices),
    venueSlots: Math.max(0, limits.venues - activeVenues.length),
    ready: venuesAfter <= limits.venues && devicesAfter <= limits.devices,
  }
}

// Only choices that still apply to the current lists are sent; older servers do not know the field.
export function accessRequest(choice: AccessChoice, detail: BillingDetail) {
  const active = new Set(detail.venues.filter(venue => venue.is_active).map(venue => venue.id))
  const request = {
    deactivateVenueIds: choice.deactivateVenueIds.filter(id => active.has(id)),
    deactivateDeviceIds: choice.deactivateDeviceIds.filter(id => detail.devices.some(device => device.id === id && device.is_active && !choice.deactivateVenueIds.includes(device.venue_id))),
    reactivateVenueIds: choice.reactivateVenueIds.filter(id => detail.venues.some(venue => venue.id === id && !venue.is_active)),
  }
  return request.deactivateVenueIds.length || request.deactivateDeviceIds.length || request.reactivateVenueIds.length ? request : undefined
}
