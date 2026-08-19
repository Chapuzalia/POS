import type { CashlogyTotal } from '../types'

export function validateCashlogyTotal(total: CashlogyTotal) {
  const amounts = [total.recyclerTotalCents, total.stackerTotalCents, total.totalCents]
  if (amounts.some((amount) => !Number.isSafeInteger(amount) || amount < 0)) {
    throw new Error('Cashlogy ha devuelto un fondo de efectivo no válido.')
  }
  if (total.recyclerTotalCents + total.stackerTotalCents !== total.totalCents) {
    throw new Error('El total de Cashlogy no coincide con el contenido de la máquina.')
  }
  return total
}
