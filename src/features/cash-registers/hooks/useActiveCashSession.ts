import { useEffect, useRef } from 'react'
import { isAdministrativeUser } from '../../../app/app-permissions'
import { getCachedCashSession } from '../../../lib/offlineStore'
import { loadOpenCashSession, subscribeToCashSessionChanges } from '../../../services/posService'
import type { CashSession, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'

type Options = {
  context: TenantContext | null
  isOnline: boolean
  onChanged: (next: CashSession | null, previous: CashSession | null) => Promise<void>
  onError: (message: string) => void
}

export function useActiveCashSession(options: Options) {
  const latestRef = useRef(options)
  latestRef.current = options
  const { context, isOnline } = options

  useEffect(() => {
    if (!context || !isOnline || isAdministrativeUser(context)) return undefined
    let active = true
    let refreshVersion = 0
    const refresh = async () => {
      const requestVersion = ++refreshVersion
      try {
        const next = await loadOpenCashSession(context)
        if (!active || requestVersion !== refreshVersion) return
        const previous = getCachedCashSession(context)
        if (next?.id !== previous?.id) await latestRef.current.onChanged(next, previous)
      } catch (error) {
        if (active && requestVersion === refreshVersion) latestRef.current.onError(getReadableError(error))
      }
    }
    const unsubscribe = subscribeToCashSessionChanges(context, () => void refresh())
    return () => {
      active = false
      unsubscribe()
    }
  }, [context, isOnline])
}
