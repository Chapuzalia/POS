import { useEffect, useRef } from 'react'
import type { TenantContext } from '../../../types'
import { subscribeToReservations } from '../services/reservationService'

type Options = {
  context: TenantContext | null
  enabled: boolean
  isOnline: boolean
  onRefresh: () => Promise<void>
}

export function useReservationsRealtime({ context, enabled, isOnline, onRefresh }: Options) {
  const refreshRef = useRef(onRefresh)
  refreshRef.current = onRefresh

  useEffect(() => {
    if (!context || !enabled || !isOnline) return undefined
    let timer: ReturnType<typeof window.setTimeout> | null = null
    const schedule = () => {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(() => void refreshRef.current(), 250)
    }
    const unsubscribe = subscribeToReservations(context, schedule)
    const onVisibility = () => {
      if (document.visibilityState === 'visible') schedule()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      if (timer) window.clearTimeout(timer)
      unsubscribe()
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [context, enabled, isOnline])
}
