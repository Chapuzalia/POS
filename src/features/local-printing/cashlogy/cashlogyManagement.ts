import type {
  CashlogyAccounting,
  CashlogyAvailableDenomination,
  CashlogyCashManagementOperation,
  CashlogyRequestedDenomination,
} from '../types'

export type CashlogyDenominationOption = CashlogyAvailableDenomination

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

export function suggestCashlogyDenominations(
  options: CashlogyDenominationOption[],
  targetCents: number,
): CashlogyRequestedDenomination[] {
  if (!Number.isInteger(targetCents) || targetCents <= 0) return []
  let combinations = new Map<number, CashlogyRequestedDenomination[]>([[0, []]])
  for (const option of [...options].sort((left, right) => right.valueCents - left.valueCents)) {
    if (!Number.isInteger(option.valueCents) || option.valueCents <= 0 || option.availableQuantity <= 0) continue
    const previous = [...combinations.entries()]
    const next = new Map(combinations)
    for (const [subtotal, denominations] of previous) {
      const maximum = Math.min(option.availableQuantity, Math.floor((targetCents - subtotal) / option.valueCents))
      for (let quantity = 1; quantity <= maximum; quantity += 1) {
        const total = subtotal + option.valueCents * quantity
        if (!next.has(total)) next.set(total, [...denominations, { valueCents: option.valueCents, quantity }])
      }
    }
    combinations = next
    const exact = combinations.get(targetCents)
    if (exact) return exact
  }
  return []
}

export function cashlogyOperationResultCents(operation: CashlogyCashManagementOperation) {
  if (operation.type === 'refill' || operation.type === 'give_change') return operation.acceptedCents
  return operation.dispensedCents
}
