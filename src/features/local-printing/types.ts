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
  cashlogyConfigured: boolean
  cashlogyTerminalCode: string
  lastSuccessfulConnectionAt: string | null
  preferences: PrintAgentPreferences
}

export type CashlogySessionState =
  | 'disabled' | 'disconnected' | 'connecting' | 'connected' | 'initializing'
  | 'ready' | 'busy' | 'error' | 'reconnecting'

export type CashlogyActiveStatus =
  | 'queued' | 'connecting' | 'initializing' | 'starting_acceptance'
  | 'waiting_for_cash' | 'finalizing_acceptance' | 'dispensing_change' | 'processing'

export type CashlogyTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'unknown' | 'needs_attention'
export type CashlogyTransactionStatus = CashlogyActiveStatus | CashlogyTerminalStatus

export type CashlogyHealth = {
  ok: boolean
  enabled: boolean
  adapter: 'legacy-v2.5' | 'legacy-v2.5-headless' | 'mock'
  sessionState: CashlogySessionState
  processRunning: boolean
  connector: {
    id: string
    host: string
    port: number
    reachable: boolean
    connected: boolean
    initialized: boolean
    protocolVersion: string | null
    lastConnectedAt: string | null
  } | null
  device: { model: string | null; serialNumber: string | null; ready: boolean } | null
  activeTransaction: { id: string; requestId: string; status: string } | null
  lastError: { code: string; message: string; at: string } | null
}

export type CashlogyTotal = {
  resultCode: string
  recyclerTotalCents: number
  stackerTotalCents: number
  totalCents: number
  queriedAt: string
}

export type CashlogyDenomination = {
  valueCents: number
  recyclerCount: number
  stackerCount: number
}

export type CashlogyDenominations = {
  resultCode: string
  coins: CashlogyDenomination[]
  notes: CashlogyDenomination[]
  queriedAt: string
}

export type CashlogyBackofficePreset = {
  status: boolean
  addChange: boolean
  manualOneCent: boolean
  withdrawCash: boolean
  removeStacker: boolean
  completeEmptying: boolean
  giveChange: boolean
  cashClosing: boolean
  viewLogs: boolean
  resetCoins: boolean
  statistics: boolean
  showOnTop: boolean
  maintenance: boolean
}

export type CashlogyBackofficeResponse = {
  resultCode: string
  amountAtEntry: number | null
  amountAtExit: number | null
  amountIntroduced: number | null
  amountWithdrawn: number | null
  pendingRefund: number | null
  accountingAdjustment: number | null
}

export type CashlogyTransaction = {
  id: string
  requestId: string
  saleId: string | null
  connectorId: string
  status: CashlogyTransactionStatus
  operationNumber: string
  terminalCode: string
  requestedAmountCents: number
  automaticAcceptedCents: number | null
  manualAcceptedCents: number | null
  returnedCents: number | null
  changeAddedCents: number | null
  netPaidCents: number | null
  connectorResultCode: string | null
  normalizedErrorCode: string | null
  error: { code: string; message: string | null } | null
  warning: { code: string; message: string } | null
  test: boolean
  cancelRequestedAt: string | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CashlogyChargeRequest = {
  requestId: string
  saleId: string | null
  amountCents: number
  terminalCode: string
  test?: false
}

export type CashlogyIntent = {
  requestId: string
  saleId: string | null
  amountCents: number
  terminalCode: string
  transactionId: string | null
  createdAt: string
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
  fiscal?: {
    provider: 'verifactu' | 'ticketbai'
    status: string
    uuid?: string
    externalCode?: string
    verificationUrl?: string
    qrBase64?: string
  }
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
  operationalSummary?: {
    billedCardCents: number
    billedCashCents: number
    cardTerminalExpectedCents: number
    cashOverOpeningFundCents: number
    cashToWithdrawCents: number
  }
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
