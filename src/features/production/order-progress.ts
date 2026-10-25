import type { ProductionEntry, ProductionLineState } from './types'
import type { RestaurantOrderLine } from '../tables/types'
import { getProductionUnsentQuantity } from './routing.ts'

export function getOrderLineProductionProgress(line: Pick<RestaurantOrderLine, 'quantity' | 'servedQuantity'>, entries: ProductionEntry[], state?: ProductionLineState) {
  const pending = Math.max(0, line.quantity - line.servedQuantity)
  const unsent = entries.length ? Math.min(pending, Math.max(0, ...entries.map((entry) => getProductionUnsentQuantity(entry, line)))) : pending
  const ready = Math.min(Math.max(0, state?.readyQuantity ?? 0), pending - unsent)
  const preparing = Math.min(Math.max(0, state?.preparingQuantity ?? 0), pending - unsent - ready)
  const sent = Math.max(0, Math.round((pending - unsent - ready - preparing) * 1000) / 1000)
  const label = pending === 0 ? 'Servido' : ready > 0 ? 'Listo para servir' : preparing > 0 ? 'En preparación' : sent > 0 ? 'Enviado' : 'Pendiente'
  return { unsent, ready, preparing, sent, label }
}
