export const COMMON_TAX_RATES = [21, 10, 4, 0] as const

export const MAX_TAX_RATE = 100

export type TaxBreakdown = {
  grossTotalCents: number
  taxAmountCents: number
  taxableBaseCents: number
}

function assertMoneyCents(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} debe ser un importe no negativo en centimos.`)
  }
}

export function isValidTaxRate(value: number) {
  return Number.isFinite(value) && value >= 0 && value <= MAX_TAX_RATE
}

function assertTaxRate(value: number) {
  if (!isValidTaxRate(value)) {
    throw new RangeError(`El tipo de IVA debe estar entre 0 y ${MAX_TAX_RATE}.`)
  }
}

export function resolveEffectiveTaxRate(
  productTaxRate: number | null | undefined,
  defaultTaxRate: number,
) {
  const effectiveTaxRate = productTaxRate ?? defaultTaxRate
  assertTaxRate(effectiveTaxRate)
  return effectiveTaxRate
}

export function calculateTaxFromGross(grossTotalCents: number, taxRate: number): TaxBreakdown {
  assertMoneyCents(grossTotalCents, 'El precio final')
  assertTaxRate(taxRate)

  const taxableBaseCents = Math.round((grossTotalCents * 100) / (100 + taxRate))
  return {
    grossTotalCents,
    taxableBaseCents,
    taxAmountCents: grossTotalCents - taxableBaseCents,
  }
}

export function calculateGrossFromNet(taxableBaseCents: number, taxRate: number): TaxBreakdown {
  assertMoneyCents(taxableBaseCents, 'La base imponible')
  assertTaxRate(taxRate)

  const taxAmountCents = Math.round((taxableBaseCents * taxRate) / 100)
  return {
    grossTotalCents: taxableBaseCents + taxAmountCents,
    taxableBaseCents,
    taxAmountCents,
  }
}
