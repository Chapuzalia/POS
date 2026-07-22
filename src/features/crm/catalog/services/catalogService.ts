import { PRODUCT_IMAGE_BUCKET, resizeProductImageToWebp } from '../../../../lib/productImages'
import { createSaleFormatKey, requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CatalogKind, type CategoryCreateInput, type Product, type ProductCreateInput, type SaleFormatDefinition, type TenantContext } from '../../../../types'

export function createProductImagePath(context: TenantContext) {
  const imageId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  return `${context.tenantId}/products/${imageId}.webp`
}

export async function uploadProductImage(context: TenantContext, file: File, fillColor?: string) {
  const client = requireSupabase()
  const imageBlob = await resizeProductImageToWebp(file, fillColor)
  const imagePath = createProductImagePath(context)
  const { error } = await client.storage.from(PRODUCT_IMAGE_BUCKET).upload(imagePath, imageBlob, {
    cacheControl: '31536000',
    contentType: 'image/webp',
    upsert: false,
  })

  if (error) {
    throw error
  }

  return imagePath
}

export async function deleteProductImage(context: TenantContext, imagePath: string | null | undefined) {
  if (!imagePath || !imagePath.startsWith(`${context.tenantId}/`)) {
    return
  }

  const client = requireSupabase()
  const { data: references, error: referencesError } = await client
    .from('products')
    .select('id')
    .eq('tenant_id', context.tenantId)
    .eq('image_path', imagePath)
    .limit(1)

  if (referencesError) {
    throw referencesError
  }

  if (references?.length) {
    return
  }

  const { error } = await client.storage.from(PRODUCT_IMAGE_BUCKET).remove([imagePath])

  if (error) {
    throw error
  }
}

export async function createCategory(context: TenantContext, input: CategoryCreateInput) {
  const client = requireSupabase()
  const { error } = await client.from('categories').insert({
    tenant_id: context.tenantId,
    name: input.name,
    kind: input.kind,
    icon: input.kind,
    sort_order: input.sortOrder,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateCategory(
  context: TenantContext,
  categoryId: string,
  input: Partial<CategoryCreateInput> & { isActive?: boolean },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('categories')
    .update({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.kind !== undefined ? { kind: input.kind, icon: input.kind } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', categoryId)

  if (error) {
    throw error
  }
}

export async function deleteCategory(context: TenantContext, categoryId: string) {
  const client = requireSupabase()
  const { error } = await client.from('categories').delete().eq('tenant_id', context.tenantId).eq('id', categoryId)

  if (error) {
    throw error
  }
}

export async function createSaleFormat(context: TenantContext, input: { label: string; sortOrder: number }) {
  const client = requireSupabase()
  const label = input.label.trim()
  const key = createSaleFormatKey(label)

  if (!label || !key) {
    throw new Error('Indica un nombre valido para el formato.')
  }

  if (key === 'all' || key === 'top') {
    throw new Error('Ese nombre esta reservado para pestanas del catalogo.')
  }

  const { error } = await client.from('sale_formats').insert({
    tenant_id: context.tenantId,
    key,
    label,
    sort_order: input.sortOrder,
    is_active: true,
  })

  if (error) {
    throw error
  }
}

export async function updateSaleFormat(
  context: TenantContext,
  saleFormat: SaleFormatDefinition,
  input: { isActive?: boolean; label?: string; sortOrder?: number },
) {
  const client = requireSupabase()
  const nextLabel = input.label?.trim()
  const { error } = await client
    .from('sale_formats')
    .update({
      ...(nextLabel !== undefined ? { label: nextLabel || saleFormat.label } : {}),
      ...(input.sortOrder !== undefined ? { sort_order: input.sortOrder } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('key', saleFormat.key)

  if (error) {
    throw error
  }
}

export async function deleteSaleFormat(context: TenantContext, saleFormat: SaleFormatDefinition) {
  const client = requireSupabase()
  const { error } = await client
    .from('sale_formats')
    .update({ is_active: false })
    .eq('tenant_id', context.tenantId)
    .eq('id', saleFormat.id)

  if (error) {
    throw error
  }
}

export async function createProductWithVariant(context: TenantContext, input: ProductCreateInput) {
  const client = requireSupabase()

  if (!input.variants.length) {
    throw new Error('Selecciona al menos un formato de venta con su precio.')
  }

  const { data: product, error: productError } = await client
    .from('products')
    .insert({
      tenant_id: context.tenantId,
      venue_id: input.venueId,
      category_id: input.categoryId,
      name: input.name,
      product_type: input.productType,
      description: input.description || null,
      image_path: input.imagePath ?? null,
      kind: input.kind,
      sale_formats: input.saleFormats,
      can_sell_standalone: input.canSellStandalone,
      can_use_as_mixer: input.canUseAsMixer,
      is_featured: input.isFeatured,
      mixer_supplement_cents: input.canUseAsMixer ? input.mixerSupplementCents : 0,
      tax_rate: input.taxRate,
      is_active: true,
      sort_order: 0,
    })
    .select('id')
    .single<{ id: string }>()

  if (productError) {
    throw productError
  }

  const { error: variantError } = await client.from('product_variants').insert(
    input.variants.map((variant, index) => ({
      tenant_id: context.tenantId,
      product_id: product.id,
      name: variant.name,
      price_cents: variant.priceCents,
      sale_format_id: variant.saleFormatId ?? null,
      is_default: index === 0,
      is_active: true,
      sort_order: index * 10,
    })),
  )

  if (variantError) {
    throw variantError
  }

}

export async function updateProduct(
  context: TenantContext,
  productId: string,
  input: {
    categoryId?: string
    description?: string
    imagePath?: string | null
    isActive?: boolean
    isFeatured?: boolean
    kind?: CatalogKind
    name?: string
    saleFormats?: ProductCreateInput['saleFormats']
    canSellStandalone?: boolean
    canUseAsMixer?: boolean
    mixerSupplementCents?: number
    productType?: Product['productType']
    taxRate?: number | null
  },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('products')
    .update({
      ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.imagePath !== undefined ? { image_path: input.imagePath } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.isFeatured !== undefined ? { is_featured: input.isFeatured } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.productType !== undefined ? { product_type: input.productType } : {}),
      ...(input.saleFormats !== undefined ? { sale_formats: input.saleFormats } : {}),
      ...(input.canSellStandalone !== undefined ? { can_sell_standalone: input.canSellStandalone } : {}),
      ...(input.canUseAsMixer !== undefined ? { can_use_as_mixer: input.canUseAsMixer } : {}),
      ...(input.mixerSupplementCents !== undefined ? { mixer_supplement_cents: input.mixerSupplementCents } : {}),
      ...(input.taxRate !== undefined ? { tax_rate: input.taxRate } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', productId)

  if (error) {
    throw error
  }

}

export async function deleteProduct(context: TenantContext, productId: string) {
  const client = requireSupabase()
  const { error } = await client.from('products').delete().eq('tenant_id', context.tenantId).eq('id', productId)

  if (error) {
    throw error
  }
}

export async function updateVariant(
  context: TenantContext,
  variantId: string,
  input: {
    isDefault?: boolean
    name?: string
    priceCents?: number
    sku?: string | null
    saleFormatId?: string | null
    isActive?: boolean
  },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('product_variants')
    .update({
      ...(input.isDefault !== undefined ? { is_default: input.isDefault } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.priceCents !== undefined ? { price_cents: input.priceCents } : {}),
      ...(input.sku !== undefined ? { sku: input.sku } : {}),
      ...(input.saleFormatId !== undefined ? { sale_format_id: input.saleFormatId } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
    })
    .eq('tenant_id', context.tenantId)
    .eq('id', variantId)

  if (error) {
    throw error
  }
}

export async function createVariant(
  context: TenantContext,
  productId: string,
  input: {
    isDefault?: boolean
    name: string
    priceCents: number
    saleFormatId?: string | null
  },
) {
  const client = requireSupabase()
  const { error } = await client.from('product_variants').insert({
    tenant_id: context.tenantId,
    product_id: productId,
    name: input.name,
    price_cents: input.priceCents,
    sale_format_id: input.saleFormatId ?? null,
    is_default: input.isDefault ?? false,
    is_active: true,
    sort_order: 10,
  })

  if (error) {
    throw error
  }
}

export async function deleteVariant(context: TenantContext, variantId: string) {
  const client = requireSupabase()
  const { error } = await client
    .from('product_variants')
    .update({ is_active: false, is_default: false })
    .eq('tenant_id', context.tenantId)
    .eq('id', variantId)

  if (error) {
    throw error
  }
}

export async function createCatalogTab(context: TenantContext, input: { venueId: string; label: string; icon: string; sortOrder: number }) {
  const label = input.label.trim()
  const key = createSaleFormatKey(label)
  if (!label || !key || key === 'all' || key === 'top') throw new Error('Indica un nombre valido para la pestana.')
  const { error } = await requireSupabase().from('catalog_tabs').insert({
    tenant_id: context.tenantId, venue_id: input.venueId, key, label, icon: input.icon || 'receipt',
    sort_order: input.sortOrder, is_active: true,
  })
  if (error) throw error
}

export async function setCatalogTabActive(context: TenantContext, tabId: string, isActive: boolean) {
  const { error } = await requireSupabase().from('catalog_tabs').update({ is_active: isActive })
    .eq('tenant_id', context.tenantId).eq('id', tabId)
  if (error) throw error
}

export async function createCatalogPlacement(context: TenantContext, input: { venueId: string; tabId: string; categoryId: string; productId: string; defaultVariantId: string | null; isFeatured: boolean; sortOrder: number }) {
  const { error } = await requireSupabase().from('catalog_placements').insert({
    tenant_id: context.tenantId, venue_id: input.venueId, tab_id: input.tabId, category_id: input.categoryId,
    product_id: input.productId, default_variant_id: input.defaultVariantId, is_featured: input.isFeatured,
    sort_order: input.sortOrder, is_active: true,
  })
  if (error) throw error
}

export async function setCatalogPlacementActive(context: TenantContext, placementId: string, isActive: boolean) {
  const { error } = await requireSupabase().from('catalog_placements').update({ is_active: isActive })
    .eq('tenant_id', context.tenantId).eq('id', placementId)
  if (error) throw error
}

export async function createSelectionGroup(context: TenantContext, input: { venueId: string; kind: 'mixer' | 'menu_component'; name: string; minSelect: number; maxSelect: number }) {
  if (!input.name.trim() || input.minSelect < 0 || input.maxSelect < input.minSelect) throw new Error('Configura un nombre y limites validos.')
  const { error } = await requireSupabase().from('selection_groups').insert({
    tenant_id: context.tenantId, venue_id: input.venueId, kind: input.kind, name: input.name.trim(),
    min_select: input.minSelect, max_select: input.maxSelect, sort_order: 0, is_active: true,
  })
  if (error) throw error
}

export async function addSelectionGroupItem(context: TenantContext, input: { groupId: string; productId: string; variantId: string | null; priceDeltaCents: number }) {
  const { error } = await requireSupabase().from('selection_group_items').insert({
    tenant_id: context.tenantId, group_id: input.groupId, product_id: input.productId, variant_id: input.variantId,
    price_delta_cents: input.priceDeltaCents, is_default: false, sort_order: 0, is_active: true,
  })
  if (error) throw error
}

export async function assignSelectionGroupToVariant(context: TenantContext, variantId: string, selectionGroupId: string) {
  const { error } = await requireSupabase().from('variant_selection_groups').upsert({
    tenant_id: context.tenantId, variant_id: variantId, selection_group_id: selectionGroupId, sort_order: 0,
  }, { onConflict: 'variant_id,selection_group_id' })
  if (error) throw error
}

export async function createModifierGroup(
  context: TenantContext,
  input: { productId: string; name: string; minSelect: number; maxSelect: number; sortOrder?: number },
) {
  const name = input.name.trim()
  if (!name || input.minSelect < 0 || input.maxSelect < Math.max(1, input.minSelect)) {
    throw new Error('Configura un nombre y limites validos para el grupo.')
  }

  const client = requireSupabase()
  const { data, error } = await client.from('modifier_groups').insert({
    tenant_id: context.tenantId,
    product_id: input.productId,
    name,
    min_select: input.minSelect,
    max_select: input.maxSelect,
    sort_order: input.sortOrder ?? 0,
    is_active: true,
  }).select('id').single<{ id: string }>()
  if (error) throw error

  const { error: assignmentError } = await client.from('product_modifier_groups').insert({
    tenant_id: context.tenantId,
    product_id: input.productId,
    variant_id: null,
    modifier_group_id: data.id,
    sort_order: input.sortOrder ?? 0,
  })
  if (assignmentError) throw assignmentError
}

export async function addModifier(
  context: TenantContext,
  input: { groupId: string; name: string; priceCents: number; isDefault: boolean; sortOrder?: number },
) {
  const name = input.name.trim()
  if (!name || input.priceCents < 0) throw new Error('Configura un modificador y suplemento validos.')
  const { error } = await requireSupabase().from('modifiers').insert({
    tenant_id: context.tenantId,
    group_id: input.groupId,
    name,
    price_cents: input.priceCents,
    is_default: input.isDefault,
    is_active: true,
    sort_order: input.sortOrder ?? 0,
  })
  if (error) throw error
}

export async function assignModifierGroup(
  context: TenantContext,
  input: { productId: string; variantId: string | null; modifierGroupId: string; sortOrder?: number },
) {
  const client = requireSupabase()
  let existingQuery = client.from('product_modifier_groups').select('product_id')
    .eq('tenant_id', context.tenantId)
    .eq('product_id', input.productId)
    .eq('modifier_group_id', input.modifierGroupId)
  existingQuery = input.variantId ? existingQuery.eq('variant_id', input.variantId) : existingQuery.is('variant_id', null)
  const { data: existing, error: readError } = await existingQuery.maybeSingle<{ product_id: string }>()
  if (readError) throw readError

  const payload = {
    tenant_id: context.tenantId,
    product_id: input.productId,
    variant_id: input.variantId,
    modifier_group_id: input.modifierGroupId,
    sort_order: input.sortOrder ?? 0,
  }
  if (!existing) {
    const { error } = await client.from('product_modifier_groups').insert(payload)
    if (error) throw error
    return
  }

  let updateQuery = client.from('product_modifier_groups').update({ sort_order: payload.sort_order })
    .eq('tenant_id', context.tenantId)
    .eq('product_id', input.productId)
    .eq('modifier_group_id', input.modifierGroupId)
  updateQuery = input.variantId ? updateQuery.eq('variant_id', input.variantId) : updateQuery.is('variant_id', null)
  const { error } = await updateQuery
  if (error) throw error
}
