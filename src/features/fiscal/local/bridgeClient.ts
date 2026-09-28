import { z } from 'zod'

export const bridgeStates = [
  'LOCAL_PENDING', 'VPS_STORED', 'AEAT_ACCEPTED',
  'AEAT_ACCEPTED_WITH_ERRORS', 'AEAT_REJECTED', 'REQUIRES_ACTION',
] as const

const resultSchema = z.object({
  idempotencyKey: z.string().min(1),
  state: z.enum(bridgeStates),
  code: z.string().nullable(),
  description: z.string().nullable(),
  csv: z.string().nullable(),
  responseRef: z.string().nullable(),
  vpsStoredAt: z.iso.datetime({ offset: true }).nullable(),
  aeatRespondedAt: z.iso.datetime({ offset: true }).nullable(),
  retryAfterSeconds: z.number().int().min(0).max(86400).optional(),
})

const batchResponseSchema = z.object({ contract: z.literal('tickit-verifactu-bridge'), version: z.literal(1), results: z.array(resultSchema) })
const leaseResponseSchema = z.object({ contract: z.literal('tickit-verifactu-bridge'), version: z.literal(1), leaseId: z.string().min(1), installationId: z.string().min(1), deviceId: z.string().min(1), fencingToken: z.number().int().positive(), expiresAt: z.iso.datetime({ offset: true }), serverUtcAt: z.iso.datetime({ offset: true }) })
const responseEventsSchema = z.object({
  idempotencyKey: z.string().min(1),
  events: z.array(z.object({
    at: z.iso.datetime({ offset: true }), state: z.enum(bridgeStates),
    code: z.string().nullable(), description: z.string().nullable(),
    csv: z.string().nullable(), responseRef: z.string().nullable(),
  })),
})

export class BridgeHttpError extends Error {
  readonly status: number

  constructor(status: number) {
    super(`Puente fiscal: HTTP ${status}`)
    this.status = status
  }
}

export type BridgeResult = z.infer<typeof resultSchema>

export type BridgeRecord = {
  idempotencyKey: string
  environment: 'test' | 'production'
  tenantId: string
  fiscalSubjectId: string
  issuerNif: string
  venueId: string
  cashRegisterId: string
  installationId: string
  deviceId: string
  lease?: { leaseId: string; fencingToken: number }
  invoiceId: string
  chainPosition: number
  previous: { issuerNif: string; seriesAndNumber: string; issueDate: string; hash: string } | null
  hash: string
  generatedAt: string
  canonicalSchema: 'aeat-registro-v1'
  canonicalRecord: Record<string, unknown>
}

export type BridgeInvoiceSnapshot = {
  issuerName: string; issuerNif: string; issuerAddress?: string
  series: string; number: number; issuedAt: string; qrUrl: string
  ticketId: string; saleId: string; paymentId: string | null
  lines: readonly { description: string; grossCents: number; discountCents: number; baseCents: number; taxCents: number; taxRate: string }[]
  recipient: { name: string; nif: string } | null; totalCents: number; taxCents: number
}

export type BridgeSubmission = BridgeRecord & { invoice: BridgeInvoiceSnapshot }

export type BridgeClientConfig = {
  mode: 'disabled' | 'test' | 'production'
  baseUrl: string
  getAccessToken: () => Promise<string>
}

/** Transport only. A bridge response cannot replace canonicalRecord or hash. */
export function createBridgeClient(config: BridgeClientConfig) {
  if (config.mode === 'disabled') throw new Error('El componente fiscal local está desactivado.')
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw new Error('El puente fiscal requiere una URL HTTPS sin credenciales ni parámetros.')
  }

  async function request(path: string, init?: RequestInit): Promise<unknown> {
    const token = await config.getAccessToken()
    if (!token) throw new Error('No hay una sesión de dispositivo válida para el puente fiscal.')
    const response = await fetch(new URL(path, base), {
      ...init,
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...init?.headers },
      cache: 'no-store',
      signal: init?.signal ?? AbortSignal.timeout(20000),
    })
    if (!response.ok) throw new BridgeHttpError(response.status)
    return response.json()
  }

  return {
    async acquireInstallationLease(installationId: string, deviceId: string) {
      const value = leaseResponseSchema.parse(await request(`/v1/installations/${encodeURIComponent(installationId)}/lease`, {
        method: 'POST', body: JSON.stringify({ contract: 'tickit-verifactu-bridge', version: 1, deviceId }),
      }))
      const wallUtcAtReceipt = Date.now()
      const monotonicAtReceipt = performance.now()
      if (value.installationId !== installationId || value.deviceId !== deviceId) throw new Error('La concesión corresponde a otro dispositivo.')
      return {
        leaseId: value.leaseId, installationId, deviceId, fencingToken: value.fencingToken,
        expiresAt: value.expiresAt,
        clock: { serverUtcAtReceipt: value.serverUtcAt, wallUtcAtReceipt, monotonicAtReceipt },
      }
    },
    async deliver(records: readonly BridgeSubmission[]): Promise<BridgeResult[]> {
      if (records.length === 0 || records.length > 100) throw new Error('El lote fiscal debe contener entre 1 y 100 registros.')
      if (records.some(record => record.environment !== config.mode)) {
        throw new Error('El entorno del registro fiscal no coincide con el del puente.')
      }
      if (new Set(records.map(record => record.idempotencyKey)).size !== records.length) {
        throw new Error('El lote fiscal contiene claves idempotentes repetidas.')
      }
      const response = batchResponseSchema.parse(await request('/v1/records', {
        method: 'POST', body: JSON.stringify({ contract: 'tickit-verifactu-bridge', version: 1, records }),
      }))
      const requested = new Set(records.map(record => record.idempotencyKey))
      if (response.results.length !== requested.size
        || new Set(response.results.map(result => result.idempotencyKey)).size !== requested.size
        || response.results.some(result => !requested.has(result.idempotencyKey) || result.state === 'LOCAL_PENDING')) {
        throw new Error('El puente no ha respondido individualmente a todos los registros.')
      }
      return response.results
    },
    async status(idempotencyKey: string): Promise<BridgeResult> {
      const result = resultSchema.parse(await request(`/v1/records/${encodeURIComponent(idempotencyKey)}`))
      if (result.idempotencyKey !== idempotencyKey || result.state === 'LOCAL_PENDING') throw new Error('El puente respondió sobre otro registro fiscal.')
      return result
    },
    async responses(idempotencyKey: string) {
      const value = responseEventsSchema.parse(await request(`/v1/records/${encodeURIComponent(idempotencyKey)}/responses`))
      if (value.idempotencyKey !== idempotencyKey) throw new Error('El puente devolvió respuestas de otro registro fiscal.')
      return value.events
    },
  }
}
