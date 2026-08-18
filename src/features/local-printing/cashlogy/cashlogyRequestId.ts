import type { CashlogyCashManagementType } from '../types'

const operationNames: Record<CashlogyCashManagementType | 'payment', string> = {
  payment: 'sale',
  refill: 'refill',
  give_change: 'give-change',
  withdraw: 'withdraw',
  empty: 'empty',
  remove_stacker: 'stacker',
}

export function createCashlogyRequestId(type: CashlogyCashManagementType | 'payment') {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
  return `cashlogy:${operationNames[type]}:${random}`.replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 200)
}
