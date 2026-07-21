export type SaleFormat = string

export type SaleFormatDefinition = {
  key: SaleFormat
  label: string
  isActive: boolean
  sortOrder: number
}

export type CatalogKind =
  | 'beer'
  | 'mixed'
  | 'shot'
  | 'other'
  | 'alcohol'
  | 'mixer'
  | 'beer_bottle'
  | 'soft_bottle'
  | 'cocktail'

export type CatalogStartTab = 'all' | 'top'

export type CatalogFilter = CatalogStartTab | SaleFormat

export type PaymentMethod = 'cash' | 'card'
export type HistoricalPaymentMethod = PaymentMethod | 'invitation' | 'other'

export type DiscountCalculationType = 'percentage' | 'fixed'
export type DiscountSnapshotType = DiscountCalculationType | 'manual'
export type DiscountRoundingIncrementCents = 5 | 10 | 50 | 100

export type Discount = {
  id: string
  tenantId: string
  venueId: string
  name: string
  type: DiscountCalculationType
  value: number
  roundingIncrementCents: DiscountRoundingIncrementCents | null
  color: string | null
  isActive: boolean
  sortOrder: number
}

export type DiscountCreateInput = {
  venueId: string
  name: string
  type: DiscountCalculationType
  value: number
  roundingIncrementCents: DiscountRoundingIncrementCents | null
  color: string | null
  isActive: boolean
}

export type AppliedDiscount = {
  discountId: string | null
  name: string
  type: DiscountSnapshotType
  calculationType: DiscountCalculationType
  value: number
  roundingIncrementCents: DiscountRoundingIncrementCents | null
  color: string | null
}

export type TenantRole = 'superadmin' | 'owner' | 'admin' | 'manager' | 'cashier'
export type DeviceMode = 'satellite' | 'checkout' | 'hybrid'

export type ThemeMode = 'light' | 'dark'

export type ThemeDefinition = {
  id: string
  name: string
  description: string
  mode: ThemeMode
  radius: string
  borderWidth: string
  shadow: string
  tokens: Record<string, string>
}

export type TenantContext = {
  tenantId: string
  tenantName: string
  tenantSlug: string
  venueId: string
  venueName: string
  venueAddress?: string
  venueLegalName?: string
  venueTaxId?: string
  deviceId: string
  deviceName: string
  deviceMode?: DeviceMode
  defaultCashRegisterId?: string | null
  canTakeOrders?: boolean
  canTakePayments?: boolean
  canOpenCashSession?: boolean
  canCloseCashSession?: boolean
  canManageCash?: boolean
  userId: string
  userName: string
  role: TenantRole
}

export type LoginInput = {
  email: string
  password: string
}

export type CrmVenue = {
  id: string
  name: string
  address: string
  legalName: string
  taxId: string
  sortOrder: number
  isActive: boolean
  tablesEnabled: boolean
  defaultTaxRate: number
}

export type CrmDevice = {
  id: string
  venueId: string
  name: string
  isActive: boolean
  deviceMode: DeviceMode
  defaultCashRegisterId: string | null
}

export type CrmPosUser = {
  id: string
  email: string
  fullName: string
  hasActiveLogin: boolean
  isActive: boolean
  hasDeviceAssignment: boolean
  loginExpiresAt: string | null
  loginHeartbeatAt: string | null
  venueId: string
  deviceId: string
}

export type Category = {
  id: string
  tenantId: string
  name: string
  kind: CatalogKind
  icon: string
  isActive: boolean
  sortOrder: number
}

export type ProductVariant = {
  id: string
  productId: string
  name: string
  priceCents: number
  sku: string | null
  isDefault: boolean
  sortOrder: number
}

export type Modifier = {
  id: string
  groupId: string
  name: string
  priceCents: number
  sortOrder: number
}

export type ModifierGroup = {
  id: string
  productId: string
  name: string
  minSelect: number
  maxSelect: number
  sortOrder: number
  modifiers: Modifier[]
}

export type Product = {
  id: string
  tenantId: string
  venueId: string
  categoryId: string
  name: string
  description: string | null
  imagePath: string | null
  imageUrl: string | null
  kind: CatalogKind
  saleFormats: SaleFormat[]
  canSellStandalone: boolean
  canUseAsMixer: boolean
  isFeatured: boolean
  mixerSupplementCents: number
  taxRate: number | null
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  modifierGroups: ModifierGroup[]
}

export type Catalog = {
  categories: Category[]
  discounts: Discount[]
  manualDiscountEnabled: boolean
  products: Product[]
  saleFormats: SaleFormatDefinition[]
  updatedAt: string
  source: 'supabase' | 'cache'
}

export type TicketLineModifier = {
  id: string
  groupId: string
  name: string
  priceCents: number
}

export type TicketLineMixer = {
  productId: string
  name: string
  priceCents: number
}

export type ProductLineSelection = {
  modifiers: TicketLineModifier[]
  mixerProductId: string | null
  mixer: TicketLineMixer | null
}

export type TicketLine = {
  id: string
  productId: string
  productName: string
  variantId: string
  variantName: string
  unitPriceCents: number
  quantity: number
  modifiers: TicketLineModifier[]
  mixerProductId?: string | null
  mixer?: TicketLineMixer | null
  fiscalSnapshot?: TicketLineFiscalSnapshot | null
}

export type TicketLineFiscalSnapshot = {
  taxRate: number
  taxableBaseCents: number
  taxAmountCents: number
  grossTotalCents: number
}

export type CashSession = {
  id: string
  tenantId: string
  venueId: string
  deviceId: string
  cashRegisterId: string
  cashRegisterName: string
  userId: string
  openedAt: string
  openingFloatCents: number
  status: 'open'
}

export type CashRegister = { id: string; tenantId: string; venueId: string; name: string; isActive: boolean; sortOrder: number }

export type CashMovementType = 'cash_in' | 'cash_out' | 'card_cashback'

export type CashMovement = {
  id: string
  tenantId: string
  venueId: string
  cashSessionId: string
  createdBy: string
  type: CashMovementType
  direction: 'entry' | 'exit'
  amountCents: number
  notes: string
  requestId: string
  createdAt: string
}

export type SaleRecord = {
  id: string
  cashSessionId: string
  paymentMethod: HistoricalPaymentMethod | null
  totalCents: number
  createdAt: string
}

export type SessionTicketRecord = {
  id: string
  cashSessionId: string
  paymentMethod: HistoricalPaymentMethod | null
  totalCents: number
  createdAt: string
  status: 'active' | 'voided'
  payload: SaleCreatedPayload
  printStatus?: 'not_requested' | 'pending' | 'printed' | 'failed' | 'unknown'
  printJobId?: string | null
  printRequestId?: string | null
  printedAt?: string | null
  printErrorCode?: string | null
  printAttempts?: number
}

export type ProductSalesStat = {
  productId: string
  quantity: number
  totalCents: number
}

export type CashSummary = {
  cashCents: number
  cardCents: number
  invitationCents: number
  otherCents: number
  totalSalesCents: number
  cashEntriesCents: number
  cashExitsCents: number
  cardCashbackCents: number
}

export type SaleLinePayload = {
  id: string
  ticketId: string
  tenantId: string
  productId: string
  variantId: string
  productName: string
  variantName: string
  quantity: number
  unitPriceCents: number
  lineTotalCents: number
  modifiers: TicketLineModifier[]
  fiscalSnapshot: TicketLineFiscalSnapshot | null
}

export type SaleCreatedPayload = {
  ticket: {
    id: string
    tenantId: string
    cashSessionId: string
    cashRegisterId: string
    venueId: string
    deviceId: string
    userId: string
    subtotalCents: number
    discount: AppliedDiscount | null
    discountAmountCents: number
    totalCents: number
    createdAt: string
  }
  lines: SaleLinePayload[]
  sale: {
    id: string
    tenantId: string
    ticketId: string
    cashSessionId: string
    cashRegisterId: string
    venueId: string
    deviceId: string
    userId: string
    totalCents: number
    paymentMethod: HistoricalPaymentMethod | null
    createdAt: string
  }
  payment: {
    id: string
    tenantId: string
    saleId: string
    method: PaymentMethod
    amountCents: number
    receivedCents: number | null
    changeCents: number
  } | null
}

export type CashClosedPayload = {
  sessionId: string
  tenantId: string
  closedAt: string
  closedBy: string
  expectedCashCents: number
  expectedCardCents: number
  expectedInvitationCents: number
  expectedOtherCents: number
  countedCashCents: number
  countedCardCents: number
  countedInvitationCents: number
  countedOtherCents: number
  discrepancyCents: number
  finalCashFundCents: number
  notes: string
}

export type CashClosingPrintSnapshot = {
  reportTitle: string
  companyName: string
  registerName: string
  shiftLabel: string
  openedAt: string
  closedAt: string
  timezone: string
  currency: string
  locale: string
  openedBy?: string
  closedBy?: string
  summary: { totalSalesCents: number; salesCount: number; averageSaleCents: number }
  payments: Array<{ code: string; label: string; amountCents: number }>
  cashMovements: {
    cashEntriesCents: number
    cashExitsCents: number
    cardCashbackCents: number
  }
  cashFund: { openingCashFundCents: number; finalCashFundCents: number }
  expectedAndCounted: {
    expectedCashCents: number
    countedCashCents: number
    expectedCardCents: number
    countedCardCents: number
  }
  differences: { cashDifferenceCents: number; cardDifferenceCents: number }
}

export type CashClosingRecord = {
  id: string
  tenantId: string
  venueId: string
  cashRegisterId: string
  closedAt: string
  closedBy: string
  printSnapshot: CashClosingPrintSnapshot
  printStatus: 'not_requested' | 'pending' | 'printed' | 'failed' | 'unknown'
  printJobId: string | null
  printRequestId: string | null
  printedAt: string | null
  printErrorCode: string | null
  printAttempts: number
  printCopies: number
}

export type OfflineEvent =
  | {
      id: string
      kind: 'cash_opened'
      tenantId: string
      createdAt: string
      attempts: number
      lastError?: string
      payload: { session: CashSession }
    }
  | {
      id: string
      kind: 'sale_created'
      tenantId: string
      createdAt: string
      attempts: number
      lastError?: string
      payload: SaleCreatedPayload
    }
  | {
      id: string
      kind: 'sale_payment_changed'
      tenantId: string
      createdAt: string
      attempts: number
      lastError?: string
      payload: {
        saleId: string
        paymentId: string
        paymentMethod: PaymentMethod
        receivedCents: number | null
        changeCents: number
      }
    }
  | {
      id: string
      kind: 'sale_voided'
      tenantId: string
      createdAt: string
      attempts: number
      lastError?: string
      payload: {
        saleId: string
        ticketId: string
      }
    }
  | {
      id: string
      kind: 'cash_closed'
      tenantId: string
      createdAt: string
      attempts: number
      lastError?: string
      payload: CashClosedPayload
    }

export type ProductCreateInput = {
  venueId: string
  canSellStandalone: boolean
  canUseAsMixer: boolean
  categoryId: string
  description: string
  imagePath?: string | null
  isFeatured: boolean
  kind: CatalogKind
  mixerSupplementCents: number
  name: string
  saleFormats: SaleFormat[]
  taxRate: number | null
  variants: Array<{
    name: string
    priceCents: number
  }>
}

export type CategoryCreateInput = {
  kind: CatalogKind
  name: string
  sortOrder: number
}

export type CrmStats = {
  averageTicketCents: number
  byPayment: Array<{
    method: PaymentMethod
    totalCents: number
    count: number
  }>
  discountApplications: Array<{
    id: string
    name: string
    applications: number
    discountedCents: number
    netSalesCents: number
    ticketPercentage: number
  }>
  discountedTicketCount: number
  discountsCents: number
  monthSalesCents: number
  monthTicketCount: number
  openCashSessions: Array<{
    id: string
    venueName: string
    deviceName: string
    openedAt: string
    openingFloatCents: number
    salesCents: number
    ticketCount: number
    cashCents: number
    cardCents: number
    invitationCents: number
    otherCents: number
  }>
  topProducts: Array<{
    productName: string
    quantity: number
    totalCents: number
  }>
}

export type CrmSalesReportTicket = {
  id: string
  createdAt: string
  lineCount: number
  lines: Array<{
    categoryId: string | null
    categoryName: string
    id: string
    lineTotalCents: number
    modifiers: Array<{
      name: string
      priceCents: number
    }>
    productId: string | null
    productName: string
    quantity: number
    unitPriceCents: number
    variantName: string
    fiscalSnapshot: TicketLineFiscalSnapshot | null
  }>
  discountAmountCents: number
  discountId: string | null
  discountName: string | null
  discountType: DiscountSnapshotType | null
  discountValue: number | null
  discountValueType: DiscountCalculationType | null
  discountRoundingIncrementCents: DiscountRoundingIncrementCents | null
  paymentMethod: HistoricalPaymentMethod | null
  quantity: number
  status: 'paid' | 'void'
  subtotalCents: number
  totalCents: number
}

export type CrmSalesReportAggregate = {
  id: string
  label: string
  quantity: number
  ticketCount: number
  totalCents: number
}

export type CrmSalesReports = {
  byCategory: CrmSalesReportAggregate[]
  byFormat: CrmSalesReportAggregate[]
  byProduct: CrmSalesReportAggregate[]
  tickets: CrmSalesReportTicket[]
}
