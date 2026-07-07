import { supabase } from '../lib/supabase'
import { normalizeText } from '../lib/format'
import type { RevoImportProduct } from '../lib/revoImport'
import type {
  CatalogKind,
  CategoryCreateInput,
  CrmStats,
  PaymentMethod,
  ProductCreateInput,
  SaleFormat,
  TenantContext,
} from '../types'

type SaleStatsRow = {
  id: string
  payment_method: PaymentMethod
  total_cents: number
}

type TicketLineStatsRow = {
  product_name: string
  quantity: number
  line_total_cents: number
}

type ImportCategoryRow = {
  id: string
  name: string
  kind: CatalogKind
  sort_order: number
}

type ImportVariantRow = {
  id: string
  name: string
}

type ImportProductRow = {
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

function requireSupabase() {
  if (!supabase) {
    throw new Error('Supabase no esta configurado.')
  }

  return supabase
}

function getMonthStartIso() {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
}

function getImportKey(value: string) {
  return normalizeText(value).replace(/[^a-z0-9]+/g, ' ').trim()
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

export async function createProductWithVariant(context: TenantContext, input: ProductCreateInput) {
  const client = requireSupabase()
  const { data: product, error: productError } = await client
    .from('products')
    .insert({
      tenant_id: context.tenantId,
      category_id: input.categoryId,
      name: input.name,
      description: input.description || null,
      kind: input.kind,
      sale_formats: input.saleFormats,
      can_sell_standalone: input.canSellStandalone,
      can_use_as_mixer: input.canUseAsMixer,
      mixer_supplement_cents: input.canUseAsMixer ? input.mixerSupplementCents : 0,
      is_active: true,
      sort_order: 0,
    })
    .select('id')
    .single<{ id: string }>()

  if (productError) {
    throw productError
  }

  const { error: variantError } = await client.from('product_variants').insert({
    tenant_id: context.tenantId,
    product_id: product.id,
    name: input.variantName,
    price_cents: input.priceCents,
    is_default: true,
    sort_order: 0,
  })

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
    isActive?: boolean
    kind?: CatalogKind
    name?: string
    saleFormats?: ProductCreateInput['saleFormats']
    canSellStandalone?: boolean
    canUseAsMixer?: boolean
    mixerSupplementCents?: number
  },
) {
  const client = requireSupabase()
  const { error } = await client
    .from('products')
    .update({
      ...(input.categoryId !== undefined ? { category_id: input.categoryId } : {}),
      ...(input.description !== undefined ? { description: input.description || null } : {}),
      ...(input.isActive !== undefined ? { is_active: input.isActive } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.saleFormats !== undefined ? { sale_formats: input.saleFormats } : {}),
      ...(input.canSellStandalone !== undefined ? { can_sell_standalone: input.canSellStandalone } : {}),
      ...(input.canUseAsMixer !== undefined ? { can_use_as_mixer: input.canUseAsMixer } : {}),
      ...(input.mixerSupplementCents !== undefined ? { mixer_supplement_cents: input.mixerSupplementCents } : {}),
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
    is_default: false,
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

export async function importRevoCatalogProducts(
  context: TenantContext,
  products: RevoImportProduct[],
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

export async function loadCrmStats(context: TenantContext): Promise<CrmStats> {
  const client = requireSupabase()
  const monthStart = getMonthStartIso()
  const [{ data: salesRows, error: salesError }, { data: lineRows, error: linesError }] = await Promise.all([
    client
      .from('sales')
      .select('id, payment_method, total_cents')
      .eq('tenant_id', context.tenantId)
      .gte('created_at', monthStart),
    client
      .from('ticket_lines')
      .select('product_name, quantity, line_total_cents')
      .eq('tenant_id', context.tenantId)
      .gte('created_at', monthStart),
  ])

  if (salesError) {
    throw salesError
  }

  if (linesError) {
    throw linesError
  }

  const sales = (salesRows ?? []) as SaleStatsRow[]
  const lines = (lineRows ?? []) as TicketLineStatsRow[]
  const monthSalesCents = sales.reduce((total, sale) => total + sale.total_cents, 0)
  const byPaymentMap = new Map<PaymentMethod, { method: PaymentMethod; totalCents: number; count: number }>()
  const topProductMap = new Map<string, { productName: string; quantity: number; totalCents: number }>()

  sales.forEach((sale) => {
    const current = byPaymentMap.get(sale.payment_method) ?? {
      method: sale.payment_method,
      totalCents: 0,
      count: 0,
    }
    byPaymentMap.set(sale.payment_method, {
      ...current,
      count: current.count + 1,
      totalCents: current.totalCents + sale.total_cents,
    })
  })

  lines.forEach((line) => {
    const current = topProductMap.get(line.product_name) ?? {
      productName: line.product_name,
      quantity: 0,
      totalCents: 0,
    }
    topProductMap.set(line.product_name, {
      ...current,
      quantity: current.quantity + line.quantity,
      totalCents: current.totalCents + line.line_total_cents,
    })
  })

  return {
    averageTicketCents: sales.length ? Math.round(monthSalesCents / sales.length) : 0,
    byPayment: [...byPaymentMap.values()].sort((a, b) => b.totalCents - a.totalCents),
    monthSalesCents,
    monthTicketCount: sales.length,
    topProducts: [...topProductMap.values()].sort((a, b) => b.totalCents - a.totalCents).slice(0, 8),
  }
}
