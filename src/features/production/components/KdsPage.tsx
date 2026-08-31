import { Beaker, Check, CheckCheck, ListChecks, LogOut, RefreshCw, TriangleAlert, WifiOff } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button } from '../../../components/ui'
import type { TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { loadKdsQueue, markKdsItemReady, subscribeToKds } from '../service'
import type { KdsQueue } from '../types'
import { InventoryPreparationsPanel } from '../../inventory'
import { hasTenantFeature } from '../../platform/tenantFeatureAccess'

type Props = {
  context: TenantContext
  isOnline: boolean
  onLogout: () => Promise<void>
}

const emptyQueue: KdsQueue = { destinationId: '', items: [], events: [] }

function itemDetails(item: KdsQueue['items'][number]) {
  const modifiers = [
    ...(item.snapshot.lineModifiers ?? []),
    ...(item.snapshot.componentModifiers ?? []),
  ].map((modifier) => modifier.name).filter(Boolean)
  return [item.snapshot.variantName, ...modifiers].filter(Boolean).join(' · ')
}

export function KdsPage({ context, isOnline, onLogout }: Props) {
  const [queue, setQueue] = useState<KdsQueue>(emptyQueue)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [view, setView] = useState<'orders' | 'preparations'>('orders')
  const inventoryRecipesEnabled = hasTenantFeature(context, 'inventory') && hasTenantFeature(context, 'inventory_recipes')

  const refresh = useCallback(async () => {
    if (!isOnline) return
    try {
      const next = await loadKdsQueue(context.deviceId)
      setQueue(next)
      setError(null)
    } catch (cause) {
      setError(getReadableError(cause))
    }
  }, [context.deviceId, isOnline])

  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => {
    if (!inventoryRecipesEnabled && view === 'preparations') setView('orders')
  }, [inventoryRecipesEnabled, view])
  useEffect(() => {
    if (!isOnline || !context.productionDestinationId) return undefined
    return subscribeToKds(context, context.productionDestinationId, () => void refresh())
  }, [context, isOnline, refresh])

  const recentEvents = useMemo(() => queue.events.slice(0, 8), [queue.events])

  const markReady = async (itemId: string, quantity: number) => {
    if (!isOnline || quantity <= 0 || busyId) return
    setBusyId(itemId)
    setError(null)
    try {
      await markKdsItemReady(context.deviceId, itemId, quantity)
      await refresh()
    } catch (cause) {
      setError(getReadableError(cause))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <main className="min-h-screen bg-[var(--background)] p-3 text-[var(--foreground)] sm:p-5">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-[var(--muted)]">Producción · {context.venueName}</p>
          <h1 className="text-2xl font-black">{context.deviceName}</h1>
        </div>
        <div className="flex gap-2">
          {inventoryRecipesEnabled ? <Button onClick={() => setView((current) => current === 'orders' ? 'preparations' : 'orders')} size="md" type="button" variant="secondary">{view === 'orders' ? <Beaker className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />} {view === 'orders' ? 'Preparaciones' : 'Comandas'}</Button> : null}
          <Button disabled={!isOnline} onClick={() => void refresh()} size="md" type="button" variant="secondary"><RefreshCw className="h-4 w-4" /> Actualizar</Button>
          <Button onClick={() => void onLogout()} size="md" type="button" variant="tertiary"><LogOut className="h-4 w-4" /> Salir</Button>
        </div>
      </header>

      {!isOnline ? <div className="mb-4 flex items-center gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] p-4 font-bold"><WifiOff className="h-5 w-5" /> El KDS necesita conexión. No se muestran datos en caché.</div> : null}
      {error ? <div className="mb-4 rounded-[var(--radius)] border border-[var(--danger)] p-4 font-semibold text-[var(--danger)]">{error}</div> : null}

      {inventoryRecipesEnabled && view === 'preparations' ? <InventoryPreparationsPanel context={context} isOnline={isOnline} /> : <>
      {recentEvents.length ? <section className="mb-4 space-y-2">
        {recentEvents.map((event) => <article className="flex items-start gap-3 rounded-[var(--radius)] border-2 border-[var(--danger)] bg-[var(--surface)] p-3" key={event.id}>
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--danger)]" />
          <div><strong>{event.event_type === 'cancelled' ? 'ANULACIÓN' : 'MODIFICACIÓN'} · {event.quantity} unidad(es)</strong><p className="text-sm text-[var(--muted)]">{String(event.payload.productName ?? 'Producto')} · {new Date(event.created_at).toLocaleTimeString()}</p></div>
        </article>)}
      </section> : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {queue.items.map((item) => {
          const remaining = Math.max(0, item.quantity - item.readyQuantity - item.cancelledQuantity)
          const details = itemDetails(item)
          return <article className="flex min-h-64 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]" key={item.id}>
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-sm font-black uppercase text-[var(--warning)]">{item.tableName} · Envío #{item.batchSequence}</p><h2 className="mt-1 text-xl font-black">{remaining}x {item.snapshot.productName ?? 'Producto'}</h2></div>
              <time className="shrink-0 font-mono text-sm font-bold">{new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </div>
            {item.snapshot.parentProductName ? <p className="mt-2 font-semibold text-[var(--muted)]">Menú: {item.snapshot.parentProductName}</p> : null}
            {details ? <p className="mt-2 font-semibold">{details}</p> : null}
            {item.snapshot.note ? <p className="mt-3 rounded-lg border border-[var(--warning)] p-2 font-black">NOTA: {item.snapshot.note}</p> : null}
            <div className="mt-auto grid grid-cols-2 gap-2 pt-5">
              <Button disabled={busyId !== null || remaining < 1 || !isOnline} onClick={() => void markReady(item.id, 1)} size="lg" type="button" variant="secondary"><Check className="h-5 w-5" /> Lista 1</Button>
              <Button disabled={busyId !== null || remaining < 1 || !isOnline} onClick={() => void markReady(item.id, remaining)} size="lg" type="button" variant="primary"><CheckCheck className="h-5 w-5" /> Todo listo</Button>
            </div>
          </article>
        })}
      </section>
      {isOnline && queue.items.length === 0 ? <div className="flex min-h-72 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] text-center text-lg font-bold text-[var(--muted)]">No hay elaboraciones pendientes.</div> : null}
      </>}
    </main>
  )
}
