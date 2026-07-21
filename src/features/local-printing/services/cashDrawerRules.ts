type Payment = { method?: string | null; amountCents?: number }

export type AutomaticSaleHardwareAction = 'print' | 'open_drawer' | 'none'

export function shouldOpenCashDrawer(input: {
  payments: Payment[]
  isReprint?: boolean
  settings: { autoOpenCashDrawer?: boolean }
}) {
  if (input.isReprint || input.settings.autoOpenCashDrawer !== true) return false
  return input.payments.some((payment) => payment.method === 'cash' && (payment.amountCents === undefined || payment.amountCents > 0))
}

export function getAutomaticSaleHardwareAction(input: {
  payments: Payment[]
  isReprint?: boolean
  settings: { alwaysPrintTicket?: boolean; autoOpenCashDrawer?: boolean }
}): AutomaticSaleHardwareAction {
  if (input.isReprint || input.settings.alwaysPrintTicket !== false) return 'print'
  return shouldOpenCashDrawer({ payments: input.payments, settings: input.settings }) ? 'open_drawer' : 'none'
}

