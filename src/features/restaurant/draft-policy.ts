import type { PosView, RestaurantOrderSaveState } from '../tables/types'

export function shouldFlushRestaurantDraft(saveState: RestaurantOrderSaveState) {
  return saveState === 'dirty' || saveState === 'error'
}

export function isRestaurantRevisionConflict(error: unknown) {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === '40001')
}

export function shouldSaveBeforeLeavingOrder(view: PosView, saveState: RestaurantOrderSaveState) {
  return view.type === 'table_order' && saveState !== 'saved'
}
