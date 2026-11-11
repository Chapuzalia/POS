// Odoo 19 JSON-2 client for Alteil's fiscal issuer. No SDK; never retain keys, bodies or Odoo messages.

export type OdooErrorCode = 'ODOO_UNAVAILABLE' | 'ODOO_AUTH' | 'ODOO_REJECTED' | 'ODOO_TOTAL_MISMATCH' | 'ODOO_PARTNER_INVALID' | 'ODOO_SETUP_MISSING' | 'ODOO_REVIEW_REQUIRED'
export const ODOO_ERROR_CODES: readonly OdooErrorCode[] = ['ODOO_UNAVAILABLE', 'ODOO_AUTH', 'ODOO_REJECTED', 'ODOO_TOTAL_MISMATCH', 'ODOO_PARTNER_INVALID', 'ODOO_SETUP_MISSING', 'ODOO_REVIEW_REQUIRED']

export class OdooRequestError extends Error {
  readonly diagnostic: { status: number }
  constructor(code: OdooErrorCode, status = 0) {
    super(code)
    this.diagnostic = { status }
  }
}

const MAX_PDF_BYTES = 5 * 1024 * 1024
const failure = (status: number) => new OdooRequestError(status === 401 || status === 403 ? 'ODOO_AUTH' : status >= 400 && status < 500 ? 'ODOO_REJECTED' : 'ODOO_UNAVAILABLE', status)

export class OdooGateway {
  private readonly url: string
  private readonly db: string
  private readonly key: string
  private readonly transport: typeof fetch
  constructor(url: string, db: string, key: string, transport: typeof fetch = fetch) {
    this.url = url.replace(/\/$/, ''); this.db = db; this.key = key; this.transport = transport
  }
  private async send(path: string, init: RequestInit) {
    let response: Response
    try { response = await this.transport(`${this.url}${path}`, { ...init, signal: AbortSignal.timeout(15_000) }) }
    catch { throw new OdooRequestError('ODOO_UNAVAILABLE') }
    if (!response.ok) throw failure(response.status)
    return response
  }
  async call<T>(model: string, method: string, params: Record<string, unknown>): Promise<T> {
    if (!/^[a-z_.]+$/.test(model) || !/^[a-z_]+$/.test(method) || method.startsWith('_')) throw new OdooRequestError('ODOO_REJECTED')
    const response = await this.send(`/json/2/${model}/${method}`, {
      method: 'POST',
      headers: { Authorization: `bearer ${this.key}`, 'X-Odoo-Database': this.db, 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    })
    try { return await response.json() as T } catch { throw new OdooRequestError('ODOO_UNAVAILABLE', response.status) }
  }
  // Portal report URLs carry their own access_token; only /my/ pages are fetched.
  async pdf(path: string): Promise<Uint8Array> {
    if (!path.startsWith('/my/')) throw new OdooRequestError('ODOO_REJECTED')
    const response = await this.send(path, { method: 'GET' })
    if (!response.headers.get('content-type')?.startsWith('application/pdf')) throw new OdooRequestError('ODOO_REJECTED', response.status)
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > MAX_PDF_BYTES) throw new OdooRequestError('ODOO_REJECTED', response.status)
    return bytes
  }
}
