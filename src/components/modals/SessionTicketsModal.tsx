import { NativeSelect as UiNativeSelect } from '../ui/NativeSelect'
import { ChevronLeft, ChevronRight, CreditCard, LoaderCircle, Printer, Search, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { formatMoney } from '../../lib/format'
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
  isBusy: boolean
  loadPage: (page: number, query: string) => Promise<SessionTicketHistoryPage>
  onChangePayment: (ticket: SessionTicketRecord, paymentMethod: PaymentMethod) => void | Promise<void>
  onClose: () => void
  onReprint: (ticket: SessionTicketRecord) => void | Promise<void>
  onVoidTicket: (ticket: SessionTicketRecord) => void | Promise<void>
}

export function SessionTicketsModal({
  canReprint,
  isBusy,
  loadPage,
  onChangePayment,
  onClose,
  onReprint,
  onVoidTicket,
}: SessionTicketsModalProps) {
  const { isPrintingTicket } = usePrintAgent()
  const [searchQuery, setSearchQuery] = useState('')
  const [requestedQuery, setRequestedQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageData, setPageData] = useState<SessionTicketHistoryPage | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
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
      setPageData(null)
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
          ) : loadError ? (
            <div className="flex min-h-52 flex-col items-center justify-center gap-3 rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
              <span>{loadError}</span>
              <Button onClick={() => void refreshPage()} type="button" variant="secondary">Reintentar</Button>
            </div>
          ) : visibleTickets.length ? (
            <div className="grid gap-3">
              {visibleTickets.map(({ number, ticket }) => (
                <article
                  className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"
                  key={ticket.id}
                >
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-black uppercase text-[var(--muted)]">
                        Ticket {number}
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
                        disabled={isBusy || isPrintingTicket || !canReprint || ticket.status !== 'active'}
                        onClick={() => onReprint(ticket)}
                        type="button"
                        variant="secondary"
                      >
                        <Printer className="h-4 w-4" />
                        Reimprimir
                      </Button>
                      {ticket.totalCents === 0 ? (
                        <span className="text-sm font-semibold text-[var(--muted)]">Pago no requerido</span>
                      ) : (
                        <label className="flex min-h-10 items-center gap-2 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 transition-[border-color,box-shadow] focus-within:border-[var(--accent)] focus-within:shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_24%,transparent)]">
                          <CreditCard className="h-4 w-4 text-[var(--muted)]" />
                          <UiNativeSelect
                            className="bg-transparent text-sm font-semibold text-[var(--field-foreground)] !outline-none"
                            disabled={isBusy || ticket.status !== 'active'}
                            onChange={(event) => void changePayment(ticket, event.target.value as PaymentMethod)}
                            triggerClassName="!min-h-8 !border-0 !bg-transparent !px-0 !shadow-none"
                            value={ticket.paymentMethod ?? ''}
                          >
                            {ticket.paymentMethod === 'invitation' || ticket.paymentMethod === 'other' ? (
                              <option disabled value={ticket.paymentMethod}>{paymentLabels[ticket.paymentMethod]} (histórico)</option>
                            ) : null}
                            {paymentMethods.map((method) => (
                              <option key={method} value={method}>{paymentLabels[method]}</option>
                            ))}
                          </UiNativeSelect>
                        </label>
                      )}
                      <Button
                        disabled={isBusy || ticket.status !== 'active'}
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
    </AppModal>
  )
}
