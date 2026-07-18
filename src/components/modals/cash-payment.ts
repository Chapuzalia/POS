export const cashDenominationsCents = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] as const

export function addCashDenomination(currentCents: number, denominationCents: number, replaceInitialExact: boolean) {
  return (replaceInitialExact ? 0 : Math.max(0, currentCents)) + denominationCents
}
