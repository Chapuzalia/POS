import { createMenuCatalog } from './menu-catalog.mjs'

export function createEditableProductCatalog() {
  const catalog = createMenuCatalog()
  const row = (id, extra = {}) => ({ id, tenantId: 'tenant', venueId: 'venue', active: true, sortOrder: 0, ...extra })
  catalog.products[1] = { ...catalog.products[1], name: 'Combinado' }
  catalog.products[2] = { ...catalog.products[2], name: 'Cola' }
  catalog.products[3] = { ...catalog.products[3], name: 'Tónica' }
  catalog.variants.push(row('large', { productId: 'p1', isDefault: false, name: 'Grande', priceCents: 1000 }))
  catalog.selectionGroups.push(row('mixers', { name: 'Refresco', type: 'mixer' }))
  catalog.selectionOptions.push(...[2, 3].map(index => row(`mixer${index}`, { groupId: 'mixers', productId: `p${index}`, variantId: `v${index}`,
    supplementCents: index === 3 ? 100 : 0, defaultQuantity: 0, maxQuantity: 1 })))
  catalog.selectionAssignments.push(row('mixer-assignment', { productId: 'p1', groupId: 'mixers', minSelection: 0, maxSelection: 1, appliesToAllVariants: true, variantIds: [] }))
  catalog.modifierGroups.push(row('ice', { name: 'Hielo' }))
  catalog.modifiers.push(row('with-ice', { groupId: 'ice', name: 'Con hielo', supplementCents: 0, isDefault: false }),
    row('without-ice', { groupId: 'ice', name: 'Sin hielo', supplementCents: 0, isDefault: false }))
  catalog.modifierAssignments.push(row('ice-assignment', { productId: 'p1', groupId: 'ice', minSelection: 1, maxSelection: 1, appliesToAllVariants: true, variantIds: [] }))
  return catalog
}
