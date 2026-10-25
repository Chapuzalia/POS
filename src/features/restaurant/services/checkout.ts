import { supabase } from '../../../lib/supabase'
import type { TenantContext } from '../../../types'

export async function prepareRestaurantCheckout(context: TenantContext, operationId: string, action: string, params: Record<string, unknown>) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { error } = await supabase.rpc('prepare_restaurant_checkout', {
    p_operation_id: operationId, p_tenant_id: context.tenantId, p_venue_id: context.venueId,
    p_device_id: context.deviceId, p_action: action, p_params: params,
  })
  if (error) throw error
}

export async function releaseRestaurantCheckout(context: TenantContext, operationId: string) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc('release_restaurant_checkout', {
    p_operation_id: operationId, p_device_id: context.deviceId,
  })
  if (error) throw error
  return data === true
}

export async function startRestaurantCheckout(context: TenantContext, operationId: string) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { error } = await supabase.rpc('start_restaurant_checkout', {
    p_operation_id: operationId, p_device_id: context.deviceId,
  })
  if (error) throw error
}

export async function cancelRestaurantCheckout(operationId: string, deviceId: string) {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { error } = await supabase.rpc('cancel_restaurant_checkout', { p_operation_id: operationId, p_device_id: deviceId })
  if (error) throw error
}
