import { useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Check, ChevronLeft, Minus, Plus, ReceiptEuro, Scissors, Search, X } from 'lucide-react'
import { formatMoney, normalizeText } from '../../../lib/format'
import type { RestaurantOrderGroupDetail, RestaurantOrderLineMove } from '../types'

type Props = {
  currentOrderId: string
  group: RestaurantOrderGroupDetail
  isBusy: boolean
  onClose: () => void
  onMove: (sourceOrderId: string, targetOrderId: string | null, moves: RestaurantOrderLineMove[]) => Promise<string | null>
  onOpenOrder: (orderId: string) => void
}

export function SplitOrderModal({ currentOrderId, group, isBusy, onClose, onMove, onOpenOrder }: Props) {
  const openOrders = group.orders.filter((detail) => detail.order.status === 'open')
  const [sourceOrderId, setSourceOrderId] = useState(
    openOrders.some((detail) => detail.order.id === currentOrderId) ? currentOrderId : openOrders[0]?.order.id ?? '',
  )
  const [targetOrderId, setTargetOrderId] = useState<string>('new')
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const source = group.orders.find((detail) => detail.order.id === sourceOrderId)
  const deferredSearchQuery = useDeferredValue(searchQuery)

  useEffect(() => {
    if (!openOrders.some((detail) => detail.order.id === sourceOrderId)) setSourceOrderId(openOrders[0]?.order.id ?? '')
  }, [openOrders, sourceOrderId])

  useEffect(() => {
    setQuantities({})
    setSearchQuery('')
  }, [sourceOrderId])

  useEffect(() => {
    if (targetOrderId === sourceOrderId) setTargetOrderId('new')
  }, [sourceOrderId, targetOrderId])

  const moves = useMemo(() => Object.entries(quantities)
    .filter(([, quantity]) => quantity > 0)
    .map(([lineId, quantity]) => ({ lineId, quantity })), [quantities])
  const movedTotal = source?.lines.reduce((sum, line) => sum + (quantities[line.id] ?? 0) * line.unitPriceCents, 0) ?? 0
  const target = group.orders.find((detail) => detail.order.id === targetOrderId)
  const normalizedSearchQuery = normalizeText(deferredSearchQuery.trim())
  const visibleLines = useMemo(() => {
    if (!source || !normalizedSearchQuery) return source?.lines ?? []
    return source.lines.filter((line) => normalizeText([
      line.productName,
      line.variantName,
      ...line.modifiers.map((modifier) => modifier.name),
      line.mixer?.name,
      line.note,
    ].filter(Boolean).join(' ')).includes(normalizedSearchQuery))
  }, [normalizedSearchQuery, source])

  function setLineQuantity(lineId: string, maximum: number, quantity: number) {
    setQuantities((current) => ({ ...current, [lineId]: Math.max(0, Math.min(maximum, quantity)) }))
  }

  async function submitMove(openForPayment = false) {
    if (!source || moves.length === 0) return
    const movedOrderId = await onMove(source.order.id, targetOrderId === 'new' ? null : targetOrderId, moves)
    if (!movedOrderId) return
    setQuantities({})
    if (openForPayment) onOpenOrder(movedOrderId)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4">
      <section aria-labelledby="split-order-title" aria-modal="true" className="flex h-[100svh] w-full flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)] shadow-[var(--shadow)] sm:h-auto sm:max-h-[90svh] sm:max-w-6xl sm:rounded-[var(--radius)] sm:border sm:border-[var(--separator)]" role="dialog">
        <header className="flex items-center justify-between border-b border-[var(--separator)] px-4 py-3 sm:px-5">
          <div className="flex min-w-0 items-center gap-3">
            <button aria-label="Cerrar division" className="grid min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)] sm:hidden" onClick={onClose} type="button"><ChevronLeft size={20} /></button>
            <div className="min-w-0"><h2 className="flex items-center gap-2 text-lg font-black" id="split-order-title"><Scissors size={19} />Dividir comanda</h2><p className="truncate text-sm text-[var(--muted)]">{group.tables.map((table) => table.name).join(' + ')}</p></div>
          </div>
          <button aria-label="Cerrar" className="hidden min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)] sm:grid" onClick={onClose} type="button"><X size={18} /></button>
        </header>

        <div className="grid min-h-0 flex-1 lg:grid-cols-[17rem_minmax(0,1fr)_18rem]">
          <aside className="border-b border-[var(--separator)] p-3 lg:overflow-y-auto lg:border-b-0 lg:border-r">
            <p className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--muted)]">Subcomandas</p>
            <div className="flex gap-2 overflow-x-auto pb-1 lg:grid">
              {group.orders.map((detail) => {
                const isPaid = detail.order.status === 'paid'
                const active = detail.order.id === sourceOrderId
                return <button className={`min-w-40 rounded-[var(--radius)] border p-3 text-left ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)] bg-[var(--surface)]'} ${isPaid ? 'opacity-75' : ''}`} disabled={isPaid || isBusy} key={detail.order.id} onClick={() => setSourceOrderId(detail.order.id)} type="button">
                  <span className="flex items-center justify-between gap-2"><strong>Comanda {detail.order.splitSequence}</strong>{isPaid ? <span className="rounded-full bg-[var(--success-soft)] px-2 py-0.5 text-xs font-bold text-[var(--success)]">Cobrada</span> : null}</span>
                  <span className="mt-1 block font-mono font-bold">{formatMoney(detail.totalCents)}</span>
                  <span className="text-xs text-[var(--muted)]">{detail.lines.reduce((sum, line) => sum + line.quantity, 0)} uds.</span>
                </button>
              })}
            </div>
          </aside>

          <main className="min-h-0 overflow-y-auto p-4 sm:p-5">
            <div className="mb-4">
              <div className="flex items-center justify-between gap-3">
                <div><h3 className="font-black">Comanda {source?.order.splitSequence}</h3><p className="text-sm text-[var(--muted)]">Marca las unidades que quieras cobrar.</p></div>
                {source?.lines.length ? <button className="rounded-[var(--radius)] border border-[var(--separator)] px-3 py-2 text-sm font-bold" disabled={isBusy || visibleLines.length === 0} onClick={() => setQuantities((current) => ({ ...current, ...Object.fromEntries(visibleLines.map((line) => [line.id, line.quantity])) }))} type="button">{normalizedSearchQuery ? 'Seleccionar visibles' : 'Seleccionar todo'}</button> : null}
              </div>
              {source?.lines.length ? <label className="relative mt-3 block">
                <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]" size={18} />
                <input aria-label="Buscar productos de la comanda" autoComplete="off" className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] py-2 pl-10 pr-3 outline-none focus:border-[var(--accent)]" onChange={(event) => setSearchQuery(event.target.value)} placeholder="Buscar producto, modificación o nota…" type="search" value={searchQuery} />
              </label> : null}
            </div>
            <div className="grid gap-2">
              {visibleLines.map((line) => {
                const selected = quantities[line.id] ?? 0
                return <article className={`rounded-[var(--radius)] border p-3 ${selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)] bg-[var(--surface)]'}`} key={line.id}>
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0"><strong className="block truncate">{line.quantity}x · {line.productName}</strong><span className="block truncate text-xs text-[var(--muted)]">{[line.variantName, ...line.modifiers.map((modifier) => modifier.name), line.mixer?.name, line.note].filter(Boolean).join(' · ')}</span><span className="mt-1 block font-mono text-sm">{formatMoney(line.unitPriceCents * line.quantity)}</span></div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button aria-label={`Restar ${line.productName}`} className="grid min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)]" disabled={isBusy || selected === 0} onClick={() => setLineQuantity(line.id, line.quantity, selected - 1)} type="button"><Minus size={16} /></button>
                      <span className="w-8 text-center font-mono font-black tabular-nums">{selected}</span>
                      <button aria-label={`Sumar ${line.productName}`} className="grid min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)]" disabled={isBusy || selected === line.quantity} onClick={() => setLineQuantity(line.id, line.quantity, selected + 1)} type="button"><Plus size={16} /></button>
                    </div>
                  </div>
                  {line.servedQuantity > 0 ? <p className="mt-2 text-xs font-semibold text-[var(--success)]"><Check className="mr-1 inline" size={13} />{line.servedQuantity} servidas; su estado se conserva al moverlas.</p> : null}
                </article>
              })}
              {!source?.lines.length ? <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-8 text-center text-[var(--muted)]">Esta subcomanda no contiene productos.</div> : visibleLines.length === 0 ? <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-8 text-center text-[var(--muted)]">No hay productos que coincidan con la búsqueda.</div> : null}
            </div>
          </main>

          <aside className="border-t border-[var(--separator)] bg-[var(--surface)] p-4 lg:border-l lg:border-t-0 lg:p-5">
            <h3 className="font-black">Destino</h3>
            <div className="mt-3 grid gap-2">
              <label className={`cursor-pointer rounded-[var(--radius)] border p-3 ${targetOrderId === 'new' ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)]'}`}><input checked={targetOrderId === 'new'} className="mr-2" name="split-target" onChange={() => setTargetOrderId('new')} type="radio" />Nueva comanda</label>
              {openOrders.filter((detail) => detail.order.id !== sourceOrderId).map((detail) => <label className={`cursor-pointer rounded-[var(--radius)] border p-3 ${targetOrderId === detail.order.id ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)]'}`} key={detail.order.id}><input checked={targetOrderId === detail.order.id} className="mr-2" name="split-target" onChange={() => setTargetOrderId(detail.order.id)} type="radio" />Comanda {detail.order.splitSequence}<span className="block pl-5 text-xs text-[var(--muted)]">{formatMoney(detail.totalCents)}</span></label>)}
            </div>
            <div className="mt-4 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)] p-3 text-sm">
              <span className="flex justify-between"><span>Seleccionado</span><strong className="font-mono">{formatMoney(movedTotal)}</strong></span>
              <span className="mt-1 flex justify-between text-[var(--muted)]"><span>Total destino</span><strong className="font-mono">{formatMoney((target?.totalCents ?? 0) + movedTotal)}</strong></span>
            </div>
            <div className={`mt-3 grid gap-2 ${targetOrderId === 'new' ? 'grid-cols-2' : 'grid-cols-1'}`}>
              <button className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] px-3 text-sm font-black text-[var(--accent)] disabled:opacity-50" disabled={isBusy || moves.length === 0} onClick={() => void submitMove()} type="button"><Scissors size={17} />{isBusy ? 'Moviendo…' : targetOrderId === 'new' ? 'Crear y mover' : 'Mover productos'}</button>
              {targetOrderId === 'new' ? <button className="inline-flex min-h-12 items-center justify-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-3 text-sm font-black text-[var(--accent-contrast)] disabled:opacity-50" disabled={isBusy || moves.length === 0} onClick={() => void submitMove(true)} type="button"><ReceiptEuro size={17} />Cobrar selección</button> : null}
            </div>
            <div className="mt-4 grid gap-2 border-t border-[var(--separator)] pt-4">
              {openOrders.map((detail) => <button className="inline-flex min-h-11 items-center justify-between rounded-[var(--radius)] border border-[var(--separator)] px-3 font-bold" key={detail.order.id} onClick={() => onOpenOrder(detail.order.id)} type="button"><span>Comanda {detail.order.splitSequence}</span><span className="flex items-center gap-1"><ReceiptEuro size={16} />Cobrar</span></button>)}
            </div>
          </aside>
        </div>
      </section>
    </div>
  )
}
