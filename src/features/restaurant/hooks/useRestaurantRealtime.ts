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
  latestRef.current = options

  const loadCurrentMap = useCallback(async (activeContext: TenantContext, sessionId = options.activeCashSessionId) => {
    const permanentMap = await loadRestaurantMap(activeContext)
    if (!sessionId) return { ...permanentMap, layoutRevision: 0 }
    const layout = await loadSessionTableLayout(activeContext, sessionId)
    return applySessionLayout(permanentMap, layout)
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
    if (!context || !isOnline || !enabled) {
      setTablesEnabled(false)
      setMap({ areas: [], tables: [], layoutRevision: 0 })
      setConfigLoaded(true)
      return undefined
    }

    let active = true
    let initialized = false
    setConfigLoaded(false)
    const refresh = async () => {
      const isInitialLoad = !initialized
      initialized = true
      try {
        const enabledForVenue = await loadVenueTablesEnabled(context)
        if (!active) return
        setTablesEnabled(enabledForVenue)
        if (!enabledForVenue) {
          latestRef.current.setPosView({ type: 'quick_sale' })
          setMap({ areas: [], tables: [], layoutRevision: 0 })
          setConfigLoaded(true)
          return
        }
        const nextMap = await loadCurrentMap(context, options.activeCashSessionId)
        if (!active) return
        setMap(nextMap)
        if (isInitialLoad) latestRef.current.setPosView({ type: 'table_map', areaId: nextMap.areas[0]?.id })
        setConfigLoaded(true)
      } catch (mapError) {
        if (!active) return
        if (isInitialLoad) initialized = false
        setConfigLoaded(true)
        latestRef.current.onError(getReadableError(mapError))
      }
    }

    void refresh()
    let realtimeTimer: ReturnType<typeof window.setTimeout> | null = null
    let fallbackTimer: ReturnType<typeof window.setInterval> | null = null
    const scheduleRefresh = () => {
      if (realtimeTimer) window.clearTimeout(realtimeTimer)
      realtimeTimer = window.setTimeout(() => {
        void (async () => {
          await refresh()
          const current = latestRef.current
          if (current.posView.type !== 'table_order' || current.saveState !== 'saved') return
          try {
            const detail = await loadRestaurantOrder(context, current.posView.orderId)
            if (!active || latestRef.current.saveState !== 'saved') return
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
            if (active) latestRef.current.onError(getReadableError(orderError))
          }
        })()
      }, 250)
    }

    const unsubscribe = subscribeToRestaurantMap(context, scheduleRefresh, (status, channelError) => {
      if (status === 'SUBSCRIBED') {
        if (fallbackTimer) window.clearInterval(fallbackTimer)
        fallbackTimer = null
        scheduleRefresh()
        return
      }
      if ((status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') && !fallbackTimer) {
        console.warn('Realtime de comandas no disponible; se activa la resincronizacion periodica.', channelError)
        fallbackTimer = window.setInterval(scheduleRefresh, 3000)
      }
    })
    const unsubscribeLayout = options.activeCashSessionId
      ? subscribeToSessionTableLayout(context, options.activeCashSessionId, () => void refresh())
      : () => undefined

    return () => {
      active = false
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
