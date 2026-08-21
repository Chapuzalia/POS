import type { Printer } from '../types.ts'

export async function recoverSelectedPrinter(
  remotePrinter: Printer | null,
  storedPrinterId: string | null,
  selectPrinter: (printerId: string) => Promise<Printer>,
) {
  if (remotePrinter?.id || !storedPrinterId) return remotePrinter
  return selectPrinter(storedPrinterId)
}
