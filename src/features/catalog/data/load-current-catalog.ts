import { supabase } from '../../../lib/supabase.ts'
import type { Catalog, Discount, TenantContext } from '../../../types/index.ts'
import { projectCatalogForCurrentUi } from '../compatibility/project-current-ui.ts'
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

export async function loadCurrentCatalog(context: TenantContext): Promise<Catalog> {
  if (!supabase) throw new Error('Supabase no esta configurado.')
  const repository = new CatalogRepository(supabase)
  const [catalog, discountsResult, venueResult] = await Promise.all([
    repository.getCatalog(context.venueId, 'pos'),
    supabase.from('discounts')
      .select('id, tenant_id, venue_id, name, type, value, rounding_increment_cents, color, is_active, sort_order')
      .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId).eq('is_active', true)
      .order('sort_order', { ascending: true }),
    supabase.from('venues').select('manual_discount_enabled').eq('tenant_id', context.tenantId)
      .eq('id', context.venueId).maybeSingle(),
  ])
  if (discountsResult.error) throw discountsResult.error
  if (venueResult.error) throw venueResult.error
  const discounts: Discount[] = ((discountsResult.data ?? []) as DiscountRow[]).map((row) => ({
    id: row.id, tenantId: row.tenant_id, venueId: row.venue_id, name: row.name, type: row.type,
    value: row.type === 'fixed' ? Math.round(Number(row.value) * 100) : Number(row.value),
    roundingIncrementCents: row.rounding_increment_cents, color: row.color,
    isActive: row.is_active, sortOrder: row.sort_order,
  }))
  return projectCatalogForCurrentUi({
    catalog,
    discounts,
    manualDiscountEnabled: Boolean((venueResult.data as { manual_discount_enabled?: boolean } | null)?.manual_discount_enabled),
  })
}
