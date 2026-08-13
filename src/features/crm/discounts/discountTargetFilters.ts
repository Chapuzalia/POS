import type { DiscountTargetProductOption } from './services/discountService.ts'

export type DiscountTargetFilters = {
  categoryId: string
  query: string
  variantName: string
}

export function normalizeDiscountTargetFilter(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('es')
}

export function getDiscountTargetCategoryOptions(options: DiscountTargetProductOption[]) {
  const categories = new Map<string, string>()
  for (const product of options) {
    for (const category of product.categories) categories.set(category.id, category.name)
  }
  return [
    { label: 'Categoría', value: 'all' },
    ...[...categories].sort((left, right) => left[1].localeCompare(right[1], 'es'))
      .map(([value, label]) => ({ label, value })),
  ]
}

export function getDiscountTargetVariantOptions(options: DiscountTargetProductOption[]) {
  const variants = new Map<string, string>()
  for (const product of options) {
    for (const variant of product.variants) {
      variants.set(normalizeDiscountTargetFilter(variant.name), variant.name)
    }
  }
  return [
    { label: 'Variante', value: 'all' },
    ...[...variants].sort((left, right) => left[1].localeCompare(right[1], 'es'))
      .map(([value, label]) => ({ label, value })),
  ]
}

export function filterDiscountTargetOptions(
  options: DiscountTargetProductOption[],
  filters: DiscountTargetFilters,
) {
  const query = normalizeDiscountTargetFilter(filters.query)
  return options.flatMap((product) => {
    if (filters.categoryId !== 'all' && !product.categories.some((category) => category.id === filters.categoryId)) {
      return []
    }
    const productMatches = !query || normalizeDiscountTargetFilter(product.name).includes(query)
    const variants = product.variants.filter((variant) => {
      const normalizedName = normalizeDiscountTargetFilter(variant.name)
      return (filters.variantName === 'all' || normalizedName === filters.variantName)
        && (productMatches || normalizedName.includes(query))
    })
    if (filters.variantName !== 'all' && !variants.length) return []
    if (!productMatches && !variants.length) return []
    return [{ ...product, variants }]
  })
}
