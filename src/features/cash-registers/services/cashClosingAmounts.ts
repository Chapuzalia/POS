import type { CashClosingPrintSnapshot } from '../../../types/domain.ts'

export function getClosingPaymentCents(
  snapshot: Pick<CashClosingPrintSnapshot, 'payments'>,
  code: string,
) {
  return snapshot.payments.reduce(
    (total, payment) =>
      payment.code.toLocaleLowerCase() === code.toLocaleLowerCase()
        ? total + payment.amountCents
        : total,
    0,
  )
}

export function getCashClosingAmounts(
  snapshot: Pick<
    CashClosingPrintSnapshot,
    'cashFund' | 'expectedAndCounted' | 'payments'
  >,
) {
  return {
    billedCardCents: getClosingPaymentCents(snapshot, 'card'),
    billedCashCents: getClosingPaymentCents(snapshot, 'cash'),
    cardTerminalExpectedCents:
      snapshot.expectedAndCounted.expectedCardCents,
    cashOverOpeningFundCents:
      snapshot.expectedAndCounted.countedCashCents -
      snapshot.cashFund.openingCashFundCents,
    cashToWithdrawCents:
      snapshot.expectedAndCounted.countedCashCents -
      snapshot.cashFund.finalCashFundCents,
  }
}
