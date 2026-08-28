import type { CashlogyCashManagementOperation, CashlogyManagementIntent } from '../types.ts'

export type CashlogyStackerCollection = {
  cashSessionId: string
  requestId: string
  operationId: string
  amountCents: number
}

export function getCompletedStackerCollection(
  operation: CashlogyCashManagementOperation,
  intent: CashlogyManagementIntent | null,
): CashlogyStackerCollection | null {
  if (operation.type !== 'remove_stacker' || operation.status !== 'completed') return null
  if (!intent?.cashSessionId || operation.requestId !== intent.requestId) return null
  if (!Number.isInteger(operation.dispensedCents) || operation.dispensedCents === null || operation.dispensedCents < 0) return null
  if (!operation.id.trim() || !operation.requestId.trim()) return null
  return {
    cashSessionId: intent.cashSessionId,
    requestId: operation.requestId,
    operationId: operation.id,
    amountCents: operation.dispensedCents,
  }
}
