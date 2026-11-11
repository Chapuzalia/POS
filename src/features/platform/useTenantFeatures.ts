import { useEffect, useRef } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import { isSuperadmin } from '../../app/app-permissions'
import { saveCachedContext } from '../../lib/offlineStore'
import { loadTenantFeatures } from '../../services/posService'
import type { TenantContext } from '../../types'
import { createTenantFeatureRefresh, subscribeTenantFeatureRefresh } from './tenantFeatureRefresh'

export function useTenantFeatures(
  context: TenantContext | null,
  isOnline: boolean,
  setContext: Dispatch<SetStateAction<TenantContext | null>>,
) {
  const tenantId = context && !isSuperadmin(context) ? context.tenantId : null
  const userId = context?.userId ?? null
  const venueId = context?.venueId || undefined
  const initiallyLoaded = context?.features !== undefined
  const refreshRef = useRef<{
    tenantId: string
    userId: string
    venueId?: string
    controller: ReturnType<typeof createTenantFeatureRefresh>
  } | null>(null)

  useEffect(() => {
    if (!tenantId || !userId) {
      refreshRef.current = null
      return undefined
    }
    if (!isOnline) return undefined
    if (refreshRef.current?.tenantId !== tenantId
      || refreshRef.current.userId !== userId
      || refreshRef.current.venueId !== venueId) {
      refreshRef.current = {
        tenantId, userId, venueId,
        controller: createTenantFeatureRefresh(() => loadTenantFeatures(tenantId, venueId), initiallyLoaded),
      }
    }
    const controller = refreshRef.current.controller
    let active = true
    const refreshFeatures = async () => {
      try {
        const features = await controller.refreshIfStale()
        if (!active || features === undefined) return
        setContext((current) => {
          if (!current || current.tenantId !== tenantId || current.userId !== userId || (current.venueId || undefined) !== venueId) return current
          const unchanged = current.features?.length === features.length
            && current.features.every((feature, index) => feature === features[index])
          if (unchanged) return current
          const nextContext = { ...current, features }
          saveCachedContext(nextContext)
          return nextContext
        })
      } catch {
        // A temporary refresh failure must not interrupt an active POS session.
      }
    }
    const unsubscribe = subscribeTenantFeatureRefresh(refreshFeatures)
    return () => {
      active = false
      unsubscribe()
    }
  }, [initiallyLoaded, isOnline, setContext, tenantId, userId, venueId])
}
