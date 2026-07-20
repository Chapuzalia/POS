import { loadOpenRestaurantOrders, loadRestaurantOrder } from '../../tables/service'
import { getOrderPendingUnits } from '../../tables/service-status'
import type { CashSession, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'

type Options = {
  cashSession: CashSession
  context: TenantContext
  isOnline: boolean
  tablesEnabled: boolean
}

export async function getRestaurantCashClosureError(options: Options) {
  if (!options.context.canCloseCashSession) return 'Este dispositivo no puede cerrar cajas.'
  if (options.tablesEnabled && !options.isOnline) {
    return 'Con el addon de mesas activo, el cierre de caja requiere conexion para comprobar comandas abiertas.'
  }
  if (!options.isOnline) return null
  try {
    const openOrders = await loadOpenRestaurantOrders(options.context, options.cashSession.id)
    if (!openOrders.length) return null
    const details = await Promise.all(
      openOrders.map((order) => loadRestaurantOrder(options.context, order.id)),
    )
    return `No se puede cerrar la caja. Comandas abiertas: ${details.map((detail) =>
      `${detail.tables.map((table) => table.name).join(' + ')} (${(detail.totalCents / 100).toFixed(2)} EUR, abierta ${new Date(detail.order.openedAt).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}, ${getOrderPendingUnits(detail.lines)} por servir)`
    ).join('; ')}`
  } catch (error) {
    return getReadableError(error)
  }
}
