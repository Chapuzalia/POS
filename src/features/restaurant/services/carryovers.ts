import { supabase } from '../../../lib/supabase'
import type { TenantContext } from '../../../types'

export type RestaurantCarryover = {
  id: string
  order_group_id: string
  order_ids: string[]
  from_cash_session_id: string
  carried_at: string
  recovery_undo_expires_at: string
}

export async function loadRecoveredRestaurantCarryovers(
  context: TenantContext,
  sessionId: string,
): Promise<RestaurantCarryover[]> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.from('restaurant_order_carryovers')
    .select('id, order_group_id, order_ids, from_cash_session_id, carried_at, recovery_undo_expires_at')
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
    .eq('to_cash_session_id', sessionId)
    .eq('recovered_by_device_id', context.deviceId)
    .gt('recovery_undo_expires_at', new Date().toISOString())
    .order('carried_at')
  if (error) throw error
  return data as RestaurantCarryover[]
}

export async function unloadRestaurantCarryovers(context: TenantContext, sessionId: string, ids: string[]) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc('unload_restaurant_carryovers', {
    p_cash_session_id: sessionId, p_device_id: context.deviceId, p_carryover_ids: ids,
  })
  if (error) throw error
  return Number(data)
}
