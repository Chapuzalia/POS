import { PRODUCT_IMAGE_BUCKET } from '../../../../lib/productImages'
import { deleteProductImage } from './catalogService'
import { getImportKey, requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CatalogKind, type SaleFormat, type TenantContext } from '../../../../types'
import { type ParsedCatalogTransfer } from '../../../../lib/catalogTransfer'
import { type RevoImportProduct } from '../../../../lib/revoImport'

export type ProductSaleFormatsRow = {
  id: string
  sale_formats: SaleFormat[] | null
}

export type ImportCategoryRow = {
  id: string
  name: string
  kind: CatalogKind
  sort_order: number
}

export type ImportVariantRow = {
  id: string
  name: string
}

export type ImportProductRow = {
  id: string
  category_id: string
  name: string
  sort_order: number
  product_variants: ImportVariantRow[] | null
}

export type CatalogImportResult = {
  categoriesCreated: number
  categoriesUpdated: number
  productsCreated: number
  productsUpdated: number
  variantsCreated: number
  variantsUpdated: number
}

export type CatalogBackupImportResult = CatalogImportResult & {
  saleFormatsCreated: number
  saleFormatsUpdated: number
  modifierGroupsCreated: number
  modifierGroupsUpdated: number
  modifiersCreated: number
  modifiersUpdated: number
  imagesUploaded: number
}

export type BackupVariantRow = {
  id: string
  name: string
}

export type BackupModifierRow = {
  id: string
  name: string
}

export type BackupModifierGroupRow = {
  id: string
  name: string
  modifiers: BackupModifierRow[] | null
}

export type BackupProductRow = {
  id: string
  category_id: string
  name: string
  image_path: string | null
  product_variants: BackupVariantRow[] | null
  modifier_groups: BackupModifierGroupRow[] | null
}

export function getBackupImagePath(context: TenantContext, sourceProductId: string) {
  const safeId = sourceProductId.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80) || 'product'
  return `${context.tenantId}/products/backup-${safeId}.webp`
}

/**
 * Merges a complete CRM catalog backup into the selected venue. Records are
 * matched by their source id first and by normalized name second, which makes
 * re-importing the same ZIP idempotent without coupling backups to a tenant.
 */
export async function importCatalogBackup(
  context: TenantContext,
  transfer: ParsedCatalogTransfer,
  venueId: string,
): Promise<CatalogBackupImportResult> {
  const client = requireSupabase()
  const result: CatalogBackupImportResult = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
    saleFormatsCreated: 0,
    saleFormatsUpdated: 0,
    modifierGroupsCreated: 0,
    modifierGroupsUpdated: 0,
    modifiersCreated: 0,
    modifiersUpdated: 0,
    imagesUploaded: 0,
  }
  const [categoriesResult, saleFormatsResult, productsResult] = await Promise.all([
    client
      .from('categories')
      .select('id, name')
      .eq('tenant_id', context.tenantId),
    client
      .from('sale_formats')
      .select('key')
      .eq('tenant_id', context.tenantId),
    client
      .from('products')
      .select(`
        id,
        category_id,
        name,
        image_path,
        product_variants (id, name),
        modifier_groups (id, name, modifiers (id, name))
      `)
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId),
  ])

  if (categoriesResult.error || saleFormatsResult.error || productsResult.error) {
    throw categoriesResult.error ?? saleFormatsResult.error ?? productsResult.error
  }

  const existingSaleFormats = new Set((saleFormatsResult.data ?? []).map((row) => row.key as string))
  if (transfer.manifest.saleFormats.length) {
    const { error } = await client.from('sale_formats').upsert(
      transfer.manifest.saleFormats.map((saleFormat) => ({
        tenant_id: context.tenantId,
        key: saleFormat.key,
        label: saleFormat.label,
        sort_order: saleFormat.sortOrder,
        is_active: saleFormat.isActive,
      })),
      { onConflict: 'tenant_id,key' },
    )
    if (error) {
      throw error
    }
    for (const saleFormat of transfer.manifest.saleFormats) {
      if (existingSaleFormats.has(saleFormat.key)) {
        result.saleFormatsUpdated += 1
      } else {
        result.saleFormatsCreated += 1
      }
    }
  }

  const categoryRows = (categoriesResult.data ?? []) as Array<{ id: string; name: string }>
  const categoryById = new Map(categoryRows.map((category) => [category.id, category]))
  const categoryByName = new Map(categoryRows.map((category) => [getImportKey(category.name), category]))
  const categoryIdMap = new Map<string, string>()

  for (const category of transfer.manifest.categories) {
    const existing = categoryById.get(category.id) ?? categoryByName.get(getImportKey(category.name))
    if (existing) {
      const { error } = await client
        .from('categories')
        .update({
          name: category.name,
          kind: category.kind,
          icon: category.icon || category.kind,
          sort_order: category.sortOrder,
          is_active: category.isActive,
        })
        .eq('tenant_id', context.tenantId)
        .eq('id', existing.id)
      if (error) {
        throw error
      }
      categoryIdMap.set(category.id, existing.id)
      result.categoriesUpdated += 1
      continue
    }

    const { data, error } = await client
      .from('categories')
      .insert({
        tenant_id: context.tenantId,
        name: category.name,
        kind: category.kind,
        icon: category.icon || category.kind,
        sort_order: category.sortOrder,
        is_active: category.isActive,
      })
      .select('id, name')
      .single<{ id: string; name: string }>()
    if (error) {
      throw error
    }
    categoryByName.set(getImportKey(data.name), data)
    categoryIdMap.set(category.id, data.id)
    result.categoriesCreated += 1
  }

  const productRows = (productsResult.data ?? []) as BackupProductRow[]
  const productById = new Map(productRows.map((product) => [product.id, product]))
  const productByName = new Map(
    productRows.map((product) => [`${product.category_id}:${getImportKey(product.name)}`, product]),
  )

  for (const product of transfer.manifest.products) {
    const categoryId = categoryIdMap.get(product.categoryId)
    if (!categoryId) {
      throw new Error(`No se ha podido resolver la categoria de ${product.name}.`)
    }
    const existing = productById.get(product.id) ?? productByName.get(`${categoryId}:${getImportKey(product.name)}`)
    const previousImagePath = existing?.image_path ?? null
    let imagePath: string | null = null

    if (product.imageFile) {
      const image = transfer.images.get(product.imageFile)
      if (!image) {
        throw new Error(`No se ha encontrado la imagen de ${product.name}.`)
      }
      imagePath = getBackupImagePath(context, product.id)
      const imageBuffer = image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength) as ArrayBuffer
      const { error } = await client.storage
        .from(PRODUCT_IMAGE_BUCKET)
        .upload(imagePath, new Blob([imageBuffer], { type: 'image/webp' }), {
          cacheControl: '31536000',
          contentType: 'image/webp',
          upsert: true,
        })
      if (error) {
        throw new Error(`No se ha podido importar la imagen de ${product.name}: ${error.message}`)
      }
      result.imagesUploaded += 1
    }

    const productPayload = {
      category_id: categoryId,
      name: product.name,
      description: product.description,
      image_path: imagePath,
      kind: product.kind,
      sale_formats: product.saleFormats,
      can_sell_standalone: product.canSellStandalone,
      can_use_as_mixer: product.canUseAsMixer,
      is_featured: product.isFeatured,
      mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
      tax_rate: product.taxRate,
      is_active: product.isActive,
      sort_order: product.sortOrder,
    }
    let savedProduct: BackupProductRow

    if (existing) {
      const { error } = await client
        .from('products')
        .update(productPayload)
        .eq('tenant_id', context.tenantId)
        .eq('id', existing.id)
      if (error) {
        throw error
      }
      savedProduct = existing
      result.productsUpdated += 1
    } else {
      const { data, error } = await client
        .from('products')
        .insert({
          tenant_id: context.tenantId,
          venue_id: venueId,
          ...productPayload,
        })
        .select('id, category_id, name, image_path')
        .single<Omit<BackupProductRow, 'product_variants' | 'modifier_groups'>>()
      if (error) {
        throw error
      }
      savedProduct = { ...data, product_variants: [], modifier_groups: [] }
      productByName.set(`${categoryId}:${getImportKey(product.name)}`, savedProduct)
      result.productsCreated += 1
    }

    if (previousImagePath && previousImagePath !== imagePath) {
      await deleteProductImage(context, previousImagePath).catch(() => undefined)
    }

    const variants = savedProduct.product_variants ?? []
    const variantById = new Map(variants.map((variant) => [variant.id, variant]))
    const variantByName = new Map(variants.map((variant) => [getImportKey(variant.name), variant]))
    for (const variant of product.variants) {
      const existingVariant = variantById.get(variant.id) ?? variantByName.get(getImportKey(variant.name))
      const payload = {
        name: variant.name,
        price_cents: variant.priceCents,
        sku: variant.sku,
        is_default: variant.isDefault,
        sort_order: variant.sortOrder,
      }
      if (existingVariant) {
        const { error } = await client
          .from('product_variants')
          .update(payload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingVariant.id)
        if (error) {
          throw error
        }
        result.variantsUpdated += 1
      } else {
        const { error } = await client.from('product_variants').insert({
          tenant_id: context.tenantId,
          product_id: savedProduct.id,
          ...payload,
        })
        if (error) {
          throw error
        }
        result.variantsCreated += 1
      }
    }

    const groups = savedProduct.modifier_groups ?? []
    const groupById = new Map(groups.map((group) => [group.id, group]))
    const groupByName = new Map(groups.map((group) => [getImportKey(group.name), group]))
    for (const group of product.modifierGroups) {
      const existingGroup = groupById.get(group.id) ?? groupByName.get(getImportKey(group.name))
      const groupPayload = {
        name: group.name,
        min_select: group.minSelect,
        max_select: group.maxSelect,
        sort_order: group.sortOrder,
      }
      let savedGroup: BackupModifierGroupRow
      if (existingGroup) {
        const { error } = await client
          .from('modifier_groups')
          .update(groupPayload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingGroup.id)
        if (error) {
          throw error
        }
        savedGroup = existingGroup
        result.modifierGroupsUpdated += 1
      } else {
        const { data, error } = await client
          .from('modifier_groups')
          .insert({ tenant_id: context.tenantId, product_id: savedProduct.id, ...groupPayload })
          .select('id, name')
          .single<{ id: string; name: string }>()
        if (error) {
          throw error
        }
        savedGroup = { ...data, modifiers: [] }
        result.modifierGroupsCreated += 1
      }

      const modifiers = savedGroup.modifiers ?? []
      const modifierById = new Map(modifiers.map((modifier) => [modifier.id, modifier]))
      const modifierByName = new Map(modifiers.map((modifier) => [getImportKey(modifier.name), modifier]))
      for (const modifier of group.modifiers) {
        const existingModifier = modifierById.get(modifier.id) ?? modifierByName.get(getImportKey(modifier.name))
        const modifierPayload = {
          name: modifier.name,
          price_cents: modifier.priceCents,
          sort_order: modifier.sortOrder,
        }
        if (existingModifier) {
          const { error } = await client
            .from('modifiers')
            .update(modifierPayload)
            .eq('tenant_id', context.tenantId)
            .eq('id', existingModifier.id)
          if (error) {
            throw error
          }
          result.modifiersUpdated += 1
        } else {
          const { error } = await client.from('modifiers').insert({
            tenant_id: context.tenantId,
            group_id: savedGroup.id,
            ...modifierPayload,
          })
          if (error) {
            throw error
          }
          result.modifiersCreated += 1
        }
      }
    }
  }

  return result
}

export async function importRevoCatalogProducts(
  context: TenantContext,
  products: RevoImportProduct[],
  venueId: string,
): Promise<CatalogImportResult> {
  const client = requireSupabase()
  const result: CatalogImportResult = {
    categoriesCreated: 0,
    categoriesUpdated: 0,
    productsCreated: 0,
    productsUpdated: 0,
    variantsCreated: 0,
    variantsUpdated: 0,
  }
  const [{ data: categoryRows, error: categoriesError }, { data: productRows, error: productsError }] =
    await Promise.all([
      client
        .from('categories')
        .select('id, name, kind, sort_order')
        .eq('tenant_id', context.tenantId)
        .order('sort_order', { ascending: true }),
      client
        .from('products')
        .select(
          `
          id,
          category_id,
          name,
          sort_order,
          product_variants (
            id,
            name
          )
        `,
        )
        .eq('tenant_id', context.tenantId)
        .eq('venue_id', venueId)
        .order('sort_order', { ascending: true }),
    ])

  if (categoriesError) {
    throw categoriesError
  }

  if (productsError) {
    throw productsError
  }

  const categoriesByKey = new Map(
    ((categoryRows ?? []) as ImportCategoryRow[]).map((category) => [getImportKey(category.name), category]),
  )
  const productsByKey = new Map(
    ((productRows ?? []) as ImportProductRow[]).map((product) => [
      `${product.category_id}:${getImportKey(product.name)}`,
      product,
    ]),
  )
  let nextCategorySortOrder = Math.max(0, ...((categoryRows ?? []) as ImportCategoryRow[]).map((row) => row.sort_order)) + 1
  let nextProductSortOrder = Math.max(0, ...((productRows ?? []) as ImportProductRow[]).map((row) => row.sort_order)) + 1

  async function ensureCategory(product: RevoImportProduct) {
    const categoryKey = getImportKey(product.categoryName)
    const existingCategory = categoriesByKey.get(categoryKey)

    if (existingCategory) {
      if (existingCategory.kind !== product.categoryKind) {
        const { error } = await client
          .from('categories')
          .update({
            icon: product.categoryKind,
            kind: product.categoryKind,
          })
          .eq('tenant_id', context.tenantId)
          .eq('id', existingCategory.id)

        if (error) {
          throw error
        }

        existingCategory.kind = product.categoryKind
        result.categoriesUpdated += 1
      }

      return existingCategory
    }

    const { data: category, error } = await client
      .from('categories')
      .insert({
        tenant_id: context.tenantId,
        name: product.categoryName,
        kind: product.categoryKind,
        icon: product.categoryKind,
        sort_order: nextCategorySortOrder,
        is_active: true,
      })
      .select('id, name, kind, sort_order')
      .single<ImportCategoryRow>()

    if (error) {
      throw error
    }

    nextCategorySortOrder += 1
    categoriesByKey.set(categoryKey, category)
    result.categoriesCreated += 1
    return category
  }

  for (const product of products) {
    const category = await ensureCategory(product)
    const productKey = `${category.id}:${getImportKey(product.name)}`
    const existingProduct = productsByKey.get(productKey)

    if (existingProduct) {
      const { error } = await client
        .from('products')
        .update({
          category_id: category.id,
          name: product.name,
          kind: product.kind,
          sale_formats: product.saleFormats as SaleFormat[],
          can_sell_standalone: product.canSellStandalone,
          can_use_as_mixer: product.canUseAsMixer,
          mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
          is_active: product.active,
        })
        .eq('tenant_id', context.tenantId)
        .eq('id', existingProduct.id)

      if (error) {
        throw error
      }

      result.productsUpdated += 1
    } else {
      const { data: createdProduct, error } = await client
        .from('products')
        .insert({
          tenant_id: context.tenantId,
          venue_id: venueId,
          category_id: category.id,
          name: product.name,
          description: null,
          kind: product.kind,
          sale_formats: product.saleFormats as SaleFormat[],
          can_sell_standalone: product.canSellStandalone,
          can_use_as_mixer: product.canUseAsMixer,
          mixer_supplement_cents: product.canUseAsMixer ? product.mixerSupplementCents : 0,
          is_active: product.active,
          sort_order: nextProductSortOrder,
        })
        .select('id, category_id, name, sort_order')
        .single<Omit<ImportProductRow, 'product_variants'>>()

      if (error) {
        throw error
      }

      nextProductSortOrder += 1
      result.productsCreated += 1
      productsByKey.set(productKey, {
        ...createdProduct,
        product_variants: [],
      })
    }

    const savedProduct = productsByKey.get(productKey)

    if (!savedProduct) {
      continue
    }

    if (product.variants.length) {
      const { error } = await client
        .from('product_variants')
        .update({ is_default: false })
        .eq('tenant_id', context.tenantId)
        .eq('product_id', savedProduct.id)

      if (error) {
        throw error
      }
    }

    const variantsByKey = new Map(
      (savedProduct.product_variants ?? []).map((variant) => [getImportKey(variant.name), variant]),
    )

    for (const [variantIndex, variant] of product.variants.entries()) {
      const variantKey = getImportKey(variant.name)
      const existingVariant = variantsByKey.get(variantKey)
      const payload = {
        name: variant.name,
        price_cents: variant.priceCents,
        is_default: variantIndex === 0,
        sort_order: variant.sortOrder,
      }

      if (existingVariant) {
        const { error } = await client
          .from('product_variants')
          .update(payload)
          .eq('tenant_id', context.tenantId)
          .eq('id', existingVariant.id)

        if (error) {
          throw error
        }

        result.variantsUpdated += 1
      } else {
        const { data: createdVariant, error } = await client
          .from('product_variants')
          .insert({
            tenant_id: context.tenantId,
            product_id: savedProduct.id,
            ...payload,
          })
          .select('id, name')
          .single<ImportVariantRow>()

        if (error) {
          throw error
        }

        variantsByKey.set(variantKey, createdVariant)
        savedProduct.product_variants = [...(savedProduct.product_variants ?? []), createdVariant]
        result.variantsCreated += 1
      }
    }
  }

  return result
}
