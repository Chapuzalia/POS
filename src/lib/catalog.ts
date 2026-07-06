import type { CatalogKind, Product, ProductVariant, SaleFormat } from '../types'
import { normalizeText } from './format'

export const saleFormatOptions: Array<{ label: string; value: SaleFormat }> = [
  { label: 'Cubata', value: 'cubata' },
  { label: 'Copa', value: 'copa' },
  { label: 'Chupito', value: 'shot' },
  { label: 'Botellin cerveza', value: 'beer_bottle' },
  { label: 'Botellin refresco', value: 'soft_bottle' },
  { label: 'Coctel', value: 'cocktail' },
]

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

const saleFormatVariantAliases: Record<SaleFormat, string[]> = {
  cubata: ['cubata', 'copa larga', 'alcohol mixer', 'mixed'],
  copa: ['copa', 'solo', 'alcohol solo'],
  shot: ['chupito', 'shot'],
  beer_bottle: ['botellin', 'botella', 'cerveza'],
  soft_bottle: ['botellin', 'botella', 'refresco'],
  cocktail: ['coctel', 'cocktail'],
}

export function getSaleFormatLabel(format: SaleFormat) {
  return saleFormatOptions.find((option) => option.value === format)?.label ?? format
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
    (saleFormat === 'beer_bottle' && product.kind === 'beer') ||
    (saleFormat === 'soft_bottle' && product.kind === 'other')
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

export function getProductVariantForSaleFormat(product: Product, saleFormat: SaleFormat): ProductVariant | null {
  const aliases = saleFormatVariantAliases[saleFormat].map(normalizeText)
  const matchingVariant = product.variants.find((variant) => {
    const normalizedName = normalizeText(variant.name)
    return aliases.some((alias) => normalizedName.includes(alias))
  })

  return matchingVariant ?? product.variants.find((variant) => variant.isDefault) ?? product.variants[0] ?? null
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
  if (kind === 'soft_bottle' || kind === 'mixer' || kind === 'other') {
    return ['soft_bottle']
  }
  if (kind === 'cocktail') {
    return ['cocktail']
  }

  return []
}
