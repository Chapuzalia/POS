export type PurchaseCategoryGraph = {
  recipes: Array<{ id: string; variantId: string }>
  recipeLines: Array<{ recipeId: string; inventoryItemId: string }>
  products: Array<{ id: string; active: boolean }>
  variants: Array<{ id: string; productId: string; active: boolean }>
  placements: Array<{ productId: string; categoryId: string | null; active: boolean }>
  categories: Array<{ id: string; name: string; active: boolean }>
}

export function resolveUnambiguousPurchaseCategories(graph: PurchaseCategoryGraph) {
  const activeProducts = new Set(graph.products.filter((product) => product.active).map((product) => product.id))
  const categoryNames = new Map(graph.categories.filter((category) => category.active).map((category) => [category.id, category.name]))
  const categoriesByProduct = new Map<string, Set<string>>()
  for (const placement of graph.placements) {
    if (!placement.active || !placement.categoryId || !categoryNames.has(placement.categoryId)) continue
    const categories = categoriesByProduct.get(placement.productId) ?? new Set<string>()
    categories.add(placement.categoryId)
    categoriesByProduct.set(placement.productId, categories)
  }
  const productByVariant = new Map(graph.variants
    .filter((variant) => variant.active && activeProducts.has(variant.productId))
    .map((variant) => [variant.id, variant.productId]))
  const productByRecipe = new Map(graph.recipes.flatMap((recipe) => {
    const productId = productByVariant.get(recipe.variantId)
    return productId ? [[recipe.id, productId] as const] : []
  }))
  const categoryIdsByItem = new Map<string, Set<string>>()
  for (const line of graph.recipeLines) {
    const productId = productByRecipe.get(line.recipeId)
    if (!productId) continue
    const productCategories = categoriesByProduct.get(productId)
    if (!productCategories?.size) continue
    const itemCategories = categoryIdsByItem.get(line.inventoryItemId) ?? new Set<string>()
    for (const categoryId of productCategories) itemCategories.add(categoryId)
    categoryIdsByItem.set(line.inventoryItemId, itemCategories)
  }
  return Object.fromEntries([...categoryIdsByItem].flatMap(([inventoryItemId, categoryIds]) => {
    if (categoryIds.size !== 1) return []
    const categoryName = categoryNames.get([...categoryIds][0])
    return categoryName ? [[inventoryItemId, categoryName]] : []
  }))
}
