import { useEffect, useRef, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'

export function isOrderLineActionTarget(target: EventTarget | null) {
  return target instanceof Element && !target.closest('[data-order-line-hold="true"]')
    && Boolean(target.closest('button, a, input, textarea, select, summary, [role="button"], [data-order-line-action="true"]'))
}

export function useOrderLineLongPress(disabled: boolean, onOpen: () => void) {
  const timer = useRef<number | null>(null)
  const origin = useRef<{ x: number; y: number } | null>(null)
  const held = useRef(false)
  const open = useRef(onOpen)
  useEffect(() => { open.current = onOpen }, [onOpen])

  function cancel() {
    if (timer.current !== null) window.clearTimeout(timer.current)
    timer.current = null
    origin.current = null
  }

  useEffect(() => {
    if (disabled) cancel()
    return cancel
  }, [disabled])

  return {
    // Some touch buttons stop pointer events from bubbling. A new gesture must
    // still clear click suppression left by a hold that opened another modal.
    onPointerDownCapture() { held.current = false },
    onPointerDown(event: PointerEvent<HTMLElement>) {
      cancel()
      held.current = false
      if (disabled || event.button !== 0 || event.isPrimary === false || isOrderLineActionTarget(event.target)) return
      origin.current = { x: event.clientX, y: event.clientY }
      timer.current = window.setTimeout(() => {
        timer.current = null
        held.current = true
        open.current()
      }, 600)
    },
    onPointerMove(event: PointerEvent<HTMLElement>) {
      if (origin.current && (Math.abs(event.clientX - origin.current.x) > 8 || Math.abs(event.clientY - origin.current.y) > 8)) cancel()
    },
    onPointerUp() { cancel(); return held.current },
    onPointerCancel() { cancel(); held.current = false },
    onContextMenu(event: MouseEvent<HTMLElement>) {
      if (disabled || isOrderLineActionTarget(event.target)) return
      event.preventDefault()
      cancel()
      if (!held.current) open.current()
      held.current = true
    },
    onClickCapture(event: MouseEvent<HTMLElement>) {
      if (!held.current) return
      event.preventDefault()
      event.stopPropagation()
      held.current = false
    },
    onKeyDown(event: KeyboardEvent<HTMLElement>) {
      if (disabled || event.target !== event.currentTarget || !(event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))) return
      event.preventDefault()
      open.current()
    },
  }
}
