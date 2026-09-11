import { getCashlogyIntentStorageKey } from './cashlogyStorage.ts'
import type { PrintAgentScope } from '../types.ts'

type Acknowledgement = { transactionId: string; reviewed: boolean }

// Persist before clearing the payment intent. A restart or failed HTTP response
// must not lose the acknowledgement, nor make a settled sale payable again.
export function cashlogyAcknowledgements(scope: PrintAgentScope, baseUrl: string) {
  const key = `${getCashlogyIntentStorageKey(scope)}:acknowledgements:${baseUrl}`
  const read = (): Acknowledgement[] => JSON.parse(window.localStorage.getItem(key) ?? '[]')
  return {
    contains(transactionId: string) { return read().some((item) => item.transactionId === transactionId) },
    add(transactionId: string, reviewed: boolean) {
      const pending = read().filter((item) => item.transactionId !== transactionId)
      window.localStorage.setItem(key, JSON.stringify([...pending, { transactionId, reviewed }]))
    },
    async flush(acknowledge: (id: string, reviewed: boolean) => Promise<unknown>) {
      for (const item of read()) {
        await acknowledge(item.transactionId, item.reviewed)
        const pending = read().filter((entry) => entry.transactionId !== item.transactionId)
        if (pending.length) window.localStorage.setItem(key, JSON.stringify(pending))
        else window.localStorage.removeItem(key)
      }
    },
  }
}
