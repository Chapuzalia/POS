type Payment = { method?: string | null; amountCents?: number }

export type AutomaticSaleHardwareAction = 'print' | 'open_drawer' | 'none'

export function shouldOpenCashDrawer(input: {
  payments: Payment[]
  isReprint?: boolean
  settings: { autoOpenCashDrawer?: boolean; cashlogyConfigured?: boolean }
}) {
  if (input.isReprint || input.settings.cashlogyConfigured || input.settings.autoOpenCashDrawer !== true) return false
  return input.payments.some((payment) => payment.method === 'cash' && (payment.amountCents === undefined || payment.amountCents > 0))
}

export function getAutomaticSaleHardwareAction(input: {
  payments: Payment[]
  isReprint?: boolean
  settings: { alwaysPrintTicket?: boolean; autoOpenCashDrawer?: boolean; cashlogyConfigured?: boolean }
}): AutomaticSaleHardwareAction {
  if (input.settings.cashlogyConfigured && input.payments.some((payment) => payment.method === 'cash')) return 'print'
  if (input.isReprint || input.settings.alwaysPrintTicket !== false) return 'print'
  return shouldOpenCashDrawer({ payments: input.payments, settings: input.settings }) ? 'open_drawer' : 'none'
}

