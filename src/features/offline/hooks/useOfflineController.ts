import { useOfflineSync } from '../../../hooks/useOfflineSync'

/**
 * Application-facing offline boundary.  Domain controllers receive this small
 * contract instead of depending on the persistence/sync hook directly.
 */
export function useOfflineController(isOnline: boolean) {
  return useOfflineSync(isOnline)
}
