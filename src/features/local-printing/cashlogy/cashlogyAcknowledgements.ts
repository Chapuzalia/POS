import { getCashlogyIntentStorageKey } from './cashlogyStorage.ts'
import type { CashlogyIntent, PrintAgentScope } from '../types.ts'

type Acknowledgement = { transactionId: string; reviewed: boolean; cancelledIntent?: CashlogyIntent; confirmedIntent?: CashlogyIntent }

// Persist before clearing the payment intent. A restart or failed HTTP response
// must not lose the acknowledgement, nor make a settled sale payable again.
export function cashlogyAcknowledgements(scope: PrintAgentScope, baseUrl: string) {
  const key = `${getCashlogyIntentStorageKey(scope)}:acknowledgements:${baseUrl}`
  const read = (): Acknowledgement[] => JSON.parse(window.localStorage.getItem(key) ?? '[]')
  return {
    contains(transactionId: string) { return read().some((item) => item.transactionId === transactionId) },
    isCancelled(requestId: string) { return read().some(item => item.cancelledIntent?.requestId === requestId) },
    isConfirmed(requestId: string) { return read().some(item => item.confirmedIntent?.requestId === requestId) },
    confirm(intent: CashlogyIntent) {
      const pending = read().filter(item => item.confirmedIntent?.requestId !== intent.requestId)
      window.localStorage.setItem(key, JSON.stringify([...pending, {
        transactionId: intent.transactionId ?? `request:${intent.requestId}`, reviewed: true, confirmedIntent: intent,
      }]))
    },
    cancel(intent: CashlogyIntent) {
      const pending = read().filter(item => item.cancelledIntent?.requestId !== intent.requestId)
      window.localStorage.setItem(key, JSON.stringify([...pending, {
        transactionId: intent.transactionId ?? `request:${intent.requestId}`, reviewed: true, cancelledIntent: intent,
      }]))
    },
    removeCancellation(requestId: string) {
      const pending = read().filter(item => item.cancelledIntent?.requestId !== requestId)
      if (pending.length) window.localStorage.setItem(key, JSON.stringify(pending))
      else window.localStorage.removeItem(key)
    },
    add(transactionId: string, reviewed: boolean) {
      const pending = read().filter((item) => item.transactionId !== transactionId)
      window.localStorage.setItem(key, JSON.stringify([...pending, { transactionId, reviewed }]))
    },
    async flush(acknowledge: (id: string, reviewed: boolean) => Promise<unknown>, cancel?: (intent: CashlogyIntent) => Promise<void>, confirm?: (intent: CashlogyIntent) => Promise<void>) {
      for (const item of read()) {
        if (item.cancelledIntent) {
          if (!cancel) continue
          await cancel(item.cancelledIntent)
        } else if (item.confirmedIntent) {
          if (!confirm) continue
          await confirm(item.confirmedIntent)
        } else await acknowledge(item.transactionId, item.reviewed)
        const pending = read().filter((entry) => entry.transactionId !== item.transactionId)
        if (pending.length) window.localStorage.setItem(key, JSON.stringify(pending))
        else window.localStorage.removeItem(key)
      }
    },
  }
}
