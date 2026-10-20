export type { AddonSelection, CommercialException, Contract, Interval, Product, Selection, Version } from '../../../supabase/functions/_shared/billing/domain'
import type { Contract, Product, Version } from '../../../supabase/functions/_shared/billing/domain'

export type BillingAccount = {
  tenant_id: string
  name?: string
  venueCount?: number
  source: 'manual' | 'stripe'
  status: string
  legal_name: string | null
  tax_id: string | null
  email: string | null
  contract: Contract | null
  billed_contract: Contract | null
  subscription_started_at: string | null
  canceled_at: string | null
  period_end: string | null
  cancel_at_period_end: boolean
  last_payment_status: string | null
  last_reconciled_at: string | null
  sync_error: string | null
  stripe_customer_id: string | null
  stripe_subscription_id: string | null
  grace_days: number
  created_at: string
}
export type BillingInvoice = {
  stripe_invoice_id: string; number: string | null; status: string
  amount_due_cents: number; amount_paid_cents: number; created_at: string
  hosted_invoice_url: string | null; invoice_pdf: string | null
}
export type BillingOperation = {
  id: string; kind: string; status: string; timing: 'immediate' | 'period_end'; reason: string
  preview: { amountDueCents: number; recurringCents: number; renewalCents?: number | null; currency: string; effectiveAt: string | null; details: string }
  result?: { url?: string } | null
  created_at: string; effective_at?: string | null
}
export type BillingDetail = {
  account: BillingAccount
  tenant: { id: string; name: string; max_venues: number; max_devices: number }
  venues: Array<{ id: string; name: string; is_active: boolean }>
  devices: Array<{ id: string; name: string; venue_id: string; is_active: boolean }>
  invoices: BillingInvoice[]
  operations: BillingOperation[]
  audit: Array<{ id: string; action: string; reason: string; actor_id: string | null; created_at: string }>
  commercialState: string
}
export type BillingCatalog = { products: Product[]; versions: Version[]; features: Array<{ key: string; name: string; is_core: boolean }> }
export type BillingOverview = {
  accounts: BillingAccount[]
  events: Array<{ event_id: string; event_type: string; status: string; error_code: string | null; attempts: number; created_at: string }>
  metrics: { arrCents: number; mrrCents: number; paidCents: number; paidExcludingTaxCents: number }
  truncated: boolean
}
