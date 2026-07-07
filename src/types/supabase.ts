import type { CatalogKind, PaymentMethod, SaleFormat } from './domain'

export type TenantRow = {
  id: string
  name: string
  slug: string
}

export type MembershipRow = {
  role: string
}

export type VenueRow = {
  id: string
  name: string
}

export type DeviceRow = {
  id: string
  name: string
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
  category_id: string
  name: string
  description: string | null
  kind: CatalogKind
  sale_formats?: SaleFormat[] | null
  can_sell_standalone?: boolean | null
  can_use_as_mixer?: boolean | null
  mixer_supplement_cents?: number | null
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
