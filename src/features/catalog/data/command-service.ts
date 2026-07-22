import { CatalogDomainError } from '../domain/errors.ts'
import type {
  CatalogAssignmentInput,
  CatalogBatchCommand,
  CatalogPlacementInput,
  CatalogProductInput,
  CatalogReorderInput,
  CatalogSaleFormatInput,
  CatalogSelectionGroupInput,
  CatalogVariantInput,
} from './commands.ts'
import type { CatalogRepository } from './repository.ts'

const payload = (value: object) => value as Readonly<Record<string, unknown>>

export class CatalogCommandService {
  private readonly repository: CatalogRepository

  constructor(repository: CatalogRepository) {
    this.repository = repository
  }

  createProduct(venueId: string, input: CatalogProductInput) {
    if (!input.variants?.length) throw new CatalogDomainError('CATALOG_PRODUCT_NOT_SELLABLE', 'El producto necesita al menos una variante.')
    return this.repository.executeCommand(venueId, 'create_product', payload(input))
  }

  updateProduct(venueId: string, input: CatalogProductInput & { id: string }) {
    return this.repository.executeCommand(venueId, 'update_product', payload(input))
  }

  setProductActive(venueId: string, productId: string, active: boolean) {
    return this.repository.executeCommand(venueId, 'set_product_active', { id: productId, active })
  }

  deleteProduct(venueId: string, productId: string) {
    return this.repository.executeCommand(venueId, 'delete_product', { id: productId })
  }

  createVariant(venueId: string, productId: string, input: CatalogVariantInput) {
    if (input.formatId) return this.repository.executeVariantFormatCommand(venueId, 'create_variant', payload({ ...input, productId }))
    return this.repository.executeCommand(venueId, 'create_variant', payload({ ...input, productId }))
  }

  updateVariant(venueId: string, input: CatalogVariantInput & { id: string; productId: string }) {
    if (input.formatId) return this.repository.executeVariantFormatCommand(venueId, 'update_variant', payload(input))
    return this.repository.executeCommand(venueId, 'update_variant', payload(input))
  }

  setDefaultVariant(venueId: string, productId: string, variantId: string) {
    return this.repository.executeCommand(venueId, 'set_default_variant', { productId, variantId })
  }

  deleteVariant(venueId: string, productId: string, variantId: string) {
    return this.repository.executeCommand(venueId, 'delete_variant', { productId, id: variantId })
  }

  createPlacement(venueId: string, input: CatalogPlacementInput) {
    return this.repository.executeCommand(venueId, 'create_placement', payload(input))
  }

  updatePlacement(venueId: string, input: CatalogPlacementInput & { id: string }) {
    return this.repository.executeCommand(venueId, 'update_placement', payload(input))
  }

  deletePlacement(venueId: string, placementId: string) {
    return this.repository.executeCommand(venueId, 'delete_placement', { id: placementId })
  }

  saveTab(venueId: string, input: { id?: string; key: string; label: string; icon?: string | null; active?: boolean; sortOrder: number }) {
    return this.repository.executeCommand(venueId, 'save_tab', payload({ ...input, icon: input.icon || 'receipt' }))
  }

  deleteTab(venueId: string, tabId: string) {
    return this.repository.executeCommand(venueId, 'delete_tab', { id: tabId })
  }

  saveCategory(venueId: string, input: { id?: string; name: string; icon?: string | null; unused?: boolean; active?: boolean; sortOrder: number }) {
    return this.repository.executeCommand(venueId, 'save_category', payload(input))
  }

  deleteCategory(venueId: string, categoryId: string) {
    return this.repository.executeCommand(venueId, 'delete_category', { id: categoryId })
  }

  saveSelectionGroup(venueId: string, input: CatalogSelectionGroupInput) {
    return this.repository.executeCommand(venueId, 'save_selection_group', payload(input))
  }

  deleteSelectionGroup(venueId: string, groupId: string) {
    return this.repository.executeCommand(venueId, 'delete_selection_group', { id: groupId })
  }

  saveSelectionOption(venueId: string, input: {
    id?: string; groupId: string; productId: string; variantId?: string | null; supplementCents: number
    defaultQuantity: number; maxQuantity?: number | null; active?: boolean; sortOrder: number
  }) {
    return this.repository.executeCommand(venueId, 'save_selection_option', payload(input))
  }

  deleteSelectionOption(venueId: string, optionId: string) {
    return this.repository.executeCommand(venueId, 'delete_selection_option', { id: optionId })
  }

  saveModifierGroup(venueId: string, input: { id?: string; name: string; active?: boolean; sortOrder: number }) {
    return this.repository.executeCommand(venueId, 'save_modifier_group', payload(input))
  }

  deleteModifierGroup(venueId: string, groupId: string) {
    return this.repository.executeCommand(venueId, 'delete_modifier_group', { id: groupId })
  }

  saveModifier(venueId: string, input: {
    id?: string; groupId: string; name: string; supplementCents: number; isDefault?: boolean; active?: boolean; sortOrder: number
  }) {
    return this.repository.executeCommand(venueId, 'save_modifier', payload(input))
  }

  deleteModifier(venueId: string, modifierId: string) {
    return this.repository.executeCommand(venueId, 'delete_modifier', { id: modifierId })
  }

  saveAssignment(venueId: string, input: CatalogAssignmentInput) {
    return this.repository.executeCommand(venueId, 'save_assignment', payload(input))
  }

  deleteAssignment(venueId: string, domain: CatalogAssignmentInput['domain'], assignmentId: string) {
    return this.repository.executeCommand(venueId, 'delete_assignment', { domain, id: assignmentId })
  }

  reorder(venueId: string, input: CatalogReorderInput) {
    return this.repository.executeCommand(venueId, 'reorder', payload(input))
  }

  executeBatch(venueId: string, commands: readonly CatalogBatchCommand[]) {
    return this.repository.executeBatch(venueId, commands)
  }

  executeBatchWithVariantFormats(venueId: string, commands: readonly CatalogBatchCommand[], variantFormats: readonly { variantId: string; formatId: string }[], newFormats: readonly { id: string; name: string; active: boolean; sortOrder: number }[] = []) {
    return this.repository.executeBatchWithVariantFormats(venueId, commands, variantFormats, newFormats)
  }

  saveSaleFormat(venueId: string, input: CatalogSaleFormatInput) {
    return this.repository.executeSaleFormatCommand(venueId, 'save', payload(input))
  }

  deleteSaleFormat(venueId: string, formatId: string) {
    return this.repository.executeSaleFormatCommand(venueId, 'delete', { id: formatId })
  }

  reorderSaleFormats(venueId: string, items: readonly { id: string; sortOrder: number }[]) {
    return this.repository.executeSaleFormatCommand(venueId, 'reorder', { items })
  }

  saveTabCategory(venueId: string, input: {
    id?: string; tabId: string; categoryId: string; active?: boolean; sortOrder: number
  }) {
    return this.repository.saveTabCategory(venueId, payload(input))
  }

  deleteTabCategory(venueId: string, id: string) {
    return this.repository.deleteTabCategory(venueId, id)
  }

  saveProductImage(venueId: string, input: {
    id?: string; productId: string; storagePath: string; mimeType: string; sizeBytes: number; sha256: string
  }) {
    return this.repository.saveProductImage(venueId, payload(input))
  }

  deleteProductImage(venueId: string, productId: string) {
    return this.repository.deleteProductImage(venueId, productId)
  }}
