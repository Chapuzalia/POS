import { useCallback, useMemo, useRef, useState, type SetStateAction } from 'react'
import { sileo } from 'sileo'
import {
  clearSaleLedger,
  clearSessionTickets,
  getSessionTickets,
  saveCachedCashSession,
  saveSaleLedger,
  saveSessionTickets,
} from '../../../lib/offlineStore'
import {
  loadSalesLedgerFromSupabase,
  loadSessionTicketsFromSupabase,
  summarizeSales,
} from '../../../services/posService'
import type {
  CashClosedPayload,
  CashClosingRecord,
  CashSession,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
} from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { usePrintAgentScope } from '../../local-printing/hooks/usePrintAgentScope'
import { cashClosingRequestId } from '../../local-printing/services/cashClosingPrintMapper'
import { printCashClosing } from '../../local-printing/services/printCashClosing'
import { usePrintAgentStore } from '../../local-printing/store/usePrintAgentStore'
import {
  mergeRemoteTicketPrintStates,
  printTicket,
} from '../../local-printing/services/printTicket'
import {
  closeCashSession as closeCashSessionLifecycle,
  joinCashSession as joinCashSessionLifecycle,
  openCashSession as openCashSessionLifecycle,
} from '../services/cashSessionLifecycle'
import { useActiveCashSession } from './useActiveCashSession'
import { useCashRegisterOptions } from './useCashRegisterOptions'
import { useCashTicketActions } from './useCashTicketActions'
import { getClosedCashState } from '../services/cashState'
import { loadCashClosing, loadCashClosingHistory, recordCashClosingPrintResult } from '../service'

type Options = {
  context: TenantContext | null
  isOnline: boolean
  onError: (message: string | null) => void
  refreshPendingCount: () => void
  setBusy: (busy: boolean) => void
  subtractProductSalesStats: (lines: Array<{ productId: string; quantity: number; lineTotalCents: number }>) => void
  syncPendingEvents: () => Promise<void>
}

export function useCashSession(options: Options) {
  const [session, setSession] = useState<CashSession | null>(null)
  const [ledger, setLedger] = useState<SaleRecord[]>([])
  const [tickets, setTicketsState] = useState<SessionTicketRecord[]>([])
  const ticketsRef = useRef<SessionTicketRecord[]>([])
  const [closeModalOpen, setCloseModalOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [closingHistoryOpen, setClosingHistoryOpen] = useState(false)
  const [cashClosings, setCashClosings] = useState<CashClosingRecord[]>([])
  const [completedClosing, setCompletedClosing] = useState<CashClosingRecord | null>(null)
  const [printingClosingId, setPrintingClosingId] = useState<string | null>(null)
  usePrintAgentScope(options.context)

  const setTickets = useCallback((value: SetStateAction<SessionTicketRecord[]>) => {
    const next = typeof value === 'function' ? value(ticketsRef.current) : value
    ticketsRef.current = next
    setTicketsState(next)
  }, [])

  const persistSession = useCallback((nextSession: CashSession | null) => {
    setSession(nextSession)
    if (options.context) saveCachedCashSession(options.context, nextSession)
  }, [options.context])

  const persistLedger = useCallback((nextLedger: SaleRecord[]) => {
    setLedger(nextLedger)
    if (options.context) saveSaleLedger(options.context, nextLedger)
  }, [options.context])

  const persistTickets = useCallback((nextTickets: SessionTicketRecord[]) => {
    setTickets(nextTickets)
    if (options.context && session) saveSessionTickets(options.context, session.id, nextTickets)
  }, [options.context, session, setTickets])

  const updateTicketPrintState = useCallback((
    saleId: string,
    patch: Partial<Pick<SessionTicketRecord,
      'printStatus' | 'printJobId' | 'printRequestId' | 'printedAt' | 'printErrorCode' | 'printAttempts'>>,
  ) => {
    const next = ticketsRef.current.map((ticket) => ticket.id === saleId ? { ...ticket, ...patch } : ticket)
    setTickets(next)
    if (options.context && session) saveSessionTickets(options.context, session.id, next)
  }, [options.context, session, setTickets])

  const mergeRemotePrintStates = useCallback(
    (remoteTickets: SessionTicketRecord[]) => mergeRemoteTicketPrintStates(ticketsRef.current, remoteTickets),
    [],
  )

  const printSale = useCallback(async (
    payload: SessionTicketRecord['payload'],
    printOptions: { isReprint?: boolean; copyNumber?: number } = {},
  ) => {
    if (!options.context) return
    if (!printOptions.isReprint && !ticketsRef.current.some((ticket) => ticket.id === payload.sale.id)) {
      persistTickets([{
        id: payload.sale.id,
        cashSessionId: payload.sale.cashSessionId,
        paymentMethod: payload.sale.paymentMethod,
        totalCents: payload.sale.totalCents,
        createdAt: payload.sale.createdAt,
        status: 'active',
        payload,
        printStatus: 'not_requested',
        printAttempts: 0,
      }, ...ticketsRef.current])
    }
    await printTicket({
      context: options.context,
      payload,
      tickets: ticketsRef.current,
      updateTicketPrintState,
      options: printOptions,
    })
  }, [options.context, persistTickets, updateTicketPrintState])

  const handleClosedRemotely = useCallback(() => {
    if (options.context) {
      saveCachedCashSession(options.context, null)
      clearSaleLedger(options.context)
      if (session) clearSessionTickets(options.context, session.id)
    }
    const closed = getClosedCashState()
    setSession(closed.session)
    setLedger([...closed.ledger])
    setTickets([...closed.tickets])
    setCloseModalOpen(false)
    setHistoryOpen(false)
    options.onError('La caja con la que estabas trabajando se ha cerrado.')
  }, [options, session, setTickets])

  const handleAutomaticSession = useCallback((nextSession: CashSession) => {
    if (options.context) saveCachedCashSession(options.context, nextSession)
    setSession(nextSession)
  }, [options.context])

  const cashOptions = useCashRegisterOptions({
    context: options.context,
    currentSession: session,
    isOnline: options.isOnline,
    onClosedRemotely: handleClosedRemotely,
    onSessionSelected: handleAutomaticSession,
  })

  const handleActiveSessionChanged = useCallback(async (
    nextSession: CashSession | null,
    previousSession: CashSession | null,
  ) => {
    if (!options.context) return
    if (previousSession) clearSessionTickets(options.context, previousSession.id)
    setSession(nextSession)
    saveCachedCashSession(options.context, nextSession)
    setCloseModalOpen(false)
    setHistoryOpen(false)
    if (!nextSession) {
      setLedger([])
      clearSaleLedger(options.context)
      setTickets([])
      options.onError('La caja se ha cerrado desde otro dispositivo. Abre una nueva caja para continuar.')
      return
    }
    const remoteLedger = await loadSalesLedgerFromSupabase(options.context, nextSession.id)
    setLedger(remoteLedger)
    saveSaleLedger(options.context, remoteLedger)
    setTickets(getSessionTickets(options.context, nextSession.id))
    options.onError(null)
  }, [options, setTickets])

  useActiveCashSession({
    context: options.context,
    isOnline: options.isOnline,
    onChanged: handleActiveSessionChanged,
    onError: (message) => options.onError(message),
  })

  const refreshConfirmedSale = useCallback(async (saleId: string, missingTicketTitle: string, shouldPrint = true) => {
    if (!options.context || !session) return
    const [nextLedger, remoteTickets] = await Promise.all([
      loadSalesLedgerFromSupabase(options.context, session.id),
      loadSessionTicketsFromSupabase(options.context, session.id),
    ])
    persistLedger(nextLedger)
    persistTickets(mergeRemotePrintStates(remoteTickets))
    const confirmedTicket = remoteTickets.find((ticket) => ticket.id === saleId)
    if (confirmedTicket && shouldPrint) void printSale(confirmedTicket.payload)
    else if (!confirmedTicket) sileo.warning({ title: missingTicketTitle, description: 'No se ha podido recuperar el ticket confirmado.' })
  }, [mergeRemotePrintStates, options.context, persistLedger, persistTickets, printSale, session])
  const ticketActions = useCashTicketActions({
    context: options.context,
    cashSession: session,
    isOnline: options.isOnline,
    tickets,
    ledger,
    syncPendingEvents: options.syncPendingEvents,
    refreshPendingCount: options.refreshPendingCount,
    persistTickets,
    persistLedger,
    mergeRemotePrintStates,
    printTicket: printSale,
    subtractProductSalesStats: options.subtractProductSalesStats,
    setBusy: options.setBusy,
    setError: options.onError,
    setHistoryOpen,
  })

  const open = useCallback(async (registerId: string, openingFloatCents: number) => {
    if (!options.context?.canOpenCashSession || !options.isOnline) return
    options.setBusy(true)
    options.onError(null)
    try {
      const nextSession = await openCashSessionLifecycle(options.context, registerId, openingFloatCents)
      persistSession(nextSession)
      setCompletedClosing(null)
      persistLedger([])
      setTickets([])
      saveSessionTickets(options.context, nextSession.id, [])
      await cashOptions.refresh(options.context)
    } catch (error) {
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [cashOptions, options, persistLedger, persistSession, setTickets])

  const join = useCallback(async (nextSession: CashSession) => {
    if (!options.context || !options.isOnline) return
    options.setBusy(true)
    try {
      persistSession(nextSession)
      const joined = await joinCashSessionLifecycle(options.context, nextSession)
      persistLedger(joined.ledger)
      setTickets(joined.tickets)
      saveSessionTickets(options.context, nextSession.id, joined.tickets)
    } catch (error) {
      persistSession(null)
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [options, persistLedger, persistSession, setTickets])

  const openDefault = useCallback((openingFloatCents: number) => {
    const registerId = options.context?.defaultCashRegisterId
      ?? cashOptions.registers.find((register) => register.isActive)?.id
    if (registerId) void open(registerId, openingFloatCents)
  }, [cashOptions.registers, open, options.context?.defaultCashRegisterId])

  const printClosing = useCallback(async (closing: CashClosingRecord, printOptions: { isReprint?: boolean; copyNumber?: number } = {}) => {
    if (!options.context || printingClosingId) return false
    const state = usePrintAgentStore.getState()
    const printerId = state.selectedPrinterId || state.selectedPrinter?.id
    if (!state.token) { sileo.warning({ title: 'Servidor de impresion no configurado.' }); return false }
    if (!printerId) { sileo.warning({ title: 'No hay una impresora configurada.' }); return false }
    if (!printOptions.isReprint && closing.printStatus === 'printed') {
      sileo.warning({ title: 'Este cierre ya se imprimio.', description: 'Usa la accion de reimpresion para generar una copia.' })
      return false
    }
    if (closing.printStatus === 'unknown') {
      sileo.warning({ title: 'No se puede confirmar si el cierre se imprimio.', description: 'Comprueba la impresora antes de volver a imprimir.' })
      return false
    }
    const copyNumber = printOptions.isReprint ? Math.max(1, printOptions.copyNumber || closing.printCopies + 1) : 0
    const requestId = cashClosingRequestId(closing.id, Boolean(printOptions.isReprint), copyNumber)
    setPrintingClosingId(closing.id)
    try {
      const claimed = await recordCashClosingPrintResult(options.context, {
        closingId: closing.id, printerId, requestId, status: 'pending',
        isReprint: Boolean(printOptions.isReprint), copyNumber,
      })
      if (!claimed) {
        sileo.warning({ title: 'La impresion ya fue solicitada.', description: 'Actualiza el historico antes de crear otra copia.' })
        return false
      }
      const result = await printCashClosing({ closing, context: options.context, isReprint: printOptions.isReprint, copyNumber })
      await recordCashClosingPrintResult(options.context, {
        closingId: closing.id, printerId, requestId,
        printJobId: result.job.jobId || result.job.id || null, status: 'printed',
        isReprint: Boolean(printOptions.isReprint), copyNumber,
      })
      const refreshed = await loadCashClosing(options.context, closing.id)
      setCompletedClosing((current) => current?.id === refreshed.id ? refreshed : current)
      setCashClosings((current) => current.map((item) => item.id === refreshed.id ? refreshed : item))
      return true
    } catch (error) {
      const errorCode = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'PRINT_FAILED'
      const status = errorCode === 'PRINT_STATUS_UNKNOWN' ? 'unknown' : 'failed'
      try {
        await recordCashClosingPrintResult(options.context, {
          closingId: closing.id, printerId, requestId, status, errorCode,
          isReprint: Boolean(printOptions.isReprint), copyNumber,
        })
        const refreshed = await loadCashClosing(options.context, closing.id)
        setCompletedClosing((current) => current?.id === refreshed.id ? refreshed : current)
        setCashClosings((current) => current.map((item) => item.id === refreshed.id ? refreshed : item))
      } catch { /* el fallo de auditoria no cambia el cierre ya guardado */ }
      return false
    } finally {
      setPrintingClosingId(null)
    }
  }, [options.context, printingClosingId])

  const openClosingHistory = useCallback(async () => {
    if (!options.context || !options.isOnline) {
      options.onError('El historico de cierres requiere conexion.')
      return
    }
    options.setBusy(true)
    try {
      setCashClosings(await loadCashClosingHistory(options.context))
      setClosingHistoryOpen(true)
    } catch (error) {
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [options])

  const close = useCallback(async (payload: CashClosedPayload) => {
    if (!options.context?.canCloseCashSession || !options.isOnline) return false
    options.setBusy(true)
    try {
      const closing = await closeCashSessionLifecycle(options.context, payload)
      persistSession(null)
      setLedger([])
      clearSaleLedger(options.context)
      clearSessionTickets(options.context, payload.sessionId)
      setTickets([])
      setCloseModalOpen(false)
      options.refreshPendingCount()
      await cashOptions.refresh(options.context)
      setCompletedClosing(closing)
      if (usePrintAgentStore.getState().preferences.printCashClosingAutomatically) {
        await printClosing(closing)
      }
      return true
    } catch (error) {
      options.onError(getReadableError(error))
      return false
    } finally {
      options.setBusy(false)
    }
  }, [cashOptions, options, persistSession, printClosing, setTickets])

  const reset = useCallback(() => {
    const closed = getClosedCashState()
    setSession(closed.session)
    setLedger([...closed.ledger])
    setTickets([...closed.tickets])
    setCloseModalOpen(false)
    setHistoryOpen(false)
    setClosingHistoryOpen(false)
    setCashClosings([])
    setCompletedClosing(null)
  }, [setTickets])

  const hydrate = useCallback((
    nextSession: CashSession | null,
    nextLedger: SaleRecord[],
    nextTickets: SessionTicketRecord[],
  ) => {
    setSession(nextSession)
    setLedger(nextLedger)
    setTickets(nextTickets)
    setClosingHistoryOpen(false)
    setCashClosings([])
    setCompletedClosing(null)
  }, [setTickets])

  const clearRejectedSession = useCallback((closedSessionId: string) => {
    if (!options.context) return
    setSession(null)
    saveCachedCashSession(options.context, null)
    setLedger([])
    clearSaleLedger(options.context)
    clearSessionTickets(options.context, closedSessionId)
    setTickets([])
    setCloseModalOpen(false)
    setHistoryOpen(false)
  }, [options.context, setTickets])

  return {
    clearRejectedSession,
    close,
    closeModalOpen,
    closingHistoryOpen,
    cashClosings,
    completedClosing,
    hydrate,
    historyOpen,
    join,
    ledger,
    mergeRemotePrintStates,
    open,
    openCloseModal: () => setCloseModalOpen(true),
    openClosingHistory,
    openDefault,
    options: cashOptions,
    persistLedger,
    persistTickets,
    printSale,
    printClosing,
    printingClosingId,
    refreshConfirmedSale,
    reset,
    session,
    setCloseModalOpen,
    setClosingHistoryOpen,
    setCompletedClosing,
    setHistoryOpen,
    setLedger,
    setSession,
    setTickets,
    summary: useMemo(() => summarizeSales(session?.openingFloatCents ?? 0, ledger), [ledger, session?.openingFloatCents]),
    ticketActions,
    tickets,
  }
}
