import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent, ReactNode } from 'react'
import { Button } from './Button'

const HOLD_MS = 1500

type Gesture = { kind: 'pointer'; id: number } | { kind: 'key'; key: string }

type HoldButtonProps = {
  children: ReactNode
  disabled?: boolean
  onHold: () => void | Promise<void>
}

// Liquid progress inspired by https://www.reactbits.dev/micro/hold-button.
export function HoldButton({ children, disabled = false, onHold }: HoldButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null)
  const frameRef = useRef(0)
  const gestureRef = useRef<Gesture | null>(null)
  const pendingRef = useRef(false)
  const mountedRef = useRef(false)
  const latestRef = useRef({ disabled, onHold })
  latestRef.current = { disabled, onHold }
  const [phase, setPhase] = useState<'idle' | 'holding' | 'pending'>('idle')

  function cancel() {
    cancelAnimationFrame(frameRef.current)
    frameRef.current = 0
    gestureRef.current = null
    if (pendingRef.current) return
    buttonRef.current?.style.setProperty('--hold-progress', '0')
    setPhase('idle')
  }

  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  useEffect(() => {
    mountedRef.current = true
    const stop = () => cancelRef.current()
    const visibilityChanged = () => { if (document.hidden) stop() }
    const pointerEnded = (event: globalThis.PointerEvent) => {
      if (gestureRef.current?.kind === 'pointer' && gestureRef.current.id === event.pointerId) stop()
    }
    const keyEnded = (event: globalThis.KeyboardEvent) => {
      if (gestureRef.current?.kind === 'key' && gestureRef.current.key === event.key) stop()
    }
    window.addEventListener('blur', stop)
    window.addEventListener('pointerup', pointerEnded)
    window.addEventListener('pointercancel', pointerEnded)
    window.addEventListener('keyup', keyEnded)
    document.addEventListener('visibilitychange', visibilityChanged)
    return () => {
      mountedRef.current = false
      cancelAnimationFrame(frameRef.current)
      window.removeEventListener('blur', stop)
      window.removeEventListener('pointerup', pointerEnded)
      window.removeEventListener('pointercancel', pointerEnded)
      window.removeEventListener('keyup', keyEnded)
      document.removeEventListener('visibilitychange', visibilityChanged)
    }
  }, [])

  useEffect(() => { if (disabled) cancelRef.current() }, [disabled])

  function begin(gesture: Gesture) {
    if (latestRef.current.disabled || pendingRef.current || gestureRef.current) return
    gestureRef.current = gesture
    const startedAt = performance.now()
    buttonRef.current?.style.setProperty('--hold-progress', '0')
    setPhase('holding')
    const step = (now: number) => {
      if (!gestureRef.current || latestRef.current.disabled || document.hidden) {
        cancel()
        return
      }
      const progress = Math.min(1, (now - startedAt) / HOLD_MS)
      buttonRef.current?.style.setProperty('--hold-progress', String(progress))
      if (progress < 1) {
        frameRef.current = requestAnimationFrame(step)
        return
      }
      frameRef.current = 0
      pendingRef.current = true
      setPhase('pending')
      void complete()
    }
    frameRef.current = requestAnimationFrame(step)
  }

  async function complete() {
    try {
      await latestRef.current.onHold()
    } finally {
      pendingRef.current = false
      if (mountedRef.current) {
        buttonRef.current?.style.setProperty('--hold-progress', '0')
        setPhase('idle')
      }
    }
  }

  function pointerDown(event: PointerEvent<HTMLButtonElement>) {
    if (event.button !== 0 || !event.isPrimary) return
    begin({ kind: 'pointer', id: event.pointerId })
    if (gestureRef.current?.kind === 'pointer' && gestureRef.current.id === event.pointerId) {
      event.currentTarget.setPointerCapture(event.pointerId)
    }
  }

  function endPointer(event: PointerEvent<HTMLButtonElement>) {
    if (gestureRef.current?.kind === 'pointer' && gestureRef.current.id === event.pointerId) cancel()
  }

  function pointerMove(event: PointerEvent<HTMLButtonElement>) {
    if (gestureRef.current?.kind !== 'pointer' || gestureRef.current.id !== event.pointerId) return
    const rect = event.currentTarget.getBoundingClientRect()
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) cancel()
  }

  function keyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'Escape') { cancel(); return }
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (!event.repeat) begin({ kind: 'key', key: event.key })
  }

  function keyUp(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key !== ' ' && event.key !== 'Enter') return
    event.preventDefault()
    if (gestureRef.current?.kind === 'key' && gestureRef.current.key === event.key) cancel()
  }

  return (
    <Button
      aria-busy={phase === 'pending'}
      aria-label="Anular ticket: mantén pulsado durante 1,5 segundos"
      className="relative isolate min-h-11 touch-none select-none overflow-hidden !gap-0 !px-4 transition-transform data-[holding=true]:scale-[0.97] motion-reduce:transform-none"
      data-holding={phase === 'holding'}
      disabled={disabled || phase === 'pending'}
      onBlur={cancel}
      onClick={(event) => event.preventDefault()}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={keyDown}
      onKeyUp={keyUp}
      onLostPointerCapture={endPointer}
      onPointerCancel={endPointer}
      onPointerDown={pointerDown}
      onPointerLeave={endPointer}
      onPointerMove={pointerMove}
      onPointerUp={endPointer}
      ref={buttonRef}
      style={{ WebkitTouchCallout: 'none' }}
      type="button"
      variant="danger"
    >
      <span aria-hidden="true" className={`pointer-events-none absolute inset-0 origin-left bg-white/25 ${phase === 'holding' ? '' : 'transition-transform duration-150'}`} style={{ transform: 'scaleX(var(--hold-progress, 0))' }} />
      <span className="pointer-events-none relative grid justify-items-center gap-0.5">
        <span className="inline-flex items-center gap-2">{children}</span>
        <span className="text-[10px] font-medium leading-none opacity-85">{phase === 'pending' ? 'Anulando…' : 'Mantén 1,5 s'}</span>
      </span>
    </Button>
  )
}
