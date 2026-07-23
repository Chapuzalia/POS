import { supabase } from '../../../lib/supabase.ts'
import type { TenantContext } from '../../../types/index.ts'

export function subscribeToCatalogTabChanges(context: TenantContext, onChange: () => void) {
  if (!supabase) return () => undefined

  const client = supabase
  const channel = client
    .channel(`catalog-tabs-${context.tenantId}-${context.venueId}`)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'catalog_tabs',
        filter: `venue_id=eq.${context.venueId}`,
      },
      (payload) => {
        const row = (Object.keys(payload.new).length ? payload.new : payload.old) as { tenant_id?: string }
        if (!row.tenant_id || row.tenant_id === context.tenantId) onChange()
      },
    )
    .subscribe()

  return () => {
    void client.removeChannel(channel)
  }
}
