import { DEFAULT_PRINT_AGENT_TIMEOUT_MS, PRINT_AGENT_HEALTH_TIMEOUT_MS } from '../constants/config.ts'
import { normalizePrintAgentUrl } from '../utils/normalizePrintAgentUrl.ts'
import { PrintAgentError, type PrintAgentErrorCode } from './PrintAgentError.ts'
import type {
  CashlogyAccounting, CashlogyCancelResponse, CashlogyCapabilities, CashlogyCashManagementOperation, CashlogyChargeRequest,
  CashlogyConnector, CashlogyDenominations, CashlogyDevice, CashlogyDeviceError, CashlogyDiagnosticLog,
  CashlogyHealth, CashlogyLevels, CashlogyOperationResponse, CashlogyRecoveryResult, CashlogyRequestedDenomination,
  CashlogyTotal, CashlogyTransaction, DiscoveryProgress, PrintJob, Printer,
} from '../types.ts'

type ClientOptions = { baseUrl: string; token?: string | null; defaultTimeoutMs?: number; fetchImpl?: typeof fetch }
type RequestOptions = {
  body?: unknown
  method?: 'GET' | 'POST' | 'PATCH'
  protected?: boolean
  retries?: number
  signal?: AbortSignal
  timeoutMs?: number
}

const errorCodes = new Set<PrintAgentErrorCode>([
  'INVALID_REQUEST', 'UNAUTHORIZED', 'ORIGIN_NOT_ALLOWED', 'PRINTER_NOT_CONFIGURED', 'PRINTER_NOT_FOUND',
  'PRINTER_CONNECTION_TIMEOUT', 'PRINTER_CONNECTION_REFUSED', 'PRINT_FAILED', 'PRINT_STATUS_UNKNOWN',
  'DISCOVERY_FAILED', 'TLS_CONFIGURATION_ERROR', 'CERTIFICATE_EXPIRED', 'CASH_DRAWER_FAILED', 'DUPLICATE_REQUEST',
])

const CASHLOGY_STACKER_TIMEOUT_MS = 910_000
const CASHLOGY_RECOVERY_TIMEOUT_MS = 240_000

export function buildPrintAgentHeaders(token?: string | null, hasBody = false) {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (hasBody) headers['Content-Type'] = 'application/json'
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function codeForStatus(status: number, body: unknown): PrintAgentErrorCode {
  const remoteCode = body && typeof body === 'object' ? (body as { code?: unknown; error?: { code?: unknown } }).code
    ?? (body as { error?: { code?: unknown } }).error?.code : undefined
  if (typeof remoteCode === 'string' && errorCodes.has(remoteCode as PrintAgentErrorCode)) return remoteCode as PrintAgentErrorCode
  if (status === 401) return 'UNAUTHORIZED'
  if (status === 403) return 'ORIGIN_NOT_ALLOWED'
  if (status === 409) return 'DUPLICATE_REQUEST'
  if (status === 400 || status === 422) return 'INVALID_REQUEST'
  return 'HTTP_ERROR'
}

async function parseResponse(response: Response) {
  const text = await response.text()
  if (!text) return null
  try { return JSON.parse(text) as unknown } catch {
    if (response.ok) throw new PrintAgentError({ code: 'INVALID_RESPONSE', message: 'El agente ha devuelto una respuesta que no es JSON.', status: response.status })
    return { message: text.slice(0, 500) }
  }
}

function responseMessage(body: unknown) {
  if (!body || typeof body !== 'object') return undefined
  const value = (body as { message?: unknown; error?: unknown }).message ?? (body as { error?: unknown }).error
  if (typeof value === 'string') return value
  if (value && typeof value === 'object' && typeof (value as { message?: unknown }).message === 'string') return (value as { message: string }).message
  return undefined
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => { globalThis.clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

export function createPrintAgentClient(options: ClientOptions) {
  const baseUrl = normalizePrintAgentUrl(options.baseUrl, {
    allowHttpInDevelopment: true,
    isDevelopment: import.meta.env?.DEV,
  })
  const fetchImpl = options.fetchImpl || fetch
  const defaultTimeoutMs = options.defaultTimeoutMs || DEFAULT_PRINT_AGENT_TIMEOUT_MS

  async function request<T>(path: string, requestOptions: RequestOptions = {}): Promise<T> {
    const method = requestOptions.method || 'GET'
    const requiresToken = requestOptions.protected !== false
    if (requiresToken && !options.token) throw new PrintAgentError({ code: 'UNAUTHORIZED', message: 'Configura el token del servidor de impresión.' })
    const attempts = Math.max(1, (requestOptions.retries || 0) + 1)

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController()
      const timeoutMs = requestOptions.timeoutMs || defaultTimeoutMs
      let timedOut = false
      const timeout = globalThis.setTimeout(() => { timedOut = true; controller.abort() }, timeoutMs)
      const abort = () => controller.abort(requestOptions.signal?.reason)
      requestOptions.signal?.addEventListener('abort', abort, { once: true })
      try {
        const response = await fetchImpl(`${baseUrl}${path}`, {
          body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
          cache: 'no-store',
          credentials: 'omit',
          headers: buildPrintAgentHeaders(requiresToken ? options.token : null, requestOptions.body !== undefined),
          method,
          mode: 'cors',
          signal: controller.signal,
        })
        const body = await parseResponse(response)
        if (!response.ok) {
          throw new PrintAgentError({
            code: codeForStatus(response.status, body),
            message: responseMessage(body),
            status: response.status,
            details: body,
          })
        }
        return body as T
      } catch (error) {
        const mapped = error instanceof PrintAgentError
          ? error
          : timedOut
            ? new PrintAgentError({ code: 'TIMEOUT', cause: error })
            : requestOptions.signal?.aborted
              ? new PrintAgentError({ code: 'ABORTED', cause: error })
              : new PrintAgentError({ code: 'NETWORK_ERROR', cause: error })
        if (attempt + 1 >= attempts || !['NETWORK_ERROR', 'TIMEOUT'].includes(mapped.code)) throw mapped
        await delay(250 * (attempt + 1), requestOptions.signal)
      } finally {
        globalThis.clearTimeout(timeout)
        requestOptions.signal?.removeEventListener('abort', abort)
      }
    }
    throw new PrintAgentError({ code: 'NETWORK_ERROR' })
  }

  async function discoverPrintersStream(onEvent: (event: { type: string; printer?: Printer; scanned?: number; total?: number; found?: number }) => void, signal?: AbortSignal) {
    if (!options.token) throw new PrintAgentError({ code: 'UNAUTHORIZED', message: 'Configura el token del servidor de impresión.' })
    const response = await fetchImpl(`${baseUrl}/api/v1/printers/discover/events`, {
      headers: { ...buildPrintAgentHeaders(options.token), Accept: 'text/event-stream' },
      cache: 'no-store', credentials: 'omit', mode: 'cors', signal,
    })
    if (!response.ok || !response.body) {
      const body = await parseResponse(response)
      throw new PrintAgentError({ code: codeForStatus(response.status, body), status: response.status, details: body })
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const events = buffer.split(/\r?\n\r?\n/)
      buffer = events.pop() || ''
      for (const block of events) {
        const data = block.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n')
        if (!data) continue
        try { onEvent(JSON.parse(data) as Parameters<typeof onEvent>[0]) } catch { /* ignora eventos no JSON */ }
      }
    }
  }

  return {
    baseUrl,
    health: (signal?: AbortSignal) => request<{ ok: boolean }>('/health', { protected: false, retries: 1, signal, timeoutMs: PRINT_AGENT_HEALTH_TIMEOUT_MS }),
    getServerInfo: (signal?: AbortSignal) => request<Record<string, unknown>>('/api/v1/server', { retries: 1, signal }),
    getDiscoveryInfo: (signal?: AbortSignal) => request<Record<string, unknown>>('/api/v1/discovery', { retries: 1, signal }),
    getPrinters: (signal?: AbortSignal) => request<{ printers?: Printer[] } | Printer[]>('/api/v1/printers', { retries: 1, signal }),
    discoverPrinters: (signal?: AbortSignal) => request<{ printers?: Printer[]; progress?: DiscoveryProgress }>('/api/v1/printers/discover', { method: 'POST', signal }),
    discoverPrintersStream,
    getSelectedPrinter: (signal?: AbortSignal) => request<{ printer?: Printer | null } | Printer | null>('/api/v1/printers/selected', { retries: 1, signal }),
    selectPrinter: (payload: unknown, signal?: AbortSignal) => request<{ ok: boolean; printer?: Printer }>('/api/v1/printers/select', { body: payload, method: 'POST', signal }),
    testPrinter: (payload: unknown, signal?: AbortSignal) => request<{ ok: boolean; jobId?: string; status?: string }>('/api/v1/printers/test', { body: payload, method: 'POST', signal }),
    printTicket: (payload: unknown, signal?: AbortSignal) => request<{ ok: boolean; jobId?: string; status?: string }>('/api/v1/print', { body: payload, method: 'POST', signal }),
    openCashDrawer: (payload: unknown, signal?: AbortSignal) => request<{ ok: boolean; jobId?: string; status?: string }>('/api/v1/cash-drawer/open', { body: payload, method: 'POST', signal }),
    getCashlogyHealth: (signal?: AbortSignal) => request<CashlogyHealth>('/api/v1/cashlogy/health', { retries: 1, signal }),
    discoverCashlogyConnectors: (signal?: AbortSignal) => request<{ connectors: CashlogyConnector[] }>('/api/v1/cashlogy/connectors/discover', { method: 'POST', signal }),
    getCashlogyConnectors: (signal?: AbortSignal) => request<{ connectors: CashlogyConnector[] }>('/api/v1/cashlogy/connectors', { retries: 1, signal }),
    selectCashlogyConnector: (connectorId: string, signal?: AbortSignal) => request<{ ok: true; connector: CashlogyConnector; device: CashlogyDevice | null }>(`/api/v1/cashlogy/connectors/${encodeURIComponent(connectorId)}/select`, { method: 'POST', signal }),
    initializeCashlogyConnector: (connectorId: string, signal?: AbortSignal) => request<{ ok: true; connector: CashlogyConnector; device: CashlogyDevice | null }>(`/api/v1/cashlogy/connectors/${encodeURIComponent(connectorId)}/initialize`, { method: 'POST', signal }),
    disconnectCashlogyConnector: (connectorId: string, signal?: AbortSignal) => request<{ ok: true }>(`/api/v1/cashlogy/connectors/${encodeURIComponent(connectorId)}/disconnect`, { method: 'POST', signal }),
    getCashlogyDevice: (signal?: AbortSignal) => request<{ device: CashlogyDevice | null }>('/api/v1/cashlogy/device', { retries: 1, signal }),
    getCashlogyDeviceVersion: (signal?: AbortSignal) => request<{ resultCode: string; payload: unknown; payloadText: string; parsed: unknown }>('/api/v1/cashlogy/device/version', { retries: 1, signal }),
    getCashlogyErrors: (signal?: AbortSignal) => request<{ response: unknown; errors: CashlogyDeviceError[] }>('/api/v1/cashlogy/device/errors', { retries: 1, signal }),
    getCashlogyAccounting: (signal?: AbortSignal) => request<CashlogyAccounting>('/api/v1/cashlogy/accounting', { retries: 1, signal }),
    getCashlogyTotal: (signal?: AbortSignal) => request<CashlogyTotal>('/api/v1/cashlogy/accounting/total', { retries: 1, signal }),
    getCashlogyDenominations: (signal?: AbortSignal) => request<CashlogyDenominations>('/api/v1/cashlogy/accounting/denominations', { retries: 1, signal }),
    getCashlogyLevels: (signal?: AbortSignal) => request<CashlogyLevels>('/api/v1/cashlogy/accounting/levels', { retries: 1, signal }),
    getCashlogyCapabilities: (signal?: AbortSignal) => request<CashlogyCapabilities>('/api/v1/cashlogy/accounting/capabilities', { retries: 1, signal }),
    createCashlogyCharge: (payload: CashlogyChargeRequest, signal?: AbortSignal) => request<{ ok: true; duplicate: boolean; transaction: CashlogyTransaction }>('/api/v1/cashlogy/transactions/charge', { body: payload, method: 'POST', signal }),
    getCashlogyTransactions: (limit = 100, signal?: AbortSignal) => request<{ transactions: CashlogyTransaction[] }>(`/api/v1/cashlogy/transactions?limit=${encodeURIComponent(String(limit))}`, { retries: 1, signal }),
    getCashlogyTransaction: (transactionId: string, signal?: AbortSignal) => request<{ transaction: CashlogyTransaction }>(`/api/v1/cashlogy/transactions/${encodeURIComponent(transactionId)}`, { retries: 1, signal }),
    getCashlogyTransactionByRequestId: (requestId: string, signal?: AbortSignal) => request<{ transaction: CashlogyTransaction }>(`/api/v1/cashlogy/transactions/by-request/${encodeURIComponent(requestId)}`, { retries: 1, signal }),
    cancelCashlogyTransaction: (transactionId: string, signal?: AbortSignal) => request<{ ok: true; duplicate: boolean; transaction: CashlogyTransaction }>(`/api/v1/cashlogy/transactions/${encodeURIComponent(transactionId)}/cancel`, { body: {}, method: 'POST', signal }),
    cancelActiveCashlogyOperation: (signal?: AbortSignal) => request<CashlogyCancelResponse>('/api/v1/cashlogy/cancel', { body: {}, method: 'POST', signal }),
    startCashlogyRefill: (requestId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>('/api/v1/cashlogy/cash-management/refill/start', { body: { requestId }, method: 'POST', signal }),
    getCashlogyRefill: (operationId: string, signal?: AbortSignal) => request<{ operation: CashlogyCashManagementOperation }>(`/api/v1/cashlogy/cash-management/refill/${encodeURIComponent(operationId)}`, { retries: 1, signal }),
    finalizeCashlogyRefill: (operationId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>(`/api/v1/cashlogy/cash-management/refill/${encodeURIComponent(operationId)}/finalize`, { body: {}, method: 'POST', signal }),
    startCashlogyGiveChange: (requestId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>('/api/v1/cashlogy/cash-management/give-change/start', { body: { requestId }, method: 'POST', signal }),
    getCashlogyGiveChange: (operationId: string, signal?: AbortSignal) => request<{ operation: CashlogyCashManagementOperation }>(`/api/v1/cashlogy/cash-management/give-change/${encodeURIComponent(operationId)}`, { retries: 1, signal }),
    finalizeCashlogyGiveChangeAdmission: (operationId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>(`/api/v1/cashlogy/cash-management/give-change/${encodeURIComponent(operationId)}/finalize-admission`, { body: {}, method: 'POST', signal }),
    dispenseCashlogyGiveChange: (operationId: string, denominations: CashlogyRequestedDenomination[], signal?: AbortSignal) => request<CashlogyOperationResponse>(`/api/v1/cashlogy/cash-management/give-change/${encodeURIComponent(operationId)}/dispense`, { body: { denominations }, method: 'POST', signal }),
    withdrawCashlogyCash: (requestId: string, denominations: CashlogyRequestedDenomination[], signal?: AbortSignal) => request<CashlogyOperationResponse>('/api/v1/cashlogy/cash-management/withdraw', { body: { requestId, denominations }, method: 'POST', signal }),
    emptyCashlogy: (requestId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>('/api/v1/cashlogy/cash-management/empty', { body: { requestId }, method: 'POST', signal }),
    collectCashlogyStacker: (requestId: string, signal?: AbortSignal) => request<CashlogyOperationResponse>('/api/v1/cashlogy/cash-management/stacker/collect', { body: { requestId }, method: 'POST', signal, timeoutMs: CASHLOGY_STACKER_TIMEOUT_MS }),
    getCashlogyCashManagementOperationByRequestId: (requestId: string, signal?: AbortSignal) => request<{ operation: CashlogyCashManagementOperation }>(`/api/v1/cashlogy/cash-management/operations/by-request/${encodeURIComponent(requestId)}`, { retries: 1, signal }),
    resetCashlogy: (signal?: AbortSignal) => request<{ ok: true; resultCode: string }>('/api/v1/cashlogy/admin/reset', { body: { confirmation: 'RESET_CASHLOGY' }, method: 'POST', signal }),
    recoverCashlogy: (signal?: AbortSignal) => request<CashlogyRecoveryResult>('/api/v1/cashlogy/admin/recover', { body: {}, method: 'POST', signal, timeoutMs: CASHLOGY_RECOVERY_TIMEOUT_MS }),
    getCashlogyDiagnosticLogs: (limit = 100, signal?: AbortSignal) => request<{ logs: CashlogyDiagnosticLog[] }>(`/api/v1/cashlogy/diagnostics/logs?limit=${encodeURIComponent(String(limit))}`, { retries: 1, signal }),
    getJobs: (signal?: AbortSignal) => request<{ jobs?: PrintJob[] } | PrintJob[]>('/api/v1/jobs', { retries: 1, signal }),
    getJob: (jobId: string, signal?: AbortSignal) => request<PrintJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, { retries: 1, signal }),
    findJobByRequestId: async (requestId: string, signal?: AbortSignal) => {
      const result = await request<{ jobs?: PrintJob[] } | PrintJob[]>(`/api/v1/jobs?requestId=${encodeURIComponent(requestId)}`, { retries: 1, signal })
      const jobs = Array.isArray(result) ? result : result.jobs || []
      return jobs.find((job) => job.requestId === requestId) || null
    },
    getConfig: (signal?: AbortSignal) => request<Record<string, unknown>>('/api/v1/config', { retries: 1, signal }),
    updateConfig: (payload: unknown, signal?: AbortSignal) => request<Record<string, unknown>>('/api/v1/config', { body: payload, method: 'PATCH', signal }),
  }
}

export type PrintAgentClient = ReturnType<typeof createPrintAgentClient>
