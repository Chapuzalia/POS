import { Input as UiInput } from '../../../components/ui/Input'
import { Button as UiButton } from '../../../components/ui/Button'
import { AppModal } from '../../../components/ui/AppModal'
import { ProgressBar } from '@heroui/react'
import { useEffect, useRef, useState } from 'react'
import { Check, Minus, Plus, UsersRound, X } from 'lucide-react'
import { CashPaymentModal, DiscountModal } from '../../../components/modals'
import { PaymentPanel } from '../../../components/pos'
import { usePrintAgentStore } from '../../local-printing'
import { calculateAppliedDiscount, calculateDiscountForLines, type DiscountScheduleContext } from '../../../lib/discounts'
import { formatMoney } from '../../../lib/format'
import type { AppliedDiscount, Discount, PaymentMethod } from '../../../types'
import type { PayRestaurantEqualPartResult, RestaurantEqualSplit, RestaurantOrderDetail } from '../types'

type PendingPayment = { method: PaymentMethod | null; receivedCents: number | null; pendingUnits: number; discount: AppliedDiscount | null; useDefaultDiscount: boolean }

type Props = {
  isBusy: boolean
  discounts: Discount[]
  defaultDiscount: AppliedDiscount | null
  discountSchedule: Omit<DiscountScheduleContext, 'now'>
  validatePin: (discountId: string, pin: string) => Promise<boolean>
  validateManualPin: (venueId: string, pin: string) => Promise<boolean>
  manualDiscountEnabled: boolean
  manualDiscountRequiresPin: boolean
  order: RestaurantOrderDetail
  split: RestaurantEqualSplit | null
  onClose: () => void
  onConfigure: (partCount: number) => Promise<RestaurantEqualSplit>
  onPay: (method: PaymentMethod | null, receivedCents: number | null, allowPending: boolean, discount: AppliedDiscount | null, useDefaultDiscount: boolean) => Promise<PayRestaurantEqualPartResult>
  onCompleted: () => void
  venueId: string
}

export function EqualSplitOrderModal({ defaultDiscount, discounts, discountSchedule, isBusy, manualDiscountEnabled, manualDiscountRequiresPin, onClose, onCompleted, onConfigure, onPay, order, split, validateManualPin, validatePin, venueId }: Props) {
  const cashlogyConfigured = usePrintAgentStore((state) => state.cashlogyConfigured)
  const [partCount, setPartCount] = useState(Math.max(2, order.order.guestCount))
  const [cashOpen, setCashOpen] = useState(false)
  const [paying, setPaying] = useState(false)
  const [feedback, setFeedback] = useState<PaymentMethod | null>(null)
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [currentDiscount, setCurrentDiscount] = useState<AppliedDiscount | null>(null)
  const [useDefaultDiscount, setUseDefaultDiscount] = useState(true)
  const initializedPartKeyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!split) return
    const partKey = `${split.id}:${split.paidParts}`
    if (initializedPartKeyRef.current === partKey) return
    initializedPartKeyRef.current = partKey
    setPartCount(split.partCount)
    setCurrentDiscount(split.nextDefaultDiscount)
    setUseDefaultDiscount(true)
  }, [split])

  const totalCents = split?.totalCents ?? order.totalCents
  const nextPartCents = split?.nextPartCents ?? Math.floor(totalCents / partCount) + (totalCents % partCount > 0 ? 1 : 0)
  const setupDiscount = calculateDiscountForLines(
    order.lines.map((line) => ({ productId: line.productId ?? '', variantId: line.variantId ?? '', grossCents: line.quantity * line.unitPriceCents, quantity: line.quantity })),
    defaultDiscount,
  )
  const inheritedSetupDiscountAmount = Math.floor(setupDiscount.discountAmountCents / partCount) + (setupDiscount.discountAmountCents % partCount > 0 ? 1 : 0)
  const setupTotal = setupDiscount.totalCents
  const setupPartTotal = nextPartCents - inheritedSetupDiscountAmount
  const nextPayment = useDefaultDiscount && currentDiscount
    ? { discountAmountCents: split?.nextDefaultDiscountAmountCents ?? 0, totalCents: split?.nextDefaultTotalCents ?? nextPartCents }
    : calculateAppliedDiscount(nextPartCents, currentDiscount)

  const completePart = async (method: PaymentMethod | null, receivedCents: number | null, allowPending = false, paymentDiscount = currentDiscount, inheritDefault = useDefaultDiscount) => {
    if (!split || paying) return
    setPaying(true)
    setLocalError(null)
    try {
      const result = await onPay(method, receivedCents, allowPending, paymentDiscount, inheritDefault)
      if (result.requiresConfirmation) {
        setPendingPayment({ method, receivedCents, pendingUnits: result.pendingUnits, discount: paymentDiscount, useDefaultDiscount: inheritDefault })
        return
      }
      setPendingPayment(null)
      setFeedback(method)
      window.setTimeout(() => setFeedback(null), 900)
      if (result.completed) onCompleted()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo registrar el cobro.')
    } finally {
      setPaying(false)
    }
  }

  const startSplit = async () => {
    setPaying(true)
    setLocalError(null)
    try {
      await onConfigure(partCount)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'No se pudo iniciar la división.')
    } finally {
      setPaying(false)
    }
  }

  return <AppModal containerClassName="!p-0 sm:!p-4" maxWidth={560} dismissDisabled={isBusy || paying} label="Dividir comanda a partes iguales" onClose={onClose}>
    <section className="w-full max-w-[440px] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-[var(--shadow)] [&_h2]:mb-2 [&_h2]:mt-0 [&_p]:mb-[18px] [&_p]:mt-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-[7px] [&_label]:font-extrabold [&_input]:min-h-12 [&_input]:rounded-[var(--radius)] [&_input]:border [&_input]:border-[var(--field-border)] [&_input]:bg-[var(--field)] [&_input]:px-3 [&_input]:text-lg [&_input]:text-[var(--field-foreground)] [&>div]:mt-[22px] [&>div]:flex [&>div]:justify-end [&>div]:gap-2.5 !w-full">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-black uppercase tracking-wide text-[var(--accent)]"><UsersRound size={15} /> A partes iguales</div>
          <h2 id="equal-split-title">Dividir comanda</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{order.tables.map((table) => table.name).join(' + ')}</p>
        </div>
        <UiButton aria-label="Cerrar" className="grid size-11 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] disabled:opacity-45" disabled={isBusy || paying} onClick={onClose} type="button"><X size={19} /></UiButton>
      </header>

      {!split ? <div className="!mt-6 !block space-y-5">
        <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-center">
          <label className="text-sm font-bold text-[var(--muted)]" htmlFor="equal-split-count">Número de comensales</label>
          <div className="mx-auto mt-3 flex max-w-xs items-center justify-center gap-3">
            <UiButton aria-label="Quitar comensal" className="grid size-11 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] disabled:opacity-45 min-h-12 min-w-12" disabled={partCount <= 2} onClick={() => setPartCount((count) => Math.max(2, count - 1))} type="button"><Minus /></UiButton>
            <UiInput className="h-14 w-24 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] text-center text-2xl font-black" id="equal-split-count" max={99} min={2} onChange={(event) => setPartCount(Math.max(2, Math.min(99, Number(event.target.value) || 2)))} type="number" value={partCount} />
            <UiButton aria-label="Añadir comensal" className="grid size-11 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] disabled:opacity-45 min-h-12 min-w-12" disabled={partCount >= 99} onClick={() => setPartCount((count) => Math.min(99, count + 1))} type="button"><Plus /></UiButton>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-[var(--radius)] border border-[var(--separator)] p-4"><span className="text-sm text-[var(--muted)]">{defaultDiscount ? 'Total con descuento' : 'Total comanda'}</span><strong className="mt-1 block text-xl font-black">{formatMoney(setupTotal)}</strong>{defaultDiscount ? <small className="text-[var(--muted)] line-through">{formatMoney(totalCents)}</small> : null}</div>
          <div className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] p-4"><span className="text-sm text-[var(--muted)]">Por comensal</span><strong className="mt-1 block text-xl font-black text-[var(--accent)]">{formatMoney(setupPartTotal)}</strong>{defaultDiscount ? <small className="text-[var(--muted)]">Descuento heredado</small> : null}</div>
        </div>
        <p className="text-center text-xs text-[var(--muted)]">Si no divide exacto, los céntimos se ajustan automáticamente entre los cobros.</p>
        {localError ? <p className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-bold text-[var(--danger)]">{localError}</p> : null}
        <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45 w-full" disabled={isBusy || paying} onClick={() => void startSplit()} type="button"><Check size={18} /> Empezar a cobrar</UiButton>
      </div> : <div className="!mt-6 !block space-y-5">
        <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5">
          <div className="flex items-end justify-between gap-4">
            <div><span className="text-sm font-bold text-[var(--muted)]">Han pagado</span><div className="mt-1 text-4xl font-black tabular-nums"><span className="text-[var(--accent)]">{split.paidParts}</span><span className="text-[var(--muted)]">/{split.partCount}</span></div></div>
            <div className="text-right"><span className="text-sm text-[var(--muted)]">Queda por cobrar</span><strong className="mt-1 block text-xl font-black">{formatMoney(split.remainingCents)}</strong></div>
          </div>
          <ProgressBar aria-label={`${split.paidParts} de ${split.partCount} pagados`} className="mt-4" maxValue={split.partCount} value={split.paidParts}><ProgressBar.Track className="h-2.5 bg-[var(--separator)]"><ProgressBar.Fill className="bg-[var(--accent)]" /></ProgressBar.Track></ProgressBar>
          <p className="mt-3 text-sm font-semibold text-[var(--muted)]">{split.remainingParts === 1 ? 'Último cobro' : `Quedan ${split.remainingParts} personas`}</p>
        </div>
        {useDefaultDiscount && currentDiscount ? <p className="rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent-soft)] px-3 py-2 text-sm font-semibold text-[var(--foreground)]">Este pago hereda el descuento de la comanda. Puedes cambiarlo o quitarlo solo para esta parte.</p> : null}
        <PaymentPanel discount={currentDiscount} disabled={isBusy || paying} feedback={feedback} heading="Cobrar siguiente parte" onOpenDiscount={() => setDiscountOpen(true)} onPayment={(method) => { if (method === 'cash' && cashlogyConfigured) void completePart('cash', null); else if (method === 'cash') setCashOpen(true); else void completePart(method, null) }} onRemoveDiscount={() => { setCurrentDiscount(null); setUseDefaultDiscount(false) }} subtotalCents={split.nextPartCents} totalCents={nextPayment.totalCents} />
        {localError ? <p className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-bold text-[var(--danger)]">{localError}</p> : null}
        {paying ? <p className="text-center text-sm font-bold text-[var(--muted)]">Registrando cobro…</p> : null}
      </div>}
    </section>

    {cashOpen && split ? <CashPaymentModal isBusy={paying || isBusy} onCancel={() => setCashOpen(false)} onConfirm={(receivedCents) => { setCashOpen(false); void completePart('cash', receivedCents) }} totalCents={nextPayment.totalCents} /> : null}

    {discountOpen && split ? <DiscountModal description="Se aplicará solo al siguiente pago." discounts={discounts} isBusy={paying || isBusy} manualDiscountEnabled={manualDiscountEnabled} manualDiscountRequiresPin={manualDiscountRequiresPin} onCancel={() => setDiscountOpen(false)} onSelect={(discount) => { setCurrentDiscount(discount); setUseDefaultDiscount(false); setDiscountOpen(false) }} schedule={discountSchedule} subtotalCents={split.nextPartCents} validateManualPin={validateManualPin} validatePin={validatePin} venueId={venueId} /> : null}

    {pendingPayment ? <AppModal containerClassName="!p-4" maxWidth={448} dismissDisabled={isBusy || paying} label="Productos pendientes" onClose={() => setPendingPayment(null)}>
      <section className="w-full max-w-[440px] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-[var(--shadow)] [&_h2]:mb-2 [&_h2]:mt-0 [&_p]:mb-[18px] [&_p]:mt-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-[7px] [&_label]:font-extrabold [&_input]:min-h-12 [&_input]:rounded-[var(--radius)] [&_input]:border [&_input]:border-[var(--field-border)] [&_input]:bg-[var(--field)] [&_input]:px-3 [&_input]:text-lg [&_input]:text-[var(--field-foreground)] [&>div]:mt-[22px] [&>div]:flex [&>div]:justify-end [&>div]:gap-2.5">
        <h2 id="equal-split-pending-title">Productos pendientes</h2>
        <p>Quedan {pendingPayment.pendingUnits} {pendingPayment.pendingUnits === 1 ? 'producto pendiente' : 'productos pendientes'} de servir.</p>
        <div><UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45" onClick={() => setPendingPayment(null)} type="button">Volver</UiButton><UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45" onClick={() => void completePart(pendingPayment.method, pendingPayment.receivedCents, true, pendingPayment.discount, pendingPayment.useDefaultDiscount)} type="button">Cobrar igualmente</UiButton></div>
      </section>
    </AppModal> : null}
  </AppModal>
}
