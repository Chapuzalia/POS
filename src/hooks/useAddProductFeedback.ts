import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export type AddProductFeedbackType = 'added' | 'updated'

export type AddProductFlyFeedback = {
  id: string
  productName: string
  sourceRect: DOMRect
  targetRect: DOMRect
}

type AddProductSuccess = {
  id: string
  productName: string
  type: AddProductFeedbackType
}

type TriggerAddProductFeedback = {
  feedbackType: AddProductFeedbackType
  productName: string
  sourceElement?: HTMLElement | null
}

function getVisibleRect(element: HTMLElement | null) {
  if (!element) return null

  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0 ? rect : null
}

function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
}

export function useAddProductFeedback(floatingTicketButtonRef: RefObject<HTMLButtonElement | null>) {
  const [flyFeedback, setFlyFeedback] = useState<AddProductFlyFeedback | null>(null)
  const [success, setSuccess] = useState<AddProductSuccess | null>(null)
  const flightTimeoutRef = useRef<number | null>(null)
  const successTimeoutRef = useRef<number | null>(null)
  const feedbackSequenceRef = useRef(0)

  const clearTimers = useCallback(() => {
    if (flightTimeoutRef.current !== null) window.clearTimeout(flightTimeoutRef.current)
    if (successTimeoutRef.current !== null) window.clearTimeout(successTimeoutRef.current)
    flightTimeoutRef.current = null
    successTimeoutRef.current = null
  }, [])

  useEffect(() => clearTimers, [clearTimers])

  const triggerAddFeedback = useCallback(({ feedbackType, productName, sourceElement }: TriggerAddProductFeedback) => {
    clearTimers()

    const id = `add-feedback-${++feedbackSequenceRef.current}`
    const sourceRect = getVisibleRect(sourceElement ?? null)
    const targetRect = getVisibleRect(floatingTicketButtonRef.current)
    const canFly = feedbackType === 'added' && !prefersReducedMotion() && sourceRect && targetRect

    setSuccess(null)

    const startSuccess = () => {
      setFlyFeedback((current) => (current?.id === id ? null : current))
      setSuccess({ id, productName, type: feedbackType })
      successTimeoutRef.current = window.setTimeout(() => {
        setSuccess((current) => (current?.id === id ? null : current))
      }, 800)
    }

    if (canFly) {
      setFlyFeedback({ id, productName, sourceRect, targetRect })
      flightTimeoutRef.current = window.setTimeout(startSuccess, 320)
      return
    }

    setFlyFeedback(null)
    startSuccess()
  }, [clearTimers, floatingTicketButtonRef])

  return {
    announcement: success ? (success.type === 'added' ? `${success.productName} añadido al ticket` : `${success.productName} actualizado`) : '',
    flyFeedback,
    isAddSuccess: success !== null,
    shouldAnimateCount: success?.type === 'added',
    successId: success?.id ?? null,
    triggerAddFeedback,
  }
}
