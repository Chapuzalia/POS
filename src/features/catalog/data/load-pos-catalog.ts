import { supabase } from '../../../lib/supabase.ts'
import type { Discount, TenantContext } from '../../../types/index.ts'
import type { CatalogData } from '../domain/types.ts'
import { CatalogRepository } from './repository.ts'

type DiscountRow = {
  id: string
  tenant_id: string
  venue_id: string
  name: string
  type: 'percentage' | 'fixed'
  value: number | string
  rounding_increment_cents: 5 | 10 | 50 | 100 | null
  fixed_application?: 'ticket' | 'line'
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
  discount_targets?: Array<{ product_id: string; variant_id: string | null }>
}

export type PosCatalogState = {
  catalog: CatalogData
  discounts: Discount[]
  manualDiscountEnabled: boolean
  manualDiscountRequiresPin: boolean
  discountSchedule: {
    dayChangeTime: string | null
    timeZone: string
  }
}

const catalogRepository = supabase ? new CatalogRepository(supabase) : null

function decimalEurosToCents(value: number | string) {
  const normalized = String(value).trim()
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(normalized)
  if (!match) throw new Error('El descuento fijo no tiene un importe válido.')
  const cents = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
  if (!Number.isSafeInteger(cents)) throw new Error('El descuento fijo supera el importe admitido.')
  return cents
}

export async function loadPosCatalog(context: TenantContext, force = false): Promise<PosCatalogState> {
  if (!supabase || !catalogRepository) throw new Error('Supabase no est? configurado.')
  const [catalog, discountsResult, venueResult] = await Promise.all([
    catalogRepository.getCatalog(context.venueId, 'pos', force),
    supabase.from('discounts')
      .select(`
        id, tenant_id, venue_id, name, type, value, rounding_increment_cents, fixed_application, color,
        is_active, sort_order, rule_kind, scope, requires_pin, active_weekdays,
        starts_at, ends_at, auto_apply, discount_targets(product_id, variant_id)
      `)
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', context.venueId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase.from('venues')
      .select('manual_discount_enabled, manual_discount_requires_pin, timezone, day_change_time')
      .eq('tenant_id', context.tenantId)
      .eq('id', context.venueId)
      .maybeSingle(),
  ])
  if (discountsResult.error) throw discountsResult.error
  if (venueResult.error) throw venueResult.error
  const discounts: Discount[] = ((discountsResult.data ?? []) as unknown as DiscountRow[]).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    value: row.type === 'fixed' ? decimalEurosToCents(row.value) : Number(row.value),
    fixedApplication: row.fixed_application ?? 'ticket',
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
  }))
  const venue = venueResult.data as {
    manual_discount_enabled?: boolean
    manual_discount_requires_pin?: boolean
    timezone?: string
    day_change_time?: string | null
  } | null
  return {
    catalog,
    discounts,
    manualDiscountEnabled: Boolean(venue?.manual_discount_enabled),
    manualDiscountRequiresPin: Boolean(venue?.manual_discount_requires_pin),
    discountSchedule: {
      dayChangeTime: venue?.day_change_time?.slice(0, 5) ?? null,
      timeZone: venue?.timezone ?? 'Europe/Madrid',
    },
  }
}

