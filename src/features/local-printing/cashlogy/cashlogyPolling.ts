import type { CashlogyTransaction, CashlogyTransactionStatus } from '../types.ts'

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

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timer = globalThis.setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      globalThis.clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

export async function pollCashlogyTransaction(
  getTransaction: (transactionId: string, signal?: AbortSignal) => Promise<{ transaction: CashlogyTransaction }>,
  transaction: CashlogyTransaction,
  options: { intervalMs?: number; signal?: AbortSignal; onUpdate?: (transaction: CashlogyTransaction) => void } = {},
) {
  let current = transaction
  const intervalMs = options.intervalMs ?? 1000
  while (cashlogyActiveStatuses.has(current.status)) {
    await delay(intervalMs, options.signal)
    current = (await getTransaction(current.id, options.signal)).transaction
    options.onUpdate?.(current)
  }
  return current
}
