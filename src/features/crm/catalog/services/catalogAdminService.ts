import { CatalogCommandService } from '../../../catalog/data/command-service.ts'
import type { CatalogBatchCommand } from '../../../catalog/data/commands.ts'
import { CatalogRepository } from '../../../catalog/data/repository.ts'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import {
  PRODUCT_IMAGE_BUCKET,
  resizeProductImageToWebp,
} from '../../../../lib/productImages.ts'
import { supabase } from '../../../../lib/supabase.ts'
import { buildProductDuplicationPlan } from './catalogAdminModel.ts'

export const CRM_CATALOG_IMAGE_MAX_SOURCE_BYTES = 10 * 1024 * 1024
export const CRM_CATALOG_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const

function requireClient() {
  if (!supabase) throw new Error('Supabase no está configurado.')
  return supabase
}

const repository = new CatalogRepository(supabase as NonNullable<typeof supabase>)
const commands = new CatalogCommandService(repository)

function uuid() {
  return crypto.randomUUID()
}

async function sha256(blob: Blob) {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const catalogAdminService = {
  uuid,

  load(venueId: string, force = false): Promise<CatalogData> {
    return repository.getCatalog(venueId, 'admin', force)
  },

  invalidate(venueId: string) {
    repository.invalidate(venueId)
  },

  batch(venueId: string, batchCommands: readonly CatalogBatchCommand[]) {
    return commands.executeBatch(venueId, batchCommands)
  },

  batchWithVariantFormats(venueId: string, batchCommands: readonly CatalogBatchCommand[], variantFormats: readonly { variantId: string; formatId: string }[], newFormats: readonly { id: string; name: string; active: boolean; sortOrder: number }[] = []) {
    return commands.executeBatchWithVariantFormats(venueId, batchCommands, variantFormats, newFormats)
  },

  async duplicateProduct(catalog: CatalogData, sourceProductId: string) {
    const plan = buildProductDuplicationPlan(catalog, sourceProductId, uuid)
    await commands.executeBatchWithVariantFormats(catalog.venueId, plan.batch, plan.variantFormats)
    if (!plan.image) return plan.productId

    try {
      await commands.saveProductImage(catalog.venueId, {
        id: uuid(),
        productId: plan.productId,
        storagePath: plan.image.storagePath,
        mimeType: plan.image.mimeType,
        sizeBytes: plan.image.sizeBytes,
        sha256: plan.image.sha256,
      })
    } catch (error) {
      try {
        await commands.deleteProduct(catalog.venueId, plan.productId)
      } catch {
        // Preserve the image error: it describes the incomplete duplication while
        // the next forced catalog refresh will still expose any failed rollback.
      }
      throw error
    }
    return plan.productId
  },

  createProduct: commands.createProduct.bind(commands),
  updateProduct: commands.updateProduct.bind(commands),
  setProductActive: commands.setProductActive.bind(commands),
  deleteProduct: commands.deleteProduct.bind(commands),
  createVariant: commands.createVariant.bind(commands),
  updateVariant: commands.updateVariant.bind(commands),
  setDefaultVariant: commands.setDefaultVariant.bind(commands),
  deleteVariant: commands.deleteVariant.bind(commands),
  saveSaleFormat: commands.saveSaleFormat.bind(commands),
  deleteSaleFormat: commands.deleteSaleFormat.bind(commands),
  reorderSaleFormats: commands.reorderSaleFormats.bind(commands),
  createPlacement: commands.createPlacement.bind(commands),
  updatePlacement: commands.updatePlacement.bind(commands),
  deletePlacement: commands.deletePlacement.bind(commands),
  saveTab: commands.saveTab.bind(commands),
  deleteTab: commands.deleteTab.bind(commands),
  saveCategory: commands.saveCategory.bind(commands),
  deleteCategory: commands.deleteCategory.bind(commands),
  saveTabCategory: commands.saveTabCategory.bind(commands),
  deleteTabCategory: commands.deleteTabCategory.bind(commands),
  saveSelectionGroup: commands.saveSelectionGroup.bind(commands),
  deleteSelectionGroup: commands.deleteSelectionGroup.bind(commands),
  saveSelectionOption: commands.saveSelectionOption.bind(commands),
  deleteSelectionOption: commands.deleteSelectionOption.bind(commands),
  saveModifierGroup: commands.saveModifierGroup.bind(commands),
  deleteModifierGroup: commands.deleteModifierGroup.bind(commands),
  saveModifier: commands.saveModifier.bind(commands),
  deleteModifier: commands.deleteModifier.bind(commands),
  saveAssignment: commands.saveAssignment.bind(commands),
  deleteAssignment: commands.deleteAssignment.bind(commands),
  reorder: commands.reorder.bind(commands),

  async uploadProductImage(input: {
    tenantId: string
    venueId: string
    productId: string
    file: File
    fillColor?: string
  }) {
    if (!CRM_CATALOG_IMAGE_TYPES.includes(input.file.type as typeof CRM_CATALOG_IMAGE_TYPES[number])) {
      throw new Error('Formato no permitido. Usa JPEG, PNG, WebP o AVIF.')
    }
    if (input.file.size <= 0 || input.file.size > CRM_CATALOG_IMAGE_MAX_SOURCE_BYTES) {
      throw new Error('La imagen debe ocupar como máximo 10 MB.')
    }
    const blob = await resizeProductImageToWebp(input.file, input.fillColor)
    if (blob.size > 1024 * 1024) throw new Error('La imagen optimizada supera el máximo de 1 MB.')
    const imageId = uuid()
    const storagePath = `${input.tenantId}/${input.venueId}/products/${input.productId}/${imageId}.webp`
    const client = requireClient()
    const { error: uploadError } = await client.storage.from(PRODUCT_IMAGE_BUCKET).upload(storagePath, blob, {
      cacheControl: '31536000',
      contentType: 'image/webp',
      upsert: false,
    })
    if (uploadError) throw uploadError
    try {
      await commands.saveProductImage(input.venueId, {
        id: imageId,
        productId: input.productId,
        storagePath,
        mimeType: 'image/webp',
        sizeBytes: blob.size,
        sha256: await sha256(blob),
      })
    } catch (error) {
      await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([storagePath])
      throw error
    }
  },

  deleteProductImage(venueId: string, productId: string) {
    return commands.deleteProductImage(venueId, productId)
  },
}
