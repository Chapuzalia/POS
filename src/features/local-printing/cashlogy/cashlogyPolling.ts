import type {
  CashlogyCashManagementOperation,
  CashlogyCashManagementStatus,
  CashlogyTransaction,
  CashlogyTransactionStatus,
} from '../types.ts'
import { CashlogyError } from './cashlogyError.ts'

export const cashlogyActiveStatuses = new Set<CashlogyTransactionStatus>([
  'queued', 'connecting', 'initializing', 'starting_acceptance', 'waiting_for_cash',
  'finalizing_acceptance', 'dispensing_change', 'processing',
])

export const cashlogyTerminalStatuses = new Set<CashlogyTransactionStatus>([
  'completed', 'cancelled', 'failed', 'unknown', 'needs_attention',
])

export const cashlogyCancellableStatuses = new Set<CashlogyTransactionStatus>([
  'queued', 'connecting', 'initializing', 'starting_acceptance', 'waiting_for_cash',
])

export const cashlogyManagementActiveStatuses = new Set<CashlogyCashManagementStatus>([
  'starting', 'accepting', 'finalizing_acceptance', 'awaiting_dispense', 'dispensing', 'processing',
])

export const cashlogyManagementCancellableStatuses = new Set<CashlogyCashManagementStatus>([
  'starting', 'accepting',
])

export const cashlogyManagementTerminalStatuses = new Set<CashlogyCashManagementStatus>([
  'completed', 'cancelled', 'failed', 'unknown', 'needs_attention',
])

function delay(ms: number, signal?: AbortSignal) {
  if (signal?.aborted) return Promise.reject(signal.reason)
  return new Promise<void>((resolve, reject) => {
    const finish = () => {
      signal?.removeEventListener('abort', abort)
      resolve()
    }
    const timer = globalThis.setTimeout(finish, ms)
    const abort = () => {
      globalThis.clearTimeout(timer)
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', abort, { once: true })
  })
}

export async function pollCashlogyTransaction(
  getTransaction: (transactionId: string, signal?: AbortSignal) => Promise<{ transaction: CashlogyTransaction }>,
  transaction: CashlogyTransaction,
  options: { intervalMs?: number; timeoutMs?: number; signal?: AbortSignal; onUpdate?: (transaction: CashlogyTransaction) => void } = {},
) {
  const controller = new AbortController()
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal
  let timer: ReturnType<typeof globalThis.setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    if (options.timeoutMs === undefined) return
    timer = globalThis.setTimeout(() => {
      const error = new CashlogyError({ code: 'CASHLOGY_CONNECTION_TIMEOUT', message: 'Cashlogy no ha confirmado el final del movimiento a tiempo. El cobro sigue pendiente. Consulta su estado o vuelve a intentar la cancelación; no inicies otro cobro hasta resolverlo.' })
      controller.abort(error)
      reject(error)
    }, options.timeoutMs)
  })
  const poll = async () => {
    let current = transaction
    while (cashlogyActiveStatuses.has(current.status)) {
      await delay(options.intervalMs ?? 500, signal)
      current = (await getTransaction(current.id, signal)).transaction
      signal.throwIfAborted()
      options.onUpdate?.(current)
    }
    return current
  }
  try {
    return await Promise.race([poll(), timeout])
  } finally {
    globalThis.clearTimeout(timer)
  }
}


export async function pollCashlogyOperation(
  getOperation: (operation: CashlogyCashManagementOperation, signal?: AbortSignal) => Promise<{ operation: CashlogyCashManagementOperation }>,
  operation: CashlogyCashManagementOperation,
  options: {
    intervalMs?: number
    signal?: AbortSignal
    onUpdate?: (operation: CashlogyCashManagementOperation) => void
    shouldContinue?: (operation: CashlogyCashManagementOperation) => boolean
  } = {},
) {
  let current = operation
  const intervalMs = options.intervalMs ?? 500
  const shouldContinue = options.shouldContinue ?? ((candidate) => cashlogyManagementActiveStatuses.has(candidate.status))
  while (shouldContinue(current)) {
    await delay(intervalMs, options.signal)
    current = (await getOperation(current, options.signal)).operation
    options.onUpdate?.(current)
  }
  return current
}
