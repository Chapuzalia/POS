import type { CatalogKind, Product, ProductVariant, SaleFormat, SaleFormatDefinition } from '../types'
import { normalizeText } from './format'

export const defaultSaleFormats: SaleFormatDefinition[] = [
  { key: 'cubata', label: 'Cubata', isActive: true, sortOrder: 1 },
  { key: 'copa', label: 'Copa', isActive: true, sortOrder: 2 },
  { key: 'shot', label: 'Chupito', isActive: true, sortOrder: 3 },
  { key: 'beer_bottle', label: 'Botellin cerveza', isActive: true, sortOrder: 4 },
  { key: 'soft_bottle', label: 'Botellin refresco', isActive: true, sortOrder: 5 },
  { key: 'cocktail', label: 'Coctel', isActive: true, sortOrder: 6 },
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

const saleFormatVariantAliases: Record<string, string[]> = {
  cubata: ['cubata', 'copa larga', 'alcohol mixer', 'mixed'],
  copa: ['copa', 'solo', 'alcohol solo'],
  shot: ['chupito', 'shot'],
  beer_bottle: ['botellin', 'botella', 'cerveza'],
  soft_bottle: ['botellin', 'botella', 'refresco'],
  cocktail: ['coctel', 'cocktail'],
}

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
  const aliases = (saleFormatVariantAliases[saleFormat] ?? [saleFormat]).flatMap((alias) => {
    const normalizedAlias = normalizeText(alias)
    return [normalizedAlias, normalizedAlias.replace(/[_-]+/g, ' ')]
  })
  return product.variants.find((variant) => {
    const normalizedName = normalizeText(variant.name)
    return aliases.some((alias) => normalizedName.includes(alias))
  }) ?? null
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
