import { useCallback, useRef } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent, forgetOfflineEvent, getOfflineQueue } from '../../../lib/offlineStore'
import { loadSessionTicketsFromSupabase } from '../../../services/posService'
import type { CashSession, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext } from '../../../types'
import { nowIso } from '../../../utils/dates'
import { getReadableError } from '../../../utils/errors'
import { voidTicketWithFiscalCancellation } from '../../fiscal/service'
import { nextPrintCopyNumber, usePrintAgentStore } from '../../local-printing'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import type { CashlogyTransaction } from '../../local-printing/types'

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
  const openHistory = useCallback(async () => {
    const { context, cashSession, isOnline } = options
    if (!context || !cashSession) return
    if (!isOnline) { options.setError('El histórico de tickets requiere conexión para consultar los datos de Supabase.'); return }
    options.setBusy(true); options.setError(null)
    try {
      await options.syncPendingEvents()
      const tickets = options.mergeRemotePrintStates(await loadSessionTicketsFromSupabase(context, cashSession.id))
      options.persistTickets(tickets)
      options.setHistoryOpen(true)
    } catch (error) { options.setError(getReadableError(error)) } finally { options.setBusy(false) }
  }, [options])

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
    await options.printTicket(ticket.payload, { isReprint: true, copyNumber: nextPrintCopyNumber(scope, ticket.id) })
  }, [options])

  const changePayment = useCallback(async (ticket: SessionTicketRecord, paymentMethod: PaymentMethod, confirmedCashlogyTransaction: CashlogyTransaction | null = null) => {
    const { context } = options
    const currentPayment = ticket.payload.payment
    if (!context || !currentPayment || ticket.status !== 'active' || ticket.paymentMethod === paymentMethod || paymentChangeLockRef.current) return
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
      const pendingSale = getOfflineQueue().find((event) =>
        event.kind === 'sale_created' && event.payload.sale.id === ticket.payload.sale.id)
      if (pendingSale) {
        forgetOfflineEvent(pendingSale.id)
        options.refreshPendingCount()
        finishCashlogyPayment(cashlogyTransaction)
        return
      }
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
        options.setError(`${getReadableError(error)} El ticket continúa pagado con tarjeta.`)
      } else if (cashlogyTransaction) {
        options.setError(`${getReadableError(error)} El cobro está confirmado en Cashlogy, pero no se pudo guardar el cambio del ticket. Revisa el histórico antes de repetir la operación.`)
      } else {
        options.setError(getReadableError(error))
      }
    } finally {
      options.setBusy(false)
      paymentChangeLockRef.current = false
    }
  }, [options])

  const voidTicket = useCallback(async (ticket: SessionTicketRecord) => {
    const { context } = options
    if (!context || ticket.status !== 'active') return
    const pendingSale = getOfflineQueue().find((event) =>
      event.kind === 'sale_created' && event.payload.sale.id === ticket.payload.sale.id)
    if (pendingSale) {
      if (!window.confirm('¿Eliminar este ticket de la sesión? Todavía no se ha enviado a Verifacti.')) return
      forgetOfflineEvent(pendingSale.id)
      options.persistTickets(options.tickets.map((item) => item.id === ticket.id ? { ...item, status: 'voided' } : item))
      options.persistLedger(options.ledger.filter((sale) => sale.id !== ticket.id))
      options.subtractProductSalesStats(ticket.payload.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, lineTotalCents: line.lineTotalCents })))
      options.refreshPendingCount()
      return
    }

    if (!options.isOnline) {
      options.setError('Necesitas conexión para anular un ticket que ya puede haberse enviado a Verifacti.')
      return
    }
    if (!window.confirm('¿Eliminar este ticket? Si tiene una factura enviada, se solicitará su anulación fiscal en Verifacti.')) return

    options.setBusy(true)
    options.setError(null)
    try {
      await voidTicketWithFiscalCancellation(context.tenantId, ticket.payload.ticket.id)
      options.persistTickets(options.tickets.map((item) => item.id === ticket.id ? { ...item, status: 'voided' } : item))
      options.persistLedger(options.ledger.filter((sale) => sale.id !== ticket.id))
      options.subtractProductSalesStats(ticket.payload.lines.map((line) => ({ productId: line.productId, quantity: line.quantity, lineTotalCents: line.lineTotalCents })))
      options.refreshPendingCount()
    } catch (error) {
      options.setError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [options])

  return { openHistory, reprint, changePayment, voidTicket }
}
