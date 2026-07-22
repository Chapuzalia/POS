import type { CatalogData, CatalogReadMode } from '../domain/types.ts'

const keyFor = (venueId: string, mode: CatalogReadMode) => `${venueId}:${mode}`

export class CatalogCache {
  private readonly entries = new Map<string, CatalogData>()
  private readonly pending = new Map<string, Promise<CatalogData>>()

  get(venueId: string, mode: CatalogReadMode) {
    return this.entries.get(keyFor(venueId, mode)) ?? null
  }

  set(catalog: CatalogData) {
    this.entries.set(keyFor(catalog.venueId, catalog.mode), catalog)
    return catalog
  }

  getPending(venueId: string, mode: CatalogReadMode) {
    return this.pending.get(keyFor(venueId, mode)) ?? null
  }

  setPending(venueId: string, mode: CatalogReadMode, request: Promise<CatalogData>) {
    const key = keyFor(venueId, mode)
    this.pending.set(key, request)
    const cleanup = () => {
      if (this.pending.get(key) === request) this.pending.delete(key)
    }
    void request.then(cleanup, cleanup)
    return request
  }

  invalidate(venueId: string) {
    for (const key of this.entries.keys()) if (key.startsWith(`${venueId}:`)) this.entries.delete(key)
    for (const key of this.pending.keys()) if (key.startsWith(`${venueId}:`)) this.pending.delete(key)
  }

  clear() {
    this.entries.clear()
    this.pending.clear()
  }
}

export const catalogCache = new CatalogCache()
