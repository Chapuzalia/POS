import { Check, CheckCheck, Minus, Pencil, Plus, Trash2 } from 'lucide-react'
import { formatMoney } from '../../../lib/format'
import { getLineAdditionNames } from '../../../lib/mixers'
import type { LineDiscountAllocation } from '../../../lib/discounts'
import { Button } from '../../../components/ui'
import { canDecreaseLineQuantity, getOrderPendingUnits, getPendingQuantity } from '../service-status'
import type { RestaurantOrderDetail, RestaurantOrderLine } from '../types'
import { MenuComponentDetails } from '../../../components/pos/MenuComponentDetails'
import { InvoiceTicketNotice } from '../../../components/pos/InvoiceTicketNotice'
import { ProductionControls } from '../../production/components/ProductionControls'
import type { OrderProductionState, ProductionSelection } from '../../production/types'

type Props = {
  isBusy: boolean
  lineDiscounts: Record<string, LineDiscountAllocation>
  order: RestaurantOrderDetail
  invoiceCustomerName?: string | null
  onChangeInvoiceCustomer?: () => void
  onDecrement: (lineId: string) => void
  onEdit: (line: RestaurantOrderLine) => void
  onIncrement: (lineId: string) => void
  onRemove: (lineId: string) => void
  onRemoveInvoiceCustomer?: () => void
  onServeAll: (lineId: string) => void
  onServeAllOrder: () => void
  onServeOne: (lineId: string) => void
  productionState?: OrderProductionState | null
  onSendToProduction?: (selection?: ProductionSelection[]) => void
}

function OrderLineRow({ discount, isBusy, line, onDecrement, onEdit, onIncrement, onRemove, onServeAll, onServeOne, productionState }: Omit<Props, 'order' | 'onServeAllOrder' | 'lineDiscounts' | 'onSendToProduction'> & { discount?: LineDiscountAllocation; line: RestaurantOrderLine }) {
  const pending = getPendingQuantity(line)
  const production = productionState?.lines.find((state) => state.lineId === line.id)
  const additionNames = getLineAdditionNames(line.modifiers, line.mixer)
  return (
    <article className={`rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 ${pending === 0 ? 'opacity-65' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate font-bold">{line.quantity}x - {line.productName}</p>
          {additionNames.length ? <p className="text-sm text-[var(--muted)]">+ {additionNames.join(', ')}</p> : null}
          <MenuComponentDetails compact components={line.components} />
          <p className="mt-1 text-sm font-semibold text-[var(--muted)]">
            {pending === 0 ? 'Todo servido' : `${line.servedQuantity} servidas - ${pending} ${pending === 1 ? 'pendiente' : 'pendientes'}`}
          </p>
          {productionState?.effective ? <p className="mt-1 text-xs font-black uppercase tracking-wide text-[var(--muted)]">Producción: {production?.unsentQuantity ?? line.quantity} sin enviar · {production?.readyQuantity ?? 0} listo(s)</p> : null}
          {discount && discount.discountAmountCents > 0 ? <p className="mt-1 flex flex-wrap items-baseline gap-2 font-mono text-sm">
            <span className="text-[var(--muted)] line-through">{formatMoney(discount.grossCents)}</span>
            <strong className="text-[var(--success)]">{formatMoney(discount.netCents)}</strong>
            <span className="text-xs font-semibold text-[var(--success)]">−{formatMoney(discount.discountAmountCents)}</span>
          </p> : <p className="mt-1 font-mono text-sm">{formatMoney(line.unitPriceCents * line.quantity)}</p>}
        </div>
        <div className="flex items-center gap-1">
          {line.components.some((component) => component.type === 'menu_component') ? <Button aria-label="Editar selección del menú" disabled={isBusy} onClick={() => onEdit(line)} size="sm" title="Editar selección" type="button" variant="tertiary"><Pencil className="h-4 w-4" /></Button> : null}
          <Button aria-label="Reducir cantidad" disabled={isBusy || !canDecreaseLineQuantity(line)} onClick={() => onDecrement(line.id)} size="sm" type="button" variant="tertiary"><Minus className="h-4 w-4" /></Button>
          <span className="w-7 text-center font-mono font-bold">{line.quantity}</span>
          <Button aria-label="Aumentar cantidad" disabled={isBusy} onClick={() => onIncrement(line.id)} size="sm" type="button" variant="tertiary"><Plus className="h-4 w-4" /></Button>
          <Button aria-label="Eliminar línea" disabled={isBusy} onClick={() => onRemove(line.id)} size="sm" title="Eliminar línea" type="button" variant="tertiary"><Trash2 className="h-4 w-4" /></Button>
        </div>
      </div>
      {pending > 0 ? <div className="mt-3 grid grid-cols-2 gap-2">
        <Button disabled={isBusy} onClick={() => onServeOne(line.id)} size="md" type="button" variant="secondary"><Check className="h-4 w-4" /> Servir 1</Button>
        <Button disabled={isBusy} onClick={() => onServeAll(line.id)} size="md" type="button" variant="primary"><CheckCheck className="h-4 w-4" /> Servir todas</Button>
      </div> : null}
    </article>
  )
}

export function RestaurantOrderPanel(props: Props) {
  const {
    invoiceCustomerName,
    isBusy,
    lineDiscounts,
    onChangeInvoiceCustomer,
    onRemoveInvoiceCustomer,
    order,
    onServeAllOrder,
    onSendToProduction,
    productionState,
    ...lineProps
  } = props
  const pendingLines = order.lines.filter((line) => getPendingQuantity(line) > 0)
  const servedLines = order.lines.filter((line) => getPendingQuantity(line) === 0)
  const newLines = productionState?.effective ? pendingLines.filter((line) => {
    const state = productionState.lines.find((entry) => entry.lineId === line.id)
    return !state || state.sentQuantity === 0
  }) : []
  const readyLines = productionState?.effective ? pendingLines.filter((line) => (productionState.lines.find((entry) => entry.lineId === line.id)?.readyQuantity ?? 0) > 0) : []
  const sentLines = productionState?.effective ? pendingLines.filter((line) => {
    const state = productionState.lines.find((entry) => entry.lineId === line.id)
    return Boolean(state && state.sentQuantity > 0 && state.readyQuantity === 0)
  }) : []
  const pendingUnits = getOrderPendingUnits(order.lines)
  return (
    <section className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
      {invoiceCustomerName && onChangeInvoiceCustomer && onRemoveInvoiceCustomer ? <InvoiceTicketNotice customerName={invoiceCustomerName} disabled={isBusy} onChange={onChangeInvoiceCustomer} onRemove={onRemoveInvoiceCustomer} /> : null}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-3">
        {order.lines.length === 0 ? <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">Pulsa un producto para añadirlo a la comanda.</div> : null}
        {!productionState?.effective && pendingLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--warning)]">Por servir</h2><div className="space-y-2">{pendingLines.map((line) => <OrderLineRow {...lineProps} discount={lineDiscounts[line.id]} isBusy={isBusy} key={line.id} line={line} productionState={productionState} />)}</div></section> : null}
        {productionState?.effective && newLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--warning)]">Nuevos · {newLines.length}</h2><div className="space-y-2">{newLines.map((line) => <OrderLineRow {...lineProps} discount={lineDiscounts[line.id]} isBusy={isBusy} key={line.id} line={line} productionState={productionState} />)}</div></section> : null}
        {productionState?.effective && readyLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--success)]">Listos · {readyLines.length}</h2><div className="space-y-2">{readyLines.map((line) => <OrderLineRow {...lineProps} discount={lineDiscounts[line.id]} isBusy={isBusy} key={line.id} line={line} productionState={productionState} />)}</div></section> : null}
        {productionState?.effective && sentLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--muted)]">Enviados · {sentLines.length}</h2><div className="space-y-2">{sentLines.map((line) => <OrderLineRow {...lineProps} discount={lineDiscounts[line.id]} isBusy={isBusy} key={line.id} line={line} productionState={productionState} />)}</div></section> : null}
        {servedLines.length ? <section><h2 className="mb-2 text-xs font-black uppercase tracking-wide text-[var(--success)]">Servido</h2><div className="space-y-2">{servedLines.map((line) => <OrderLineRow {...lineProps} discount={lineDiscounts[line.id]} isBusy={isBusy} key={line.id} line={line} productionState={productionState} />)}</div></section> : null}
      </div>
      <div className="space-y-3 border-t border-[var(--separator)] p-4">
        {productionState?.warnings.map((warning, index) => <p className="rounded-lg border border-[var(--danger)] p-2 text-sm font-bold text-[var(--danger)]" key={`${warning.destinationId}:${warning.status}:${index}`}>Impresión de producción {warning.status === 'unknown' ? 'sin confirmar' : 'fallida'}: {warning.message}</p>)}
        {productionState && onSendToProduction ? <ProductionControls disabled={isBusy} onSend={onSendToProduction} order={order} state={productionState} /> : null}
        {pendingUnits > 0 ? <Button disabled={isBusy} fullWidth onClick={onServeAllOrder} size="lg" type="button" variant="primary"><CheckCheck className="h-5 w-5" /> Marcar {pendingUnits} {pendingUnits === 1 ? 'producto' : 'productos'} como servidos</Button> : order.lines.length ? <p className="text-center font-bold text-[var(--success)]">Todo servido OK</p> : null}
      </div>
    </section>
  )
}
