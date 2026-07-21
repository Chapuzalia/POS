import type { CashMovement, CashSummary, SaleRecord } from '../../../types/domain.ts'

export function summarizeSales(
  openingFloatCents: number,
  records: SaleRecord[],
  cashMovements: CashMovement[] = [],
): CashSummary {
  const summary = records.reduce(
    (totals, record) => {
      if (record.paymentMethod === 'cash') totals.cashCents += record.totalCents
      else if (record.paymentMethod === 'card') totals.cardCents += record.totalCents
      else if (record.paymentMethod === 'invitation') totals.invitationCents += record.totalCents
      else totals.otherCents += record.totalCents
      totals.totalSalesCents += record.totalCents
      return totals
    },
    {
      cashCents: openingFloatCents,
      cardCents: 0,
      invitationCents: 0,
      otherCents: 0,
      totalSalesCents: 0,
      cashEntriesCents: 0,
      cashExitsCents: 0,
      cardCashbackCents: 0,
    },
  )

  for (const movement of cashMovements) {
    if (movement.type === 'cash_in') {
      summary.cashEntriesCents += movement.amountCents
      summary.cashCents += movement.amountCents
    } else if (movement.type === 'cash_out') {
      summary.cashExitsCents += movement.amountCents
      summary.cashCents -= movement.amountCents
    } else if (movement.type === 'card_cashback') {
      summary.cardCashbackCents += movement.amountCents
      summary.cashCents -= movement.amountCents
      summary.cardCents += movement.amountCents
    }
  }

  return summary
}
