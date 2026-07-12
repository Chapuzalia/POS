import { useCallback, useEffect, useRef, useState } from 'react'
import {
  forgetOfflineEvent,
  getOfflineQueue,
  markOfflineEventFailed,
} from '../lib/offlineStore'
import { supabaseConfig } from '../lib/supabase'
import { syncEvent } from '../services/posService'
import type { OfflineEvent } from '../types'
import { getReadableError } from '../utils/errors'

type RejectedSaleEvent = Extract<OfflineEvent, { kind: 'sale_created' }>

function isClosedCashRejection(event: OfflineEvent, error: unknown): event is RejectedSaleEvent {
  if (event.kind !== 'sale_created' || !error || typeof error !== 'object') {
    return false
  }

  const databaseError = error as { code?: unknown; details?: unknown; message?: unknown }
  const hasClosedCashMessage = [databaseError.message, databaseError.details].some(
    (value) => typeof value === 'string' && value.toLocaleLowerCase().includes('caja cerrada'),
  )

  return databaseError.code === '55000' || hasClosedCashMessage
}

export function useOfflineSync(isOnline: boolean) {
  const [pendingCount, setPendingCount] = useState(() => getOfflineQueue().length)
  const [rejectedSaleEvent, setRejectedSaleEvent] = useState<RejectedSaleEvent | null>(null)
  const syncInFlightRef = useRef<Promise<void> | null>(null)

  const refreshPendingCount = useCallback(() => {
    setPendingCount(getOfflineQueue().length)
  }, [])

  const clearRejectedSaleEvent = useCallback(() => {
    setRejectedSaleEvent(null)
  }, [])

  const syncPendingEvents = useCallback(async () => {
    if (!supabaseConfig.isReady || !isOnline) {
      refreshPendingCount()
      return
    }

    if (syncInFlightRef.current) {
      await syncInFlightRef.current
      return
    }

    const syncTask = (async () => {
      let syncFailed = false

      while (!syncFailed) {
        const events = getOfflineQueue()

        if (!events.length) {
          break
        }

        for (const event of events) {
          try {
            await syncEvent(event)
            forgetOfflineEvent(event.id)
          } catch (syncError) {
            if (isClosedCashRejection(event, syncError)) {
              forgetOfflineEvent(event.id)
              setRejectedSaleEvent(event)
              continue
            }

            markOfflineEventFailed(event.id, getReadableError(syncError))
            syncFailed = true
            break
          }
        }
      }

      refreshPendingCount()
    })()

    syncInFlightRef.current = syncTask

    try {
      await syncTask
    } finally {
      if (syncInFlightRef.current === syncTask) {
        syncInFlightRef.current = null
      }
    }
  }, [isOnline, refreshPendingCount])

  useEffect(() => {
    if (isOnline) {
      void syncPendingEvents()
    }
  }, [isOnline, syncPendingEvents])

  return {
    clearRejectedSaleEvent,
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  }
}
