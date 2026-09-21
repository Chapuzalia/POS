import type { CatalogData } from '../catalog/domain/types'
import type { RestaurantOrderLine } from '../tables/types'
import type { ProductionEntry, ProductionRouting } from './types'

function firstCategoryId(catalog: CatalogData, productId: string) {
  return catalog.placements
    .filter((placement) => placement.productId === productId && placement.active && placement.categoryId)
    .sort((left, right) => left.sortOrder - right.sortOrder || left.id.localeCompare(right.id))[0]?.categoryId ?? null
}

export function resolveProductionPass(routing: ProductionRouting | undefined, productId: string | null, categoryId: string | null) {
  if (!routing || !productId) return routing?.defaultPass ?? routing?.passes[0] ?? null
  const productPassId = routing.productRoutes.find((route) => route.productId === productId)?.passId
  const categoryPassId = categoryId ? routing.categoryRoutes.find((route) => route.categoryId === categoryId)?.passId : undefined
  const passId = productPassId ?? categoryPassId ?? routing.defaultPass?.id ?? routing.passes[0]?.id
  return routing.passes.find((pass) => pass.id === passId) ?? routing.defaultPass ?? routing.passes[0] ?? null
}

function makeEntry(line: RestaurantOrderLine, componentId: string | null, productId: string | null, productName: string, quantity: number, categoryId: string | null, routing: ProductionRouting | undefined): ProductionEntry | null {
  const pass = resolveProductionPass(routing, productId, categoryId)
  if (!pass) return null
  return {
    lineId: line.id,
    componentId,
    productName,
    parentProductName: componentId ? line.productName : null,
    quantity: line.quantity,
    sentQuantity: 0,
    readyQuantity: 0,
    unsentQuantity: Math.max(0, quantity - line.servedQuantity),
    passId: pass.id,
    passName: pass.name,
    passSortOrder: pass.sortOrder,
    hasProductionDestination: true,
    optimistic: true,
  }
}

export function buildOptimisticProductionEntries(lines: RestaurantOrderLine[], catalog: CatalogData | null, routing: ProductionRouting | undefined) {
  if (!catalog || !routing) return []
  return lines.flatMap((line) => {
    if (line.components.length === 0) {
      const categoryId = line.catalogSnapshot.categoryId ?? firstCategoryId(catalog, line.productId ?? '')
      const entry = makeEntry(line, null, line.productId, line.productName, line.quantity, categoryId, routing)
      return entry ? [entry] : []
    }
    return line.components.flatMap((component) => {
      const categoryId = firstCategoryId(catalog, component.productId)
      const entry = makeEntry(line, component.id, component.productId, component.productName, line.quantity, categoryId, routing)
      return entry ? [entry] : []
    })
  })
}

export function mergeProductionEntries(authoritative: ProductionEntry[], optimistic: ProductionEntry[]) {
  const authoritativeKeys = new Set(authoritative.map((entry) => `${entry.lineId}:${entry.componentId ?? ''}`))
  return [...authoritative, ...optimistic.filter((entry) => !authoritativeKeys.has(`${entry.lineId}:${entry.componentId ?? ''}`))]
}
