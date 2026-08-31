export type RecipeAmount = { inventoryItemId: string; quantity: number; unitId: string }
export type RecipeLine = {
  inventoryItemId: string
  quantity: number | null
  unitId: string | null
  usesFormatDefault?: boolean
  formatId?: string | null
}
export type ModifierEffect = {
  operation: 'ADD' | 'REMOVE'
  inventoryItemId: string
  quantity?: number | null
  unitId?: string | null
  multiplier?: number
}

export function resolveEffectiveInventoryRecipe(input: {
  recipes: Array<{ multiplier: number; lines: RecipeLine[] }>
  formatDefaults?: Record<string, { quantity: number; unitId: string }>
  effects?: ModifierEffect[]
}): RecipeAmount[] {
  const amounts = new Map<string, RecipeAmount>()
  const add = (amount: RecipeAmount) => {
    const current = amounts.get(amount.inventoryItemId)
    if (current && current.unitId !== amount.unitId) throw new Error('UNIT_CONVERSION_REQUIRED')
    amounts.set(amount.inventoryItemId, { ...amount, quantity: (current?.quantity ?? 0) + amount.quantity })
  }
  for (const recipe of input.recipes) {
    for (const line of recipe.lines) {
      const inherited = line.usesFormatDefault ? input.formatDefaults?.[line.formatId ?? ''] : null
      const quantity = inherited?.quantity ?? line.quantity
      const unitId = inherited?.unitId ?? line.unitId
      if (quantity == null || unitId == null) continue
      add({ inventoryItemId: line.inventoryItemId, quantity: quantity * recipe.multiplier, unitId })
    }
  }
  for (const effect of input.effects ?? []) {
    if (effect.operation === 'REMOVE') amounts.delete(effect.inventoryItemId)
  }
  for (const effect of input.effects ?? []) {
    if (effect.operation !== 'ADD' || effect.quantity == null || effect.unitId == null) continue
    add({ inventoryItemId: effect.inventoryItemId, quantity: effect.quantity * (effect.multiplier ?? 1), unitId: effect.unitId })
  }
  return [...amounts.values()].sort((left, right) => left.inventoryItemId.localeCompare(right.inventoryItemId))
}

export function scaleInventoryProduction<T extends RecipeAmount>(referenceQuantity: number, producedQuantity: number, ingredients: T[]) {
  if (!(referenceQuantity > 0) || !(producedQuantity > 0)) throw new Error('INVALID_PRODUCTION_QUANTITY')
  const factor = producedQuantity / referenceQuantity
  return ingredients.map((ingredient) => ({ ...ingredient, quantity: ingredient.quantity * factor }))
}

export function allocateInventoryByRoute(required: number, route: Array<{ warehouseId: string; priority: number; quantity: number }>) {
  if (!(required > 0) || !route.length) return route.map((level) => ({ ...level }))
  const ordered = route.map((level) => ({ ...level })).sort((a, b) => a.priority - b.priority)
  let remaining = required
  for (const level of ordered) {
    const take = Math.min(Math.max(level.quantity, 0), remaining)
    level.quantity -= take
    remaining -= take
    if (remaining <= 0) break
  }
  if (remaining > 0) ordered[0].quantity -= remaining
  return ordered
}
