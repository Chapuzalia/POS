import { useEffect, useRef } from 'react'
import type { TenantContext } from '../../../types'
import { claimLoginLease, checkLoginLease, heartbeatLoginLease } from '../../../services/loginLeaseService'

const inactivityMs = 4 * 60 * 60 * 1000
const heartbeatThrottleMs = 30_000

type UseLoginActivityOptions = {
  context: TenantContext | null
  isOnline: boolean
  onSessionClosed: (message: string, leaseBlocked: boolean) => Promise<void>
}

/** Tracks local inactivity and validates the activity-based login lease. */
export function useLoginActivity({ context, isOnline, onSessionClosed }: UseLoginActivityOptions) {
  const activityRef = useRef({
    context: null as TenantContext | null,
    lastActivityAt: Date.now(),
    lastHeartbeatAt: Date.now(),
  })

  useEffect(() => {
    if (!context) {
      activityRef.current.context = null
      return undefined
    }

    const activity = activityRef.current
    if (activity.context !== context) {
      const now = Date.now()
      activity.context = context
      activity.lastActivityAt = now
      activity.lastHeartbeatAt = now
    }

    let active = true
    let closing = false
    let leaseRequestInFlight = false
    let idleTimeoutId: ReturnType<typeof window.setTimeout> | null = null

    const close = async (message: string, leaseBlocked: boolean) => {
      if (!active || closing) return
      closing = true
      await onSessionClosed(message, leaseBlocked)
    }
    const scheduleIdleClose = () => {
      if (idleTimeoutId) window.clearTimeout(idleTimeoutId)
      const remainingMs = Math.max(0, inactivityMs - (Date.now() - activity.lastActivityAt))
      idleTimeoutId = window.setTimeout(() => void close('La sesión se ha cerrado tras 4 horas sin actividad.', false), remainingMs)
    }
    const validateLease = async (heartbeatOnActivity = false) => {
      if (!active || closing || leaseRequestInFlight) return
      if (Date.now() - activity.lastActivityAt >= inactivityMs) {
        await close('La sesión se ha cerrado tras 4 horas sin actividad.', false)
        return
      }
      if (!isOnline) return
      leaseRequestInFlight = true
      try {
        let ownsLease = heartbeatOnActivity ? await heartbeatLoginLease() : await checkLoginLease()
        if (heartbeatOnActivity && !ownsLease) {
          // This recovery mode can only take an expired lease. It cannot
          // replace another active device or a newer tab on this device.
          ownsLease = await claimLoginLease(false)
        }
        if (!ownsLease) {
          await close('La sesión se ha cerrado porque la cuenta se ha liberado o se ha abierto en otro dispositivo.', true)
        }
      } catch {
        // Network failures must not end a session that can continue offline.
      } finally {
        leaseRequestInFlight = false
      }
    }
    const recordActivity = () => {
      const now = Date.now()
      activity.lastActivityAt = now
      scheduleIdleClose()
      if (isOnline && now - activity.lastHeartbeatAt >= heartbeatThrottleMs) {
        activity.lastHeartbeatAt = now
        void validateLease(true)
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void validateLease()
    }

    scheduleIdleClose()
    void validateLease()
    window.addEventListener('pointerdown', recordActivity, { passive: true })
    window.addEventListener('keydown', recordActivity)
    window.addEventListener('wheel', recordActivity, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      active = false
      if (idleTimeoutId) window.clearTimeout(idleTimeoutId)
      window.removeEventListener('pointerdown', recordActivity)
      window.removeEventListener('keydown', recordActivity)
      window.removeEventListener('wheel', recordActivity)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [context, isOnline, onSessionClosed])
}
