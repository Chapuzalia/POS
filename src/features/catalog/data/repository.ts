import type { SupabaseClient } from '@supabase/supabase-js'
import { PRODUCT_IMAGE_BUCKET } from '../../../lib/productImages.ts'
import { CatalogDomainError, toCatalogDomainError } from '../domain/errors.ts'
import {
  getActiveTabs,
  getCategoriesForTab,
  getProductVariants,
  resolveSellableCatalog,
  resolveSellableProduct,
} from '../domain/resolver.ts'
import type { CatalogData, CatalogReadMode } from '../domain/types.ts'
import { catalogCache, type CatalogCache } from './cache.ts'
import type { CatalogBatchCommand, CatalogCommandName } from './commands.ts'
import { mapCatalogPayload } from './mapper.ts'

type CommandResult = { orphanedImagePaths?: string[]; [key: string]: unknown }

export class CatalogRepository {
  private readonly client: SupabaseClient
  private readonly cache: CatalogCache

  constructor(
    client: SupabaseClient,
    cache: CatalogCache = catalogCache,
  ) {
    this.client = client
    this.cache = cache
  }

  private publicImageUrl(storagePath: string) {
    return this.client.storage.from(PRODUCT_IMAGE_BUCKET).getPublicUrl(storagePath).data.publicUrl ?? null
  }

  async getCatalog(venueId: string, mode: CatalogReadMode = 'admin', force = false): Promise<CatalogData> {
    if (!venueId) throw new CatalogDomainError('CATALOG_CROSS_VENUE', 'El local es obligatorio para cargar el catálogo.')
    if (!force) {
      const cached = this.cache.get(venueId, mode)
      if (cached) return cached
      const pending = this.cache.getPending(venueId, mode)
      if (pending) return pending
    }
    const request = (async () => {
      const { data, error } = await this.client.rpc('get_catalog', { p_venue_id: venueId, p_mode: mode })
      if (error) throw toCatalogDomainError(error, 'No se pudo cargar el catálogo.')
      return this.cache.set(mapCatalogPayload(data, venueId, mode, (path) => this.publicImageUrl(path)))
    })()
    return this.cache.setPending(venueId, mode, request)
  }

  async getCatalogForPos(venueId: string, force = false) {
    return resolveSellableCatalog(await this.getCatalog(venueId, 'pos', force))
  }

  getActiveTabs(catalog: CatalogData) {
    return getActiveTabs(catalog)
  }

  getCategoriesForTab(catalog: CatalogData, tabId: string) {
    return getCategoriesForTab(catalog, tabId)
  }

  getActivePlacements(catalog: CatalogData) {
    return catalog.placements.filter((placement) => placement.active)
  }

  getActiveProducts(catalog: CatalogData) {
    return catalog.products.filter((product) => product.active)
  }

  getActiveVariants(catalog: CatalogData, productId: string) {
    return getProductVariants(catalog, productId, true)
  }

  getInternalProducts(catalog: CatalogData) {
    return resolveSellableCatalog(catalog).internalProducts
  }

  getProduct(catalog: CatalogData, productId: string) {
    const product = catalog.products.find((candidate) => candidate.id === productId)
    if (!product) throw new CatalogDomainError('CATALOG_PRODUCT_NOT_FOUND', 'El producto no existe.', { productId })
    return {
      product,
      variants: getProductVariants(catalog, productId, false),
      placements: catalog.placements.filter((placement) => placement.productId === productId),
      selectionAssignments: catalog.selectionAssignments.filter((assignment) => assignment.productId === productId),
      modifierAssignments: catalog.modifierAssignments.filter((assignment) => assignment.productId === productId),
    }
  }

  getVariant(catalog: CatalogData, variantId: string) {
    const variant = catalog.variants.find((candidate) => candidate.id === variantId)
    if (!variant) throw new CatalogDomainError('CATALOG_VARIANT_NOT_FOUND', 'La variante no existe.', { variantId })
    return variant
  }

  getSaleData(catalog: CatalogData, productId: string, variantId: string | null = null) {
    return resolveSellableProduct(catalog, productId, variantId)
  }

  invalidate(venueId: string) {
    this.cache.invalidate(venueId)
  }

  async executeCommand(venueId: string, command: CatalogCommandName, payload: Readonly<Record<string, unknown>> = {}) {
    try {
      const { data, error } = await this.client.rpc('catalog_command', {
        p_venue_id: venueId,
        p_command: command,
        p_payload: payload,
      })
      if (error) throw error
      const result = (data && typeof data === 'object' ? data : {}) as CommandResult
      // The database transaction has committed at this point. Never leave a stale
      // read cache behind if the independent storage cleanup needs to be retried.
      this.invalidate(venueId)
      const orphaned = result.orphanedImagePaths?.filter((path): path is string => typeof path === 'string') ?? []
      if (orphaned.length) {
        const { error: storageError } = await this.client.storage.from(PRODUCT_IMAGE_BUCKET).remove(orphaned)
        if (storageError) throw storageError
      }
      return result
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }

  async executeBatch(venueId: string, commands: readonly CatalogBatchCommand[]) {
    try {
      const { data, error } = await this.client.rpc('catalog_command_batch', {
        p_venue_id: venueId,
        p_commands: commands,
      })
      if (error) throw error
      this.invalidate(venueId)
      return data
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }

  async executeBatchWithVariantFormats(
    venueId: string,
    batchCommands: readonly CatalogBatchCommand[],
    variantFormats: readonly { variantId: string; formatId: string }[],
    newFormats: readonly { id: string; name: string; active: boolean; sortOrder: number }[] = [],
  ) {
    try {
      const { data, error } = await this.client.rpc('catalog_command_batch_with_formats', {
        p_venue_id: venueId,
        p_commands: batchCommands,
        p_variant_formats: variantFormats,
        p_new_formats: newFormats,
      })
      if (error) throw error
      this.invalidate(venueId)
      return data
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }

  async executeVariantFormatCommand(
    venueId: string,
    command: 'create_variant' | 'update_variant',
    payload: Readonly<Record<string, unknown>>,
  ) {
    try {
      const { data, error } = await this.client.rpc('catalog_variant_format_command', {
        p_venue_id: venueId,
        p_command: command,
        p_payload: payload,
      })
      if (error) throw error
      this.invalidate(venueId)
      return data
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }

  async executeSaleFormatCommand(venueId: string, action: 'save' | 'delete' | 'reorder', payload: Readonly<Record<string, unknown>>) {
    try {
      const { data, error } = await this.client.rpc('catalog_sale_format_command', {
        p_venue_id: venueId,
        p_action: action,
        p_payload: payload,
      })
      if (error) throw error
      this.invalidate(venueId)
      return data
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }

  async saveTabCategory(venueId: string, payload: Readonly<Record<string, unknown>>) {
    return this.executeAdminRelation(venueId, 'catalog_tab_category_command', 'save', payload)
  }

  async deleteTabCategory(venueId: string, id: string) {
    return this.executeAdminRelation(venueId, 'catalog_tab_category_command', 'delete', { id })
  }

  async saveProductImage(venueId: string, payload: Readonly<Record<string, unknown>>) {
    return this.executeAdminRelation(venueId, 'catalog_image_command', 'save', payload, true)
  }

  async deleteProductImage(venueId: string, productId: string) {
    return this.executeAdminRelation(venueId, 'catalog_image_command', 'delete', { productId }, true)
  }

  private async executeAdminRelation(
    venueId: string,
    rpc: 'catalog_tab_category_command' | 'catalog_image_command',
    action: 'save' | 'delete',
    payload: Readonly<Record<string, unknown>>,
    cleanStorage = false,
  ) {
    try {
      const { data, error } = await this.client.rpc(rpc, {
        p_venue_id: venueId,
        p_action: action,
        p_payload: payload,
      })
      if (error) throw error
      this.invalidate(venueId)
      const result = (data && typeof data === 'object' ? data : {}) as CommandResult
      const orphaned = result.orphanedImagePaths?.filter((path): path is string => typeof path === 'string') ?? []
      if (cleanStorage && orphaned.length) {
        const { error: storageError } = await this.client.storage.from(PRODUCT_IMAGE_BUCKET).remove(orphaned)
        if (storageError) throw storageError
      }
      return result
    } catch (error) {
      throw toCatalogDomainError(error)
    }
  }}
