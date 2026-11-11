import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { createId } from '../../../lib/format'
import { enqueueOfflineEvent, getOfflineQueue, getSessionTickets, saveSessionTickets } from '../../../lib/offlineStore'
import { isTransportError, reportOperationError } from '../../../lib/observability.ts'
import { completePaymentChangeProjection, loadDurableEvents, loadPaymentOperations, observeRemotePaymentChanges, paymentScope } from '../../../lib/durableSales.ts'
import type { PaymentOperation } from '../../../lib/durableSales.ts'
import { loadSessionTicketPageFromSupabase } from '../../../services/posService'
import type { CashSession, PaymentMethod, SaleRecord, SessionTicketRecord, TenantContext } from '../../../types'
import { nowIso } from '../../../utils/dates'
import { getReadableError } from '../../../utils/errors'
import { prepareLocalFiscalAnnulment } from '../../fiscal/local/annulment.ts'
import { issuePosRefund } from '../../fiscal/local/refund.ts'
import { nextPrintCopyNumber } from '../../local-printing/services/printAgentStorage'
import { usePrintAgentStore } from '../../local-printing/store/usePrintAgentStore'
import { finishCashlogyPayment } from '../../local-printing/cashlogy/useCashlogyStore'
import type { CashlogyTransaction } from '../../local-printing/types'
import type { SessionTicketHistoryPage } from '../services/sessionTicketHistoryModel.ts'
import { createLocalSessionTicketHistoryPage } from '../services/sessionTicketHistoryModel.ts'
import { loadLocalSessionTickets } from '../services/localSessionTickets.ts'
import { changeTicketPayment } from '../services/paymentChange.ts'
import { assertStaffPermission, staffCan } from '../../personal/permissions'

type Options = {
  context: TenantContext | null
  cashSession: CashSession | null
  isOnline: boolean
  tickets: SessionTicketRecord[]
  ledger: SaleRecord[]
  syncPendingEvents: () => Promise<void>
  refreshPendingCount: () => void
  persistTickets: (tickets: SetStateAction<SessionTicketRecord[]>) => void
  persistLedger: (ledger: SetStateAction<SaleRecord[]>) => void
  mergeRemotePrintStates: (tickets: SessionTicketRecord[]) => SessionTicketRecord[]
  printTicket: (payload: SessionTicketRecord['payload'], options?: { isReprint?: boolean; copyNumber?: number; isManualPrint?: boolean; cashDrawerAlreadyRequested?: boolean }) => Promise<void>
  subtractProductSalesStats: (lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) => void
  setBusy: (value: boolean) => void
  setError: (value: string | null) => void
  setHistoryOpen: (value: boolean) => void
}

export function useCashTicketActions(options: Options) {
  const optionsRef = useRef(options)
  optionsRef.current = options
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
    if (!staffCan(historyContext, 'pos.sales.read')) { setHistoryError('El trabajador no tiene permiso para consultar ventas.'); return }
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
    assertStaffPermission(historyContext, 'pos.sales.read')
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
      const journal = await loadPaymentOperations(historyContext, historyCashSession.id)
      await loadDurableEvents()
      const pendingAtRead = new Set(getOfflineQueue().map(event => event.id))
      const settledAtRead = journal.filter(operation => operation.params?.paymentChange === true
        && operation.state === 'committed' && !operation.result?.paymentProjectionPending && !pendingAtRead.has(operation.eventId))
      result = await loadSessionTicketPageFromSupabase(historyContext, historyCashSession.id, page, query)
      await observeRemotePaymentChanges(settledAtRead, result.tickets.map(item => item.ticket))
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
    if (!staffCan(context, 'pos.sales.read')) { options.setError('El trabajador no tiene permiso para reimprimir ventas.'); return }
    if (!context || !(context.canManageCash || context.canCloseCashSession || ['manager', 'owner'].includes(context.role))) {
      options.setError('Tu usuario no tiene permiso para reimprimir tickets.'); return
    }
    const currentJob = usePrintAgentStore.getState().currentJob
    if (currentJob?.status === 'unknown' && currentJob.requestId?.startsWith(`print:${ticket.id}:`)
      && !window.confirm('La impresión anterior tiene estado desconocido y podría haber salido. Comprueba la impresora. ¿Quieres crear una nueva copia igualmente?')) return
    const scope = usePrintAgentStore.getState().scope
    if (!scope) { options.setError('No se ha inicializado la configuración de impresión de esta terminal.'); return }
     try {
       // An original that never reached the printer (automatic printing off, no printer configured)
       // prints as the original once, without the COPIA label and without opening the drawer.
       if (ticket.printStatus === 'not_requested') await options.printTicket(ticket.payload, { isManualPrint: true, cashDrawerAlreadyRequested: true })
       else await options.printTicket(ticket.payload, { isReprint: true, copyNumber: nextPrintCopyNumber(scope, ticket.id) })
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

  const publishPaymentChange = useCallback(async (operation: PaymentOperation) => {
    const current = optionsRef.current
    if (!current.context || !current.cashSession || paymentScope(current.context, current.cashSession.id) !== operation.scope) return
    const payload = operation.payload
    const ticket: SessionTicketRecord = { id: payload.sale.id, cashSessionId: current.cashSession.id,
      ticketNumber: payload.ticket.ticketNumber, paymentMethod: payload.sale.paymentMethod, totalCents: payload.sale.totalCents,
      createdAt: payload.sale.createdAt, status: 'active', payload }
    let projected = true
    let activeTicket = true
    const save = (work: () => void) => {
      try { work() } catch (error) {
        projected = false
        reportOperationError(error, { operation: 'cash.payment_change', saleId: payload.sale.id, step: 'secondary_cache', recoverable: true })
      }
    }
    save(() => current.persistTickets(tickets => {
      const latest = tickets.find(item => item.id === ticket.id) ?? ticket
      activeTicket = latest.status === 'active'
      const changed = { ...latest, paymentMethod: payload.sale.paymentMethod, payload: { ...latest.payload,
        sale: { ...latest.payload.sale, paymentMethod: payload.sale.paymentMethod }, payment: payload.payment, payments: payload.payments } }
      return [changed, ...tickets.filter(item => item.id !== ticket.id)]
    }))
    const sale: SaleRecord = { id: payload.sale.id, cashSessionId: current.cashSession.id, paymentMethod: payload.sale.paymentMethod,
      totalCents: payload.sale.totalCents, createdAt: payload.sale.createdAt, payments: payload.payments ?? (payload.payment ? [payload.payment] : undefined) }
    save(() => current.persistLedger(ledger => [...ledger.filter(item => item.id !== sale.id), ...(activeTicket ? [sale] : [])]))
    if (projected) await completePaymentChangeProjection(operation)
    else current.setError('El cambio de cobro está guardado. No se pudo actualizar la copia local; se recuperará desde el registro durable. No vuelvas a cobrarlo.')
    current.refreshPendingCount()
    finishCashlogyPayment(operation.cashlogy)
    void current.syncPendingEvents().catch(error => current.setError(getReadableError(error, { operation: 'cash.payment_change' })))
  }, [])

  const changePayment = useCallback(async (ticket: SessionTicketRecord, paymentMethod: PaymentMethod, confirmedCashlogyTransaction: CashlogyTransaction | null = null) => {
    const { context } = options
    if (!staffCan(context, 'pos.payment.modify')) { options.setError('El trabajador no tiene permiso para cambiar cobros.'); return }
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
    try {
      const operation = await changeTicketPayment(context, ticket, paymentMethod, confirmedCashlogyTransaction)
      await publishPaymentChange(operation)
    } catch (error) {
      options.setError(`${getReadableError(error, { operation: 'cash.payment_change' })}${requiresCashlogyConfirmation
        ? ' El ticket continúa pagado con tarjeta hasta recuperar el cambio. Si la máquina aceptó efectivo, conserva el cobro original; no vuelvas a cobrarlo.' : ''}`)
    } finally {
      options.setBusy(false)
      paymentChangeLockRef.current = false
    }
  }, [options, publishPaymentChange])

  const recoveryScope = options.context && options.cashSession ? paymentScope(options.context, options.cashSession.id) : null
  useEffect(() => {
    if (!recoveryScope || !options.context || !options.cashSession) return
    let active = true
    const { context, cashSession } = options
    void loadPaymentOperations(context, cashSession.id).then(async operations => {
      for (const operation of operations) {
        if (!active) return
        if (operation.params?.paymentChange !== true || (operation.state === 'prepared')
          || (operation.state === 'committed' && !operation.result?.paymentProjectionPending)) continue
        const method = operation.payload.sale.paymentMethod
        if (method !== 'cash' && method !== 'card') continue
        const ticket: SessionTicketRecord = { id: operation.payload.sale.id, cashSessionId: cashSession.id,
          ticketNumber: operation.payload.ticket.ticketNumber, paymentMethod: method, totalCents: operation.payload.sale.totalCents,
          createdAt: operation.payload.sale.createdAt, status: 'active', payload: operation.payload }
        const recovered = await changeTicketPayment(context, ticket, method)
        if (active) await publishPaymentChange(recovered)
      }
    }).catch(error => { if (active) optionsRef.current.setError(getReadableError(error, { operation: 'cash.payment_change', step: 'recover' })) })
    return () => { active = false }
  }, [recoveryScope, publishPaymentChange, options.context, options.cashSession])

  const refund = useCallback(async (ticket: SessionTicketRecord, lines: Array<{ lineId: string; quantity: number }>, paymentMethod: PaymentMethod) => {
    const { context, cashSession } = options
    if (!staffCan(context, 'pos.refund', 0, ticket.totalCents)) { options.setError('El trabajador no tiene permiso para esta devolución.'); return }
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
    if (!staffCan(context, 'pos.order.void', 0, ticket.totalCents)) { options.setError('El trabajador no tiene permiso para anular esta venta.'); return }
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
