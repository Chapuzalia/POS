import type { CashSession, TenantContext } from '../../../types'

type Options = {
  cashSession: CashSession
  context: TenantContext
  isOnline: boolean
  tablesEnabled: boolean
}

export async function getRestaurantCashClosureError(options: Options) {
  if (!options.context.canCloseCashSession) return 'Este dispositivo no puede cerrar cajas.'
  if (options.tablesEnabled && !options.isOnline) {
    return 'Con el addon de mesas activo, el cierre de caja requiere conexión para comprobar comandas abiertas.'
  }
  // The close modal offers carryover; the database remains the final close guard.
  return null
}
