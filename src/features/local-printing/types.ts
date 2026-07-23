export type ConnectionStatus = 'unknown' | 'checking' | 'connected' | 'disconnected' | 'certificate-error' | 'cors-error' | 'unauthorized'
export type DiscoveryStatus = 'idle' | 'discovering' | 'completed' | 'failed'
export type PrintJobStatus = 'pending' | 'resolving-printer' | 'connecting' | 'printing' | 'printed' | 'failed' | 'cancelled' | 'unknown'

export type PrintAgentScope = {
  tenantId: string
  establishmentId: string
  terminalId: string
}

export type PrintAgentPreferences = {
  autoOpenCashDrawer: boolean
  alwaysPrintTicket: boolean
  cut: boolean
  copies: number
  footer: string
  printCashClosingAutomatically: boolean
  includeExpectedAndCountedAmounts: boolean
  includeUserNames: boolean
  includeOpeningAndClosingTimes: boolean
  includeZeroPaymentMethods: boolean
  includeTotalPayments: boolean
  cashClosingCopies: number
  cashClosingPaperWidth: 32 | 42 | 48
  moneySymbol: 'currency' | 'code'
}

export type PrintAgentPersistedConfig = {
  baseUrl: string
  token: string | null
  selectedPrinterId: string | null
  lastSuccessfulConnectionAt: string | null
  preferences: PrintAgentPreferences
}

export type PrintAgentServerInfo = {
  hostname?: string
  ip?: string
  platform?: string
  operatingSystem?: string
  version?: string
  https?: boolean
  certificate?: { expiresAt?: string; issuer?: string; valid?: boolean }
  [key: string]: unknown
}

export type Printer = {
  id: string
  name?: string
  displayName?: string
  manufacturer?: string
  model?: string
  ip?: string
  mac?: string
  port?: number
  confidence?: number | string
  status?: 'available' | 'unavailable' | 'selected' | 'unknown' | string
  lastSeenAt?: string
  [key: string]: unknown
}

export type PrintJob = {
  id?: string
  jobId?: string
  requestId?: string
  status: PrintJobStatus
  errorCode?: string
  message?: string
  createdAt?: string
  updatedAt?: string
  printedAt?: string
  [key: string]: unknown
}

export type PrintTicketItem = {
  name: string
  quantity: number
  unitPriceCents: number
  totalCents: number
  additions?: string[]
  notes?: string[]
  discountCents?: number
  taxCents?: number
}

export type PrintTicket = {
  establishmentName: string
  address?: string
  legalName?: string
  taxId?: string
  ticketNumber: string
  date: string
  items: PrintTicketItem[]
  subtotalCents: number
  discountCents?: number
  taxCents?: number
  tipCents?: number
  totalCents: number
  paymentMethod?: string
  payments?: Array<{ method: string; amountCents: number }>
  amountReceivedCents?: number
  changeCents?: number
  footer?: string
  copyLabel?: string
  deferredLabel?: string
}

export type PrintRequest = {
  requestId: string
  printerId: string
  ticket: PrintTicket
  options: { cut: boolean; openCashDrawer: boolean; copies: number }
}

export type CashClosingPrintDocument = {
  reportTitle: string
  companyName: string
  registerName: string
  shiftLabel: string
  closedAt: string
  timezone: string
  currency: string
  locale: string
  copyLabel?: string
  summary: { totalSalesCents: number; salesCount: number; averageSaleCents: number }
  payments: Array<{ code: string; label: string; amountCents: number }>
  cashMovements: {
    cashEntriesCents: number
    cashExitsCents: number
    cardCashbackCents: number
  }
  cashFund: { openingCashFundCents: number; finalCashFundCents: number }
  differences: { cashDifferenceCents: number; cardDifferenceCents: number }
  expectedAndCounted?: {
    expectedCashCents: number
    countedCashCents: number
    expectedCardCents: number
    countedCardCents: number
  }
  users?: { openedBy?: string; closedBy?: string }
  times?: { openedAt: string; closedAt: string }
  includeTotalPayments?: boolean
  paperWidth: 32 | 42 | 48
}

export type DiscoveryProgress = { scanned?: number; total?: number; found?: number; message?: string }
