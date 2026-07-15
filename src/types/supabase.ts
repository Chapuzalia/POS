import type { CatalogKind, DeviceMode, PaymentMethod, SaleFormat, TenantRole } from './domain'

export type TenantRow = {
  id: string
  is_active: boolean
  name: string
  slug: string
}

export type MembershipRow = {
  role: TenantRole
}

export type UserMembershipRow = MembershipRow & {
  tenant_id: string
}

export type DeviceAssignmentRow = {
  tenant_id: string
  user_id: string
  venue_id: string
  device_id: string
  is_active: boolean
}

export type VenueRow = {
  id: string
  name: string
  default_tax_rate: number
}

export type DeviceRow = {
  id: string
  name: string
  device_mode: DeviceMode
  default_cash_register_id: string | null
  can_take_orders: boolean
  can_take_payments: boolean
  can_open_cash_session: boolean
  can_close_cash_session: boolean
  can_manage_cash: boolean
}

export type CategoryRow = {
  id: string
  tenant_id: string
  name: string
  kind: CatalogKind
  icon: string | null
  is_active: boolean
  sort_order: number
}

export type SaleFormatRow = {
  key: string
  label: string
  is_active: boolean
  sort_order: number
}

export type VariantRow = {
  id: string
  product_id: string
  name: string
  price_cents: number
  sku: string | null
  is_default: boolean
  sort_order: number
}

export type ModifierRow = {
  id: string
  group_id: string
  name: string
  price_cents: number
  sort_order: number
}

export type ModifierGroupRow = {
  id: string
  product_id: string
  name: string
  min_select: number
  max_select: number
  sort_order: number
  modifiers: ModifierRow[] | null
}

export type ProductRow = {
  id: string
  tenant_id: string
  venue_id: string
  category_id: string
  name: string
  description: string | null
  image_path?: string | null
  kind: CatalogKind
  sale_formats?: SaleFormat[] | null
  can_sell_standalone?: boolean | null
  can_use_as_mixer?: boolean | null
  is_featured?: boolean | null
  mixer_supplement_cents?: number | null
  tax_rate: number | null
  is_active: boolean
  sort_order: number
  product_variants: VariantRow[] | null
  modifier_groups: ModifierGroupRow[] | null
}

export type SaleRow = {
  id: string
  cash_session_id: string
  payment_method: PaymentMethod
  total_cents: number
  created_at: string
}

export type TicketLineProductSalesRow = {
  product_id: string | null
  quantity: number
  line_total_cents: number
}
