import { useCallback, useEffect, useRef, useState } from 'react'
import type { TenantContext } from '../../types'
import { getReadableError } from '../../utils/errors'
import { loadKdsQueue, subscribeToKds } from './service'
import type { KdsQueue } from './types'

const emptyQueue: KdsQueue = { destinationId: '', items: [], events: [] }

export function useKdsQueue(context: TenantContext, isOnline: boolean) {
  const scope = `${context.tenantId}:${context.venueId}:${context.deviceId}`
  const [state, setState] = useState({ scope, queue: emptyQueue, error: null as string | null })
  const refreshRef = useRef<() => Promise<void>>(async () => undefined)
  const { tenantId, venueId, deviceId } = context

  useEffect(() => {
    if (!isOnline) return
    let active = true
    let pending: Promise<void> | null = null
    let rerun = false
    let unsubscribe: (() => void) | undefined
    let destinationId: string | undefined
    let retryTimer: number | undefined
    const refresh = (): Promise<void> => {
      if (!active) return Promise.resolve()
      if (pending) {
        rerun = true
        return pending
      }
      pending = (async () => {
        do {
          rerun = false
          try {
            const queue = await loadKdsQueue(deviceId)
            if (!active) return
            setState({ scope, queue, error: null })
            if (destinationId !== queue.destinationId) {
              // Use the destination returned by the server, including for older cached sessions.
              unsubscribe?.()
              destinationId = queue.destinationId
              unsubscribe = subscribeToKds({ tenantId, venueId }, queue.destinationId, () => void refresh())
              window.clearInterval(retryTimer)
            }
          } catch (cause) {
            if (active) setState((current) => ({
              scope,
              queue: current.scope === scope ? current.queue : emptyQueue,
              error: getReadableError(cause, { operation: 'features.production.components.KdsPage' }),
            }))
          }
        } while (active && rerun)
      })().finally(() => { pending = null })
      return pending
    }
    refreshRef.current = refresh
    retryTimer = window.setInterval(() => void refresh(), 3000)
    void refresh()
    return () => {
      active = false
      refreshRef.current = async () => undefined
      window.clearInterval(retryTimer)
      unsubscribe?.()
    }
  }, [tenantId, venueId, deviceId, isOnline, scope])

  const refresh = useCallback(() => refreshRef.current(), [])
  return {
    queue: isOnline && state.scope === scope ? state.queue : emptyQueue,
    error: isOnline && state.scope === scope ? state.error : null,
    refresh,
  }
}
