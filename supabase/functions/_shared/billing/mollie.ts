// Mollie REST client and integer-cent money helpers. No SDK; every response is re-checked by the service.
import type { Interval } from './domain.ts'

export type MollieMoney = { currency: string; value: string }
export type MolliePayment = {
  id: string; mode: string; status: string; amount: MollieMoney; amountChargedBack?: MollieMoney | null
  customerId?: string | null; subscriptionId?: string | null; mandateId?: string | null
  sequenceType: string; method: string | null; description: string; createdAt: string; paidAt?: string | null
  metadata: Record<string, string> | null; _links: { checkout?: { href: string } | null }
}
export type MollieSubscription = {
  id: string; mode: string; status: string; amount: MollieMoney; interval: string; startDate: string
  nextPaymentDate?: string | null; canceledAt?: string | null; mandateId?: string | null; customerId: string
  metadata: Record<string, string> | null
}
export type MollieMandate = { id: string; mode: string; status: string; method: string; mandateReference: string | null }

// Spanish VAT, exclusive. Catalog/contract amounts are net integer cents.
export const VAT_PERCENT = 21
export const grossCents = (net: number) => net + Math.round(net * VAT_PERCENT / 100)
export const netFromGross = (gross: number) => Math.round(gross * 100 / (100 + VAT_PERCENT))
export function money(cents: number): MollieMoney {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error('BILLING_INVALID_AMOUNT')
  return { currency: 'EUR', value: `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` }
}
export function cents(amount: MollieMoney | null | undefined) {
  if (!amount) return 0
  const match = /^(\d+)\.(\d{2})$/.exec(amount.value)
  if (amount.currency !== 'EUR' || !match) throw new Error('BILLING_CURRENCY_MISMATCH')
  return Number(match[1]) * 100 + Number(match[2])
}
export const mollieInterval = (interval: Interval) => interval === 'year' ? '12 months' : '1 month'
export const epoch = (date: string) => Math.floor(Date.parse(date) / 1000)
export const dateOnly = (seconds: number) => new Date(seconds * 1000).toISOString().slice(0, 10)

// ISO 13616 mod-97. The IBAN is forwarded to Mollie and never stored or logged.
export function normalizeIban(value: string) {
  const iban = value.replace(/\s+/g, '').toUpperCase()
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) throw new Error('BILLING_INVALID_IBAN')
  const digits = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, char => String(char.charCodeAt(0) - 55))
  let rest = 0
  for (const digit of digits) rest = (rest * 10 + Number(digit)) % 97
  if (rest !== 1) throw new Error('BILLING_INVALID_IBAN')
  return iban
}

// Never retain Mollie messages, bodies or headers: they can contain customer data.
export class MollieRequestError extends Error {
  readonly diagnostic: { status: number; field: string | null; outcome: 'rejected' | 'uncertain' }
  constructor(status: number, field: unknown) {
    super(`MOLLIE_HTTP_${status}`)
    // Validation/auth/not-found responses had no effect; timeouts and 5xx may hide one.
    const rejected = [400, 401, 403, 404, 422].includes(status)
    this.diagnostic = { status, field: typeof field === 'string' && /^[a-zA-Z0-9_.]{1,80}$/.test(field) ? field : null, outcome: rejected ? 'rejected' : 'uncertain' }
  }
}

const API = 'https://api.mollie.com/v2'
export class MollieGateway {
  private readonly key: string
  private readonly transport: typeof fetch
  readonly mode: 'test' | 'live'
  constructor(key: string, transport: typeof fetch = fetch) {
    const match = /^(test|live)_[A-Za-z0-9]{20,}$/.exec(key)
    if (!match) throw new Error('BILLING_INVALID_API_KEY')
    this.mode = match[1] === 'live' ? 'live' : 'test'
    this.key = key
    this.transport = transport
  }
  async request<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: object, idempotencyKey?: string): Promise<T> {
    if (!/^\/(customers|payments)(\/|\?|$)/.test(path)) throw new Error('BILLING_INVALID_MOLLIE_PATH')
    const result = await this.transport(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json', ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    })
    if (result.status === 204) return null as T
    if (!result.ok) {
      let field: unknown = null
      try { field = (await result.json())?.field } catch { /* Unreadable error bodies keep an uncertain outcome. */ }
      throw new MollieRequestError(result.status, field)
    }
    const data: unknown = await result.json()
    if (!data || typeof data !== 'object') throw new Error('MOLLIE_INVALID_RESPONSE')
    // A live key must never act on test resources (or vice versa), e.g. IDs left from the sandbox.
    if ('mode' in data && data.mode !== this.mode) throw new Error('BILLING_MODE_MISMATCH')
    // Boundary cast: the service checks customer, tenant and status before projecting access.
    return data as T
  }
  async list<T>(path: string, key: string): Promise<T[]> {
    const rows: T[] = []
    let next: string | null = `${path}${path.includes('?') ? '&' : '?'}limit=250`
    for (let page = 0; next && page < 40; page++) {
      const result: { _embedded?: Record<string, T[]>; _links?: { next?: { href: string } | null } } = await this.request('GET', next)
      rows.push(...(result._embedded?.[key] ?? []))
      const href = result._links?.next?.href
      if (href && !href.startsWith(API)) throw new Error('MOLLIE_INVALID_PAGINATION')
      next = href ? href.slice(API.length) : null
    }
    if (next) throw new Error('MOLLIE_PAGINATION_LIMIT')
    return rows
  }
}
