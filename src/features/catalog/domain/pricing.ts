import { calculateSaleLineTotals } from '../services/saleLineBuilder.ts'
import { calculateTaxFromGross } from '../../../lib/tax.ts'
import { CatalogDomainError } from './errors.ts'
import type { CatalogPriceBreakdown, CatalogPriceModifier, CatalogPriceSelection } from './types.ts'

function assertCents(value: number, name: string, signed = false) {
  if (!Number.isSafeInteger(value) || (!signed && value < 0)) {
    throw new CatalogDomainError('CATALOG_INCONSISTENT', `${name} debe ser un entero en céntimos.`, { value })
  }
}

function assertQuantity(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CatalogDomainError('CATALOG_SELECTION_OUT_OF_BOUNDS', `${name} debe ser una cantidad entera no negativa.`, { value })
  }
}

export function calculateCatalogPrice(input: {
  baseVariantPriceCents: number
  selections?: readonly CatalogPriceSelection[]
  modifiers?: readonly CatalogPriceModifier[]
  discountCents?: number
  vatRate: number
}): CatalogPriceBreakdown {
  const selections = input.selections ?? []
  const modifiers = input.modifiers ?? []
  const discountCents = input.discountCents ?? 0
  assertCents(input.baseVariantPriceCents, 'El precio de variante')
  assertCents(discountCents, 'El descuento')
  for (const selection of selections) {
    assertCents(selection.supplementCents, 'El suplemento de selección', true)
    assertQuantity(selection.quantity, 'La cantidad de selección')
  }
  for (const modifier of modifiers) {
    assertCents(modifier.supplementCents, 'El suplemento de modificador', true)
    assertQuantity(modifier.quantity ?? 1, 'La cantidad de modificador')
  }

  let totals: ReturnType<typeof calculateSaleLineTotals>
  try {
    totals = calculateSaleLineTotals(
      { priceCents: input.baseVariantPriceCents },
      selections.map((selection) => ({ priceDeltaCents: selection.supplementCents, quantity: selection.quantity, modifiers: [] })),
      modifiers.flatMap((modifier) => Array.from({ length: modifier.quantity ?? 1 }, () => ({ priceCents: modifier.supplementCents }))),
    )
  } catch (cause) {
    throw new CatalogDomainError(
      'CATALOG_NEGATIVE_FINAL_PRICE',
      'El precio unitario final no puede ser negativo.',
      undefined,
      { cause },
    )
  }
  const netUnitPriceCents = totals.grossBeforeDiscountCents - discountCents
  if (netUnitPriceCents < 0) {
    throw new CatalogDomainError('CATALOG_NEGATIVE_FINAL_PRICE', 'El precio unitario final no puede ser negativo.', {
      grossUnitPriceCents: totals.grossBeforeDiscountCents,
      discountCents,
    })
  }
  const tax = calculateTaxFromGross(netUnitPriceCents, input.vatRate)
  const menuSupplementsCents = selections.filter((selection) => selection.type === 'menu_component')
    .reduce((total, selection) => total + selection.supplementCents * selection.quantity, 0)
  const selectionSupplementsCents = selections.filter((selection) => selection.type !== 'menu_component')
    .reduce((total, selection) => total + selection.supplementCents * selection.quantity, 0)
  const modifierSupplementsCents = modifiers.reduce(
    (total, modifier) => total + modifier.supplementCents * (modifier.quantity ?? 1),
    0,
  )
  return {
    baseVariantPriceCents: totals.basePriceCents,
    selectionSupplementsCents,
    modifierSupplementsCents,
    menuSupplementsCents,
    grossUnitPriceCents: totals.grossBeforeDiscountCents,
    discountCents,
    netUnitPriceCents,
    vatRate: input.vatRate,
    taxableBaseCents: tax.taxableBaseCents,
    taxAmountCents: tax.taxAmountCents,
    finalUnitPriceCents: netUnitPriceCents,
  }
}
