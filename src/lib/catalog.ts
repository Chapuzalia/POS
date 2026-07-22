import type { CatalogKind, Product, ProductVariant, SaleFormat, SaleFormatDefinition } from '../types'

export const defaultSaleFormats: SaleFormatDefinition[] = [
  { id: 'legacy-format:cubata', key: 'cubata', label: 'Cubata', isActive: true, sortOrder: 1 },
  { id: 'legacy-format:copa', key: 'copa', label: 'Copa', isActive: true, sortOrder: 2 },
  { id: 'legacy-format:shot', key: 'shot', label: 'Chupito', isActive: true, sortOrder: 3 },
  { id: 'legacy-format:beer_bottle', key: 'beer_bottle', label: 'Botellin cerveza', isActive: true, sortOrder: 4 },
  { id: 'legacy-format:soft_bottle', key: 'soft_bottle', label: 'Botellin refresco', isActive: true, sortOrder: 5 },
  { id: 'legacy-format:cocktail', key: 'cocktail', label: 'Coctel', isActive: true, sortOrder: 6 },
]

export const saleFormatOptions = defaultSaleFormats.map((format) => ({
  label: format.label,
  value: format.key,
}))

export const productKindOptions: Array<{ label: string; value: CatalogKind }> = [
  { label: 'Alcohol', value: 'alcohol' },
  { label: 'Mixer', value: 'mixer' },
  { label: 'Botellin cerveza', value: 'beer_bottle' },
  { label: 'Botellin refresco', value: 'soft_bottle' },
  { label: 'Coctel', value: 'cocktail' },
  { label: 'Otros', value: 'other' },
]

export const categoryKindOptions: Array<{ label: string; value: CatalogKind }> = [
  { label: 'Familia alcohol', value: 'alcohol' },
  { label: 'Mixers / Refrescos', value: 'mixer' },
  { label: 'Cervezas', value: 'beer_bottle' },
  { label: 'Cocteles', value: 'cocktail' },
  { label: 'Otros', value: 'other' },
]

export function getAvailableSaleFormats(saleFormats: SaleFormatDefinition[] | null | undefined) {
  const source = saleFormats?.length ? saleFormats : defaultSaleFormats
  return [...source].sort((a, b) => a.sortOrder - b.sortOrder || a.label.localeCompare(b.label, 'es'))
}

export function getActiveSaleFormats(saleFormats: SaleFormatDefinition[] | null | undefined) {
  return getAvailableSaleFormats(saleFormats).filter((format) => format.isActive)
}

export function getSaleFormatLabel(format: SaleFormat, saleFormats?: SaleFormatDefinition[] | null) {
  return getAvailableSaleFormats(saleFormats).find((option) => option.key === format)?.label ?? format
}

export function getKindLabel(kind: CatalogKind) {
  return (
    [...productKindOptions, ...categoryKindOptions].find((option) => option.value === kind)?.label ??
    (kind === 'beer' ? 'Cerveza' : kind === 'mixed' ? 'Cubata' : kind === 'shot' ? 'Chupito' : 'Otros')
  )
}

export function productSupportsSaleFormat(product: Product, saleFormat: SaleFormat) {
  if (getProductSaleFormats(product).includes(saleFormat)) {
    return true
  }

  return (
    (saleFormat === 'cubata' && product.kind === 'mixed') ||
    (saleFormat === 'shot' && product.kind === 'shot') ||
    (saleFormat === 'beer_bottle' && product.kind === 'beer')
  )
}

export function getProductSaleFormats(product: Product): SaleFormat[] {
  return product.saleFormats?.length ? product.saleFormats : getDefaultSaleFormatsForKind(product.kind)
}

export function canSellProductStandalone(product: Product) {
  return product.canSellStandalone ?? product.kind !== 'mixer'
}

export function canUseProductAsMixer(product: Product) {
  return product.canUseAsMixer ?? product.kind === 'mixer'
}

export function findProductVariantForSaleFormat(product: Product, saleFormat: SaleFormat): ProductVariant | null {
  const explicit = product.variants.find((variant) => variant.isActive && variant.saleFormatKey === saleFormat)
  if (explicit) return explicit

  // @deprecated Compatibility for cached catalogues created before sale_format_id.
  // The old sale_formats array and variant order are structural data; names/aliases
  // are deliberately never inspected here.
  const legacyFormatIndex = product.saleFormats.indexOf(saleFormat)
  if (legacyFormatIndex < 0) return null
  return [...product.variants]
    .filter((variant) => variant.isActive !== false)
    .sort((a, b) => a.sortOrder - b.sortOrder)[legacyFormatIndex] ?? null
}

export function getProductVariantForSaleFormat(product: Product, saleFormat: SaleFormat): ProductVariant | null {
  return findProductVariantForSaleFormat(product, saleFormat)
    ?? product.variants.find((variant) => variant.isDefault)
    ?? product.variants[0]
    ?? null
}

export function getDefaultSaleFormatsForKind(kind: CatalogKind): SaleFormat[] {
  if (kind === 'alcohol' || kind === 'mixed') {
    return ['cubata', 'copa', 'shot']
  }
  if (kind === 'shot') {
    return ['shot']
  }
  if (kind === 'beer' || kind === 'beer_bottle') {
    return ['beer_bottle']
  }
  if (kind === 'soft_bottle' || kind === 'mixer') {
    return ['soft_bottle']
  }
  if (kind === 'cocktail') {
    return ['cocktail']
  }

  return []
}
