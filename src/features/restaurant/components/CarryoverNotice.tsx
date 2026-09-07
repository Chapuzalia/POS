import { useEffect, useRef, useState } from 'react'
import { Button } from '../../../components/ui'
import type { CashSession, TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { supabase } from '../../../lib/supabase'
import { loadRestaurantCarryovers, recoverRestaurantCarryovers, type RestaurantCarryover } from '../services/carryovers'

export function CarryoverNotice({ context, session, isOnline, disabled, onRecovered }: {
  context: TenantContext
  session: CashSession
  isOnline: boolean
  disabled: boolean
  onRecovered: () => Promise<unknown>
}) {
  const [pending, setPending] = useState<RestaurantCarryover[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let active = true
    let version = 0
    setPending([])
    setError(null)
    const refresh = async () => {
      if (!isOnline) return
      const request = ++version
      try {
        const rows = await loadRestaurantCarryovers(context)
        if (active && request === version) {
          setPending(rows)
          setError(null)
        }
      } catch (cause) {
        if (active && request === version) setError(getReadableError(cause, { operation: 'restaurant.carryovers' }))
      }
    }
    refreshRef.current = refresh
    void refresh()
    const channel = isOnline ? supabase?.channel(`restaurant-carryovers:${context.venueId}:${session.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'orders', filter: `venue_id=eq.${context.venueId}` }, () => void refresh())
      .subscribe(() => void refresh()) : null
    const timer = window.setInterval(() => void refresh(), 18000)
    const onFocus = () => void refresh()
    window.addEventListener('focus', onFocus)
    return () => { active = false; if (channel) void supabase?.removeChannel(channel); window.clearInterval(timer); window.removeEventListener('focus', onFocus) }
  }, [context, session.id, isOnline])

  async function recover() {
    if (busyRef.current || !isOnline || disabled) return
    busyRef.current = true
    setBusy(true)
    setError(null)
    try {
      await recoverRestaurantCarryovers(context, session.id, pending.map((row) => row.id))
      await refreshRef.current()
      await onRecovered()
    } catch (cause) {
      setError(getReadableError(cause, { operation: 'restaurant.carryovers' }))
    } finally { busyRef.current = false; setBusy(false) }
  }

  if (!pending.length && !error) return null
  return <section className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--separator)] bg-[var(--surface)] px-4 py-3" aria-live="polite">
    <div>
      {pending.length ? <p className="text-sm font-semibold">Hay consumos pendientes de turnos anteriores ({pending.reduce((n, row) => n + row.order_ids.length, 0)} pedidos).</p> : null}
      {error ? <p role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
    </div>
    {pending.length ? <Button disabled={busy || disabled || !isOnline || !context.canTakeOrders} onClick={() => void recover()} type="button">{busy ? 'Recuperando…' : 'Recuperar las mesas'}</Button> : null}
  </section>
}
