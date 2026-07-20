import { useEffect, useRef } from 'react'
import type { TenantContext } from '../../../types'
import { checkLoginLease, heartbeatLoginLease } from '../../../services/loginLeaseService'

const inactivityMs = 30 * 60 * 1000
const leaseCheckIntervalMs = 30_000

type UseLoginActivityOptions = {
  context: TenantContext | null
  isOnline: boolean
  onSessionClosed: (message: string, leaseBlocked: boolean) => Promise<void>
}

/** Keeps a claimed POS login alive and closes it after local inactivity. */
export function useLoginActivity({ context, isOnline, onSessionClosed }: UseLoginActivityOptions) {
  const activityRef = useRef({
    context: null as TenantContext | null,
    lastActivityAt: Date.now(),
    lastHeartbeatAt: Date.now(),
    lastSyncedActivityAt: Date.now(),
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
      activity.lastSyncedActivityAt = now
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
      idleTimeoutId = window.setTimeout(() => void close('La sesion se ha cerrado tras 30 minutos sin actividad.', false), remainingMs)
    }
    const validateLease = async (forceHeartbeat = false) => {
      if (!active || closing || leaseRequestInFlight) return
      if (Date.now() - activity.lastActivityAt >= inactivityMs) {
        await close('La sesion se ha cerrado tras 30 minutos sin actividad.', false)
        return
      }
      if (!isOnline) return
      leaseRequestInFlight = true
      try {
        const now = Date.now()
        const hasUnsyncedActivity = activity.lastActivityAt > activity.lastSyncedActivityAt
        const shouldHeartbeat = hasUnsyncedActivity && (forceHeartbeat || now - activity.lastHeartbeatAt >= leaseCheckIntervalMs)
        const syncedActivityAt = activity.lastActivityAt
        const ownsLease = shouldHeartbeat ? await heartbeatLoginLease() : await checkLoginLease()
        if (shouldHeartbeat && ownsLease) {
          activity.lastHeartbeatAt = Date.now()
          activity.lastSyncedActivityAt = syncedActivityAt
        }
        if (!ownsLease) {
          await close('La sesion se ha cerrado porque la cuenta se ha liberado o se ha abierto en otro dispositivo.', true)
        }
      } catch {
        // Network failures must not end a session that can continue offline.
      } finally {
        leaseRequestInFlight = false
      }
    }
    const recordActivity = () => {
      activity.lastActivityAt = Date.now()
      scheduleIdleClose()
      if (activity.lastActivityAt - activity.lastHeartbeatAt >= leaseCheckIntervalMs) void validateLease(true)
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') void validateLease()
    }

    scheduleIdleClose()
    void validateLease()
    const intervalId = window.setInterval(() => void validateLease(), leaseCheckIntervalMs)
    window.addEventListener('pointerdown', recordActivity, { passive: true })
    window.addEventListener('keydown', recordActivity)
    window.addEventListener('wheel', recordActivity, { passive: true })
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      active = false
      if (idleTimeoutId) window.clearTimeout(idleTimeoutId)
      window.clearInterval(intervalId)
      window.removeEventListener('pointerdown', recordActivity)
      window.removeEventListener('keydown', recordActivity)
      window.removeEventListener('wheel', recordActivity)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [context, isOnline, onSessionClosed])
}
