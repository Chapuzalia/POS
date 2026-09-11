import { useEffect, useRef, useState } from 'react'
import {
  checkCurrentAppVersion,
  type AppVersionStatus,
} from '../config/appVersion'

const FOREGROUND_CHECK_COOLDOWN_MS = 30_000
const ACTIVE_SESSION_CHECK_INTERVAL_MS = 5 * 60_000

export function useAppVersionStatus(isOnline: boolean) {
  const [status, setStatus] = useState<AppVersionStatus>('compatible')
  const lastAttemptAtRef = useRef(0)

  useEffect(() => {
    if (!isOnline) return undefined
    let active = true

    const refreshStatus = async (force = false) => {
      const now = Date.now()
      if (!force && now - lastAttemptAtRef.current < FOREGROUND_CHECK_COOLDOWN_MS) return
      lastAttemptAtRef.current = now

      try {
        const nextStatus = await checkCurrentAppVersion()
        if (active) setStatus(nextStatus)
      } catch {
        // Version discovery is advisory: a network/server failure must never stop the POS.
      }
    }

    const handleFocus = () => { void refreshStatus() }
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refreshStatus()
    }, ACTIVE_SESSION_CHECK_INTERVAL_MS)

    // Re-running this effect after an offline -> online transition forces a fresh check.
    void refreshStatus(true)
    window.addEventListener('focus', handleFocus)
    document.addEventListener('visibilitychange', handleVisibility)
    return () => {
      active = false
      window.clearInterval(intervalId)
      window.removeEventListener('focus', handleFocus)
      document.removeEventListener('visibilitychange', handleVisibility)
    }
  }, [isOnline])

  return status
}
