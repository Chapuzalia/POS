import { useCallback, useRef, useState } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent, getOfflineQueue, getSessionTickets, saveSessionTickets } from '../../../lib/offlineStore'
import { isTransportError } from '../../../lib/observability.ts'
import { loadSessionTicketPageFromSupabase } from '../../../services/posService'
import type { CashSession, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext } from '../../../types'
import { nowIso } from '../../../utils/dates'
import { getReadableError } from '../../../utils/errors'
import { prepareLocalFiscalAnnulment } from '../../fiscal/local/annulment.ts'
import { issuePosRefund } from '../../fiscal/local/refund.ts'
import { nextPrintCopyNumber, usePrintAgentStore } from '../../local-printing'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { CashlogyTransaction } from '../../local-printing/types'
import type { SessionTicketHistoryPage } from '../services/sessionTicketHistoryModel.ts'
import { createLocalSessionTicketHistoryPage } from '../services/sessionTicketHistoryModel.ts'
import { loadLocalSessionTickets } from '../services/localSessionTickets.ts'

type Options = {
  context: TenantContext | null
  cashSession: CashSession | null
  isOnline: boolean
  tickets: SessionTicketRecord[]
  ledger: SaleRecord[]
  syncPendingEvents: () => Promise<void>
  refreshPendingCount: () => void
  persistTickets: (tickets: SessionTicketRecord[]) => void
  persistLedger: (ledger: SaleRecord[]) => void
  mergeRemotePrintStates: (tickets: SessionTicketRecord[]) => SessionTicketRecord[]
  printTicket: (payload: SessionTicketRecord['payload'], options?: { isReprint?: boolean; copyNumber?: number }) => Promise<void>
  subtractProductSalesStats: (lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) => void
  setBusy: (value: boolean) => void
  setError: (value: string | null) => void
  setHistoryOpen: (value: boolean) => void
}

export function useCashTicketActions(options: Options) {
  const paymentChangeLockRef = useRef(false)
  const refundLockRef = useRef(false)
  const voidLockRef = useRef(false)
  const historySyncRef = useRef<Promise<void> | null>(null)
  const [historyRefreshVersion, setHistoryRefreshVersion] = useState(0)
  const historyContext = options.context
  const historyCashSession = options.cashSession
  const historyIsOnline = options.isOnline
  const historyTickets = options.tickets
  const mergeHistoryPrintStates = options.mergeRemotePrintStates
  const setHistoryError = options.setError
  const setHistoryOpen = options.setHistoryOpen
  const syncHistoryPendingEvents = options.syncPendingEvents
  const openHistory = useCallback(() => {
    if (!historyContext || !historyCashSession) return
    setHistoryError(null)
    setHistoryOpen(true)
    if (!historyIsOnline) return

    const hasPendingEvents = getOfflineQueue().some((event) => event.tenantId === historyContext.tenantId)
    if (!hasPendingEvents || historySyncRef.current) return

    const syncTask = syncHistoryPendingEvents()
      .catch((error) => {
        setHistoryError(getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' }))
      })
      .finally(() => {
        historySyncRef.current = null
        setHistoryRefreshVersion((version) => version + 1)
      })
    historySyncRef.current = syncTask
  }, [historyCashSession, historyContext, historyIsOnline, setHistoryError, setHistoryOpen, syncHistoryPendingEvents])

  const loadHistoryPage = useCallback(async (page: number, query: string): Promise<SessionTicketHistoryPage> => {
    // Changing this version intentionally invalidates the callback so an open
    // history refreshes after its background offline sync has settled.
    void historyRefreshVersion
    if (!historyContext || !historyCashSession) {
      throw new Error('No hay una sesión de caja seleccionada.')
    }
    const localPage = async () => createLocalSessionTicketHistoryPage(
      mergeHistoryPrintStates(await loadLocalSessionTickets(historyContext, historyCashSession, historyTickets)), page, query,
    )
    if (!historyIsOnline) return localPage()
    let result: SessionTicketHistoryPage
    try {
      result = await loadSessionTicketPageFromSupabase(historyContext, historyCashSession.id, page, query)
    } catch (error) {
      if (isTransportError(error)) return localPage()
      throw error
    }
    // Persist every consulted server page so it remains available after disconnecting.
    const stored = new Map(getSessionTickets(historyContext, historyCashSession.id).map(ticket => [ticket.payload.ticket.id, ticket]))
    const pendingEvents = getOfflineQueue().filter(event => event.tenantId === historyContext.tenantId)
    for (const { ticket } of result.tickets) {
      const cached = historyTickets.find(item => item.payload.ticket.id === ticket.payload.ticket.id) ?? stored.get(ticket.payload.ticket.id)
      const hasLocalChange = pendingEvents.some(event => (event.kind === 'sale_created' && event.payload.ticket.id === ticket.payload.ticket.id)
        || (event.kind === 'sale_voided' && event.payload.ticketId === ticket.payload.ticket.id)
        || (event.kind === 'sale_payment_changed' && event.payload.saleId === ticket.payload.sale.id))
      if (cached && hasLocalChange) { stored.set(ticket.payload.ticket.id, cached); continue }
      stored.set(ticket.payload.ticket.id, { ...ticket, payload: { ...ticket.payload,
        localFiscal: cached?.payload.localFiscal ?? ticket.payload.localFiscal,
        fiscal: cached?.payload.fiscal ?? ticket.payload.fiscal } })
    }
    saveSessionTickets(historyContext, historyCashSession.id, mergeHistoryPrintStates([...stored.values()]))
    if (query.trim()) {
      const mergedTickets = mergeHistoryPrintStates(result.tickets.map(({ ticket }) => ticket))
      const mergedById = new Map(mergedTickets.map((ticket) => [ticket.id, ticket]))
      return {
        ...result,
        tickets: result.tickets.map((item) => ({
          ...item,
          ticket: mergedById.get(item.ticket.id) ?? item.ticket,
        })),
      }
    }
    const remoteByTicketId = new Map(result.tickets.map((item) => [item.ticket.payload.ticket.id, item]))
    const cachedTickets = historyTickets.filter((ticket) => ticket.cashSessionId === historyCashSession.id)
    const merged = new Map<string, SessionTicketHistoryPage['tickets'][number]>()
    for (const cached of cachedTickets.filter(ticket => result.currentPage === 1 || remoteByTicketId.has(ticket.payload.ticket.id))) {
      const remote = remoteByTicketId.get(cached.payload.ticket.id)
      merged.set(cached.payload.ticket.id, {
        number: remote?.number ?? cached.ticketNumber ?? 0,
        ticket: remote ? {
          ...remote.ticket,
          payload: {
            ...remote.ticket.payload,
            localFiscal: cached.payload.localFiscal ?? remote.ticket.payload.localFiscal,
            fiscal: cached.payload.fiscal ?? remote.ticket.payload.fiscal,
          },
        } : cached,
      })
    }
    for (const remote of result.tickets) {
      if (!merged.has(remote.ticket.payload.ticket.id)) merged.set(remote.ticket.payload.ticket.id, remote)
    }
    const tickets = [...merged.values()].sort((left, right) => (
      right.ticket.createdAt.localeCompare(left.ticket.createdAt) || right.ticket.id.localeCompare(left.ticket.id)
    )).slice(0, 12)
    const mergedTickets = mergeHistoryPrintStates(tickets.map(({ ticket }) => ticket))
    const mergedById = new Map(mergedTickets.map((ticket) => [ticket.id, ticket]))
    return {
      ...result,
      totalResults: Math.max(result.totalResults, cachedTickets.length),
      tickets: tickets.map((item) => ({
        ...item,
        ticket: mergedById.get(item.ticket.id) ?? item.ticket,
      })),
    }
  }, [historyCashSession, historyContext, historyIsOnline, historyRefreshVersion, historyTickets, mergeHistoryPrintStates])

  const reprint = useCallback(async (ticket: SessionTicketRecord) => {
    const { context } = options
    if (!context || !(context.canManageCash || context.canCloseCashSession || ['manager', 'owner'].includes(context.role))) {
      options.setError('Tu usuario no tiene permiso para reimprimir tickets.'); return
    }
    const currentJob = usePrintAgentStore.getState().currentJob
    if (currentJob?.status === 'unknown' && currentJob.requestId?.startsWith(`print:${ticket.id}:`)
      && !window.confirm('La impresión anterior tiene estado desconocido y podría haber salido. Comprueba la impresora. ¿Quieres crear una nueva copia igualmente?')) return
    const scope = usePrintAgentStore.getState().scope
    if (!scope) { options.setError('No se ha inicializado la configuración de impresión de esta terminal.'); return }
     try {
       await options.printTicket(ticket.payload, { isReprint: true, copyNumber: nextPrintCopyNumber(scope, ticket.id) })
       for (const refund of [...(ticket.refundDocuments ?? [])].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || (left.payload.localFiscal?.number ?? 0) - (right.payload.localFiscal?.number ?? 0))) {
         try {
           await options.printTicket(refund.payload, { isReprint: true, copyNumber: nextPrintCopyNumber(scope, refund.id) })
         } catch (error) {
           throw new Error(`Paquete parcialmente impreso: el original se imprimió, pero no se pudo imprimir la devolución rectificativa (${getReadableError(error, { operation: 'reimpresión de paquete' })}).`)
         }
       }
     } catch (error) {
       options.setError(getReadableError(error, { operation: 'reimpresión de ticket' }))
     }
   }, [options])

  const changePayment = useCallback(async (ticket: SessionTicketRecord, paymentMethod: PaymentMethod, confirmedCashlogyTransaction: CashlogyTransaction | null = null) => {
    const { context } = options
    const currentPayment = ticket.payload.payment
    if (!context || !currentPayment || ticket.status !== 'active' || ticket.paymentMethod === paymentMethod || paymentChangeLockRef.current) return
    if (ticket.cashSessionId !== options.cashSession?.id) {
      options.setError('La forma de cobro solo puede cambiarse mientras siga abierta la caja original.')
      return
    }
    paymentChangeLockRef.current = true
    const requiresCashlogyConfirmation = ticket.paymentMethod === 'card' && paymentMethod === 'cash'
    options.setBusy(true)
    options.setError(null)
    let cashlogyTransaction: CashlogyTransaction | null = confirmedCashlogyTransaction
    let cashlogyConfirmationFinished = !requiresCashlogyConfirmation
    try {
      if (requiresCashlogyConfirmation) {
        cashlogyTransaction = confirmedCashlogyTransaction
          ?? await settleCashlogyPaymentIfConfigured(ticket.totalCents, ticket.payload.sale.id)
        if (cashlogyTransaction && (
          cashlogyTransaction.requestedAmountCents !== ticket.totalCents
          || cashlogyTransaction.saleId !== ticket.payload.sale.id
        )) {
          throw new Error('El cobro confirmado en Cashlogy no pertenece a este ticket.')
        }
        cashlogyConfirmationFinished = true
      }
      const cashlogyAmounts = getCashlogyPaymentAmounts(cashlogyTransaction, ticket.totalCents)
      const receivedCents = paymentMethod === 'cash'
        ? cashlogyAmounts.receivedCents ?? ticket.totalCents
        : null
      const changeCents = paymentMethod === 'cash' ? cashlogyAmounts.changeCents ?? 0 : 0
      const nextTickets = options.tickets.map((item) => item.id === ticket.id ? { ...item, paymentMethod, payload: { ...item.payload, sale: { ...item.payload.sale, paymentMethod }, payment: {
        ...currentPayment,
        method: paymentMethod,
        receivedCents,
        changeCents,
        cashlogyRequestId: cashlogyTransaction?.requestId ?? currentPayment.cashlogyRequestId ?? null,
        cashlogyTransactionId: cashlogyTransaction?.id ?? currentPayment.cashlogyTransactionId ?? null,
      } } } : item)
      options.persistTickets(nextTickets)
      options.persistLedger(options.ledger.map((sale) => sale.id === ticket.id ? { ...sale, paymentMethod } : sale))
      // Keep the accepted sale. Replay its creation before changing the payment.
      enqueueOfflineEvent({ id: createId(), kind: 'sale_payment_changed', tenantId: context.tenantId, createdAt: nowIso(), attempts: 0, payload: {
        saleId: ticket.payload.sale.id,
        paymentId: currentPayment.id,
        paymentMethod,
        receivedCents,
        changeCents,
        cashlogyRequestId: cashlogyTransaction?.requestId ?? currentPayment.cashlogyRequestId ?? null,
        cashlogyTransactionId: cashlogyTransaction?.id ?? currentPayment.cashlogyTransactionId ?? null,
      } })
      options.refreshPendingCount()
      if (cashlogyTransaction) {
        await options.syncPendingEvents()
        finishCashlogyPayment(cashlogyTransaction)
      } else {
        void options.syncPendingEvents()
      }
    } catch (error) {
      if (requiresCashlogyConfirmation && !cashlogyConfirmationFinished) {
        options.setError(`${getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' })} El ticket continúa pagado con tarjeta.`)
      } else if (cashlogyTransaction) {
        options.setError(`${getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' })} El cobro está confirmado en Cashlogy, pero no se pudo guardar el cambio del ticket. Revisa el histórico antes de repetir la operación.`)
      } else {
        options.setError(getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' }))
      }
    } finally {
      options.setBusy(false)
      paymentChangeLockRef.current = false
    }
  }, [options])

  const refund = useCallback(async (ticket: SessionTicketRecord, lines: Array<{ lineId: string; quantity: number }>, paymentMethod: PaymentMethod) => {
    const { context, cashSession } = options
    if (!context || !cashSession || ticket.status !== 'active' || refundLockRef.current) return
    if (!options.isOnline) { options.setError('La devolución requiere conexión para guardar conjuntamente el documento económico y fiscal.'); return }
    if (ticket.cashSessionId !== cashSession.id) { options.setError('La devolución solo puede hacerse mientras siga abierta la caja original.'); return }
    if (!ticket.payload.localFiscal) {
      options.setError('La devolución requiere una factura fiscal local original.')
      return
    }
    refundLockRef.current = true
    options.setBusy(true)
    options.setError(null)
    try {
      await issuePosRefund(context, cashSession, ticket, lines, paymentMethod)
      options.refreshPendingCount()
      setHistoryRefreshVersion((version) => version + 1)
    } catch (error) {
      options.setError(getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' }))
    } finally {
      options.setBusy(false)
      refundLockRef.current = false
    }
  }, [options])

  const voidTicket = useCallback(async (ticket: SessionTicketRecord) => {
    const { context } = options
    if (!context || !options.cashSession || ticket.status !== 'active' || voidLockRef.current) return
    const pendingSale = getOfflineQueue().find((event) =>
      event.kind === 'sale_created' && event.payload.sale.id === ticket.payload.sale.id)
    if (pendingSale) {
      options.setError('Esta venta pendiente puede haber sido entregada como factura. Consérvala y sincronízala; después solicita una rectificación o anulación fiscal según el caso.')
      return
    }

    const reason = 'Anulación solicitada desde el histórico de tickets'
    voidLockRef.current = true
    options.setBusy(true)
    options.setError(null)
    try {
      if (ticket.payload.localFiscal) {
        if (!options.isOnline) throw new Error('La anulación fiscal requiere conexión para confirmar la venta y conservar la copia durable.')
        await prepareLocalFiscalAnnulment(context, options.cashSession, ticket.payload.ticket.id, reason)
      } else {
        enqueueOfflineEvent({ id: createId(), kind: 'sale_voided', tenantId: context.tenantId, createdAt: nowIso(), attempts: 0, payload: {
          saleId: ticket.payload.sale.id, ticketId: ticket.payload.ticket.id,
        } })
        await options.syncPendingEvents()
      }
      options.persistTickets(options.tickets.map((item) => item.id === ticket.id ? { ...item, status: 'voided' } : item))
      options.persistLedger(options.ledger.filter((sale) => sale.id !== ticket.id))
      options.subtractProductSalesStats(ticket.payload.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, lineTotalCents: line.lineTotalCents })))
      options.refreshPendingCount()
    } catch (error) {
      options.setError(getReadableError(error, { operation: 'features.cash-registers.hooks.useCashTicketActions' }))
    } finally {
      options.setBusy(false)
      voidLockRef.current = false
    }
  }, [options])

  return { openHistory, loadHistoryPage, reprint, changePayment, refund, voidTicket }
}
