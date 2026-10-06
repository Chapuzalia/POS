import { operationBreadcrumb } from '../../../lib/observability.ts'
import { getCachedAssistConfiguration } from '../../../lib/offlineStore'
import { useCallback, useEffect, useRef, useState } from 'react'
import { applySessionLayout, loadSessionTableLayout, subscribeToSessionTableLayout } from '../../tables/layout-service'
import {
  loadRestaurantEqualSplit,
  loadRestaurantMap,
  loadRestaurantOrder,
  loadRestaurantOrderGroup,
  loadVenueTablesEnabled,
  subscribeToRestaurantMap,
} from '../../tables/service'
import type {
  PosView,
  RestaurantEqualSplit,
  RestaurantMap,
  RestaurantOrderDetail,
  RestaurantOrderGroupDetail,
  RestaurantOrderSaveState,
} from '../../tables/types'
import type { TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { addDiagnosticBreadcrumb } from '../../../lib/diagnostics'

type UseRestaurantRealtimeOptions = {
  activeCashSessionId?: string
  context: TenantContext | null
  enabled: boolean
  equalSplitOpen: boolean
  isOnline: boolean
  onError: (message: string) => void
  posView: PosView
  replaceOrder: (order: RestaurantOrderDetail | null) => void
  saveState: RestaurantOrderSaveState
  setEqualSplit: (split: RestaurantEqualSplit | null) => void
  setPosView: (view: PosView) => void
  setSplitOrderGroup: (group: RestaurantOrderGroupDetail | null) => void
  splitOrderGroup: RestaurantOrderGroupDetail | null
}

export function useRestaurantRealtime(options: UseRestaurantRealtimeOptions) {
  const [tablesEnabled, setTablesEnabled] = useState(false)
  const [map, setMap] = useState<RestaurantMap>({ areas: [], tables: [], layoutRevision: 0 })
  const [configLoaded, setConfigLoaded] = useState(false)
  const latestRef = useRef(options)
  const loadedContextKeyRef = useRef<string | null>(null)
  const tablesEnabledRef = useRef(false)
  const wasOfflineRef = useRef(false)
  const mapLoadsRef = useRef(new Map<string, { pending: Promise<RestaurantMap>; rerun: boolean }>())
  latestRef.current = options

  const loadCurrentMap = useCallback(async (activeContext: TenantContext, sessionId = options.activeCashSessionId) => {
    const key = `${activeContext.tenantId}:${activeContext.venueId}:${activeContext.deviceId}:${activeContext.userId}:${sessionId ?? ''}`
    const current = mapLoadsRef.current.get(key)
    if (current) {
      // A mutation/Realtime event during a fetch needs a trailing fresh snapshot.
      current.rerun = true
      return current.pending
    }
    const load = { pending: Promise.resolve<RestaurantMap>({ areas: [], tables: [], layoutRevision: 0 }), rerun: false }
    const pending = (async () => {
      let nextMap: RestaurantMap
      do {
        load.rerun = false
        const permanentMap = await loadRestaurantMap(activeContext, sessionId)
        // The snapshot RPC includes layout. Older servers retain the existing fallback.
        const currentLayout = sessionId && permanentMap.layoutRevision === undefined ? await loadSessionTableLayout(activeContext, sessionId) : null
        nextMap = currentLayout ? applySessionLayout(permanentMap, currentLayout) : { ...permanentMap, layoutRevision: permanentMap.layoutRevision ?? 0 }
      } while (load.rerun)
      return nextMap
    })()
    load.pending = pending
    mapLoadsRef.current.set(key, load)
    try { return await pending } finally { if (mapLoadsRef.current.get(key) === load) mapLoadsRef.current.delete(key) }
  }, [options.activeCashSessionId])

  const refreshMap = useCallback(async () => {
    const { context } = latestRef.current
    if (!context) return null
    const nextMap = await loadCurrentMap(context)
    setMap(nextMap)
    return nextMap
  }, [loadCurrentMap])

  useEffect(() => {
    const { context, enabled, isOnline } = options
    if (!context || !enabled) {
      loadedContextKeyRef.current = null
      tablesEnabledRef.current = false
      setTablesEnabled(false)
      setMap({ areas: [], tables: [], layoutRevision: 0 })
      setConfigLoaded(true)
      return undefined
    }
    if (!isOnline) {
      wasOfflineRef.current = true
      setMap((current) => {
        if (loadedContextKeyRef.current === `${context.tenantId}:${context.venueId}`) return current
        const configuration = getCachedAssistConfiguration(context)
        return { areas: [], tables: [], layoutRevision: 0, assist: configuration ? { configuration, orders: [], observedAt: '', contextKey: `${context.tenantId}:${context.venueId}` } : undefined }
      })
      setConfigLoaded(true)
      return undefined
    }

    let active = true
    const contextKey = `${context.tenantId}:${context.venueId}`
    const isInitialLoad = loadedContextKeyRef.current !== contextKey
    const source = isInitialLoad ? 'initial' : wasOfflineRef.current ? 'reconnect' : 'refresh'
    wasOfflineRef.current = false
    if (isInitialLoad) setConfigLoaded(false)

    const refresh = async (instrumentConfigLoad = false) => {
      const shouldInitializeView = loadedContextKeyRef.current !== contextKey
      const startedBreadcrumb = shouldInitializeView
        ? 'restaurant_config.initial_load_started'
        : 'restaurant_config.refresh_started'
      const finishedBreadcrumb = shouldInitializeView
        ? 'restaurant_config.initial_load_finished'
        : 'restaurant_config.refresh_finished'
      if (instrumentConfigLoad) {
        addDiagnosticBreadcrumb(startedBreadcrumb, { source, venueId: context.venueId })
      }
      let loadedTablesEnabled: boolean | undefined
      let succeeded = false
      try {
        const enabledForVenue = await loadVenueTablesEnabled(context)
        if (!active) return
        loadedTablesEnabled = enabledForVenue
        const tablesWereEnabled = tablesEnabledRef.current
        tablesEnabledRef.current = enabledForVenue
        setTablesEnabled(enabledForVenue)
        if (!enabledForVenue) {
          if (shouldInitializeView || tablesWereEnabled) latestRef.current.setPosView({ type: 'quick_sale' })
          setMap({ areas: [], tables: [], layoutRevision: 0 })
          loadedContextKeyRef.current = contextKey
          setConfigLoaded(true)
          succeeded = true
          return
        }
        const nextMap = await loadCurrentMap(context, options.activeCashSessionId)
        if (!active) return
        setMap(nextMap)
        if (shouldInitializeView) latestRef.current.setPosView({ type: 'table_map', areaId: nextMap.areas[0]?.id })
        loadedContextKeyRef.current = contextKey
        setConfigLoaded(true)
        succeeded = true
      } catch (mapError) {
        if (!active) return
        setConfigLoaded(true)
        latestRef.current.onError(getReadableError(mapError, { operation: 'restaurant.refresh', recoverable: true }))
      } finally {
        if (instrumentConfigLoad) {
          addDiagnosticBreadcrumb(finishedBreadcrumb, {
            source,
            succeeded,
            tablesEnabled: loadedTablesEnabled,
            venueId: context.venueId,
          })
        }
      }
    }

    void refresh(true)
    let realtimeTimer: number | null = null
    let fallbackTimer: number | null = null
    const scheduleRefresh = () => {
      if (!active) return
      if (realtimeTimer) window.clearTimeout(realtimeTimer)
      realtimeTimer = window.setTimeout(() => {
        void (async () => {
          await refresh()
          if (!active) return
          const current = latestRef.current
          if (current.posView.type !== 'table_order' || current.saveState !== 'saved') return
          try {
            const detail = await loadRestaurantOrder(context, current.posView.orderId)
            if (!active || latestRef.current.saveState !== 'saved') return
            if (detail.order.status === 'carried_forward') {
              current.replaceOrder(null)
              current.setEqualSplit(null)
              current.setSplitOrderGroup(null)
              current.setPosView({ type: 'table_map', areaId: detail.tables[0]?.areaId })
              return
            }
            if (detail.order.status !== 'open') {
              const group = await loadRestaurantOrderGroup(context, detail.order.id)
              const nextOrder = group.orders.find((candidate) => candidate.order.status === 'open') ?? null
              current.replaceOrder(nextOrder)
              current.setPosView(nextOrder
                ? { type: 'table_order', orderId: nextOrder.order.id }
                : { type: 'table_map', areaId: detail.tables[0]?.areaId })
              if (current.splitOrderGroup) current.setSplitOrderGroup(nextOrder ? group : null)
              return
            }
            current.replaceOrder(detail)
            if (current.equalSplitOpen) current.setEqualSplit(await loadRestaurantEqualSplit(context, detail.order.id))
            if (current.splitOrderGroup) current.setSplitOrderGroup(await loadRestaurantOrderGroup(context, detail.order.id))
          } catch (orderError) {
            if (active) latestRef.current.onError(getReadableError(orderError, { operation: 'restaurant.refresh', recoverable: true }))
          }
        })()
      }, 250)
    }

    // Realtime can remain subscribed after missing changes while the app sleeps.
    const safetyTimer = window.setInterval(scheduleRefresh, 18000)
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleRefresh()
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', scheduleRefresh)
    window.addEventListener('online', scheduleRefresh)

    const unsubscribe = subscribeToRestaurantMap(context, scheduleRefresh, (status) => {
      if (!active) return
      if (status === 'SUBSCRIBED') {
        if (fallbackTimer) window.clearInterval(fallbackTimer)
        fallbackTimer = null
        scheduleRefresh()
        return
      }
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') && !fallbackTimer) {
        operationBreadcrumb({ operation: 'restaurant.realtime', step: 'polling_fallback', syncStatus: status })
        fallbackTimer = window.setInterval(scheduleRefresh, 3000)
      }
    })
    const unsubscribeLayout = options.activeCashSessionId
      ? subscribeToSessionTableLayout(context, options.activeCashSessionId, () => void refresh())
      : () => undefined

    return () => {
      active = false
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', scheduleRefresh)
      window.removeEventListener('online', scheduleRefresh)
      window.clearInterval(safetyTimer)
      if (realtimeTimer) window.clearTimeout(realtimeTimer)
      if (fallbackTimer) window.clearInterval(fallbackTimer)
      unsubscribe()
      unsubscribeLayout()
    }
  }, [options.activeCashSessionId, options.context, options.enabled, options.isOnline, loadCurrentMap])

  return {
    configLoaded,
    loadCurrentMap,
    map,
    refreshMap,
    setMap,
    tablesEnabled,
  }
}
