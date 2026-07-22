import type { CatalogKind, CatalogProfile, DeviceMode, PaymentMethod, ProductType, SaleFormat, SelectionGroupKind, TenantRole } from './domain'

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
  id: string
  tenant_id: string
  venue_id?: string | null
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
  sale_format_id: string | null
  sale_formats?: { key: string }[] | { key: string } | null
  is_default: boolean
  is_active: boolean
  sort_order: number
}

export type ModifierRow = {
  id: string
  group_id: string
  name: string
  price_cents: number
  is_default?: boolean | null
  is_active?: boolean | null
  sort_order: number
}

export type ModifierGroupRow = {
  id: string
  product_id: string
  name: string
  min_select: number
  max_select: number
  is_active?: boolean | null
  sort_order: number
  modifiers: ModifierRow[] | null
}

export type ProductRow = {
  id: string
  tenant_id: string
  venue_id: string
  category_id: string
  name: string
  product_type: ProductType
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
  variant_selection_groups?: VariantSelectionGroupRow[] | null
}

export type CatalogTabRow = {
  id: string
  tenant_id: string
  venue_id: string
  key: string
  label: string
  icon: string | null
  is_active: boolean
  sort_order: number
}

export type CatalogPlacementRow = {
  id: string
  tenant_id: string
  venue_id: string
  tab_id: string
  category_id: string
  product_id: string
  default_variant_id: string | null
  is_featured: boolean
  is_active: boolean
  sort_order: number
}

export type SelectionGroupItemRow = {
  id: string
  group_id: string
  product_id: string
  variant_id: string | null
  price_delta_cents: number
  is_default: boolean
  is_active: boolean
  sort_order: number
}

export type SelectionGroupRow = {
  id: string
  tenant_id: string
  venue_id: string
  kind: SelectionGroupKind
  name: string
  min_select: number
  max_select: number
  is_active: boolean
  sort_order: number
  selection_group_items: SelectionGroupItemRow[] | null
}

export type VariantSelectionGroupRow = {
  variant_id: string
  selection_group_id: string
  sort_order: number
  selection_groups: SelectionGroupRow | null
}

export type ProductModifierGroupAssignmentRow = {
  product_id: string
  variant_id: string | null
  modifier_group_id: string
  sort_order: number
  modifier_groups: ModifierGroupRow | ModifierGroupRow[] | null
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
