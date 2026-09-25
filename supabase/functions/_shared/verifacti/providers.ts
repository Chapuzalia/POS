import { requestVerifactiJson } from './client.ts'
import { FiscalTotalDiscrepancyError } from './types.ts'
import type {
  FiscalProvider,
  ProviderHttpResult,
  ProviderCreateResponse,
  ProviderStatusResponse,
  TicketBaiCreatePayload,
  VerifactuCreatePayload,
  CommercialFiscalDocument,
  FiscalDocumentProvider,
  FiscalIssueOptions,
  NormalizedFiscalResult,
} from './types.ts'
import { mapProviderStatus } from './mapping.ts'

type ProviderOptions = {
  apiKey: string
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
}

function normalizeVerifactiResult(value: ProviderStatusResponse, fallbackId?: string): NormalizedFiscalResult {
  return {
    documentId: String(value.uuid ?? value.document_id ?? fallbackId ?? ''),
    fiscalNumber: typeof value.numero === 'string' ? value.numero : undefined,
    fiscalType: typeof value.tipo_factura === 'string' ? value.tipo_factura : undefined,
    fiscalDate: typeof value.fecha_expedicion === 'string' ? value.fecha_expedicion : undefined,
    status: String(value.estado ?? '').toLowerCase() === 'generado' ? 'generated' : mapProviderStatus(value.estado),
    ...(typeof value.importe_total_cents === 'number' ? { finalTotalCents: value.importe_total_cents } : {}),
    ...(typeof value.qr === 'string' ? { qrPayload: value.qr } : {}),
    ...(typeof value.url === 'string' ? { qrUrl: value.url } : {}),
  }
}

abstract class BaseProvider implements FiscalProvider {
  abstract readonly name: 'verifactu' | 'ticketbai'
  protected readonly apiKey: string
  protected readonly fetchImpl?: typeof fetch
  protected readonly sleep?: (milliseconds: number) => Promise<void>

  constructor(options: ProviderOptions) {
    this.apiKey = options.apiKey
    this.fetchImpl = options.fetchImpl
    this.sleep = options.sleep
  }

  protected call<T>(path: string, options: { body?: unknown; idempotencyKey?: string; method?: 'GET' | 'POST' | 'PUT' | 'DELETE' } = {}) {
    return requestVerifactiJson<T>({
      apiKey: this.apiKey,
      fetchImpl: this.fetchImpl,
      sleep: this.sleep,
      path,
      ...options,
    })
  }

  health() {
    return this.call<Record<string, unknown>>(`/${this.name}/health`)
  }

  getStatus(uuid: string) {
    return this.call<ProviderStatusResponse>(`/${this.name}/status?uuid=${encodeURIComponent(uuid)}`)
  }

  status(payload: { serie: string; numero: string; fecha_expedicion: string; fecha_operacion?: string }) {
    return this.call<ProviderStatusResponse>(`/${this.name}/status`, { body: payload, method: 'POST' })
  }

  cancel(payload: Record<string, unknown>, idempotencyKey: string) {
    return this.call<ProviderCreateResponse>(`/${this.name}/cancel`, { body: payload, idempotencyKey, method: 'POST' })
  }

  list(payload: Record<string, unknown>) {
    return this.call<unknown>(`/${this.name}/list`, { body: payload, method: 'POST' })
  }

  abstract create(payload: VerifactuCreatePayload | TicketBaiCreatePayload, idempotencyKey: string): Promise<ProviderHttpResult<ProviderCreateResponse>>
}

export class VerifactuProvider extends BaseProvider {
  readonly name = 'verifactu' as const

  create(payload: VerifactuCreatePayload | TicketBaiCreatePayload, idempotencyKey: string) {
    return this.call<ProviderCreateResponse>('/verifactu/create', { body: payload, idempotencyKey, method: 'POST' })
  }
}

export class TicketBaiProvider extends BaseProvider {
  readonly name = 'ticketbai' as const

  create(payload: VerifactuCreatePayload | TicketBaiCreatePayload, idempotencyKey: string) {
    return this.call<ProviderCreateResponse>('/ticketbai/create', { body: payload, idempotencyKey, method: 'POST' })
  }
}

export function createFiscalProvider(name: 'verifactu' | 'ticketbai', options: ProviderOptions): FiscalProvider {
  return name === 'ticketbai' ? new TicketBaiProvider(options) : new VerifactuProvider(options)
}

export function createFiscalDocumentProvider(name: 'odoo', options: OdooProviderOptions): FiscalDocumentProvider
export function createFiscalDocumentProvider(name: 'verifactu' | 'ticketbai', options: ProviderOptions): FiscalProvider
export function createFiscalDocumentProvider(name: 'odoo' | 'verifactu' | 'ticketbai', options: ProviderOptions | OdooProviderOptions) {
  return name === 'odoo'
    ? new OdooFiscalProvider(options as OdooProviderOptions)
    : createFiscalProvider(name, options as ProviderOptions)
}

export type OdooProviderOptions = {
  bridgeUrl: string
  bridgeSecret: string
  fiscalEntityRef: string
  fetchImpl?: typeof fetch
}

type BridgeResponse = Record<string, unknown>

export class OdooBridgeError extends Error {
  readonly retryable: boolean
  readonly status?: number
  constructor(message: string, options: { retryable?: boolean; status?: number } = {}) {
    super(message)
    this.name = 'OdooBridgeError'
    this.retryable = options.retryable === true
    this.status = options.status
  }
}

function bridgeStatus(value: unknown): NormalizedFiscalResult['status'] {
  const normalized = String(value ?? '').toLowerCase().replace(/[\s_-]+/g, '')
  if (normalized === 'generated') return 'generated'
  if (normalized === 'acceptedwitherrors' || normalized === 'registeredwitherrors') return 'accepted_with_errors'
  if (normalized === 'accepted' || normalized === 'correct' || normalized === 'correcto') return 'accepted'
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'anulada') return 'cancelled'
  if (normalized === 'rejected' || normalized === 'rechazado') return 'rejected'
  if (normalized === 'error') return 'error'
  return 'pending'
}

function normalizeBridgeResponse(value: BridgeResponse, expectedTotalCents?: number): NormalizedFiscalResult {
  const documentId = value.document_id ?? value.documentId ?? value.id
  const total = value.final_total_cents ?? value.finalTotalCents ?? value.total_cents
  if (typeof documentId !== 'string' || !documentId) throw new Error('Respuesta Odoo sin document_id')
  if (expectedTotalCents !== undefined && (typeof total !== 'number' || !Number.isInteger(total))) throw new Error('Respuesta Odoo sin total final en centimos')
  if (typeof total === 'number' && !Number.isInteger(total)) throw new Error('Respuesta Odoo con total no entero')
  if (expectedTotalCents !== undefined && total !== expectedTotalCents) throw new FiscalTotalDiscrepancyError(expectedTotalCents, total as number)
  return {
    documentId,
    fiscalNumber: typeof value.fiscal_number === 'string' ? value.fiscal_number : undefined,
    fiscalType: typeof value.fiscal_type === 'string' ? value.fiscal_type : undefined,
    fiscalDate: typeof value.fiscal_date === 'string' ? value.fiscal_date : undefined,
    status: bridgeStatus(value.status),
    ...(typeof total === 'number' ? { finalTotalCents: total } : {}),
    ...(typeof value.qr_payload === 'string' || value.qr_payload === false ? { qrPayload: value.qr_payload } : {}),
    ...(typeof value.qr_url === 'string' || value.qr_url === false ? { qrUrl: value.qr_url } : {}),
    ...(typeof value.error_message === 'string' ? { error: { message: value.error_message, retryable: value.retryable === true } } : {}),
  }
}

/** Thin bridge adapter. It deliberately does not contain Veri*Factu or QR logic. */
export class OdooFiscalProvider implements FiscalDocumentProvider {
  private readonly options: OdooProviderOptions
  constructor(options: OdooProviderOptions) {
    this.options = options
  }

  private async request(path: string, method: 'POST' | 'GET', body?: unknown, idempotencyKey?: string) {
    const response = await (this.options.fetchImpl ?? fetch)(`${this.options.bridgeUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.options.bridgeSecret}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const parsed = await response.json() as unknown
    if (!response.ok) throw new OdooBridgeError('Error del puente fiscal Odoo', { retryable: response.status >= 500 || response.status === 429, status: response.status })
    if (!parsed || typeof parsed !== 'object') throw new OdooBridgeError('Respuesta Odoo invalida')
    return parsed as BridgeResponse
  }

  issue(document: CommercialFiscalDocument, options: FiscalIssueOptions = {}) {
    return this.send('/fiscal/documents', document, options.idempotencyKey ?? document.idempotencyKey, document.expectedTotalCents)
  }

  rectify(document: CommercialFiscalDocument, options: FiscalIssueOptions = {}) {
    return this.send('/fiscal/documents/rectify', document, options.idempotencyKey ?? document.idempotencyKey, document.expectedTotalCents)
  }

  private async send(path: string, document: CommercialFiscalDocument, key: string, expected: number) {
    const taxCodes: Record<string, string> = { '4': 'IVA4', '10': 'IVA10', '21': 'IVA21' }
    const payload = {
      external_id: document.externalId,
      fiscal_entity_ref: this.options.fiscalEntityRef,
      venue_ref: document.venueRef,
      document_type: document.kind === 'full' ? 'full' : 'simplified',
      operation_date: document.operationTimestamp.slice(0, 10),
      ...(document.customer ? { customer: document.customer } : {}),
      lines: document.lines.map((line) => {
        const taxCode = taxCodes[line.taxCode]
        if (!taxCode) throw new Error(`Tipo de IVA Odoo no soportado: ${line.taxCode}`)
        return {
          description: line.description,
          quantity: line.quantity,
          unit_price_cents: line.unitPriceCents,
          tax_code: taxCode,
        }
      }),
      expected_total_cents: document.expectedTotalCents,
    }
    return normalizeBridgeResponse(await this.request(path, 'POST', payload, key), expected)
  }

  async status(documentId: string) {
    return normalizeBridgeResponse(await this.request(`/fiscal/documents/${encodeURIComponent(documentId)}`, 'GET'))
  }

  async cancel(documentId: string, options: FiscalIssueOptions = {}) {
    return normalizeBridgeResponse(await this.request(`/fiscal/documents/${encodeURIComponent(documentId)}/cancel`, 'POST', undefined, options.idempotencyKey))
  }
}
