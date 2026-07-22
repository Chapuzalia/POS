import type { CatalogProduct, ResolvedCatalogItem } from './types.ts'

export type ResolvedCatalog = {
  items: ResolvedCatalogItem[]
  internalProducts: CatalogProduct[]
  rejected: Array<{ placementId: string; code: string; message: string }>
}
