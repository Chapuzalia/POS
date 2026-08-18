import { supabase } from '../../../lib/supabase.ts'
import type { TenantContext } from '../../../types/index.ts'

export function subscribeToCatalogTabChanges(context: TenantContext, onChange: () => void) {
  if (!supabase) return () => undefined

  const client = supabase
  const venueTables = [
    'categories',
    'catalog_tab_categories',
    'products',
    'product_variants',
    'catalog_placements',
    'selection_groups',
    'selection_group_options',
    'product_selection_group_assignments',
    'product_selection_group_assignment_variants',
    'modifier_groups',
    'modifiers',
    'product_modifier_group_assignments',
    'product_modifier_group_assignment_variants',
    'discounts',
    'discount_targets',
  ] as const
  let channel = client.channel(`catalog-${context.tenantId}-${context.venueId}`)
  channel = channel.on(
    'postgres_changes',
    { event: '*', schema: 'public', table: 'catalog_tabs', filter: `venue_id=eq.${context.venueId}` },
    (payload) => {
      const row = (Object.keys(payload.new).length ? payload.new : payload.old) as { tenant_id?: string }
      if (!row.tenant_id || row.tenant_id === context.tenantId) onChange()
    },
  )
  for (const table of venueTables) {
    channel = channel.on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table,
        filter: `venue_id=eq.${context.venueId}`,
      },
      (payload) => {
        const row = (Object.keys(payload.new).length ? payload.new : payload.old) as { tenant_id?: string }
        if (!row.tenant_id || row.tenant_id === context.tenantId) onChange()
      },
    )
  }
  channel = channel.on(
    'postgres_changes',
    { event: 'UPDATE', schema: 'public', table: 'venues', filter: `id=eq.${context.venueId}` },
    (payload) => {
      const row = (Object.keys(payload.new).length ? payload.new : payload.old) as { tenant_id?: string }
      if (!row.tenant_id || row.tenant_id === context.tenantId) onChange()
    },
  )
  channel.subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}
