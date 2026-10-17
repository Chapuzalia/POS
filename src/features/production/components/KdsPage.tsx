import { Beaker, Check, CheckCheck, ListChecks, LogOut, RefreshCw, TriangleAlert, WifiOff, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '../../../components/ui'
import type { TenantContext } from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { acceptKdsBatch, acknowledgeKdsEvent, markKdsItemQuantityReady, markKdsItemReady } from '../service'
import type { KdsQueue } from '../types'
import { getKdsRemainingQuantity, getKdsUnservedQuantity, groupKdsItems, kdsColumns } from '../kds-queue'
import { useKdsQueue } from '../useKdsQueue'
import { InventoryPreparationsPanel } from '../../inventory'
import { hasTenantCapability } from '../../platform/tenantFeatureAccess'
import { formatQuantity } from '../../../lib/format'

type Props = {
  context: TenantContext
  isOnline: boolean
  onBusyChange?: (busy: boolean) => void
  onLogout: () => Promise<void>
}

function itemDetails(item: KdsQueue['items'][number]) {
  const modifiers = [
    ...(item.snapshot.lineModifiers ?? []),
    ...(item.snapshot.componentModifiers ?? []),
  ].map((modifier) => modifier.name).filter(Boolean)
  return [item.snapshot.variantName, ...modifiers].filter(Boolean).join(' · ')
}

export function KdsPage({ context, isOnline, onBusyChange, onLogout }: Props) {
  const { queue, error: queueError, refresh } = useKdsQueue(context, isOnline)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const [preparationBusy, setPreparationBusy] = useState(false)
  const [view, setView] = useState<'orders' | 'preparations'>('orders')
  const inventoryRecipesEnabled = hasTenantCapability(context, 'costing')

  useEffect(() => {
    onBusyChange?.(busyId !== null || preparationBusy)
    return () => onBusyChange?.(false)
  }, [busyId, onBusyChange, preparationBusy])

  useEffect(() => {
    if (!inventoryRecipesEnabled && view === 'preparations') setView('orders')
  }, [inventoryRecipesEnabled, view])
  const recentEvents = useMemo(() => queue.events.slice(0, 8), [queue.events])
  const batches = useMemo(() => groupKdsItems(queue.items), [queue.items])

  const runAction = async (id: string, action: () => Promise<void>) => {
    if (!isOnline || busyId) return
    setBusyId(id)
    setError(null)
    try {
      await action()
    } catch (cause) {
      setError(getReadableError(cause, { operation: 'features.production.components.KdsPage' }))
    } finally {
      await refresh()
      setBusyId(null)
    }
  }

  const markReady = (itemId: string, quantity: number, complete = false) => runAction(itemId, async () => {
    if (quantity <= 0) return
    if (complete || quantity < 1) await markKdsItemQuantityReady(context.deviceId, itemId, quantity)
    else await markKdsItemReady(context.deviceId, itemId, quantity)
  })

  const markBatchReady = (batch: typeof batches[number]) => runAction(batch.id, async () => {
    for (const item of batch.items) {
      const remaining = getKdsRemainingQuantity(item)
      if (remaining > 0 && getKdsUnservedQuantity(item) > 0) await markKdsItemQuantityReady(context.deviceId, item.id, remaining)
    }
  })

  const renderBatch = (batch: typeof batches[number]) => <article className="flex flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 shadow-[var(--shadow)]" key={batch.id}>
    <div className="flex items-start justify-between gap-2">
      <h3 className="text-sm font-black uppercase text-[var(--warning)]">{batch.tableName} · Envío #{batch.sequence}</h3>
      <time className="shrink-0 font-mono text-sm font-bold">{new Date(batch.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
    </div>
    <p className="mt-1 text-xs font-bold text-[var(--muted)]">{kdsColumns.find((column) => column.id === batch.column)?.status}</p>
    <div className="my-3 space-y-2">
      {batch.items.map((item) => {
        const remaining = getKdsRemainingQuantity(item)
        const unserved = getKdsUnservedQuantity(item)
        const ready = remaining <= 0 || unserved <= 0
        const details = itemDetails(item)
        return <section className={`rounded-lg border p-3 ${ready ? 'border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--muted)]' : 'border-[var(--separator)]'}`} key={item.id}>
          <p className="text-xs font-black uppercase tracking-wide text-[var(--muted)]">{item.snapshot.passName ?? item.passName ?? 'Directo'}</p>
          <h4 className="mt-1 text-lg font-black">{formatQuantity(unserved > 0 ? unserved : item.quantity - item.cancelledQuantity)}x {item.snapshot.productName ?? 'Producto'}</h4>
          {ready ? <p className="mt-1 flex items-center gap-1 text-sm font-bold"><CheckCheck className="h-4 w-4" /> {unserved <= 0 ? 'Servido' : 'Listo para servir'}</p> : item.readyQuantity > 0 ? <p className="mt-1 text-sm font-bold">{formatQuantity(Math.min(unserved, Math.max(0, item.readyQuantity - (item.servedQuantity ?? 0))))} listo(s) · {formatQuantity(remaining)} pendiente(s)</p> : null}
          {item.snapshot.parentProductName ? <p className="mt-2 text-sm font-semibold">Menú: {item.snapshot.parentProductName}</p> : null}
          {details ? <p className="mt-1 text-sm font-semibold">{details}</p> : null}
          {item.snapshot.note ? <p className="mt-2 rounded-lg border border-[var(--warning)] p-2 font-black">NOTA: {item.snapshot.note}</p> : null}
          {batch.column === 'preparing' && !ready ? <div className="mt-3 flex flex-wrap gap-2">
            <Button aria-label={`Marcar ${formatQuantity(Math.min(1, remaining))} de ${item.snapshot.productName ?? 'Producto'} listo`} disabled={busyId !== null || !isOnline} onClick={() => void markReady(item.id, Math.min(1, remaining))} size="lg" type="button" variant="secondary"><Check className="h-4 w-4" /> Lista {formatQuantity(Math.min(1, remaining))}</Button>
            <Button aria-label={`Marcar todo ${item.snapshot.productName ?? 'Producto'} listo`} disabled={busyId !== null || !isOnline} onClick={() => void markReady(item.id, remaining, true)} size="lg" type="button" variant="secondary"><CheckCheck className="h-4 w-4" /> Todo listo</Button>
          </div> : null}
        </section>
      })}
    </div>
    {batch.column === 'new' ? <Button disabled={busyId !== null || !isOnline} fullWidth onClick={() => void runAction(batch.id, () => acceptKdsBatch(context.deviceId, batch.items[0].batchId))} size="lg" type="button" variant="primary">Aceptar pedido</Button> : batch.column === 'preparing' ? <Button disabled={busyId !== null || !isOnline} fullWidth onClick={() => void markBatchReady(batch)} size="lg" type="button" variant="primary"><CheckCheck className="h-5 w-5" /> Envío listo</Button> : null}
  </article>

  return (
    <main className="flex h-full min-h-0 flex-col bg-[var(--background)] p-3 text-[var(--foreground)] sm:p-5">
      <header className="mb-4 flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[var(--shadow)]">
        <div>
          <p className="text-xs font-black uppercase tracking-widest text-[var(--muted)]">Producción · {context.venueName}</p>
          <h1 className="text-2xl font-black">{context.deviceName}</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {inventoryRecipesEnabled ? <Button onClick={() => setView((current) => current === 'orders' ? 'preparations' : 'orders')} size="md" type="button" variant="secondary">{view === 'orders' ? <Beaker className="h-4 w-4" /> : <ListChecks className="h-4 w-4" />} {view === 'orders' ? 'Preparaciones' : 'Comandas'}</Button> : null}
          <Button disabled={!isOnline} onClick={() => void refresh()} size="md" type="button" variant="secondary"><RefreshCw className="h-4 w-4" /> Actualizar</Button>
          <Button onClick={() => void onLogout()} size="md" type="button" variant="tertiary"><LogOut className="h-4 w-4" /> Salir</Button>
        </div>
      </header>

      {!isOnline ? <div className="mb-4 flex items-center gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[color-mix(in_srgb,var(--danger)_10%,var(--surface))] p-4 font-bold"><WifiOff className="h-5 w-5" /> El KDS necesita conexión. No se muestran datos en caché.</div> : null}
      {error || queueError ? <div className="mb-4 rounded-[var(--radius)] border border-[var(--danger)] p-4 font-semibold text-[var(--danger)]">{error ?? queueError}</div> : null}

      {inventoryRecipesEnabled && view === 'preparations' ? <div className="min-h-0 flex-1 overflow-y-auto"><InventoryPreparationsPanel context={context} isOnline={isOnline} onBusyChange={setPreparationBusy} /></div> : <>
      {recentEvents.length ? <section className="mb-4 max-h-40 shrink-0 space-y-2 overflow-y-auto">
        {recentEvents.map((event) => <article className="flex items-start gap-3 rounded-[var(--radius)] border-2 border-[var(--danger)] bg-[var(--surface)] p-3" key={event.id}>
          <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0 text-[var(--danger)]" />
          <div className="min-w-0 flex-1"><strong>{event.event_type === 'cancelled' ? 'ANULACIÓN' : 'MODIFICACIÓN'} · {formatQuantity(event.quantity)} unidad(es)</strong><p className="text-sm text-[var(--muted)]">{String(event.payload.productName ?? 'Producto')} · {new Date(event.created_at).toLocaleTimeString()}</p></div>
          <Button aria-label="Reconocer y cerrar aviso" disabled={!isOnline || busyId !== null} onClick={() => void runAction(event.id, () => acknowledgeKdsEvent(context.deviceId, event.id))} size="lg" type="button" variant="tertiary"><X className="h-5 w-5" /></Button>
        </article>)}
      </section> : null}

      <div className="min-h-0 flex-1 overflow-x-auto" aria-label="Tablero de producción">
        <div className="grid h-full min-w-[960px] grid-cols-3 gap-3">
          {kdsColumns.map((column) => {
            const orders = batches.filter((batch) => batch.column === column.id)
            return <section aria-label={column.label} className="flex min-h-0 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)]" key={column.id}>
              <header className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--separator)] p-3">
                <h2 className="font-black">{column.label}</h2><span className="rounded-full bg-[var(--surface)] px-2 py-1 text-sm font-black tabular-nums">{orders.length}</span>
              </header>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-3">
                {orders.map(renderBatch)}
                {orders.length === 0 ? <p className="py-8 text-center text-sm font-semibold text-[var(--muted)]">{column.id === 'new' ? 'Sin pedidos nuevos' : column.id === 'preparing' ? 'Sin pedidos en preparación' : 'Sin pedidos pendientes de servir'}</p> : null}
              </div>
            </section>
          })}
        </div>
      </div>
      </>}
    </main>
  )
}
