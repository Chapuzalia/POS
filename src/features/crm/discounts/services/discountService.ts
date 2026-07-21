import { requireSupabase } from '../../shared/services/crmServiceSupport'
import { type Discount, type DiscountCreateInput, type TenantContext } from '../../../../types'
import { validateDiscountDefinition } from '../../../../lib/discounts'

export type DiscountRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  type: 'percentage' | 'fixed'
  value: number | string
  rounding_increment_cents: 5 | 10 | 50 | 100 | null
  color: string | null
  is_active: boolean
  sort_order: number
}

export function mapDiscount(row: DiscountRow): Discount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    value: row.type === 'fixed' ? Math.round(Number(row.value) * 100) : Number(row.value),
    roundingIncrementCents: row.rounding_increment_cents,
    color: row.color,
    isActive: row.is_active,
    sortOrder: row.sort_order,
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
    .select('id, tenant_id, venue_id, name, type, value, rounding_increment_cents, color, is_active, sort_order')
    .eq('tenant_id', context.tenantId)
    .eq('venue_id', venueId)
    .order('sort_order')
    .order('name')
  if (error) throw error
  return ((data ?? []) as DiscountRow[]).map(mapDiscount)
}

export async function createDiscount(context: TenantContext, input: DiscountCreateInput) {
  const name = validateDiscountDefinition(input.name, input.type, input.value)
  const { error } = await requireSupabase().from('discounts').insert({
    tenant_id: context.tenantId,
    venue_id: input.venueId,
    name,
    type: input.type,
    value: serializeDiscountValue(input.type, input.value),
    rounding_increment_cents: input.roundingIncrementCents,
    color: input.color || null,
    is_active: input.isActive,
    sort_order: 0,
  })
  if (error) throw error
}

export async function updateDiscount(context: TenantContext, discountId: string, input: Omit<DiscountCreateInput, 'venueId'>) {
  const name = validateDiscountDefinition(input.name, input.type, input.value)
  const { error } = await requireSupabase().from('discounts').update({
    name,
    type: input.type,
    value: serializeDiscountValue(input.type, input.value),
    rounding_increment_cents: input.roundingIncrementCents,
    color: input.color || null,
    is_active: input.isActive,
  }).eq('tenant_id', context.tenantId).eq('id', discountId)
  if (error) throw error
}

export async function setDiscountActive(context: TenantContext, discountId: string, isActive: boolean) {
  const { error } = await requireSupabase().from('discounts').update({ is_active: isActive })
    .eq('tenant_id', context.tenantId).eq('id', discountId)
  if (error) throw error
}

export async function loadManualDiscountEnabled(context: TenantContext, venueId: string) {
  const { data, error } = await requireSupabase().from('venues').select('manual_discount_enabled')
    .eq('tenant_id', context.tenantId).eq('id', venueId).single<{ manual_discount_enabled: boolean }>()
  if (error) throw error
  return data.manual_discount_enabled
}

export async function setManualDiscountEnabled(context: TenantContext, venueId: string, enabled: boolean) {
  const { error } = await requireSupabase().from('venues').update({ manual_discount_enabled: enabled })
    .eq('tenant_id', context.tenantId).eq('id', venueId)
  if (error) throw error
}
