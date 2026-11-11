import { supabase } from '../../../lib/supabase'
import type { CashSession, TenantContext } from '../../../types'
import { commitPaymentOperation, finishPaymentOperationCancellation, loadPaymentOperations } from '../../../lib/durableSales.ts'
import { reconcileCancelledRestaurantInvoice } from '../../fiscal/local/restaurantInvoice.ts'

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

export async function reconcileCancelledRestaurantCheckouts(context: TenantContext, session: CashSession, target?: string) {
  const cancelled = (await loadPaymentOperations(context, session.id)).filter(operation => operation.state === 'cancelled'
    && operation.checkoutCancellationPending && (!target || operation.params?.orderId === target || operation.params?.splitId === target))
  for (const operation of cancelled) {
    await cancelRestaurantCheckout(operation.eventId, context.deviceId)
    const fiscal = operation.originalKey ? await reconcileCancelledRestaurantInvoice(context, session, operation.originalKey) : null
    if (fiscal?.payload) {
      await commitPaymentOperation(operation, fiscal.payload, false, fiscal.result)
      throw new Error('La venta ya está registrada. Consulta el histórico.')
    }
    if (!supabase) throw new Error('Supabase no está configurado.')
    const { data, error } = await supabase.from('restaurant_payment_operations').select('operation_id')
      .eq('operation_id', operation.eventId).eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
      .eq('device_id', context.deviceId).eq('user_id', context.userId).abortSignal(AbortSignal.timeout(10000)).maybeSingle()
    if (error) throw error
    await finishPaymentOperationCancellation(operation)
    if (data) throw new Error('La venta ya está registrada. Consulta el histórico.')
  }
}
