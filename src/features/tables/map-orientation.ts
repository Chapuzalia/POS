type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

const ORIENTATION_STORAGE_PREFIX = 'tickit:table-map-orientation:v1'

function availableStorage(storage?: PreferenceStorage) {
  if (storage) return storage
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

export function tableMapOrientationStorageKey(venueId?: string) {
  return `${ORIENTATION_STORAGE_PREFIX}:${venueId || 'default'}`
}

export function loadTableMapQuarterTurn(venueId?: string, storage?: PreferenceStorage) {
  try { return availableStorage(storage)?.getItem(tableMapOrientationStorageKey(venueId)) === 'quarter-turn' } catch { return false }
}

export function persistTableMapQuarterTurn(venueId: string | undefined, quarterTurn: boolean, storage?: PreferenceStorage) {
  try { availableStorage(storage)?.setItem(tableMapOrientationStorageKey(venueId), quarterTurn ? 'quarter-turn' : 'horizontal') } catch { /* visual preference only */ }
}
