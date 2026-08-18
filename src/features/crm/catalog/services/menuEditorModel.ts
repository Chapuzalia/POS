import type { CatalogBatchCommand } from '../../../catalog/data/commands'
import type { CatalogData, CatalogProduct } from '../../../catalog/domain/types'

export type NewMenuCourseDraft = {
  id: string
  name: string
  minSelection: number
  maxSelection: number
  options: Array<{
    productId: string
    supplementCents: number
  }>
}

export type MenuCompleteness = {
  complete: boolean
  courseCount: number
  issues: string[]
}

export function getMenuCompleteness(catalog: CatalogData, product: CatalogProduct | null): MenuCompleteness {
  if (!product) return { complete: false, courseCount: 0, issues: ['Guarda la información general.'] }
  const issues: string[] = []
  const variants = catalog.variants.filter((variant) => variant.productId === product.id && variant.active)
  if (variants.filter((variant) => variant.isDefault).length !== 1) issues.push('Debe haber exactamente una variante predeterminada activa.')
  const activeAssignments = catalog.selectionAssignments.filter((assignment) => assignment.productId === product.id && assignment.active)
  const assignments = activeAssignments
    .filter((assignment) => catalog.selectionGroups.some((group) => group.id === assignment.groupId && group.active && group.type === 'menu_component'))
    .toSorted((left, right) => left.sortOrder - right.sortOrder)
  if (activeAssignments.length !== assignments.length) issues.push('El menú contiene una asignación antigua que no es un curso válido.')
  if (!assignments.length) issues.push('Añade al menos un curso obligatorio.')
  for (const assignment of assignments) {
    const group = catalog.selectionGroups.find((candidate) => candidate.id === assignment.groupId)
    const label = assignment.displayName || group?.name || 'Curso'
    if (assignment.minSelection < 1 || assignment.maxSelection < assignment.minSelection) issues.push(`${label} tiene límites de selección inválidos.`)
    const capacity = catalog.selectionOptions
      .filter((option) => option.groupId === assignment.groupId && option.active)
      .filter((option) => catalog.products.some((candidate) => candidate.id === option.productId && candidate.active && candidate.type === 'standard'
        && catalog.variants.some((variant) => variant.productId === candidate.id && variant.active
          && (option.variantId ? variant.id === option.variantId : variant.isDefault))))
      .reduce((total, option) => total + (option.maxQuantity ?? 1), 0)
    if (capacity < assignment.minSelection) issues.push(`${label} no tiene suficientes opciones disponibles.`)
  }
  for (const variant of variants) {
    const applicable = assignments.filter((assignment) => assignment.appliesToAllVariants || assignment.variantIds.includes(variant.id))
    if (!applicable.length) issues.push(`${variant.name} no tiene ningún curso disponible.`)
  }
  return { complete: issues.length === 0, courseCount: assignments.length, issues }
}

export function buildNewMenuBatch(input: {
  catalog: CatalogData
  productId: string
  variantId: string
  formatId: string
  name: string
  description: string
  priceCents: number
  vatRate: number | null
  tabId: string
  categoryId: string
  courses: NewMenuCourseDraft[]
  createId: () => string
}) {
  const batch: CatalogBatchCommand[] = [{
    command: 'create_product',
    payload: {
      id: input.productId,
      type: 'menu',
      name: input.name.trim(),
      description: input.description.trim() || null,
      vatRate: input.vatRate,
      active: false,
      sortOrder: input.catalog.products.length * 10,
      variants: [{
        id: input.variantId,
        formatId: input.formatId,
        name: input.catalog.saleFormats.find((format) => format.id === input.formatId)?.name ?? 'Menú',
        priceCents: input.priceCents,
        active: true,
        isDefault: true,
        sortOrder: 0,
      }],
    },
  }]
  input.courses.forEach((course, courseIndex) => {
    const groupId = course.id
    batch.push({ command: 'save_selection_group', payload: { id: groupId, name: course.name.trim(), type: 'menu_component', active: true, sortOrder: input.catalog.selectionGroups.length * 10 + courseIndex * 10 } })
    course.options.forEach((option, optionIndex) => batch.push({
      command: 'save_selection_option',
      payload: { id: input.createId(), groupId, productId: option.productId, variantId: null, supplementCents: option.supplementCents, defaultQuantity: 0, maxQuantity: 1, active: true, sortOrder: optionIndex * 10 },
    }))
    batch.push({
      command: 'save_assignment',
      payload: {
        id: input.createId(), domain: 'selection', productId: input.productId, groupId,
        displayName: course.name.trim(), minSelection: course.minSelection,
        maxSelection: course.maxSelection, appliesToAllVariants: true, variantIds: [], active: true,
        sortOrder: courseIndex * 10,
      },
    })
  })
  batch.push({ command: 'set_product_active', payload: { id: input.productId, active: true } })
  if (input.tabId) batch.push({
    command: 'create_placement',
    payload: { id: input.createId(), productId: input.productId, tabId: input.tabId, categoryId: input.categoryId || null, pinnedVariantId: null, featured: false, active: true, sortOrder: input.catalog.placements.length * 10 },
  })
  return {
    batch,
    variantFormats: [{ variantId: input.variantId, formatId: input.formatId }],
  }
}

export function validateNewMenuDraft(input: { name: string; formatId: string; priceCents: number; courses: NewMenuCourseDraft[] }) {
  const issues: string[] = []
  if (!input.name.trim()) issues.push('Escribe el nombre del menú.')
  if (!input.formatId) issues.push('Selecciona un formato de venta.')
  if (!Number.isSafeInteger(input.priceCents) || input.priceCents < 0) issues.push('Introduce un precio válido.')
  if (!input.courses.length) issues.push('Añade al menos un curso.')
  for (const course of input.courses) {
    const label = course.name.trim() || 'Curso sin nombre'
    if (!course.name.trim()) issues.push('Todos los cursos necesitan nombre.')
    if (course.minSelection < 1 || course.maxSelection < course.minSelection) issues.push(`${label} tiene límites inválidos.`)
    if (course.options.length < course.minSelection) issues.push(`${label} necesita más opciones.`)
    if (course.options.some((option) => !Number.isSafeInteger(option.supplementCents))) issues.push(`${label} tiene un suplemento inválido.`)
  }
  return issues
}
