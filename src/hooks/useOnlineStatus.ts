import { useEffect, useRef, useState } from 'react'
import { addDiagnosticBreadcrumb } from '../lib/diagnostics'

export function useOnlineStatus() {
  const [isOnline, setIsOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  const isOnlineRef = useRef(isOnline)

  useEffect(() => {
    function handleOnline() {
      if (!isOnlineRef.current) addDiagnosticBreadcrumb('connectivity.online')
      isOnlineRef.current = true
      setIsOnline(true)
    }

    function handleOffline() {
      if (isOnlineRef.current) addDiagnosticBreadcrumb('connectivity.offline')
      isOnlineRef.current = false
      setIsOnline(false)
    }

    window.addEventListener('online', handleOnline)
    window.addEventListener('offline', handleOffline)
    return () => {
      window.removeEventListener('online', handleOnline)
      window.removeEventListener('offline', handleOffline)
    }
  }, [])

  return isOnline
}
