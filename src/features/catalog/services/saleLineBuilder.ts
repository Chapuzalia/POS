import * as base from './saleLineBuilder-base.ts'

export type { SaleLineContext, SaleLineTotals } from './saleLineBuilder-base.ts'

export function calculateSaleLineTotals(...parameters: Parameters<typeof base.calculateSaleLineTotals>): ReturnType<typeof base.calculateSaleLineTotals> {
  const totals = base.calculateSaleLineTotals(...parameters)
  if (totals.grossBeforeDiscountCents < 0) throw new Error('El precio unitario final no puede ser negativo.')
  return totals
}

export function buildSaleLine(...parameters: Parameters<typeof base.buildSaleLine>): ReturnType<typeof base.buildSaleLine> {
  const line = base.buildSaleLine(...parameters)
  if (line.unitPriceCents < 0) throw new Error('El precio unitario final no puede ser negativo.')
  return line
}

export const validateProductLineSelection = base.validateProductLineSelection
export const getDefaultProductLineSelection = base.getDefaultProductLineSelection
export const buildCatalogSnapshot = base.buildCatalogSnapshot
export const serializeSaleLine = base.serializeSaleLine
export const getSaleLineConsumption = base.getSaleLineConsumption
export const wouldCreateMenuCycle = base.wouldCreateMenuCycle
