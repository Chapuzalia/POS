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
  const initialQueue = getOfflineQueue()
  const [pendingCount, setPendingCount] = useState(() => initialQueue.length)
  const [lastSyncError, setLastSyncError] = useState<string | null>(
    () => initialQueue.find((event) => event.lastError)?.lastError ?? null,
  )
  const [rejectedSaleEvent, setRejectedSaleEvent] = useState<RejectedSaleEvent | null>(null)
  const syncInFlightRef = useRef<Promise<void> | null>(null)

  const refreshPendingCount = useCallback(() => {
    const events = getOfflineQueue()
    setPendingCount(events.length)
    setLastSyncError(events.find((event) => event.lastError)?.lastError ?? null)
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
      const activeTask = syncInFlightRef.current
      await activeTask

      if (syncInFlightRef.current === activeTask) {
        syncInFlightRef.current = null
      }

      // Una venta puede haberse encolado justo cuando la sincronizacion
      // anterior ya estaba terminando. En ese caso necesita una nueva pasada.
      if (!getOfflineQueue().some((event) => event.attempts === 0)) {
        refreshPendingCount()
        return
      }
    }

    const syncTask = (async () => {
      const events = getOfflineQueue()

      // Cada evento se intenta una vez por pasada. Un evento antiguo con error
      // no debe bloquear las ventas posteriores de la misma cola.
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
    lastSyncError,
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  }
}
