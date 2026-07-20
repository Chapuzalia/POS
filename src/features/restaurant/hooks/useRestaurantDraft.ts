import { useCallback, useEffect, useRef, useState } from 'react'
import { loadRestaurantOrder, saveRestaurantOrderLines } from '../../tables/service'
import type { RestaurantOrderDetail, RestaurantOrderSaveState } from '../../tables/types'
import type { TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { isRestaurantRevisionConflict, shouldFlushRestaurantDraft } from '../draft-policy'


type UseRestaurantDraftOptions = {
  context: TenantContext | null
  isOnline: boolean
  onError: (message: string) => void
}

export function useRestaurantDraft({ context, isOnline, onError }: UseRestaurantDraftOptions) {
  const [order, setOrder] = useState<RestaurantOrderDetail | null>(null)
  const [saveState, setSaveState] = useState<RestaurantOrderSaveState>('saved')
  const orderRef = useRef<RestaurantOrderDetail | null>(null)
  const editGenerationRef = useRef(0)
  const saveStateRef = useRef<RestaurantOrderSaveState>('saved')
  const savePromiseRef = useRef<Promise<RestaurantOrderDetail | null> | null>(null)
  const flushRef = useRef<() => Promise<RestaurantOrderDetail | null>>(async () => null)

  const updateSaveState = useCallback((nextState: RestaurantOrderSaveState) => {
    saveStateRef.current = nextState
    setSaveState(nextState)
  }, [])

  const replaceOrder = useCallback((nextOrder: RestaurantOrderDetail | null) => {
    orderRef.current = nextOrder
    setOrder(nextOrder)
    updateSaveState('saved')
  }, [updateSaveState])

  const updateDraft = useCallback((transform: (detail: RestaurantOrderDetail) => RestaurantOrderDetail) => {
    const current = orderRef.current
    if (!current) return
    const transformed = transform(current)
    const next = {
      ...transformed,
      totalCents: transformed.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
    }
    orderRef.current = next
    editGenerationRef.current += 1
    setOrder(next)
    updateSaveState('dirty')
  }, [updateSaveState])

  const flush = useCallback(async (): Promise<RestaurantOrderDetail | null> => {
    const currentDraft = orderRef.current
    if (currentDraft && saveStateRef.current === 'saved') return currentDraft
    if (!isOnline) {
      onError('La gestion de mesas requiere conexion para guardar la comanda.')
      return null
    }

    const pendingSave = savePromiseRef.current
    if (pendingSave) {
      await pendingSave
      return shouldFlushRestaurantDraft(saveStateRef.current) ? flushRef.current() : orderRef.current
    }

    const draft = orderRef.current
    if (!draft) return null
    if (saveStateRef.current === 'saved') return draft
    if (saveStateRef.current === 'error') updateSaveState('dirty')

    const savedGeneration = editGenerationRef.current
    updateSaveState('saving')
    const request = (async () => {
      try {
        const result = await saveRestaurantOrderLines(draft)
        const current = orderRef.current
        if (!current || current.order.id !== draft.order.id) return null
        const hasNewerEdits = editGenerationRef.current !== savedGeneration
        const reconciled: RestaurantOrderDetail = {
          ...current,
          order: { ...current.order, revision: result.revision },
          lines: hasNewerEdits ? current.lines : result.lines,
          totalCents: hasNewerEdits
            ? current.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0)
            : result.lines.reduce((total, line) => total + line.quantity * line.unitPriceCents, 0),
        }
        orderRef.current = reconciled
        setOrder(reconciled)
        updateSaveState(hasNewerEdits ? 'dirty' : 'saved')
        return reconciled
      } catch (saveError) {
        if (isRestaurantRevisionConflict(saveError) && context) {
          try {
            const remoteOrder = await loadRestaurantOrder(context, draft.order.id)
            replaceOrder(remoteOrder)
            onError('La comanda cambio en otro dispositivo. Se ha recargado la version mas reciente.')
          } catch (reloadError) {
            updateSaveState('error')
            onError(getReadableError(reloadError))
          }
          return null
        }
        updateSaveState('error')
        onError(getReadableError(saveError))
        return null
      }
    })()

    savePromiseRef.current = request
    const result = await request
    if (savePromiseRef.current === request) savePromiseRef.current = null
    return result
  }, [context, isOnline, onError, replaceOrder, updateSaveState])

  flushRef.current = flush

  useEffect(() => {
    if (!isOnline || saveState !== 'dirty' || !order) return undefined
    const timer = window.setTimeout(() => void flushRef.current(), 800)
    return () => window.clearTimeout(timer)
  }, [isOnline, order, saveState])

  useEffect(() => {
    if (!isOnline) return undefined
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden' && shouldFlushRestaurantDraft(saveStateRef.current)) {
        void flushRef.current()
      }
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [isOnline])

  return {
    clearOrder: () => replaceOrder(null),
    flush,
    getCurrentOrder: () => orderRef.current,
    order,
    replaceOrder,
    saveState,
    updateDraft,
  }
}
