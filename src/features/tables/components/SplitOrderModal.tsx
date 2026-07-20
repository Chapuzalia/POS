import { useDeferredValue, useMemo, useState } from 'react'
import {
  Check,
  ChevronLeft,
  Minus,
  Plus,
  ReceiptEuro,
  Scissors,
  Search,
  X,
} from 'lucide-react'
import { CashPaymentModal, DiscountModal } from '../../../components/modals'
import { PaymentPanel } from '../../../components/pos'
import { calculateAppliedDiscount } from '../../../lib/discounts'
import { formatMoney, normalizeText } from '../../../lib/format'
import type { AppliedDiscount, Discount, PaymentMethod } from '../../../types'
import type {
  PayRestaurantOrderItemsResult,
  RestaurantOrderDetail,
  RestaurantOrderLineMove,
} from '../types'

type PendingPayment = {
  method: PaymentMethod | null
  receivedCents: number | null
  pendingUnits: number
  discount: AppliedDiscount | null
}

type Props = {
  defaultDiscount: AppliedDiscount | null
  discounts: Discount[]
  isBusy: boolean
  manualDiscountEnabled: boolean
  onClose: () => void
  onPay: (
    moves: RestaurantOrderLineMove[],
    method: PaymentMethod | null,
    receivedCents: number | null,
    allowPending: boolean,
    discount: AppliedDiscount | null,
  ) => Promise<PayRestaurantOrderItemsResult>
  order: RestaurantOrderDetail
  venueId: string
}

export function SplitOrderModal({
  defaultDiscount,
  discounts,
  isBusy,
  manualDiscountEnabled,
  onClose,
  onPay,
  order,
  venueId,
}: Props) {
  const [step, setStep] = useState<'select' | 'pay'>('select')
  const [quantities, setQuantities] = useState<Record<string, number>>({})
  const [searchQuery, setSearchQuery] = useState('')
  const [cashOpen, setCashOpen] = useState(false)
  const [discountOpen, setDiscountOpen] = useState(false)
  const [currentDiscount, setCurrentDiscount] = useState<AppliedDiscount | null>(defaultDiscount)
  const [paying, setPaying] = useState(false)
  const [feedback, setFeedback] = useState<PaymentMethod | null>(null)
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null)
  const [localError, setLocalError] = useState<string | null>(null)
  const deferredSearchQuery = useDeferredValue(searchQuery)

  const moves = useMemo(
    () => Object.entries(quantities)
      .filter(([, quantity]) => quantity > 0)
      .map(([lineId, quantity]) => ({ lineId, quantity })),
    [quantities],
  )

  const selectedUnits = moves.reduce((sum, move) => sum + move.quantity, 0)
  const subtotalCents = order.lines.reduce(
    (sum, line) => sum + (quantities[line.id] ?? 0) * line.unitPriceCents,
    0,
  )
  const paymentTotals = calculateAppliedDiscount(subtotalCents, currentDiscount)
  const normalizedSearchQuery = normalizeText(deferredSearchQuery.trim())

  const visibleLines = useMemo(() => {
    if (!normalizedSearchQuery) return order.lines

    return order.lines.filter((line) => normalizeText([
      line.productName,
      line.variantName,
      ...line.modifiers.map((modifier) => modifier.name),
      line.mixer?.name,
      line.note,
    ].filter(Boolean).join(' ')).includes(normalizedSearchQuery))
  }, [normalizedSearchQuery, order.lines])

  function setLineQuantity(lineId: string, maximum: number, quantity: number) {
    setQuantities((current) => ({
      ...current,
      [lineId]: Math.max(0, Math.min(maximum, quantity)),
    }))
  }

  async function completePayment(
    method: PaymentMethod | null,
    receivedCents: number | null,
    allowPending = false,
    paymentDiscount = currentDiscount,
  ) {
    if (moves.length === 0 || paying) return

    setPaying(true)
    setLocalError(null)

    try {
      const result = await onPay(
        moves,
        method,
        receivedCents,
        allowPending,
        paymentDiscount,
      )

      if (result.requiresConfirmation) {
        setPendingPayment({
          method,
          receivedCents,
          pendingUnits: result.pendingUnits,
          discount: paymentDiscount,
        })
        return
      }

      setPendingPayment(null)
      setFeedback(method)
      window.setTimeout(() => setFeedback(null), 900)
    } catch (error) {
      setLocalError(
        error instanceof Error
          ? error.message
          : 'No se pudo registrar el cobro.',
      )
    } finally {
      setPaying(false)
    }
  }

  return (
    <div className="table-modal-backdrop">
      <section
        aria-labelledby="split-order-title"
        aria-modal="true"
        className={`table-modal max-h-[calc(100svh-2.5rem)] overflow-y-auto ${
          step === 'select'
            ? '!w-[min(760px,100%)]'
            : '!w-[min(560px,100%)]'
        }`}
        role="dialog"
      >
        <header className="flex items-start justify-between gap-4">
          <div>
            <div className="mb-2 inline-flex items-center gap-2 rounded-full bg-[var(--accent-soft)] px-3 py-1 text-xs font-black uppercase tracking-wide text-[var(--accent)]">
              <Scissors size={15} />
              Por ítems
            </div>
            <h2 id="split-order-title">
              {step === 'select' ? 'Seleccionar productos' : 'Cobrar selección'}
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {order.tables.map((table) => table.name).join(' + ')}
            </p>
          </div>

          <button
            aria-label="Cerrar"
            className="table-icon-button"
            disabled={isBusy || paying}
            onClick={onClose}
            type="button"
          >
            <X size={19} />
          </button>
        </header>

        {step === 'select' ? (
          <div className="!mt-5 !block">
            <div className="flex items-end justify-between gap-3">
              <div>
                <h3 className="font-black">
                  Marca las unidades que quieras cobrar
                </h3>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  Los productos cobrados se quitarán de la comanda; la mesa seguirá abierta.
                </p>
              </div>

              {normalizedSearchQuery ? (
                <button
                  className="shrink-0 rounded-[var(--radius)] border border-[var(--separator)] px-3 py-2 text-sm font-bold"
                  disabled={isBusy || visibleLines.length === 0}
                  onClick={() => setQuantities((current) => ({
                    ...current,
                    ...Object.fromEntries(
                      visibleLines.map((line) => [line.id, line.quantity]),
                    ),
                  }))}
                  type="button"
                >
                  Seleccionar visibles
                </button>
              ) : null}
            </div>

            {order.lines.length ? (
              <label className="relative mt-4 block">
                <Search
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[var(--muted)]"
                  size={18}
                />
                <input
                  aria-label="Buscar productos de la comanda"
                  autoComplete="off"
                  className="min-h-11 w-full rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] py-2 !pl-10 pr-3 outline-none focus:border-[var(--accent)]"
                  onChange={(event) => setSearchQuery(event.target.value)}
                  placeholder="Buscar producto, modificación o nota…"
                  type="search"
                  value={searchQuery}
                />
              </label>
            ) : null}

            <div className="mt-4 grid max-h-[52svh] gap-2 overflow-y-auto pr-1">
              {visibleLines.map((line) => {
                const selected = quantities[line.id] ?? 0

                return (
                  <article
                    className={`rounded-[var(--radius)] border p-3 ${
                      selected
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                        : 'border-[var(--separator)] bg-[var(--surface)]'
                    }`}
                    key={line.id}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <strong className="block truncate">
                          {line.quantity}x · {line.productName}
                        </strong>
                        <span className="block truncate text-xs text-[var(--muted)]">
                          {[
                            line.variantName,
                            ...line.modifiers.map((modifier) => modifier.name),
                            line.mixer?.name,
                            line.note,
                          ].filter(Boolean).join(' · ')}
                        </span>
                        <span className="mt-1 block font-mono text-sm">
                          {formatMoney(line.unitPriceCents * line.quantity)}
                        </span>
                      </div>

                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          aria-label={`Restar ${line.productName}`}
                          className="grid min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)]"
                          disabled={isBusy || selected === 0}
                          onClick={() => setLineQuantity(
                            line.id,
                            line.quantity,
                            selected - 1,
                          )}
                          type="button"
                        >
                          <Minus size={16} />
                        </button>
                        <span className="w-8 text-center font-mono font-black tabular-nums">
                          {selected}
                        </span>
                        <button
                          aria-label={`Sumar ${line.productName}`}
                          className="grid min-h-10 min-w-10 place-items-center rounded-[var(--radius)] border border-[var(--separator)]"
                          disabled={isBusy || selected === line.quantity}
                          onClick={() => setLineQuantity(
                            line.id,
                            line.quantity,
                            selected + 1,
                          )}
                          type="button"
                        >
                          <Plus size={16} />
                        </button>
                      </div>
                    </div>

                    {line.servedQuantity > 0 ? (
                      <p className="mt-2 text-xs font-semibold text-[var(--success)]">
                        <Check className="mr-1 inline" size={13} />
                        {line.servedQuantity}{' '}
                        {line.servedQuantity === 1
                          ? 'unidad servida'
                          : 'unidades servidas'}
                      </p>
                    ) : null}
                  </article>
                )
              })}

              {!order.lines.length ? (
                <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-8 text-center text-[var(--muted)]">
                  La comanda no contiene productos.
                </div>
              ) : visibleLines.length === 0 ? (
                <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-8 text-center text-[var(--muted)]">
                  No hay productos que coincidan con la búsqueda.
                </div>
              ) : null}
            </div>

            <div className="mt-4 flex flex-col gap-3 border-t border-[var(--separator)] pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <span className="text-sm text-[var(--muted)]">
                  {selectedUnits}{' '}
                  {selectedUnits === 1
                    ? 'unidad seleccionada'
                    : 'unidades seleccionadas'}
                </span>
                <strong className="ml-3 font-mono text-xl">
                  {formatMoney(subtotalCents)}
                </strong>
              </div>

              <button
                className="table-action primary"
                disabled={isBusy || moves.length === 0}
                onClick={() => setStep('pay')}
                type="button"
              >
                <ReceiptEuro size={18} />
                Cobrar ítems seleccionados
              </button>
            </div>
          </div>
        ) : (
          <div className="!mt-5 !block space-y-5">
            <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <span className="text-sm text-[var(--muted)]">
                    Selección
                  </span>
                  <strong className="mt-1 block text-lg font-black">
                    {selectedUnits}{' '}
                    {selectedUnits === 1 ? 'unidad' : 'unidades'}
                  </strong>
                </div>

                <div className="text-right">
                  <span className="text-sm text-[var(--muted)]">
                    Total a cobrar
                  </span>
                  <strong className="mt-1 block text-2xl font-black text-[var(--accent)]">
                    {formatMoney(paymentTotals.totalCents)}
                  </strong>
                  {currentDiscount ? (
                    <small className="text-[var(--muted)] line-through">
                      {formatMoney(subtotalCents)}
                    </small>
                  ) : null}
                </div>
              </div>
            </div>

            <PaymentPanel
              discount={currentDiscount}
              disabled={isBusy || paying}
              feedback={feedback}
              heading="Cobrar ítems seleccionados"
              onOpenDiscount={() => setDiscountOpen(true)}
              onPayment={(method) => {
                if (method === 'cash') setCashOpen(true)
                else void completePayment(method, null)
              }}
              onRemoveDiscount={() => setCurrentDiscount(null)}
              subtotalCents={subtotalCents}
              totalCents={paymentTotals.totalCents}
            />

            {localError ? (
              <p className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-bold text-[var(--danger)]">
                {localError}
              </p>
            ) : null}

            <button
              className="table-action secondary w-full"
              disabled={isBusy || paying}
              onClick={() => setStep('select')}
              type="button"
            >
              <ChevronLeft size={18} />
              Cambiar selección
            </button>
          </div>
        )}
      </section>

      {cashOpen ? (
        <CashPaymentModal
          isBusy={paying || isBusy}
          onCancel={() => setCashOpen(false)}
          onConfirm={(receivedCents) => {
            setCashOpen(false)
            void completePayment('cash', receivedCents)
          }}
          totalCents={paymentTotals.totalCents}
        />
      ) : null}

      {discountOpen ? (
        <DiscountModal
          description="Se aplicará solo a este cobro."
          discounts={discounts}
          isBusy={paying || isBusy}
          manualDiscountEnabled={manualDiscountEnabled}
          onCancel={() => setDiscountOpen(false)}
          onSelect={(discount) => {
            setCurrentDiscount(discount)
            setDiscountOpen(false)
          }}
          subtotalCents={subtotalCents}
          venueId={venueId}
        />
      ) : null}

      {pendingPayment ? (
        <div className="table-modal-backdrop">
          <section
            aria-labelledby="split-items-pending-title"
            aria-modal="true"
            className="table-modal max-w-md"
            role="dialog"
          >
            <h2 id="split-items-pending-title">Productos pendientes</h2>
            <p>
              Hay {pendingPayment.pendingUnits}{' '}
              {pendingPayment.pendingUnits === 1
                ? 'unidad seleccionada pendiente'
                : 'unidades seleccionadas pendientes'}{' '}
              de servir.
            </p>
            <div>
              <button
                className="table-action secondary"
                onClick={() => setPendingPayment(null)}
                type="button"
              >
                Volver
              </button>
              <button
                className="table-action primary"
                onClick={() => void completePayment(
                  pendingPayment.method,
                  pendingPayment.receivedCents,
                  true,
                  pendingPayment.discount,
                )}
                type="button"
              >
                Cobrar igualmente
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  )
}