import { parseMoneyToCents } from '../../../../lib/format.ts'
import type { SaleFormat, SaleFormatDefinition } from '../../../../types/index.ts'

export type ProductFormGuardInput = {
  categoryId: string
  name: string
  priceInputs: Partial<Record<SaleFormat, string>>
  selectedSaleFormats: SaleFormat[]
  venueId: string
}

export type ProductFormGuardError = 'missing-product-data' | 'missing-sale-format-prices' | null

export function getProductFormGuardError(input: ProductFormGuardInput): ProductFormGuardError {
  if (!input.name.trim() || !input.categoryId || !input.venueId) return 'missing-product-data'
  if (!input.selectedSaleFormats.length) return 'missing-sale-format-prices'
  return input.selectedSaleFormats.some((format) => !input.priceInputs[format]?.trim())
    ? 'missing-sale-format-prices'
    : null
}

export function buildProductVariantInputs(
  selectedSaleFormats: SaleFormat[],
  priceInputs: Partial<Record<SaleFormat, string>>,
  saleFormats: SaleFormatDefinition[],
) {
  return selectedSaleFormats.map((format) => ({
    format,
    name: saleFormats.find((definition) => definition.key === format)?.label ?? format,
    priceCents: parseMoneyToCents(priceInputs[format] ?? ''),
  }))
}
