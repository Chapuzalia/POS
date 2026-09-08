import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui'
import type { CashSession, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import {
  loadRecoveredRestaurantCarryovers,
  unloadRestaurantCarryovers,
  type RestaurantCarryover,
} from '../services/carryovers'

const UNDO_WINDOW_MS = 5_000
const TIMER_RADIUS = 16
const TIMER_CIRCUMFERENCE = 2 * Math.PI * TIMER_RADIUS

export function CarryoverNotice({ context, session, isOnline, disabled, onRecovered }: {
  context: TenantContext
  session: CashSession
  isOnline: boolean
  disabled: boolean
  onRecovered: () => Promise<unknown>
}) {
  const [recovered, setRecovered] = useState<RestaurantCarryover[]>([])
  const [remainingMs, setRemainingMs] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const deadlineRef = useRef(0)

  useEffect(() => {
    let active = true
    setRecovered([])
    setRemainingMs(0)
    setError(null)
    if (!isOnline) return () => { active = false }

    void loadRecoveredRestaurantCarryovers(context, session.id)
      .then((rows) => {
        if (!active || !rows.length) return
        const deadline = Math.min(...rows.map((row) => Date.parse(row.recovery_undo_expires_at)))
        const nextRemainingMs = Math.max(0, deadline - Date.now())
        if (nextRemainingMs > 0) {
          deadlineRef.current = deadline
          setRecovered(rows)
          setRemainingMs(nextRemainingMs)
        }
      })
      .catch((cause) => {
        if (active) setError(getReadableError(cause, { operation: 'restaurant.carryovers' }))
      })

    return () => { active = false }
  }, [context, session.id, isOnline])

  useEffect(() => {
    if (!recovered.length) return undefined
    const tick = () => {
      const nextRemainingMs = Math.max(0, deadlineRef.current - Date.now())
      setRemainingMs(nextRemainingMs)
      if (nextRemainingMs === 0) setRecovered([])
    }
    const timer = window.setInterval(tick, 100)
    return () => window.clearInterval(timer)
  }, [recovered.length])

  async function unload() {
    if (busyRef.current || !isOnline || disabled || remainingMs <= 0) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      const unloaded = await unloadRestaurantCarryovers(context, session.id, recovered.map((row) => row.id))
      setRecovered([])
      setRemainingMs(0)
      if (unloaded > 0) await onRecovered()
    } catch (cause) {
      setError(getReadableError(cause, { operation: 'restaurant.carryovers' }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  if (!recovered.length) {
    return error ? <p role="alert" className="border-b border-[var(--danger)] bg-[var(--danger-soft)] px-4 py-3 text-sm font-semibold text-[var(--danger)]">{error}</p> : null
  }

  const timerProgress = Math.max(0, Math.min(1, remainingMs / UNDO_WINDOW_MS))
  const seconds = Math.max(1, Math.ceil(remainingMs / 1000))
  return <section className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--separator)] bg-[var(--surface)] px-4 py-3" aria-live="polite">
    <div>
      <p className="text-sm font-semibold">Se han cargado las mesas pendientes del turno anterior.</p>
      {error ? <p role="alert" className="mt-1 text-sm text-[var(--danger)]">{error}</p> : null}
    </div>
    <div className="flex items-center gap-3">
      <Button className="border-1" disabled={busy || disabled || !isOnline || !context.canTakeOrders || remainingMs <= 0} onClick={() => void unload()} type="button">
        {busy ? 'Deshaciendo…' : 'No cargar'}
      </Button>
      <div className="relative grid h-10 w-10 shrink-0 place-items-center" aria-label={`${seconds} segundos para deshacer`} role="timer">
        <svg aria-hidden="true" className="absolute inset-0 -rotate-90" height="40" viewBox="0 0 40 40" width="40">
          <circle className="fill-none stroke-[var(--separator)]" cx="20" cy="20" r={TIMER_RADIUS} strokeWidth="3" />
          <circle
            className="fill-none stroke-[var(--accent)] transition-[stroke-dashoffset] duration-100 ease-linear"
            cx="20"
            cy="20"
            r={TIMER_RADIUS}
            strokeDasharray={TIMER_CIRCUMFERENCE}
            strokeDashoffset={TIMER_CIRCUMFERENCE * (1 - timerProgress)}
            strokeLinecap="round"
            strokeWidth="3"
          />
        </svg>
        <span className="text-xs font-black tabular-nums">{seconds}</span>
      </div>
    </div>
  </section>
}
