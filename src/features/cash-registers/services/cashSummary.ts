import type { CashMovement, CashSummary, SaleRecord } from '../../../types/domain.ts'

export function getExpectedCashAfterStackerCollections(
  expectedCashCents: number,
  stackerCollectionsCents: number,
) {
  return expectedCashCents - stackerCollectionsCents
}

export function summarizeSales(
  openingFloatCents: number,
  records: SaleRecord[],
  cashMovements: CashMovement[] = [],
): CashSummary {
  const summary = records.reduce(
    (totals, record) => {
      const payments = record.payments?.length ? record.payments : [{ method: record.paymentMethod, amountCents: record.totalCents }]
      for (const payment of payments) {
        if (payment.method === 'cash') totals.cashCents += payment.amountCents
        else if (payment.method === 'card') totals.cardCents += payment.amountCents
        else if (payment.method === 'invitation') totals.invitationCents += payment.amountCents
        else totals.otherCents += payment.amountCents
      }
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
