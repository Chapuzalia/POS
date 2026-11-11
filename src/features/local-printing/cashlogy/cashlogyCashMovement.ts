import type { CashlogyCashManagementOperation, CashlogyManagementIntent } from '../types'

export function getCompletedCashlogyMovement(
  operation: CashlogyCashManagementOperation,
  intent: CashlogyManagementIntent | null,
) {
  // Older intents and operations outside an open shift have no movement to register.
  if (!intent?.cashSessionId || !intent.cashMovementRequestId || operation.status !== 'completed') return null
  if (operation.type === 'remove_stacker') return null
  if (operation.requestId !== intent.requestId || operation.type !== intent.type) {
    throw new Error('La operación Cashlogy no coincide con el movimiento de caja pendiente.')
  }

  const validAmount = (amount: number | null): amount is number => Number.isSafeInteger(amount) && amount !== null && amount >= 0
  let netCents: number
  if (operation.type === 'refill') {
    if (!validAmount(operation.acceptedCents)) throw new Error('Cashlogy no ha confirmado el importe introducido.')
    netCents = operation.acceptedCents
  } else if (operation.type === 'give_change') {
    if (!validAmount(operation.acceptedCents) || !validAmount(operation.dispensedCents)) {
      throw new Error('Cashlogy no ha confirmado los importes del cambio.')
    }
    netCents = operation.acceptedCents - operation.dispensedCents
  } else {
    if (!validAmount(operation.dispensedCents)) throw new Error('Cashlogy no ha confirmado el importe retirado.')
    netCents = -operation.dispensedCents
  }
  if (netCents === 0) return null

  return {
    cashSessionId: intent.cashSessionId,
    type: netCents > 0 ? 'cash_in' as const : 'cash_out' as const,
    amountCents: Math.abs(netCents),
    notes: netCents > 0 ? 'Entrada de efectivo en Cashlogy' : 'Salida de efectivo de Cashlogy',
    requestId: intent.cashMovementRequestId,
  }
}
