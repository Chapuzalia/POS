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
  CashSession,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
} from '../../../types'
import { getReadableError } from '../../../utils/errors'
import { usePrintAgentScope } from '../../local-printing/hooks/usePrintAgentScope'
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

  const close = useCallback(async (payload: CashClosedPayload) => {
    if (!options.context?.canCloseCashSession || !options.isOnline) return false
    options.setBusy(true)
    try {
      await closeCashSessionLifecycle(options.context, payload)
      persistSession(null)
      setLedger([])
      clearSaleLedger(options.context)
      clearSessionTickets(options.context, payload.sessionId)
      setTickets([])
      setCloseModalOpen(false)
      options.refreshPendingCount()
      await cashOptions.refresh(options.context)
      return true
    } catch (error) {
      options.onError(getReadableError(error))
      return false
    } finally {
      options.setBusy(false)
    }
  }, [cashOptions, options, persistSession, setTickets])

  const reset = useCallback(() => {
    const closed = getClosedCashState()
    setSession(closed.session)
    setLedger([...closed.ledger])
    setTickets([...closed.tickets])
    setCloseModalOpen(false)
    setHistoryOpen(false)
  }, [setTickets])

  const hydrate = useCallback((
    nextSession: CashSession | null,
    nextLedger: SaleRecord[],
    nextTickets: SessionTicketRecord[],
  ) => {
    setSession(nextSession)
    setLedger(nextLedger)
    setTickets(nextTickets)
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
    hydrate,
    historyOpen,
    join,
    ledger,
    mergeRemotePrintStates,
    open,
    openCloseModal: () => setCloseModalOpen(true),
    openDefault,
    options: cashOptions,
    persistLedger,
    persistTickets,
    printSale,
    refreshConfirmedSale,
    reset,
    session,
    setCloseModalOpen,
    setHistoryOpen,
    setLedger,
    setSession,
    setTickets,
    summary: useMemo(() => summarizeSales(session?.openingFloatCents ?? 0, ledger), [ledger, session?.openingFloatCents]),
    ticketActions,
    tickets,
  }
}
