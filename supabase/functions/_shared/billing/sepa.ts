import type { StripeGateway, StripeInvoice, StripeSubscription } from './stripe.ts'

export type StripePaymentMethod = { id: string; type: string; customer: string | null; livemode: boolean }
type InvoicePayment = { id: string; invoice: string; livemode: boolean; status: string; currency: string; amount_requested: number; is_default: boolean; payment: { type: string; payment_intent?: string } }
type ProcessingIntent = {
  id: string; customer: string; livemode: boolean; currency: string; status: string; amount: number; last_payment_error: unknown
  payment_method: StripePaymentMethod | string | null
  latest_charge: { id: string; customer: string; payment_intent: string; payment_method: string; livemode: boolean; status: string; currency: string; amount: number; refunded: boolean; failure_code: string | null; payment_method_details: { type: string; sepa_debit?: { mandate: string } } } | string | null
}
type Mandate = { id: string; livemode: boolean; status: string; type: string; payment_method: string; payment_method_details: { type: string }; customer_acceptance: { type: string; accepted_at: number } }
type AuthorizationOperation = { id: string; stripe_params: { subscriptionId: string | null; sepaDebit?: boolean }; result: { checkoutId?: string; pendingInvoiceId?: string | null } | null }
export type SepaAuthorization = { customerId: string; subscriptionId: string; invoiceId: string; operationId: string; checkoutId: string | null; paymentIntentId: string; paymentMethodId: string; mandateId: string; acceptedAt: number }

export async function subscriptionUsesSepa(stripe: StripeGateway, sub: StripeSubscription) {
  let method = sub.default_payment_method
  if (!method) {
    const customer = await stripe.request<{ id: string; invoice_settings?: { default_payment_method?: StripePaymentMethod | string | null } }>('GET', `/customers/${sub.customer}`, { expand: ['invoice_settings.default_payment_method'] })
    if (customer.id !== sub.customer) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
    method = customer.invoice_settings?.default_payment_method
  }
  if (typeof method === 'string') method = await stripe.request<StripePaymentMethod>('GET', `/payment_methods/${method}`)
  if (!method) return false
  if (method.customer !== sub.customer || method.livemode !== false) throw new Error('BILLING_SUBSCRIPTION_MISMATCH')
  return method.type === 'sepa_debit'
}

// Read authoritative Stripe resources, not redirect parameters or a webhook body.
// Never return/store an IBAN, mandate acceptance IP, user agent or client secret.
export async function processingSepaAuthorization(stripe: StripeGateway, tenantId: string, sub: StripeSubscription, invoice: StripeInvoice, operation: AuthorizationOperation): Promise<SepaAuthorization | null> {
  if (sub.status !== 'active' || sub.pending_update || invoice.status !== 'open' || invoice.customer !== sub.customer || invoice.currency !== 'eur' || invoice.amount_due <= 0) return null
  const checkoutId = operation.result?.checkoutId ?? null
  if (checkoutId) {
    const session = await stripe.request<{ id: string; livemode: boolean; mode: string; status: string; payment_status: string; customer: string; subscription: string; invoice: string; currency: string; client_reference_id: string; metadata: Record<string, string> }>('GET', `/checkout/sessions/${checkoutId}`)
    if (session.id !== checkoutId || session.livemode !== false || session.mode !== 'subscription' || session.status !== 'complete' || session.payment_status !== 'unpaid'
      || session.customer !== sub.customer || session.subscription !== sub.id || session.invoice !== invoice.id || session.currency !== 'eur' || session.client_reference_id !== tenantId
      || session.metadata.tickit_tenant_id !== tenantId || session.metadata.tickit_operation_id !== operation.id || sub.metadata.tickit_operation_id !== operation.id) return null
  } else if (!operation.stripe_params.sepaDebit || operation.stripe_params.subscriptionId !== sub.id || operation.result?.pendingInvoiceId !== invoice.id) return null

  const payments = await stripe.list<InvoicePayment>('/invoice_payments', { invoice: invoice.id })
  const payment = payments.find(row => row.invoice === invoice.id && row.livemode === false && row.status === 'open' && row.currency === 'eur' && row.amount_requested === invoice.amount_due && row.is_default && row.payment.type === 'payment_intent' && row.payment.payment_intent)
  if (!payment?.payment.payment_intent) return null
  const intent = await stripe.request<ProcessingIntent>('GET', `/payment_intents/${payment.payment.payment_intent}`, { expand: ['payment_method', 'latest_charge'] })
  const method = intent.payment_method
  const charge = intent.latest_charge
  if (intent.id !== payment.payment.payment_intent || intent.customer !== sub.customer || intent.livemode !== false || intent.currency !== 'eur' || intent.amount !== invoice.amount_due
    || intent.status !== 'processing' || intent.last_payment_error || !method || typeof method === 'string' || method.type !== 'sepa_debit' || method.customer !== sub.customer || method.livemode !== false
    || !charge || typeof charge === 'string' || charge.customer !== sub.customer || charge.payment_intent !== intent.id || charge.payment_method !== method.id
    || charge.livemode !== false || charge.status !== 'pending' || charge.currency !== 'eur' || charge.amount !== intent.amount || charge.refunded || charge.failure_code || charge.payment_method_details.type !== 'sepa_debit') return null
  const mandateId = charge.payment_method_details.sepa_debit?.mandate
  if (!mandateId) return null
  const mandate = await stripe.request<Mandate>('GET', `/mandates/${mandateId}`)
  if (mandate.id !== mandateId || mandate.livemode !== false || mandate.status !== 'active' || mandate.type !== 'multi_use' || mandate.payment_method !== method.id
    || mandate.payment_method_details.type !== 'sepa_debit' || mandate.customer_acceptance.type !== 'online' || !Number.isSafeInteger(mandate.customer_acceptance.accepted_at)
    || mandate.customer_acceptance.accepted_at <= 0 || mandate.customer_acceptance.accepted_at > Math.floor(Date.now() / 1000) + 300) return null
  return { customerId: sub.customer, subscriptionId: sub.id, invoiceId: invoice.id, operationId: operation.id, checkoutId, paymentIntentId: intent.id, paymentMethodId: method.id, mandateId, acceptedAt: mandate.customer_acceptance.accepted_at }
}
