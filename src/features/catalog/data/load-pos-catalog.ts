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
  color: string | null
  is_active: boolean
  sort_order: number
}

export type PosCatalogState = {
  catalog: CatalogData
  discounts: Discount[]
  manualDiscountEnabled: boolean
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
  if (!supabase || !catalogRepository) throw new Error('Supabase no está configurado.')
  const [catalog, discountsResult, venueResult] = await Promise.all([
    catalogRepository.getCatalog(context.venueId, 'pos', force),
    supabase.from('discounts')
      .select('id, tenant_id, venue_id, name, type, value, rounding_increment_cents, color, is_active, sort_order')
      .eq('tenant_id', context.tenantId)
      .eq('venue_id', context.venueId)
      .eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase.from('venues')
      .select('manual_discount_enabled')
      .eq('tenant_id', context.tenantId)
      .eq('id', context.venueId)
      .maybeSingle(),
  ])
  if (discountsResult.error) throw discountsResult.error
  if (venueResult.error) throw venueResult.error
  const discounts: Discount[] = ((discountsResult.data ?? []) as DiscountRow[]).map((row) => ({
    id: row.id,
    tenantId: row.tenant_id,
    venueId: row.venue_id,
    name: row.name,
    type: row.type,
    value: row.type === 'fixed' ? decimalEurosToCents(row.value) : Number(row.value),
    roundingIncrementCents: row.rounding_increment_cents,
    color: row.color,
    isActive: row.is_active,
    sortOrder: row.sort_order,
  }))
  return {
    catalog,
    discounts,
    manualDiscountEnabled: Boolean((venueResult.data as { manual_discount_enabled?: boolean } | null)?.manual_discount_enabled),
  }
}
