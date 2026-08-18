import type {
  CashlogyAccounting,
  CashlogyCashManagementOperation,
  CashlogyRequestedDenomination,
} from '../types'

export type CashlogyDenominationOption = {
  valueCents: number
  availableQuantity: number
  kind: 'coin' | 'note'
}

export function denominationTotalCents(denominations: CashlogyRequestedDenomination[]) {
  return denominations.reduce((total, denomination) => (
    total + denomination.valueCents * denomination.quantity
  ), 0)
}

export function selectedDenominations(quantities: Record<number, number>) {
  return Object.entries(quantities)
    .map(([valueCents, quantity]) => ({ valueCents: Number(valueCents), quantity }))
    .filter(({ valueCents, quantity }) => Number.isInteger(valueCents) && valueCents > 0 && Number.isInteger(quantity) && quantity > 0)
    .sort((left, right) => right.valueCents - left.valueCents)
}

export function getDispensableDenominations(accounting: CashlogyAccounting | null): CashlogyDenominationOption[] {
  if (!accounting) return []
  const capabilities = new Map(
    accounting.capabilities.capabilities
      .filter((capability) => capability.valueCents !== null)
      .map((capability) => [capability.valueCents as number, capability]),
  )
  const hasSpecificCapabilities = capabilities.size > 0
  return [
    ...accounting.denominations.notes.map((item) => ({ ...item, kind: 'note' as const })),
    ...accounting.denominations.coins.map((item) => ({ ...item, kind: 'coin' as const })),
  ]
    .filter((item) => item.recyclerCount > 0 && (!hasSpecificCapabilities || capabilities.get(item.valueCents)?.dispensable === true))
    .map((item) => ({ valueCents: item.valueCents, availableQuantity: item.recyclerCount, kind: item.kind }))
    .sort((left, right) => right.valueCents - left.valueCents)
}

export function cashlogyOperationResultCents(operation: CashlogyCashManagementOperation) {
  if (operation.type === 'refill' || operation.type === 'give_change') return operation.acceptedCents
  return operation.dispensedCents
}
