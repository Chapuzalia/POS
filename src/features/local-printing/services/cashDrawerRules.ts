type Payment = { method?: string | null; amountCents?: number }

export function shouldOpenCashDrawer(input: {
  payments: Payment[]
  isReprint?: boolean
  settings: { autoOpenCashDrawer?: boolean }
}) {
  if (input.isReprint || input.settings.autoOpenCashDrawer !== true) return false
  return input.payments.some((payment) => payment.method === 'cash' && (payment.amountCents === undefined || payment.amountCents > 0))
}

