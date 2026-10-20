export type StripeItem = { id: string; price: { id: string; unit_amount: number }; quantity: number; current_period_start: number; current_period_end: number }
export type StripeSubscription = {
  id: string; customer: string; status: string; livemode: boolean
  items: { data: StripeItem[]; has_more: boolean }
  pending_update: unknown; cancel_at_period_end: boolean
  latest_invoice: string | StripeInvoice | null
  schedule: string | null
  billing_cycle_anchor?: number
  discounts: Array<string | { source: { coupon: string | { id: string } } }>
  metadata: Record<string, string>
}
export type StripeInvoice = {
  id: string; customer: string; status: string; currency: string
  amount_due: number; amount_paid: number; subtotal_excluding_tax: number | null
  total_excluding_tax: number | null; total: number; created: number
  number: string | null; hosted_invoice_url: string | null; invoice_pdf: string | null
  status_transitions: { paid_at: number | null }
  account_name?: string | null; account_country?: string | null; account_tax_ids?: Array<string | { type: string; value: string }> | null
  customer_name?: string | null; customer_tax_ids?: Array<{ type: string; value: string }> | null
  customer_address?: { line1: string | null; line2: string | null; city: string | null; state: string | null; postal_code: string | null; country: string | null } | null
}
export type StripeList<T> = { data: T[]; has_more: boolean }
type FormValue = string | number | boolean | null | undefined | FormValue[] | { [key: string]: FormValue }

// Never retain Stripe messages, bodies or headers containing customer data/secrets.
const diagnosticToken = (value: unknown) => typeof value === 'string' && /^[a-zA-Z0-9_.[\]-]{1,150}$/.test(value) ? value : null
export class StripeRequestError extends Error {
  readonly diagnostic: { status: number; type: string | null; code: string | null; param: string | null; requestId: string | null; outcome: 'rejected' | 'uncertain' }
  constructor(status: number, error: { type?: unknown; code?: unknown; param?: unknown }, requestId: string | null, shouldRetry = false) {
    super(`STRIPE_HTTP_${status}`)
    const type = diagnosticToken(error.type)
    // Conflicts, rate limits, idempotency errors and server failures can hide prior effects.
    const rejected = !shouldRetry && !String(error.code ?? '').includes('idempotency') && ((status === 400 || status === 404) && type === 'invalid_request_error'
      || status === 401 && type === 'authentication_error'
      || status === 403 && type === 'permission_error')
    this.diagnostic = { status, type, code: diagnosticToken(error.code), param: diagnosticToken(error.param), requestId: diagnosticToken(requestId), outcome: rejected ? 'rejected' : 'uncertain' }
  }
}

export function encodeStripeForm(params: Record<string, FormValue>) {
  const form = new URLSearchParams()
  function append(key: string, value: FormValue) {
    if (value === undefined || value === null) return
    if (Array.isArray(value)) { value.forEach((entry, index) => append(`${key}[${index}]`, entry)); return }
    if (typeof value === 'object') { Object.entries(value).forEach(([child, entry]) => append(`${key}[${child}]`, entry)); return }
    form.append(key, String(value))
  }
  Object.entries(params).forEach(([key, value]) => append(key, value))
  return form
}

export class StripeGateway {
  private readonly key: string
  private readonly transport: typeof fetch
  constructor(key: string, transport: typeof fetch = fetch) {
    // Production activation requires a deliberate reviewed change, not just a swapped secret.
    if (!/^(sk|rk)_test_/.test(key)) throw new Error('BILLING_TEST_KEY_REQUIRED')
    this.key = key
    this.transport = transport
  }
  async request<T>(method: 'GET' | 'POST' | 'DELETE', path: string, params: Record<string, FormValue> = {}, idempotencyKey?: string): Promise<T> {
    if (!/^\/(customers|products|prices|checkout\/sessions|subscriptions|subscription_schedules|invoices|billing_portal\/(sessions|configurations)|coupons)(\/|$)/.test(path)) throw new Error('BILLING_INVALID_STRIPE_PATH')
    const form = encodeStripeForm(params)
    const result = await this.transport(`https://api.stripe.com/v1${path}${method === 'GET' && form.size ? `?${form}` : ''}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Stripe-Version': '2026-09-30.endive', 'Content-Type': 'application/x-www-form-urlencoded', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: method === 'GET' ? undefined : form,
      signal: AbortSignal.timeout(15_000),
    })
    if (!result.ok) {
      let details: { type?: unknown; code?: unknown; param?: unknown } = {}
      try {
        const body = await result.json()
        if (body?.error && typeof body.error === 'object') details = body.error
      } catch { /* An unreadable error response has an uncertain outcome. */ }
      throw new StripeRequestError(result.status, details, result.headers.get('request-id'), result.headers.get('stripe-should-retry') === 'true')
    }
    const body: unknown = await result.json()
    if (!body || typeof body !== 'object') throw new Error('STRIPE_INVALID_RESPONSE')
    if ('livemode' in body && body.livemode !== false) throw new Error('BILLING_LIVE_MODE_FORBIDDEN')
    // Boundary cast: individual resources are checked by the service before projecting access.
    return body as T
  }
  async list<T>(path: string, params: Record<string, FormValue> = {}): Promise<T[]> {
    const rows: T[] = []
    let startingAfter: string | undefined
    for (let page = 0; page < 100; page++) {
      const result = await this.request<StripeList<T & { id: string }>>('GET', path, { ...params, limit: 100, starting_after: startingAfter })
      rows.push(...result.data)
      if (!result.has_more) return rows
      startingAfter = result.data.at(-1)?.id
      if (!startingAfter) throw new Error('STRIPE_INVALID_PAGINATION')
    }
    throw new Error('STRIPE_PAGINATION_LIMIT')
  }
}

export async function verifyStripeSignature(raw: string, header: string | null, secret: string, now = Date.now()) {
  if (!header || !secret || raw.length > 1_000_000) throw new Error('BILLING_INVALID_SIGNATURE')
  const parts = header.split(',').map(part => part.split('='))
  const timestamp = parts.find(([key]) => key === 't')?.[1]
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(now / 1000 - Number(timestamp)) > 300) throw new Error('BILLING_INVALID_SIGNATURE')
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}.${raw}`))
  const expected = [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')
  const valid = parts.filter(([key]) => key === 'v1').some(([, value]) => {
    if (value?.length !== expected.length) return false
    let difference = 0
    for (let index = 0; index < expected.length; index++) difference |= expected.charCodeAt(index) ^ value.charCodeAt(index)
    return difference === 0
  })
  if (!valid) throw new Error('BILLING_INVALID_SIGNATURE')
}
