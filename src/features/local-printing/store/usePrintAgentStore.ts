import { create } from 'zustand'
import { createPrintAgentClient } from '../api/printAgentClient'
import { PrintAgentError, toPrintAgentError } from '../api/PrintAgentError'
import { DEFAULT_PRINT_AGENT_URL, PRINT_AGENT_ENABLED } from '../constants/config'
import { printRequestSchema, printerActionSchema, selectPrinterSchema } from '../schemas/printSchemas'
import { pollPrintJob } from '../services/jobPolling'
import {
  clearPrintAgentConfig,
  defaultPrintAgentPreferences,
  loadPrintAgentConfig,
  savePrintAgentConfig,
} from '../services/printAgentStorage'
import type {
  CashlogyConnector, CashlogyHealth, CashlogyRecoveryResult, ConnectionStatus, DiscoveryProgress, DiscoveryStatus, PrintAgentPreferences, PrintAgentScope,
  PrintAgentServerInfo, PrintJob, PrintRequest, Printer,
} from '../types'
import { normalizePrintAgentUrl } from '../utils/normalizePrintAgentUrl'
import { sanitizePrintDiagnostics } from '../utils/sanitizePrintDiagnostics'

type StoreState = {
  scope: PrintAgentScope | null
  baseUrl: string
  token: string | null
  connectionStatus: ConnectionStatus
  lastConnectionCheckAt: string | null
  lastSuccessfulConnectionAt: string | null
  lastConnectionError: PrintAgentError | null
  lastResponseTimeMs: number | null
  serverInfo: PrintAgentServerInfo | null
  printers: Printer[]
  selectedPrinter: Printer | null
  selectedPrinterId: string | null
  cashlogyConfigured: boolean
  cashlogyTerminalCode: string
  cashlogyHealth: CashlogyHealth | null
  cashlogyConnectors: CashlogyConnector[]
  cashlogyConnectorsLoaded: boolean
  discoveryStatus: DiscoveryStatus
  discoveryProgress: DiscoveryProgress | null
  jobs: PrintJob[]
  currentJob: PrintJob | null
  lastPrintAt: string | null
  settingsLoaded: boolean
  preferences: PrintAgentPreferences
  isCheckingConnection: boolean
  isLoadingServerInfo: boolean
  isLoadingPrinters: boolean
  isDiscoveringPrinters: boolean
  isSelectingPrinter: boolean
  isTestingPrinter: boolean
  isPrintingTicket: boolean
  isOpeningCashDrawer: boolean
  isLoadingJobs: boolean
  isCheckingCashlogy: boolean
  isLoadingCashlogyConnectors: boolean
  isDiscoveringCashlogyConnectors: boolean
  isRecoveringCashlogy: boolean
  cashlogyConnectorAction: { connectorId: string; type: 'select' | 'initialize' } | null
  configureScope: (scope: PrintAgentScope) => void
  setBaseUrl: (baseUrl: string) => string
  setToken: (token: string | null) => void
  updatePreferences: (preferences: Partial<PrintAgentPreferences>) => void
  updateCashlogyConfiguration: (input: { configured?: boolean; terminalCode?: string }) => void
  checkCashlogyHealth: (signal?: AbortSignal) => Promise<CashlogyHealth>
  loadCashlogyConnectors: (signal?: AbortSignal) => Promise<CashlogyConnector[]>
  discoverCashlogyConnectors: (signal?: AbortSignal) => Promise<CashlogyConnector[]>
  selectCashlogyConnector: (connectorId: string, signal?: AbortSignal) => Promise<CashlogyConnector>
  initializeCashlogyConnector: (connectorId: string, signal?: AbortSignal) => Promise<CashlogyConnector>
  recoverCashlogy: (signal?: AbortSignal) => Promise<CashlogyRecoveryResult>
  checkConnection: (signal?: AbortSignal) => Promise<boolean>
  loadServerInfo: (signal?: AbortSignal) => Promise<PrintAgentServerInfo>
  loadPrinters: (signal?: AbortSignal) => Promise<Printer[]>
  discoverPrinters: (signal?: AbortSignal) => Promise<Printer[]>
  selectPrinter: (printerId: string, signal?: AbortSignal) => Promise<Printer>
  testPrinter: (printerId?: string, signal?: AbortSignal) => Promise<unknown>
  printTicket: (payload: PrintRequest, signal?: AbortSignal) => Promise<PrintJob>
  openCashDrawer: (payload?: { requestId?: string; printerId?: string }, signal?: AbortSignal) => Promise<unknown>
  loadJobs: (signal?: AbortSignal) => Promise<PrintJob[]>
  clearError: () => void
  resetConfiguration: () => void
  getDiagnosticReport: () => Record<string, unknown>
}

function unwrapPrinters(value: { printers?: Printer[] } | Printer[]) {
  return Array.isArray(value) ? value : value.printers || []
}

function persist(state: StoreState) {
  if (!state.scope) return
  savePrintAgentConfig(state.scope, {
    baseUrl: state.baseUrl,
    token: state.token,
    selectedPrinterId: state.selectedPrinterId,
    cashlogyConfigured: state.cashlogyConfigured,
    cashlogyTerminalCode: state.cashlogyTerminalCode,
    lastSuccessfulConnectionAt: state.lastSuccessfulConnectionAt,
    preferences: state.preferences,
  })
}

function connectionStatusFor(error: PrintAgentError): ConnectionStatus {
  if (error.code === 'UNAUTHORIZED') return 'unauthorized'
  if (error.code === 'ORIGIN_NOT_ALLOWED') return 'cors-error'
  if (error.code === 'TLS_CONFIGURATION_ERROR' || error.code === 'CERTIFICATE_EXPIRED') return 'certificate-error'
  return 'disconnected'
}

export const usePrintAgentStore = create<StoreState>((set, get) => {
  const client = () => createPrintAgentClient({ baseUrl: get().baseUrl, token: get().token })

  return {
    scope: null,
    baseUrl: DEFAULT_PRINT_AGENT_URL,
    token: null,
    connectionStatus: PRINT_AGENT_ENABLED ? 'unknown' : 'disconnected',
    lastConnectionCheckAt: null,
    lastSuccessfulConnectionAt: null,
    lastConnectionError: null,
    lastResponseTimeMs: null,
    serverInfo: null,
    printers: [],
    selectedPrinter: null,
    selectedPrinterId: null,
    cashlogyConfigured: false,
    cashlogyTerminalCode: 'POS_MAIN',
    cashlogyHealth: null,
    cashlogyConnectors: [],
    cashlogyConnectorsLoaded: false,
    discoveryStatus: 'idle',
    discoveryProgress: null,
    jobs: [],
    currentJob: null,
    lastPrintAt: null,
    settingsLoaded: false,
    preferences: { ...defaultPrintAgentPreferences },
    isCheckingConnection: false,
    isLoadingServerInfo: false,
    isLoadingPrinters: false,
    isDiscoveringPrinters: false,
    isSelectingPrinter: false,
    isTestingPrinter: false,
    isPrintingTicket: false,
    isOpeningCashDrawer: false,
    isLoadingJobs: false,
    isCheckingCashlogy: false,
    isLoadingCashlogyConnectors: false,
    isDiscoveringCashlogyConnectors: false,
    isRecoveringCashlogy: false,
    cashlogyConnectorAction: null,

    configureScope(scope) {
      const config = loadPrintAgentConfig(scope)
      set({
        scope, baseUrl: config.baseUrl, token: config.token, selectedPrinterId: config.selectedPrinterId,
        cashlogyConfigured: config.cashlogyConfigured, cashlogyTerminalCode: config.cashlogyTerminalCode,
        cashlogyHealth: null, cashlogyConnectors: [], cashlogyConnectorsLoaded: false,
        isLoadingCashlogyConnectors: false, isDiscoveringCashlogyConnectors: false, isRecoveringCashlogy: false, cashlogyConnectorAction: null,
        selectedPrinter: null, printers: [], serverInfo: null, jobs: [], currentJob: null,
        lastSuccessfulConnectionAt: config.lastSuccessfulConnectionAt, preferences: config.preferences,
        connectionStatus: 'unknown', lastConnectionError: null, settingsLoaded: true,
      })
    },

    setBaseUrl(value) {
      const baseUrl = normalizePrintAgentUrl(value, { allowHttpInDevelopment: true, isDevelopment: import.meta.env?.DEV })
      set({ baseUrl, connectionStatus: 'unknown', lastConnectionError: null, serverInfo: null, printers: [], selectedPrinter: null, cashlogyHealth: null, cashlogyConnectors: [], cashlogyConnectorsLoaded: false })
      persist(get())
      return baseUrl
    },

    setToken(value) {
      set({ token: value?.trim() || null, connectionStatus: 'unknown', lastConnectionError: null, serverInfo: null, cashlogyHealth: null, cashlogyConnectors: [], cashlogyConnectorsLoaded: false })
      persist(get())
    },

    updatePreferences(value) {
      set((state) => ({ preferences: { ...state.preferences, ...value } }))
      persist(get())
    },

    updateCashlogyConfiguration(value) {
      const terminalCode = value.terminalCode === undefined
        ? get().cashlogyTerminalCode
        : value.terminalCode.trim().toUpperCase().replace(/[^A-Z0-9_.:-]/g, '_').slice(0, 64) || 'POS_MAIN'
      set({
        cashlogyConfigured: value.configured ?? get().cashlogyConfigured,
        cashlogyTerminalCode: terminalCode,
      })
      persist(get())
    },

    async checkCashlogyHealth(signal) {
      set({ isCheckingCashlogy: true, lastConnectionError: null })
      try {
        const health = await client().getCashlogyHealth(signal)
        set({ cashlogyHealth: health })
        return health
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally {
        set({ isCheckingCashlogy: false })
      }
    },

    async loadCashlogyConnectors(signal) {
      set({ isLoadingCashlogyConnectors: true, lastConnectionError: null })
      try {
        const result = await client().getCashlogyConnectors(signal)
        const connectors = result.connectors || []
        set({ cashlogyConnectors: connectors, cashlogyConnectorsLoaded: true })
        return connectors
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isLoadingCashlogyConnectors: false }) }
    },

    async discoverCashlogyConnectors(signal) {
      set({ isDiscoveringCashlogyConnectors: true, lastConnectionError: null })
      try {
        const result = await client().discoverCashlogyConnectors(signal)
        const connectors = result.connectors || []
        set({ cashlogyConnectors: connectors, cashlogyConnectorsLoaded: true })
        return connectors
      } catch (error) {
        const mapped = toPrintAgentError(error, 'DISCOVERY_FAILED')
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isDiscoveringCashlogyConnectors: false }) }
    },

    async selectCashlogyConnector(connectorId, signal) {
      if (!connectorId || connectorId.length > 300) throw new PrintAgentError({ code: 'INVALID_REQUEST' })
      set({ cashlogyConnectorAction: { connectorId, type: 'select' }, lastConnectionError: null })
      try {
        const activeClient = client()
        const result = await activeClient.selectCashlogyConnector(connectorId, signal)
        set((state) => ({
          cashlogyConnectors: state.cashlogyConnectors.map((connector) => connector.id === connectorId
            ? { ...connector, ...result.connector, selected: true }
            : { ...connector, selected: false }),
        }))
        try { set({ cashlogyHealth: await activeClient.getCashlogyHealth(signal) }) } catch { /* la selección ya se completó; el estado se podrá refrescar */ }
        return result.connector
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ cashlogyConnectorAction: null }) }
    },

    async initializeCashlogyConnector(connectorId, signal) {
      if (!connectorId || connectorId.length > 300) throw new PrintAgentError({ code: 'INVALID_REQUEST' })
      set({ cashlogyConnectorAction: { connectorId, type: 'initialize' }, lastConnectionError: null })
      try {
        const activeClient = client()
        const result = await activeClient.initializeCashlogyConnector(connectorId, signal)
        set((state) => ({
          cashlogyConnectors: state.cashlogyConnectors.map((connector) => connector.id === connectorId
            ? { ...connector, ...result.connector }
            : connector),
        }))
        try { set({ cashlogyHealth: await activeClient.getCashlogyHealth(signal) }) } catch { /* la inicialización ya se completó; el estado se podrá refrescar */ }
        return result.connector
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ cashlogyConnectorAction: null }) }
    },

    async recoverCashlogy(signal) {
      if (get().isRecoveringCashlogy) throw new PrintAgentError({ code: 'DUPLICATE_REQUEST' })
      set({ isRecoveringCashlogy: true, lastConnectionError: null })
      try {
        const activeClient = client()
        const result = await activeClient.recoverCashlogy(signal)
        if (!result.ok || !result.ready) {
          throw new PrintAgentError({
            code: 'INVALID_RESPONSE',
            message: 'La recuperación forzada terminó, pero Cashlogy no ha quedado preparada. Revisa el diagnóstico del agente.',
            details: result,
          })
        }
        try {
          const [health, connectorResult] = await Promise.all([
            activeClient.getCashlogyHealth(signal),
            activeClient.getCashlogyConnectors(signal),
          ])
          set({ cashlogyHealth: health, cashlogyConnectors: connectorResult.connectors || [], cashlogyConnectorsLoaded: true })
        } catch { /* la recuperación ya está confirmada; el estado puede refrescarse manualmente */ }
        return result
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isRecoveringCashlogy: false }) }
    },

    async checkConnection(signal) {
      const startedAt = performance.now()
      set({ isCheckingConnection: true, connectionStatus: 'checking', lastConnectionError: null })
      try {
        const result = await client().health(signal)
        if (!result?.ok) throw new PrintAgentError({ code: 'INVALID_RESPONSE', message: 'El agente no ha confirmado que este operativo.' })
        const now = new Date().toISOString()
        set({ connectionStatus: 'connected', lastConnectionCheckAt: now, lastSuccessfulConnectionAt: now, lastResponseTimeMs: Math.round(performance.now() - startedAt) })
        persist(get())
        return true
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ connectionStatus: connectionStatusFor(mapped), lastConnectionCheckAt: new Date().toISOString(), lastConnectionError: mapped, lastResponseTimeMs: Math.round(performance.now() - startedAt) })
        return false
      } finally { set({ isCheckingConnection: false }) }
    },

    async loadServerInfo(signal) {
      set({ isLoadingServerInfo: true, lastConnectionError: null })
      try {
        const info = await client().getServerInfo(signal) as PrintAgentServerInfo
        set({ serverInfo: info, connectionStatus: 'connected' })
        return info
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped, connectionStatus: connectionStatusFor(mapped) })
        throw mapped
      } finally { set({ isLoadingServerInfo: false }) }
    },

    async loadPrinters(signal) {
      set({ isLoadingPrinters: true, lastConnectionError: null })
      try {
        const printers = unwrapPrinters(await client().getPrinters(signal))
        const selectedPrinter = printers.find((printer) => printer.id === get().selectedPrinterId) || null
        set({ printers, selectedPrinter })
        return printers
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isLoadingPrinters: false }) }
    },

    async discoverPrinters(signal) {
      set({ isDiscoveringPrinters: true, discoveryStatus: 'discovering', discoveryProgress: null, lastConnectionError: null })
      const found = new Map<string, Printer>()
      try {
        let streamed = false
        try {
          await client().discoverPrintersStream((event) => {
            streamed = true
            if (event.printer) found.set(event.printer.id, event.printer)
            set({ printers: [...found.values()], discoveryProgress: { scanned: event.scanned, total: event.total, found: event.found ?? found.size } })
          }, signal)
        } catch (streamError) {
          if (signal?.aborted) throw streamError
          const result = await client().discoverPrinters(signal)
          for (const printer of result.printers || []) found.set(printer.id, printer)
          set({ discoveryProgress: result.progress || { found: found.size } })
        }
        if (!streamed && found.size === 0) {
          const refreshed = unwrapPrinters(await client().getPrinters(signal))
          for (const printer of refreshed) found.set(printer.id, printer)
        }
        const printers = [...found.values()]
        set({ printers, discoveryStatus: 'completed' })
        return printers
      } catch (error) {
        const mapped = toPrintAgentError(error, 'DISCOVERY_FAILED')
        set({ discoveryStatus: 'failed', lastConnectionError: mapped })
        throw mapped
      } finally { set({ isDiscoveringPrinters: false }) }
    },

    async selectPrinter(printerId, signal) {
      selectPrinterSchema.parse({ printerId })
      set({ isSelectingPrinter: true, lastConnectionError: null })
      try {
        const result = await client().selectPrinter({ printerId }, signal)
        const selectedPrinter = result.printer || get().printers.find((printer) => printer.id === printerId) || { id: printerId }
        set({ selectedPrinterId: printerId, selectedPrinter })
        persist(get())
        return selectedPrinter
      } catch (error) {
        const mapped = toPrintAgentError(error)
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isSelectingPrinter: false }) }
    },

    async testPrinter(printerId = get().selectedPrinterId || '', signal) {
      const payload = printerActionSchema.parse({ requestId: `test:${get().scope?.terminalId || 'terminal'}:${Date.now()}`, printerId })
      set({ isTestingPrinter: true, lastConnectionError: null })
      try { return await client().testPrinter(payload, signal) }
      catch (error) { const mapped = toPrintAgentError(error, 'PRINT_FAILED'); set({ lastConnectionError: mapped }); throw mapped }
      finally { set({ isTestingPrinter: false }) }
    },

    async printTicket(rawPayload, signal) {
      const payload = printRequestSchema.parse(rawPayload)
      set({ isPrintingTicket: true, lastConnectionError: null, currentJob: { requestId: payload.requestId, status: 'pending' } })
      const activeClient = client()
      try {
        const response = await activeClient.printTicket(payload, signal)
        let job: PrintJob = { jobId: response.jobId, id: response.jobId, requestId: payload.requestId, status: (response.status || 'pending') as PrintJob['status'] }
        set({ currentJob: job })
        if (response.jobId && !['printed', 'failed', 'cancelled'].includes(job.status)) {
          job = await pollPrintJob(activeClient, response.jobId, { signal, onUpdate: (next) => set({ currentJob: next }) })
        }
        if (job.status === 'unknown') throw new PrintAgentError({ code: 'PRINT_STATUS_UNKNOWN' })
        if (job.status === 'failed' || job.status === 'cancelled') throw new PrintAgentError({ code: job.errorCode === 'PRINTER_NOT_FOUND' ? 'PRINTER_NOT_FOUND' : 'PRINT_FAILED', details: job })
        const printedAt = job.printedAt || new Date().toISOString()
        set((state) => ({ currentJob: job, lastPrintAt: printedAt, jobs: [job, ...state.jobs.filter((item) => item.requestId !== job.requestId)].slice(0, 25) }))
        return job
      } catch (error) {
        const mapped = toPrintAgentError(error, 'PRINT_FAILED')
        if (['NETWORK_ERROR', 'TIMEOUT'].includes(mapped.code)) {
          try {
            const known = await activeClient.findJobByRequestId(payload.requestId, signal)
            if (known) {
              const resolved = known.jobId || known.id ? await pollPrintJob(activeClient, String(known.jobId || known.id), { signal, onUpdate: (job) => set({ currentJob: job }) }) : known
              if (resolved.status === 'printed') { set({ currentJob: resolved, lastPrintAt: resolved.printedAt || new Date().toISOString() }); return resolved }
            }
          } catch { /* el resultado sigue siendo incierto */ }
          const unknown = new PrintAgentError({ code: 'PRINT_STATUS_UNKNOWN', cause: mapped })
          set({ lastConnectionError: unknown, currentJob: { requestId: payload.requestId, status: 'unknown' } })
          throw unknown
        }
        set({ lastConnectionError: mapped })
        throw mapped
      } finally { set({ isPrintingTicket: false }) }
    },

    async openCashDrawer(input = {}, signal) {
      if (get().cashlogyConfigured) {
        throw new PrintAgentError({
          code: 'CONFIGURATION_ERROR',
          message: 'El cajón de la impresora está deshabilitado porque este establecimiento usa Cashlogy.',
        })
      }
      const payload = printerActionSchema.parse({
        requestId: input.requestId || `drawer:${get().scope?.terminalId || 'terminal'}:${Date.now()}`,
        printerId: input.printerId || get().selectedPrinterId || '',
      })
      set({ isOpeningCashDrawer: true, lastConnectionError: null })
      try { return await client().openCashDrawer(payload, signal) }
      catch (error) { const mapped = toPrintAgentError(error, 'CASH_DRAWER_FAILED'); set({ lastConnectionError: mapped }); throw mapped }
      finally { set({ isOpeningCashDrawer: false }) }
    },

    async loadJobs(signal) {
      set({ isLoadingJobs: true })
      try { const jobs = unwrapJobs(await client().getJobs(signal)); set({ jobs }); return jobs }
      catch (error) { const mapped = toPrintAgentError(error); set({ lastConnectionError: mapped }); throw mapped }
      finally { set({ isLoadingJobs: false }) }
    },

    clearError() { set({ lastConnectionError: null }) },

    resetConfiguration() {
      const scope = get().scope
      if (scope) clearPrintAgentConfig(scope)
      set({
        baseUrl: DEFAULT_PRINT_AGENT_URL, token: null, selectedPrinterId: null, selectedPrinter: null,
        cashlogyConfigured: false, cashlogyTerminalCode: 'POS_MAIN', cashlogyHealth: null,
        cashlogyConnectors: [], cashlogyConnectorsLoaded: false,
        isLoadingCashlogyConnectors: false, isDiscoveringCashlogyConnectors: false, isRecoveringCashlogy: false, cashlogyConnectorAction: null,
        printers: [], serverInfo: null, jobs: [], currentJob: null, connectionStatus: 'unknown',
        lastConnectionError: null, lastConnectionCheckAt: null, lastSuccessfulConnectionAt: null,
        lastResponseTimeMs: null, lastPrintAt: null, preferences: { ...defaultPrintAgentPreferences },
      })
    },

    getDiagnosticReport() {
      const state = get()
      return sanitizePrintDiagnostics({
        connectionStatus: state.connectionStatus, url: state.baseUrl, lastConnectionCheckAt: state.lastConnectionCheckAt,
        lastSuccessfulConnectionAt: state.lastSuccessfulConnectionAt, responseTimeMs: state.lastResponseTimeMs,
        serverInfo: state.serverInfo, selectedPrinter: state.selectedPrinter,
        cashlogy: { configured: state.cashlogyConfigured, terminalCode: state.cashlogyTerminalCode, health: state.cashlogyHealth, connectors: state.cashlogyConnectors },
        lastError: state.lastConnectionError ? {
          code: state.lastConnectionError.code, message: state.lastConnectionError.message, status: state.lastConnectionError.status,
        } : null,
        lastJob: state.currentJob, frontendOrigin: typeof window === 'undefined' ? null : window.location.origin,
        scope: state.scope,
      }) as Record<string, unknown>
    },
  }
})

function unwrapJobs(value: { jobs?: PrintJob[] } | PrintJob[]) {
  return Array.isArray(value) ? value : value.jobs || []
}
