import { ChevronLeft, ChevronRight, CreditCard, LoaderCircle, Printer, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMoney, formatTicketNumber } from '../../lib/format'
import type { HistoricalPaymentMethod, PaymentMethod, SessionTicketRecord } from '../../types'
import { AppModal, Button, Input } from '../ui'
import { usePrintAgent } from '../../features/local-printing'
import {
  getVisibleTicketPages,
  SESSION_TICKETS_PAGE_SIZE,
  type SessionTicketHistoryPage,
} from '../../features/cash-registers/services/sessionTicketHistoryModel.ts'

const paymentLabels: Record<HistoricalPaymentMethod, string> = {
  card: 'Tarjeta',
  cash: 'Efectivo',
  invitation: 'Invitación',
  other: 'Otros',
}

const paymentMethods: PaymentMethod[] = ['cash', 'card']

type SessionTicketsModalProps = {
  canReprint: boolean
  initialPage: SessionTicketHistoryPage | null
  isBusy: boolean
  loadPage: (page: number, query: string) => Promise<SessionTicketHistoryPage>
  onChangePayment: (ticket: SessionTicketRecord, paymentMethod: PaymentMethod) => void | Promise<void>
  onRefund?: (ticket: SessionTicketRecord, lines: Array<{ lineId: string; quantity: number }>, paymentMethod: PaymentMethod) => void | Promise<void>
  onClose: () => void
  onReprint: (ticket: SessionTicketRecord) => void | Promise<void>
  onVoidTicket: (ticket: SessionTicketRecord) => void | Promise<void>
}

function getSessionTicketLabel(ticket: SessionTicketRecord) {
  if (ticket.payload.localFiscal) return `${ticket.payload.localFiscal.series}/${ticket.payload.localFiscal.number}`
  if (ticket.payload.fiscal?.externalCode) return ticket.payload.fiscal.externalCode
  if (ticket.payload.ticket.invoice?.series && ticket.payload.ticket.invoice.number) return `${ticket.payload.ticket.invoice.series}/${ticket.payload.ticket.invoice.number}`
  return ticket.ticketNumber ? formatTicketNumber(ticket.ticketNumber) : 'Pendiente de numeración'
}

export function SessionTicketsModal({
  canReprint,
  initialPage,
  isBusy,
  loadPage,
  onChangePayment,
  onRefund,
  onClose,
  onReprint,
  onVoidTicket,
}: SessionTicketsModalProps) {
  const { isPrintingTicket } = usePrintAgent()
  const [searchQuery, setSearchQuery] = useState('')
  const [requestedQuery, setRequestedQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageData, setPageData] = useState<SessionTicketHistoryPage | null>(() => initialPage)
  const [isLoading, setIsLoading] = useState(initialPage === null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionTicket, setActionTicket] = useState<SessionTicketRecord | null>(null)
  const [paymentChoiceTicket, setPaymentChoiceTicket] = useState<SessionTicketRecord | null>(null)
  const [refundTicket, setRefundTicket] = useState<SessionTicketRecord | null>(null)
  const [refundQuantities, setRefundQuantities] = useState<Record<string, number>>({})
  const [refundPaymentMethod, setRefundPaymentMethod] = useState<PaymentMethod>('cash')
  const requestVersion = useRef(0)
  const totalResults = pageData?.totalResults ?? 0
  const visibleTickets = pageData?.tickets ?? []
  const totalPages = Math.max(1, Math.ceil(totalResults / SESSION_TICKETS_PAGE_SIZE))
  const visiblePage = pageData?.currentPage ?? currentPage
  const visiblePages = getVisibleTicketPages(visiblePage, totalResults)
  const firstResult = totalResults ? (visiblePage - 1) * SESSION_TICKETS_PAGE_SIZE + 1 : 0
  const lastResult = Math.min(visiblePage * SESSION_TICKETS_PAGE_SIZE, totalResults)

  useEffect(() => {
    const nextQuery = searchQuery.trim()
    if (nextQuery === requestedQuery) return undefined
    const timer = window.setTimeout(() => {
      setRequestedQuery(nextQuery)
      setCurrentPage(1)
      setPageData(null)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [requestedQuery, searchQuery])

  const refreshPage = useCallback(async () => {
    const version = requestVersion.current + 1
    requestVersion.current = version
    setIsLoading(true)
    setLoadError(null)
    try {
      const result = await loadPage(currentPage, requestedQuery)
      if (requestVersion.current !== version) return
      setPageData(result)
      if (result.currentPage !== currentPage) setCurrentPage(result.currentPage)
    } catch {
      if (requestVersion.current !== version) return
      setLoadError('No se ha podido cargar el histórico de tickets.')
    } finally {
      if (requestVersion.current === version) setIsLoading(false)
    }
  }, [currentPage, loadPage, requestedQuery])

  useEffect(() => {
    void refreshPage()
    return () => { requestVersion.current += 1 }
  }, [refreshPage])

  function changePage(page: number) {
    setCurrentPage(page)
    setPageData(null)
  }

  async function changePayment(ticket: SessionTicketRecord, paymentMethod: PaymentMethod) {
    await onChangePayment(ticket, paymentMethod)
    await refreshPage()
  }

  async function voidTicket(ticket: SessionTicketRecord) {
    await onVoidTicket(ticket)
    await refreshPage()
  }

  return (
    <AppModal containerClassName="!p-4" maxWidth={768} dismissDisabled={isBusy} label="Tickets de la sesión" onClose={onClose}>
      <section className="flex max-h-[calc(100svh-32px)] w-full max-w-4xl flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
          <div>
            <h2 className="text-2xl font-bold">Histórico de tickets</h2>
            <p className="text-sm text-[var(--muted)]">
              {isLoading && !pageData ? 'Cargando…' : `${totalResults} ${requestedQuery ? 'coincidencias' : 'tickets'}`}
            </p>
          </div>
          <Button disabled={isBusy} onClick={onClose} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b border-[var(--separator)] p-5">
          <label className="flex min-h-12 items-center gap-2 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_24%,transparent)]">
            <Search aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--muted)]" />
            <Input
              aria-label="Buscar tickets"
              className="h-full min-h-full min-w-0 flex-1 border-none bg-transparent text-[var(--field-foreground)] outline-none"
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder="Buscar por ID, importe o producto…"
              type="search"
              value={searchQuery}
            />
          </label>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-5">
          {isLoading && !pageData ? (
            <div className="flex min-h-52 items-center justify-center gap-2 text-sm font-semibold text-[var(--muted)]">
              <LoaderCircle className="h-5 w-5 animate-spin" /> Cargando tickets…
            </div>
          ) : loadError && !pageData ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
              <span>{loadError}</span>
              <Button onClick={() => void refreshPage()} type="button" variant="secondary">Reintentar</Button>
            </div>
          ) : visibleTickets.length ? (
            <div className="grid gap-3">
              {visibleTickets.map(({ ticket }) => (
                <article
                  className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"
                  key={ticket.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black uppercase text-[var(--muted)]">
                         Ticket {getSessionTicketLabel(ticket)}
                         {ticket.linkedDocumentRole === 'original' ? ' · original con devolución' : ticket.linkedDocumentRole === 'refund' ? ' · devolución' : ''}
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
                      <p className="mt-1 text-xs font-bold text-[var(--muted)]">
                        Impresión: {ticket.printStatus || 'no solicitada'}{ticket.printErrorCode ? ` · ${ticket.printErrorCode}` : ''}
                      </p>
                    </div>

                    <div className="flex flex-wrap items-center justify-end gap-2">
                      <Button
                        disabled={isBusy || isPrintingTicket || !canReprint || ticket.status !== 'active' || (ticket.linkedDocumentRole === 'original' && !ticket.refundDocuments?.length)}
                        onClick={() => onReprint(ticket)}
                        type="button"
                        variant="secondary"
                      >
                        <Printer className="h-4 w-4" />
                         {ticket.refundDocuments?.length ? 'Reimprimir paquete' : 'Reimprimir'}

                      </Button>
                      {ticket.totalCents === 0 ? (
                        <span className="text-sm font-semibold text-[var(--muted)]">Pago no requerido</span>
                      ) : (
                        <Button disabled={isBusy || ticket.status !== 'active' || Boolean(ticket.linkedDocumentRole)} onClick={() => setActionTicket(ticket)} type="button" variant="secondary">
                          <CreditCard className="h-4 w-4" /> Modificar
                        </Button>
                      )}
                      <Button
disabled={isBusy || ticket.status !== 'active' || Boolean(ticket.linkedDocumentRole)}
                         onClick={() => void voidTicket(ticket)}
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
              {requestedQuery ? 'No hay tickets que coincidan con la búsqueda.' : 'No hay tickets creados en esta sesión.'}
            </div>
          )}
        </div>

        <div className="flex min-h-[68px] flex-col items-center justify-between gap-3 border-t border-[var(--separator)] px-5 py-3.5 sm:flex-row">
          <p className="m-0 text-xs font-medium text-[var(--muted)]">
            Mostrando {firstResult}-{lastResult} de {totalResults} resultados
          </p>
          <nav aria-label="Paginación de tickets" className="flex flex-wrap items-center justify-center gap-1.5">
            <Button
              aria-label="Página anterior"
              className="min-h-9 px-2.5 text-xs"
              disabled={isLoading || visiblePage === 1}
              onClick={() => changePage(visiblePage - 1)}
              size="sm"
              type="button"
              variant="tertiary"
            >
              <ChevronLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Anterior</span>
            </Button>
            {visiblePages.map((page) => (
              <Button
                active={page === visiblePage}
                aria-current={page === visiblePage ? 'page' : undefined}
                aria-label={`Página ${page}`}
                className="size-9 min-h-9 min-w-9 p-0 text-xs"
                key={page}
                disabled={isLoading}
                onClick={() => changePage(page)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                {page}
              </Button>
            ))}
            <Button
              aria-label="Página siguiente"
              className="min-h-9 px-2.5 text-xs"
              disabled={isLoading || visiblePage === totalPages}
              onClick={() => changePage(visiblePage + 1)}
              size="sm"
              type="button"
              variant="tertiary"
            >
              <span className="hidden sm:inline">Siguiente</span>
              <ChevronRight className="h-4 w-4" />
            </Button>
          </nav>
        </div>
      </section>
      {actionTicket ? (
        <AppModal label="Modificar ticket" maxWidth={420} onClose={() => setActionTicket(null)}>
          <div className="grid gap-4 p-5">
            <div>
              <h3 className="text-xl font-bold">Modificar ticket</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">Elige una acción para este ticket.</p>
            </div>
            <Button className="min-h-12 justify-start" onClick={() => { setPaymentChoiceTicket(actionTicket); setActionTicket(null) }} type="button" variant="secondary">
              <CreditCard className="h-5 w-5" /> Cambiar forma de pago
            </Button>
            <Button className="min-h-12 justify-start" onClick={() => { setRefundQuantities(Object.fromEntries(actionTicket.payload.lines.map((line) => [line.id, line.quantity]))); setRefundPaymentMethod('cash'); setPaymentChoiceTicket(null); setActionTicket(null); setRefundTicket(actionTicket) }} type="button" variant="secondary">
              Devolución
            </Button>
          </div>
        </AppModal>
      ) : null}
      {paymentChoiceTicket ? (
        <AppModal label="Cambiar forma de pago" maxWidth={420} onClose={() => setPaymentChoiceTicket(null)}>
          <div className="grid gap-4 p-5">
            <h3 className="text-xl font-bold">Cambiar forma de pago</h3>
            <div className="grid grid-cols-2 gap-3">
              {paymentMethods.map((method) => (
                <Button className="min-h-14" key={method} onClick={() => { void changePayment(paymentChoiceTicket, method); setPaymentChoiceTicket(null) }} type="button" variant={paymentChoiceTicket.paymentMethod === method ? 'primary' : 'secondary'}>
                  {paymentLabels[method]}
                </Button>
              ))}
            </div>
          </div>
        </AppModal>
      ) : null}
      {refundTicket ? (
        <AppModal label="Devolución" maxWidth={560} onClose={() => setRefundTicket(null)}>
          <div className="grid max-h-[calc(100svh-48px)] gap-4 overflow-y-auto p-5">
            <div>
              <h3 className="text-xl font-bold">Devolución</h3>
              <p className="mt-1 text-sm text-[var(--muted)]">Selecciona las cantidades que quieres devolver.</p>
            </div>
            <div className="grid gap-2">
              {refundTicket.payload.lines.map((line) => (
                <label className="flex min-h-14 items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3" key={line.id}>
                  <span className="min-w-0 truncate text-sm font-semibold">{line.productName} <span className="text-[var(--muted)]">(máx. {line.quantity})</span></span>
                  <Input aria-label={`Cantidad a devolver de ${line.productName}`} className="w-24 text-center" max={line.quantity} min={0} onChange={(event) => setRefundQuantities((current) => ({ ...current, [line.id]: Math.min(line.quantity, Math.max(0, Number(event.target.value) || 0)) }))} type="number" value={refundQuantities[line.id] ?? 0} />
                </label>
              ))}
            </div>
            <div className="grid gap-2">
              <span className="text-sm font-bold">Forma de devolución</span>
              <div className="grid grid-cols-2 gap-3">
                {paymentMethods.map((method) => (
                  <Button className="min-h-12" key={method} onClick={() => setRefundPaymentMethod(method)} type="button" variant={refundPaymentMethod === method ? 'primary' : 'secondary'}>{paymentLabels[method]}</Button>
                ))}
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setRefundTicket(null)} type="button" variant="tertiary">Cancelar</Button>
              <Button disabled={!Object.values(refundQuantities).some((quantity) => quantity > 0) || !onRefund} onClick={() => { const lines = refundTicket.payload.lines.map((line) => ({ lineId: line.id, quantity: refundQuantities[line.id] ?? 0 })).filter((line) => line.quantity > 0); if (onRefund && lines.length) void onRefund(refundTicket, lines, refundPaymentMethod); setRefundTicket(null) }} type="button">Confirmar devolución</Button>
            </div>
          </div>
        </AppModal>
      ) : null}
    </AppModal>
  )
}
