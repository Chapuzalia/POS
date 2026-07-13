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

export type PaymentMethod = 'cash' | 'card' | 'invitation' | 'other'

export type TenantRole = 'owner' | 'admin' | 'manager' | 'cashier'

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
  deviceId: string
  deviceName: string
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
  sortOrder: number
  isActive: boolean
}

export type CrmDevice = {
  id: string
  venueId: string
  name: string
  isActive: boolean
}

export type CrmPosUser = {
  id: string
  email: string
  fullName: string
  isActive: boolean
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
  isActive: boolean
  sortOrder: number
  variants: ProductVariant[]
  modifierGroups: ModifierGroup[]
}

export type Catalog = {
  categories: Category[]
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

export type TicketLine = {
  id: string
  productId: string
  productName: string
  variantId: string
  variantName: string
  unitPriceCents: number
  quantity: number
  modifiers: TicketLineModifier[]
}

export type CashSession = {
  id: string
  tenantId: string
  venueId: string
  deviceId: string
  userId: string
  openedAt: string
  openingFloatCents: number
  status: 'open'
}

export type SaleRecord = {
  id: string
  cashSessionId: string
  paymentMethod: PaymentMethod
  totalCents: number
  createdAt: string
}

export type SessionTicketRecord = {
  id: string
  cashSessionId: string
  paymentMethod: PaymentMethod
  totalCents: number
  createdAt: string
  status: 'active' | 'voided'
  payload: SaleCreatedPayload
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
}

export type SaleCreatedPayload = {
  ticket: {
    id: string
    tenantId: string
    cashSessionId: string
    venueId: string
    deviceId: string
    userId: string
    totalCents: number
    createdAt: string
  }
  lines: SaleLinePayload[]
  sale: {
    id: string
    tenantId: string
    ticketId: string
    cashSessionId: string
    venueId: string
    deviceId: string
    userId: string
    totalCents: number
    paymentMethod: PaymentMethod
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
  }
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
  notes: string
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
  priceCents: number
  saleFormats: SaleFormat[]
  variantName: string
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
