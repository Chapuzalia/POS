import { requireSupabase } from '../../shared/services/crmServiceSupport'
import {
  type Discount,
  type DiscountCreateInput,
  type DiscountTarget,
  type TenantContext,
} from '../../../../types'
import { validateDiscountRule } from '../../../../lib/discounts'

export type DiscountTargetRow = {
  product_id: string
  variant_id: string | null
}

export type DiscountRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  type: 'percentage' | 'fixed'
  value: number | string
  rounding_increment_cents: 5 | 10 | 50 | 100 | null
  fixed_application?: 'ticket' | 'unit' | 'line'
  color: string | null
  is_active: boolean
  sort_order: number
  rule_kind?: 'discount' | 'promotion'
  scope?: 'general' | 'specific'
  requires_pin?: boolean
  active_weekdays?: number[]
  starts_at?: string | null
  ends_at?: string | null
  auto_apply?: boolean
  discount_targets?: DiscountTargetRow[]
}

export type DiscountTargetProductOption = {
  categories: Array<{ id: string; name: string }>
  id: string
  name: string
  variants: Array<{ id: string; name: string }>
}

const discountColumns = `
  id, tenant_id, venue_id, name, type, value, rounding_increment_cents, fixed_application, color,
  is_active, sort_order, rule_kind, scope, requires_pin, active_weekdays,
  starts_at, ends_at, auto_apply, discount_targets(product_id, variant_id)
`

export function mapDiscount(row: DiscountRow): Discount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    value: row.type === 'fixed' ? Math.round(Number(row.value) * 100) : Number(row.value),
    fixedApplication: row.fixed_application === 'unit' || row.fixed_application === 'line' ? 'unit' : 'ticket',
    roundingIncrementCents: row.rounding_increment_cents,
    color: row.color,
    isActive: row.is_active,
    sortOrder: row.sort_order,
    ruleKind: row.rule_kind ?? 'discount',
    scope: row.scope ?? 'general',
    targets: (row.discount_targets ?? []).map((target) => ({
      productId: target.product_id,
      variantId: target.variant_id,
    })),
    requiresPin: Boolean(row.requires_pin),
    activeWeekdays: row.active_weekdays ?? [],
    startsAt: row.starts_at?.slice(0, 5) ?? null,
    endsAt: row.ends_at?.slice(0, 5) ?? null,
    autoApply: Boolean(row.auto_apply),
  }
}

export function serializeDiscountValue(type: DiscountCreateInput['type'], value: number) {
  if (!Number.isFinite(value) || value <= 0 || (type === 'percentage' && value > 100)) {
    throw new Error(type === 'percentage' ? 'El porcentaje debe estar entre 0 y 100.' : 'El importe debe ser mayor que 0.')
  }
  if (type === 'fixed' && !Number.isInteger(value)) throw new Error('El importe debe expresarse en céntimos.')
  return type === 'fixed' ? (value / 100).toFixed(2) : value
}

export async function loadCrmDiscounts(context: TenantContext, venueId: string): Promise<Discount[]> {
  const { data, error } = await requireSupabase()
    .from('discounts')
    .select(discountColumns)
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('sort_order')
    .order('name')
  if (error) throw error
  return ((data ?? []) as unknown as DiscountRow[]).map(mapDiscount)
}

async function saveDiscountRule(
  _context: TenantContext,
  discountId: string | null,
  input: DiscountCreateInput,
) {
  const name = validateDiscountRule(input)
  const { error } = await requireSupabase().rpc('upsert_discount_rule', {
    p_discount_id: discountId,
    p_venue_id: input.venueId,
    p_input: {
      name,
      rounding_increment_cents: input.roundingIncrementCents,
      type: input.type,
      value: serializeDiscountValue(input.type, input.value),
      fixedApplication: input.type === 'fixed' ? input.fixedApplication : 'ticket',
      roundingIncrementCents: input.roundingIncrementCents,
      color: input.color || null,
      isActive: input.isActive,
      ruleKind: input.ruleKind,
      scope: input.scope,
      targets: input.targets,
      requiresPin: input.requiresPin,
      activeWeekdays: input.ruleKind === 'promotion' ? input.activeWeekdays : [],
      startsAt: input.ruleKind === 'promotion' ? input.startsAt : null,
      endsAt: input.ruleKind === 'promotion' ? input.endsAt : null,
      autoApply: input.ruleKind === 'promotion' && input.autoApply,
    },
    p_pin: input.requiresPin ? input.pin : null,
  })
  if (error) throw error
}

export async function createDiscount(context: TenantContext, input: DiscountCreateInput) {
  await saveDiscountRule(context, null, input)
}

export async function updateDiscount(
  context: TenantContext,
  discountId: string,
  input: DiscountCreateInput,
) {
  await saveDiscountRule(context, discountId, input)
}

export async function setDiscountActive(context: TenantContext, discountId: string, isActive: boolean) {
  const { error } = await requireSupabase().from('discounts').update({ is_active: isActive })
    .eq('tenant_id', context.tenantId).eq('id', discountId)
  if (error) throw error
}

export async function validateDiscountPin(discountId: string, pin: string) {
  if (!/^\d{4,8}$/.test(pin)) return false
  const { data, error } = await requireSupabase().rpc('validate_discount_pin', {
    p_discount_id: discountId,
    p_pin: pin,
  })
  if (error) throw error
  return data === true
}

export async function loadDiscountTargetOptions(
  context: TenantContext,
  venueId: string,
): Promise<DiscountTargetProductOption[]> {
  const supabase = requireSupabase()
  const [productsResult, categoriesResult, placementsResult] = await Promise.all([
    supabase.from('products')
      .select('id, name, product_variants(id, name)')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('name'),
    supabase.from('categories')
      .select('id, name')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .order('sort_order')
      .order('name'),
    supabase.from('catalog_placements')
      .select('product_id, category_id')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', venueId)
      .eq('is_active', true)
      .not('category_id', 'is', null),
  ])
  if (productsResult.error) throw productsResult.error
  if (categoriesResult.error) throw categoriesResult.error
  if (placementsResult.error) throw placementsResult.error

  const categoriesById = new Map(
    ((categoriesResult.data ?? []) as Array<{ id: string; name: string }>)
      .map((category) => [category.id, category]),
  )
  const categoryIdsByProduct = new Map<string, Set<string>>()
  for (const placement of (placementsResult.data ?? []) as Array<{ product_id: string; category_id: string | null }>) {
    if (!placement.category_id || !categoriesById.has(placement.category_id)) continue
    const categoryIds = categoryIdsByProduct.get(placement.product_id) ?? new Set<string>()
    categoryIds.add(placement.category_id)
    categoryIdsByProduct.set(placement.product_id, categoryIds)
  }

  return ((productsResult.data ?? []) as Array<{
    id: string
    name: string
    product_variants?: Array<{ id: string; name: string }>
  }>).map((product) => ({
    categories: [...(categoryIdsByProduct.get(product.id) ?? [])]
      .map((categoryId) => categoriesById.get(categoryId)!)
      .sort((left, right) => left.name.localeCompare(right.name, 'es')),
    id: product.id,
    name: product.name,
    variants: [...(product.product_variants ?? [])].sort((a, b) => a.name.localeCompare(b.name, 'es')),
  }))
}

export function normalizeDiscountTargets(targets: DiscountTarget[]) {
  const seen = new Set<string>()
  return targets.filter((target) => {
    const key = `${target.productId}:${target.variantId ?? '*'}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type ManualDiscountSettings = {
  enabled: boolean
  requiresPin: boolean
}

export async function loadManualDiscountSettings(context: TenantContext, venueId: string): Promise<ManualDiscountSettings> {
  const { data, error } = await requireSupabase().from('venues').select('manual_discount_enabled, manual_discount_requires_pin')
    .eq('tenant_id', context.tenantId).eq('id', venueId).single<{
      manual_discount_enabled: boolean
      manual_discount_requires_pin: boolean
    }>()
  if (error) throw error
  return {
    enabled: data.manual_discount_enabled,
    requiresPin: data.manual_discount_requires_pin,
  }
}

export async function saveManualDiscountSettings(
  _context: TenantContext,
  venueId: string,
  settings: ManualDiscountSettings & { pin: string | null },
) {
  if (settings.pin !== null && !/^\d{4,8}$/.test(settings.pin)) {
    throw new Error('El PIN debe contener entre 4 y 8 dígitos.')
  }
  const { error } = await requireSupabase().rpc('update_manual_discount_settings', {
    p_venue_id: venueId,
    p_enabled: settings.enabled,
    p_requires_pin: settings.requiresPin,
    p_pin: settings.pin,
  })
  if (error) throw error
}

export async function loadManualDiscountEnabled(context: TenantContext, venueId: string) {
  return (await loadManualDiscountSettings(context, venueId)).enabled
}

export async function setManualDiscountEnabled(context: TenantContext, venueId: string, enabled: boolean) {
  const current = await loadManualDiscountSettings(context, venueId)
  await saveManualDiscountSettings(context, venueId, { enabled, requiresPin: current.requiresPin, pin: null })

}
