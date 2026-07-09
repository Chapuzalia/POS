import { CreditCard, Trash2, X } from 'lucide-react'
import { formatMoney } from '../../lib/format'
import type { PaymentMethod, SessionTicketRecord } from '../../types'
import { Button } from '../ui'

const paymentLabels: Record<PaymentMethod, string> = {
  card: 'Tarjeta',
  cash: 'Efectivo',
  invitation: 'Invitacion',
  other: 'Otros',
}

const paymentMethods: PaymentMethod[] = ['cash', 'card', 'invitation', 'other']

type SessionTicketsModalProps = {
  isBusy: boolean
  onChangePayment: (ticket: SessionTicketRecord, paymentMethod: PaymentMethod) => void
  onClose: () => void
  onVoidTicket: (ticket: SessionTicketRecord) => void
  tickets: SessionTicketRecord[]
}

export function SessionTicketsModal({
  isBusy,
  onChangePayment,
  onClose,
  onVoidTicket,
  tickets,
}: SessionTicketsModalProps) {
  const activeTickets = tickets.filter((ticket) => ticket.status === 'active')
  const totalCents = activeTickets.reduce((total, ticket) => total + ticket.totalCents, 0)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section className="flex max-h-[calc(100svh-32px)] w-full max-w-4xl flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
          <div>
            <h2 className="text-2xl font-bold">Historico de tickets</h2>
            <p className="text-sm text-[var(--muted)]">
              {activeTickets.length} activos - {formatMoney(totalCents)}
            </p>
          </div>
          <Button disabled={isBusy} onClick={onClose} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {tickets.length ? (
            <div className="grid gap-3">
              {tickets.map((ticket, index) => (
                <article
                  className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"
                  key={ticket.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black uppercase text-[var(--muted)]">
                        Ticket {tickets.length - index}
                        {ticket.status === 'voided' ? ' - anulado' : ''}
                      </p>
                      <p className="mt-1 font-mono text-2xl font-black tabular-nums">{formatMoney(ticket.totalCents)}</p>
                      <p className="text-xs font-semibold text-[var(--muted)]">
                        {new Intl.DateTimeFormat('es-ES', {
                          day: '2-digit',
                          hour: '2-digit',
                          minute: '2-digit',
                          month: '2-digit',
                        }).format(new Date(ticket.createdAt))}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3">
                        <CreditCard className="h-4 w-4 text-[var(--muted)]" />
                        <select
                          className="bg-transparent text-sm font-semibold text-[var(--field-foreground)] outline-none"
                          disabled={isBusy || ticket.status !== 'active'}
                          onChange={(event) => onChangePayment(ticket, event.target.value as PaymentMethod)}
                          value={ticket.paymentMethod}
                        >
                          {paymentMethods.map((method) => (
                            <option key={method} value={method}>
                              {paymentLabels[method]}
                            </option>
                          ))}
                        </select>
                      </label>
                      <Button
                        disabled={isBusy || ticket.status !== 'active'}
                        onClick={() => onVoidTicket(ticket)}
                        type="button"
                        variant="danger"
                      >
                        <Trash2 className="h-4 w-4" />
                        Eliminar
                      </Button>
                    </div>
                  </div>

                  <div className="mt-3 grid gap-2">
                    {ticket.payload.lines.map((line) => (
                      <div
                        className="flex items-center justify-between gap-3 rounded-[var(--radius)] bg-[var(--surface)] px-3 py-2 text-sm"
                        key={line.id}
                      >
                        <span className="min-w-0 truncate font-semibold">
                          {line.quantity}x {line.productName}
                          {line.modifiers.length ? ` + ${line.modifiers.map((modifier) => modifier.name).join(', ')}` : ''}
                        </span>
                        <span className="shrink-0 font-mono font-bold tabular-nums">{formatMoney(line.lineTotalCents)}</span>
                      </div>
                    ))}
                  </div>
                </article>
              ))}
            </div>
          ) : (
            <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
              No hay tickets creados en esta sesion.
            </div>
          )}
        </div>
      </section>
    </div>
  )
}
