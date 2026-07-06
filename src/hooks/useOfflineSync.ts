import { useCallback, useEffect, useState } from 'react'
import {
  forgetOfflineEvent,
  getOfflineQueue,
  markOfflineEventFailed,
} from '../lib/offlineStore'
import { supabaseConfig } from '../lib/supabase'
import { syncEvent } from '../services/posService'
import { getReadableError } from '../utils/errors'

export function useOfflineSync(isOnline: boolean) {
  const [pendingCount, setPendingCount] = useState(() => getOfflineQueue().length)

  const refreshPendingCount = useCallback(() => {
    setPendingCount(getOfflineQueue().length)
  }, [])

  const syncPendingEvents = useCallback(async () => {
    if (!supabaseConfig.isReady || !isOnline) {
      refreshPendingCount()
      return
    }

    const events = getOfflineQueue()

    for (const event of events) {
      try {
        await syncEvent(event)
        forgetOfflineEvent(event.id)
      } catch (syncError) {
        markOfflineEventFailed(event.id, getReadableError(syncError))
        break
      }
    }

    refreshPendingCount()
  }, [isOnline, refreshPendingCount])

  useEffect(() => {
    if (isOnline) {
      void syncPendingEvents()
    }
  }, [isOnline, syncPendingEvents])

  return {
    pendingCount,
    refreshPendingCount,
    syncPendingEvents,
  }
}
