import type { ProductType, SaleLineCatalogSnapshot } from '../../../types/index.ts'

type SnapshotFallback = {
  productId: string | null
  productName: string
  variantId: string | null
  variantName: string
  basePriceCents: number | null
  productType?: ProductType | null
  vatRate?: number | null
}

export function normalizeCatalogSnapshot(
  snapshot: Partial<SaleLineCatalogSnapshot> | null | undefined,
  fallback: SnapshotFallback,
): SaleLineCatalogSnapshot {
  return {
    placementId: snapshot?.placementId ?? null,
    productType: snapshot?.productType ?? fallback.productType ?? null,
    productId: snapshot?.productId ?? fallback.productId,
    productName: snapshot?.productName ?? fallback.productName,
    variantId: snapshot?.variantId ?? fallback.variantId,
    variantName: snapshot?.variantName ?? fallback.variantName,
    basePriceCents: snapshot?.basePriceCents ?? fallback.basePriceCents,
    vatRate: snapshot?.vatRate ?? fallback.vatRate ?? null,
    categoryId: snapshot?.categoryId ?? null,
    categoryName: snapshot?.categoryName ?? '',
    catalogTabId: snapshot?.catalogTabId ?? null,
    catalogTabName: snapshot?.catalogTabName ?? '',
    saleFormatId: snapshot?.saleFormatId ?? null,
    saleFormatName: snapshot?.saleFormatName ?? fallback.variantName,
  }
}
