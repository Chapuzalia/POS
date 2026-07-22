import { catalogCache } from './cache.ts'

export function invalidateCatalogAfterImport(venueId: string) {
  catalogCache.invalidate(venueId)
}

export function invalidateCatalogAfterMutation(venueId: string) {
  catalogCache.invalidate(venueId)
}
