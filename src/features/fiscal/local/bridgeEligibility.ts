import { supabase } from '../../../lib/supabase.ts'

/** A tenant URL must never enroll an old identity or its historical queue. */
export async function fiscalBridgeEligible(tenantId: string, installationId: string): Promise<boolean> {
  if (!supabase) return false
  const { data, error } = await supabase.from('fiscal_sif_installations').select('bridge_requested')
    .eq('tenant_id', tenantId).eq('id', installationId).maybeSingle()
  // A connectivity failure delays transport; economic sync remains independent.
  return !error && data?.bridge_requested === true
}
