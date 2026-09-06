import { reportOperationError, operationBreadcrumb, isTransportError } from '../lib/observability.ts'
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
import { isClosedCashSaleRejection } from '../features/offline/services/cashSessionRejection'

type RejectedSaleEvent = Extract<OfflineEvent, { kind: 'sale_created' }>

export function useOfflineSync(isOnline: boolean, sessionReady = true) {
  const initialQueue = getOfflineQueue()
  const [pendingCount, setPendingCount] = useState(() => initialQueue.length)
  const [lastSyncError, setLastSyncError] = useState<string | null>(
    () => initialQueue.some((event) => event.lastError) ? 'Hay operaciones pendientes de sincronizar. Revisa su estado.' : null,
  )
  const [rejectedSaleEvent, setRejectedSaleEvent] = useState<RejectedSaleEvent | null>(null)
  const syncInFlightRef = useRef<Promise<void> | null>(null)

  const refreshPendingCount = useCallback(() => {
    const events = getOfflineQueue()
    setPendingCount(events.length)
    setLastSyncError(events.some((event) => event.lastError) ? 'Hay operaciones pendientes de sincronizar. Revisa su estado.' : null)
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

      // Una venta puede haberse encolado justo cuando la sincronización
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
          operationBreadcrumb({ operation: 'offline.sync', operationId: event.id, saleId: event.kind === 'sale_created' ? event.payload.sale.id : undefined, step: event.kind })
          await syncEvent(event)
          forgetOfflineEvent(event.id)
        } catch (syncError) {
          const incident = { operation: 'offline.sync', operationId: event.id, saleId: event.kind === 'sale_created' ? event.payload.sale.id : undefined, step: event.kind, syncStatus: 'failed', recoverable: true }
          reportOperationError(syncError, incident)
          if (isClosedCashSaleRejection(event, syncError)) {
            forgetOfflineEvent(event.id)
            setRejectedSaleEvent(event)
            continue
          }

          markOfflineEventFailed(event.id, isTransportError(syncError) ? 'Sin conexión. La operación sigue pendiente de sincronizar.' : getReadableError(syncError, incident, 'No se ha podido sincronizar la operación. Revisa las operaciones pendientes.'))
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
    if (isOnline && sessionReady) {
      void syncPendingEvents()
    }
  }, [isOnline, sessionReady, syncPendingEvents])

  return {
    clearRejectedSaleEvent,
    lastSyncError,
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  }
}
