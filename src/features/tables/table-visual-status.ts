import type { RestaurantTableMapItem, RestaurantTableStatus } from './types'

export type RestaurantTableVisualStatus = RestaurantTableStatus | 'occupied-pending'

export function getRestaurantTableVisualStatus(
  table: Pick<RestaurantTableMapItem, 'pendingUnits' | 'status'>,
): RestaurantTableVisualStatus {
  return table.status === 'occupied' && table.pendingUnits > 0 ? 'occupied-pending' : table.status
}
