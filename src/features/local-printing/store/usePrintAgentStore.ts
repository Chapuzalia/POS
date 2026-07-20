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
  ConnectionStatus, DiscoveryProgress, DiscoveryStatus, PrintAgentPreferences, PrintAgentScope,
  PrintAgentServerInfo, PrintJob, Printer, PrintRequest,
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
  configureScope: (scope: PrintAgentScope) => void
  setBaseUrl: (baseUrl: string) => string
  setToken: (token: string | null) => void
  updatePreferences: (preferences: Partial<PrintAgentPreferences>) => void
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

    configureScope(scope) {
      const config = loadPrintAgentConfig(scope)
      set({
        scope, baseUrl: config.baseUrl, token: config.token, selectedPrinterId: config.selectedPrinterId,
        selectedPrinter: null, printers: [], serverInfo: null, jobs: [], currentJob: null,
        lastSuccessfulConnectionAt: config.lastSuccessfulConnectionAt, preferences: config.preferences,
        connectionStatus: 'unknown', lastConnectionError: null, settingsLoaded: true,
      })
    },

    setBaseUrl(value) {
      const baseUrl = normalizePrintAgentUrl(value, { allowHttpInDevelopment: true, isDevelopment: import.meta.env?.DEV })
      set({ baseUrl, connectionStatus: 'unknown', lastConnectionError: null, serverInfo: null, printers: [], selectedPrinter: null })
      persist(get())
      return baseUrl
    },

    setToken(value) {
      set({ token: value?.trim() || null, connectionStatus: 'unknown', lastConnectionError: null, serverInfo: null })
      persist(get())
    },

    updatePreferences(value) {
      set((state) => ({ preferences: { ...state.preferences, ...value } }))
      persist(get())
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
        serverInfo: state.serverInfo, selectedPrinter: state.selectedPrinter, lastError: state.lastConnectionError ? {
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
