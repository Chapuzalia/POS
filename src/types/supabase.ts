import type { CatalogProfile, DeviceMode, PaymentMethod, TenantRole } from './domain'

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
  address: string | null
  legal_name: string | null
  tax_id: string | null
  default_tax_rate: number
  catalog_profile: CatalogProfile
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

export type SaleRow = {
  id: string
  cash_session_id: string
  payment_method: PaymentMethod | 'invitation' | 'other' | null
  total_cents: number
  created_at: string
}

export type TicketLineProductSalesRow = {
  product_id: string | null
  quantity: number
  allocated_quantity: number | null
  line_total_cents: number
}
