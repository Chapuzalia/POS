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
import { loadDurableEvents } from '../lib/durableSales.ts'

type RejectedSaleEvent = Extract<OfflineEvent, { kind: 'sale_created' }>

export function useOfflineSync(isOnline: boolean, sessionReady = true) {
  const initialQueue = getOfflineQueue()
  const [pendingCount, setPendingCount] = useState(() => initialQueue.length)
  const [lastSyncError, setLastSyncError] = useState<string | null>(
    () => initialQueue.some((event) => event.lastError) ? 'Hay operaciones pendientes de sincronizar. Revisa su estado.' : null,
  )
  const [rejectedSaleEvent, setRejectedSaleEvent] = useState<RejectedSaleEvent | null>(null)
  const [isSyncing, setIsSyncing] = useState(false)
  const syncInFlightRef = useRef<Promise<void> | null>(null)

  const refreshPendingCount = useCallback(() => {
    const events = getOfflineQueue()
    setPendingCount(events.length)
    setLastSyncError(events.some((event) => event.lastError) ? 'Hay operaciones pendientes de sincronizar. Revisa su estado.' : null)
    void loadDurableEvents().then(() => {
      const loaded = getOfflineQueue()
      setPendingCount(loaded.length)
      setLastSyncError(loaded.some(event => event.lastError) ? 'Hay operaciones pendientes de sincronizar. Revisa su estado.' : null)
    }).catch(error => {
      reportOperationError(error, { operation: 'offline.storage', step: 'load_queue', recoverable: true })
      setLastSyncError('No se ha podido leer la cola durable. Revisa el almacenamiento antes de cerrar la caja.')
    })
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

    setIsSyncing(true)
    const syncTask = (async () => {
      await loadDurableEvents()
      const events = getOfflineQueue()

      // Cada evento se intenta una vez por pasada. Un evento antiguo con error
      // no debe bloquear las ventas posteriores de la misma cola.
      for (const event of events) {
        try {
          operationBreadcrumb({ operation: 'offline.sync', operationId: event.id, saleId: event.kind === 'sale_created' ? event.payload.sale.id : undefined, step: event.kind })
          await syncEvent(event)
          await forgetOfflineEvent(event.id)
        } catch (syncError) {
          const incident = { operation: 'offline.sync', operationId: event.id, saleId: event.kind === 'sale_created' ? event.payload.sale.id : undefined, step: event.kind, syncStatus: 'failed', recoverable: true }
          reportOperationError(syncError, incident)
          if (isClosedCashSaleRejection(event, syncError)) {
            await markOfflineEventFailed(event.id, 'La caja original está cerrada. La venta se conserva pendiente de conciliación; no vuelvas a cobrarla.')
            setRejectedSaleEvent(event)
            continue
          }

          await markOfflineEventFailed(event.id, isTransportError(syncError) ? 'Sin conexión. La operación sigue pendiente de sincronizar.' : getReadableError(syncError, incident, 'No se ha podido sincronizar la operación. Revisa las operaciones pendientes.'))
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
        setIsSyncing(false)
      }
    }
  }, [isOnline, refreshPendingCount])

  useEffect(() => {
    refreshPendingCount()
    if (isOnline && sessionReady) {
      void syncPendingEvents()
    }
  }, [isOnline, sessionReady, syncPendingEvents, refreshPendingCount])

  return {
    clearRejectedSaleEvent,
    isSyncing,
    lastSyncError,
    pendingCount,
    rejectedSaleEvent,
    refreshPendingCount,
    syncPendingEvents,
  }
}
