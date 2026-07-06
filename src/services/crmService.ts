import { supabase } from '../lib/supabase'
import type {
  CatalogKind,
  CategoryCreateInput,
  CrmStats,
  PaymentMethod,
  ProductCreateInput,
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
