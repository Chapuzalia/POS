import { requestVerifactiJson } from './client.ts'
import type {
  FiscalProvider,
  ProviderHttpResult,
  ProviderCreateResponse,
  ProviderStatusResponse,
  TicketBaiCreatePayload,
  VerifactuCreatePayload,
} from './types.ts'

type ProviderOptions = {
  apiKey: string
  fetchImpl?: typeof fetch
  sleep?: (milliseconds: number) => Promise<void>
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
