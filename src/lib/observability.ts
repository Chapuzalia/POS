import { captureException, addBreadcrumb } from '@sentry/react'
import { sanitizeDiagnosticText } from './observabilityPrivacy.ts'

export type OperationContext = {
  operation: string
  operationId?: string | null
  saleId?: string | null
  ticketId?: string | null
  cashSessionId?: string | null
  tableId?: string | null
  integration?: string
  step?: string
  syncStatus?: string
  online?: boolean
  expected?: boolean
  recoverable?: boolean
}

const seen = new WeakSet<object>()
const recent = new Map<string, number>()
const expectedCodes = new Set(['invalid_credentials', 'email_not_confirmed', 'user_already_exists', 'CASHLOGY_OPERATION_CANCELLED', 'CASHLOGY_BUSY', 'CASHLOGY_NOT_CONFIGURED', 'CASHLOGY_DISABLED', 'ABORTED', 'DUPLICATE_REQUEST'])

export function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined
  return typeof error.code === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(error.code) ? error.code : undefined
}

export function isTransportError(error: unknown) {
  const message = error instanceof Error ? error.message : error && typeof error === 'object' && 'message' in error ? String(error.message) : ''
  return /Failed to fetch|Load failed|NetworkError|network request failed|Servidor temporalmente inaccesible|fetch failed/i.test(message)
    || (error instanceof Error && error.name === 'AbortError')
}

export function shouldReportError(error: unknown, context: OperationContext) {
  if (context.expected || (error && typeof error === 'object' && 'expected' in error && error.expected === true)) return false
  if (expectedCodes.has(errorCode(error) ?? '')) return false
  // A disconnected browser does not make a failed local write or hardware charge harmless.
  if (context.recoverable && isTransportError(error)) return false
  return true
}

export function operationBreadcrumb(context: OperationContext) {
  try {
    addBreadcrumb({ category: 'pos.operation', message: context.operation, level: 'info', data: safeOperationContext(context) })
  } catch { /* Telemetry must not interrupt the operation. */ }
}

export function safeOperationContext(context: OperationContext) {
  const result: Record<string, string | boolean> = { online: context.online ?? (typeof navigator === 'undefined' || navigator.onLine) }
  for (const key of ['operation', 'operationId', 'saleId', 'ticketId', 'cashSessionId', 'tableId', 'integration', 'step', 'syncStatus'] as const) {
    const value = context[key]
    if (typeof value === 'string' && /^[\w.:/-]{1,160}$/.test(value)) result[key] = value
  }
  return result
}

/** Capture at the boundary that knows whether recovery succeeded. Never throw from telemetry. */
export function reportOperationError(error: unknown, context: OperationContext) {
  try {
    if (!shouldReportError(error, context)) return
    const chain: object[] = []
    let cause = error
    while (cause && typeof cause === 'object' && !chain.includes(cause) && chain.length < 8) {
      if (seen.has(cause)) return
      chain.push(cause)
      cause = 'cause' in cause ? cause.cause : undefined
    }
    const code = errorCode(error)
    const data = safeOperationContext(context)
    const signature = error instanceof Error ? `${error.name}:${sanitizeDiagnosticText(error.message)}` : code
    const key = JSON.stringify([data.operation, data.operationId, data.saleId, data.ticketId, data.cashSessionId, data.step, code, signature])
    const now = Date.now()
    if (now - (recent.get(key) ?? 0) < 60_000) return
    if (recent.size >= 500) recent.delete(recent.keys().next().value!)
    recent.set(key, now)
    chain.forEach((item) => seen.add(item))
    captureException(error, {
      tags: { operation: data.operation, integration: data.integration, step: data.step, errorCode: code },
      contexts: { operation: { ...data, errorCode: code } },
    })
  } catch { /* Observability must never interrupt payment or recovery. */ }
}
