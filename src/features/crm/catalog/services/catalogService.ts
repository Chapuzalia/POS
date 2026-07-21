import { PRODUCT_IMAGE_BUCKET, resizeProductImageToWebp } from '../../../../lib/productImages'
import { createSaleFormatKey, requireSupabase } from '../../shared/services/crmServiceSupport'
import { type CatalogKind, type CategoryCreateInput, type ProductCreateInput, type SaleFormatDefinition, type TenantContext } from '../../../../types'
import { type ProductSaleFormatsRow } from './catalogImportService'

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
  const { data: productRows, error: productsError } = await client
    .from('products')
    .select('id, sale_formats')
    .eq('tenant_id', context.tenantId)
    .contains('sale_formats', [saleFormat.key])

  if (productsError) {
    throw productsError
  }

  for (const product of (productRows ?? []) as ProductSaleFormatsRow[]) {
    const nextSaleFormats = (product.sale_formats ?? []).filter((format) => format !== saleFormat.key)
    const { error } = await client
      .from('products')
      .update({ sale_formats: nextSaleFormats })
      .eq('tenant_id', context.tenantId)
      .eq('id', product.id)

    if (error) {
      throw error
    }
  }

  const { error } = await client
    .from('sale_formats')
    .delete()
    .eq('tenant_id', context.tenantId)
    .eq('key', saleFormat.key)

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
      is_default: index === 0,
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
  },
) {
  const client = requireSupabase()
  const { error } = await client.from('product_variants').insert({
    tenant_id: context.tenantId,
    product_id: productId,
    name: input.name,
    price_cents: input.priceCents,
    is_default: input.isDefault ?? false,
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
    .delete()
    .eq('tenant_id', context.tenantId)
    .eq('id', variantId)

  if (error) {
    throw error
  }
}
