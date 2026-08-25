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

export type CashlogyConnector = {
  id: string
  host: string
  port: number
  reachable: boolean
  processRunning?: boolean
  connected?: boolean
  initialized: boolean
  selected?: boolean
  protocolVersion: string | null
  lastConnectedAt: string | null
  lastError?: CashlogyRemoteError | null
  createdAt?: string
  updatedAt?: string
}

export type CashlogyDevice = {
  id?: string
  connectorId?: string
  model: string | null
  serialNumber: string | null
  versionInfoJson?: unknown
  versionInfoRaw?: string | null
  versionInfoParsed?: boolean
  currency?: string
  ready: boolean
  lastInspectedAt?: string
  createdAt?: string
  updatedAt?: string
}

export type CashlogyRemoteError = {
  code: string
  message?: string | null
  originalCode?: string | null
  details?: unknown
  at?: string
}

export type CashlogyActiveStatus =
  | 'queued' | 'connecting' | 'initializing' | 'starting_acceptance'
  | 'waiting_for_cash' | 'finalizing_acceptance' | 'dispensing_change' | 'processing'

export type CashlogyTerminalStatus = 'completed' | 'cancelled' | 'failed' | 'unknown' | 'needs_attention'
export type CashlogyTransactionStatus = CashlogyActiveStatus | CashlogyTerminalStatus

export type CashlogyHealth = {
  ok: boolean
  enabled: boolean
  adapter: string
  sessionState: CashlogySessionState
  processDetectionAvailable: boolean
  processRunning: boolean
  connector: CashlogyConnector | null
  device: CashlogyDevice | null
  activeTransaction: { id: string; requestId: string; status: string } | null
  activeCashManagementOperation: { id: string; requestId: string; type: string; status: string } | null
  busyReason: string | null
  lastError: CashlogyRemoteError | null
}

export type CashlogyTotal = {
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
  coins: CashlogyDenomination[]
  notes: CashlogyDenomination[]
  queriedAt: string
}

export type CashlogyLevelState = 'ok' | 'empty' | 'near_empty' | 'full' | 'near_full' | 'unknown'

export type CashlogyLevel = {
  index: number
  valueCents: number
  stateCode: number
  state: CashlogyLevelState
  percentage: number | null
}

export type CashlogyLevels = {
  levels: CashlogyLevel[]
  queriedAt: string
}

export type CashlogyCapability = {
  valueCents: number | null
  capabilityCode: number
  depositable: boolean
  dispensable: boolean
}

export type CashlogyCapabilities = {
  currency: string
  capabilities: CashlogyCapability[]
  queriedAt: string
}

export type CashlogyAccounting = {
  total: CashlogyTotal
  denominations: CashlogyDenominations
  levels: CashlogyLevels
  capabilities: CashlogyCapabilities
  queriedAt: string
}

export type CashlogyDeviceErrorType =
  | 'warning' | 'user_recoverable' | 'technical_recoverable' | 'fatal' | 'unknown'

export type CashlogyDeviceError = {
  code: string
  type: CashlogyDeviceErrorType
  title: string | null
  mainMessage: string | null
  additionalMessage: string | null
  videoPath: string | null
  imagePath: string | null
  requiresTechnicalIntervention: boolean
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
  saleId?: string | null
  amountCents: number
  terminalCode: string
  options?: {
    showSecondScreen?: boolean
    secondScreenX?: number
    secondScreenY?: number
    showAcceptButton?: boolean
    allowPartialPayment?: boolean
    showScreenOnTop?: boolean
    allowManualCents?: boolean
    showManualPaymentButton?: boolean
  }
  test?: boolean
  confirmRealCash?: boolean
}

export type CashlogyCashManagementType = 'refill' | 'give_change' | 'withdraw' | 'empty' | 'remove_stacker'
export type CashlogyCashManagementActiveStatus =
  | 'starting' | 'accepting' | 'finalizing_acceptance' | 'awaiting_dispense' | 'dispensing' | 'processing'
export type CashlogyCashManagementStatus = CashlogyCashManagementActiveStatus | CashlogyTerminalStatus

export type CashlogyRequestedDenomination = {
  valueCents: number
  quantity: number
}

export type CashlogyAvailableDenomination = {
  valueCents: number
  availableQuantity: number
  kind: 'coin' | 'note'
}

export type CashlogyCashManagementOperation = {
  id: string
  requestId: string
  connectorId: string
  type: CashlogyCashManagementType
  status: CashlogyCashManagementStatus
  requestedAmountCents: number | null
  acceptedCents: number | null
  dispensedCents: number | null
  denominationsRequested: CashlogyRequestedDenomination[] | null
  denominationsDispensed: CashlogyRequestedDenomination[] | null
  changeAddedCents: number | null
  stackerCollectionRequired?: boolean
  resultCode: string | null
  normalizedErrorCode: string | null
  error: CashlogyRemoteError | null
  warning?: CashlogyRemoteError | null
  startedAt: string | null
  completedAt: string | null
  createdAt: string
  updatedAt: string
}

export type CashlogyOperationResponse = {
  ok: boolean
  duplicate: boolean
  operation: CashlogyCashManagementOperation
}

export type CashlogyCancelTarget = {
  kind: 'cash_management' | 'transaction'
  id: string
}

export type CashlogyCancelResponse = {
  ok: boolean
  cancelled: boolean
  pending: boolean
  duplicate: boolean
  target: CashlogyCancelTarget | null
  operation?: {
    status: CashlogyCashManagementStatus
    resultCode?: string | null
  }
  transaction?: CashlogyTransaction
}

export type CashlogyRecoveryStep = {
  ok: boolean
  resultCode: string | null
  error: CashlogyRemoteError | null
}

export type CashlogyRecoveryResult = {
  ok: boolean
  ready: boolean
  previousErrors: CashlogyRecoveryStep & { errors?: CashlogyDeviceError[] }
  cancelResult: CashlogyRecoveryStep | null
  resetResult: CashlogyRecoveryStep
  initializationResult: CashlogyRecoveryStep & { protocolVersion?: string | null }
  currentErrors: CashlogyRecoveryStep & { errors?: CashlogyDeviceError[] }
  accountingCheck: {
    ok: boolean
    total: CashlogyRecoveryStep & { totalCents?: number }
    denominations: CashlogyRecoveryStep & {
      coinDenominationCount?: number
      noteDenominationCount?: number
    }
  }
  affectedOperation: {
    id?: string
    requestId?: string
    type?: CashlogyCashManagementType
    status: 'unknown'
  } | null
}

export type CashlogyManagementIntent = {
  requestId: string
  type: CashlogyCashManagementType
  operationId: string | null
  denominationOptions?: CashlogyAvailableDenomination[]
  createdAt: string
}

export type CashlogyIntent = {
  requestId: string
  saleId: string | null
  amountCents: number
  terminalCode: string
  transactionId: string | null
  chargeRequestedAt?: string | null
  createdAt: string
}

export type CashlogyDiagnosticLog = {
  id: string
  connectorId: string
  commandName: string
  durationMs: number
  resultCode: string | null
  outcome: string
  requestFrameSanitized: string | null
  responseFrameSanitized: string | null
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
  paperWidth?: 58 | 80
  characterSet?: string
  cashDrawerPin?: 0 | 1
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

export type PrintRequest = {
  requestId: string
  printerId: string
  force: boolean
  lines: string[]
  elements?: PrintElement[]
  options: { cut: boolean; openCashDrawer: boolean; copies: number }
}

export type PrintElement =
  | { type: 'text'; value: string }
  | { type: 'qr'; data: string; size?: number; errorCorrection?: 'L' | 'M' | 'Q' | 'H' }

export type PrinterLayout = {
  columns: 32 | 48
  paperWidth: 58 | 80
  characterSet: string
}

export type DiscoveryProgress = { scanned?: number; total?: number; found?: number; message?: string }
