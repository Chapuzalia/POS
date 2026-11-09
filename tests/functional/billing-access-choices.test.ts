import { expect, it } from 'vitest'
import { accessNeeds, accessRequest, emptyAccessChoice, selectionLimits } from '../../src/features/billing/access'
import { resolveSelectedVenueId } from '../../src/features/crm/venues/services/venueSelection'
import type { BillingCatalog, BillingDetail } from '../../src/features/billing/types'
import type { CrmVenue } from '../../src/types'

const plan = { id: 'solo', productKey: 'solo', interval: 'month', amountCents: 2900, stripePriceId: null, features: [], limits: { venues: 1, devices: 2 }, included: {}, maximum: null, requires: [], published: true } as const
const extraVenue = { key: 'extra_venue', kind: 'addon', name: 'Local adicional', description: '', scope: 'tenant', featureKey: null, resource: 'venues', active: true, sortOrder: 1 } as const
const catalog = { products: [extraVenue], versions: [plan], features: [] } as unknown as BillingCatalog
const detail = {
  venues: [{ id: 'centro', name: 'Centro', is_active: true }, { id: 'terraza', name: 'Terraza', is_active: true }, { id: 'playa', name: 'Playa', is_active: false }],
  devices: [{ id: 'barra', name: 'Barra', venue_id: 'centro', is_active: true }, { id: 'tpv-terraza', name: 'TPV Terraza', venue_id: 'terraza', is_active: true }, { id: 'caja', name: 'Caja', venue_id: 'centro', is_active: true }],
} as unknown as BillingDetail

it('computes capacity like the contract: plan limits, resource addons and fixed exception limits', () => {
  expect(selectionLimits(catalog, { planVersionId: 'solo', addons: [] }, null)).toEqual({ venues: 1, devices: 2 })
  expect(selectionLimits(catalog, { planVersionId: 'solo', addons: [{ key: 'extra_venue', versionId: 'x', quantity: 2, venueIds: [], deviceIds: [] }] }, null)).toEqual({ venues: 3, devices: 2 })
  expect(selectionLimits(catalog, { planVersionId: 'solo', addons: [] }, { freeUnits: {}, limits: { devices: 9 }, discountBasisPoints: 0, customAmounts: {}, cycles: null, reason: 'x' })).toEqual({ venues: 1, devices: 9 })
  expect(selectionLimits(catalog, { planVersionId: 'missing', addons: [] }, null)).toBeNull()
})

it('requires choosing venues/devices to switch off and counts a venue with its terminals', () => {
  const needs = accessNeeds(detail, { venues: 1, devices: 2 }, emptyAccessChoice)
  expect(needs).toMatchObject({ venuesToDeactivate: 1, devicesToDeactivate: 1, venueSlots: 0, ready: false })
  // Switching Terraza off also removes its terminal: the device limit fits again.
  const choice = { ...emptyAccessChoice, deactivateVenueIds: ['terraza'] }
  expect(accessNeeds(detail, { venues: 1, devices: 2 }, choice)).toMatchObject({ devicesToDeactivate: 0, ready: true })
  expect(accessRequest(choice, detail)).toEqual({ deactivateVenueIds: ['terraza'], deactivateDeviceIds: [], reactivateVenueIds: [] })
})

it('offers free slots to reactivate inactive venues and sends nothing when no choice applies', () => {
  expect(accessNeeds(detail, { venues: 3, devices: 5 }, emptyAccessChoice)).toMatchObject({ venueSlots: 1, ready: true })
  expect(accessNeeds(detail, { venues: 3, devices: 5 }, { ...emptyAccessChoice, reactivateVenueIds: ['playa'] }).ready).toBe(true)
  expect(accessRequest(emptyAccessChoice, detail)).toBeUndefined()
  // Stale ids (an active venue marked for reactivation) are dropped.
  expect(accessRequest({ ...emptyAccessChoice, reactivateVenueIds: ['centro'] }, detail)).toBeUndefined()
})

it('keeps an explicitly chosen inactive venue selected and defaults to the first active one', () => {
  const venues = [{ id: 'playa', isActive: false }, { id: 'centro', isActive: true }] as CrmVenue[]
  expect(resolveSelectedVenueId(venues, 'playa')).toBe('playa')
  expect(resolveSelectedVenueId(venues, '')).toBe('centro')
  expect(resolveSelectedVenueId(venues, 'removed')).toBe('centro')
})
