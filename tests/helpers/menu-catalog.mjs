export function createMenuCatalog() {
  const row = (id, extra = {}) => ({ id, tenantId: 'tenant', venueId: 'venue', active: true, sortOrder: 0, ...extra })
  const products = ['Menú diario', 'Ensalada', 'Pollo', 'Flan', 'Merluza'].map((name, index) => row(`p${index}`, { name,
    type: index === 0 ? 'menu' : 'standard', vatRate: 10, image: null }))
  return {
    tenantId: 'tenant', venueId: 'venue', mode: 'pos', loadedAt: '', products,
    variants: products.map((product, index) => row(`v${index}`, { productId: product.id, isDefault: true, name: 'Normal', priceCents: index === 0 ? 1500 : 600 })),
    tabs: [row('tab', { label: 'Carta', key: 'main' })], categories: [row('cat', { name: 'Menús' })], tabCategories: [],
    placements: products.map((product, index) => row(`placement${index}`, { productId: product.id, tabId: 'tab', categoryId: 'cat' })),
    selectionGroups: ['Primero', 'Segundo', 'Postre'].map((name, index) => row(`g${index}`, { name, type: 'menu_component' })),
    selectionOptions: [1, 2, 3, 4].map((index) => row(`option${index}`, { groupId: `g${index === 4 ? 1 : index - 1}`, productId: `p${index}`, variantId: `v${index}`,
      supplementCents: 0, defaultQuantity: 0, maxQuantity: 1 })),
    selectionAssignments: [0, 1, 2].map((index) => row(`assignment${index}`, { productId: 'p0', groupId: `g${index}`, minSelection: 1,
      maxSelection: 1, appliesToAllVariants: true, variantIds: [] })),
    modifierGroups: [], modifiers: [], modifierAssignments: [],
    productionRouting: {
      passes: ['Primeros', 'Segundos', 'Postres'].map((name, index) => ({ id: `pass${index}`, name, sortOrder: index })),
      defaultPass: { id: 'pass0', name: 'Primeros', sortOrder: 0 },
      productRoutes: [1, 2, 3, 4].map((index) => ({ productId: `p${index}`, passId: `pass${index === 4 ? 1 : index - 1}` })),
      categoryRoutes: [], categoryDestinationRoutes: [],
      productDestinationRoutes: [1, 2, 3, 4].map((index) => ({ productId: `p${index}`, destinationId: 'kitchen' })), loadedAt: '',
    },
  }
}
