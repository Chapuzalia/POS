import type { ProviderHttpResult } from './types.ts'

const API_BASE_URL = 'https://api.verifacti.com'

export class ProviderHttpError extends Error {
  readonly attempts: number
  readonly body: unknown
  readonly retryable: boolean
  readonly status: number | null

  constructor(message: string, options: { attempts: number; body?: unknown; retryable: boolean; status?: number | null }) {
    super(message)
    this.name = 'ProviderHttpError'
    this.attempts = options.attempts
    this.body = options.body
    this.retryable = options.retryable
    this.status = options.status ?? null
  }
}

type RequestOptions = {
  apiKey: string
  body?: unknown
  fetchImpl?: typeof fetch
  idempotencyKey?: string
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  path: string
  sleep?: (milliseconds: number) => Promise<void>
}

function errorMessage(body: unknown, fallback: string) {
  if (body && typeof body === 'object') {
    const value = body as Record<string, unknown>
    if (typeof value.message === 'string') return value.message
    if (typeof value.error === 'string') return value.error
  }
  return fallback
}

async function parseBody(response: Response) {
  const text = await response.text()
  if (!text) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return { raw: text }
  }
}

function retryDelay(response: Response | null, attempt: number) {
  const retryAfter = response?.headers.get('Retry-After')
  const retryAfterMilliseconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : 0
  return Math.min(3000, retryAfterMilliseconds || 250 * (2 ** (attempt - 1)))
}

export async function requestVerifactiJson<T>(options: RequestOptions): Promise<ProviderHttpResult<T>> {
  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)))
  const maxAttempts = 3

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response: Response | null = null
    try {
      response = await fetchImpl(`${API_BASE_URL}${options.path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(options.idempotencyKey ? { 'Idempotency-Key': options.idempotencyKey } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      })
      const body = await parseBody(response)
      if (response.ok) {
        return { data: body as T, httpStatus: response.status, attempts: attempt }
      }

      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt === maxAttempts) {
        throw new ProviderHttpError(errorMessage(body, `Verifacti respondio ${response.status}`), {
          attempts: attempt,
          body,
          retryable,
          status: response.status,
        })
      }
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error
      if (attempt === maxAttempts) {
        throw new ProviderHttpError(error instanceof Error ? error.message : 'Error de red al conectar con Verifacti', {
          attempts: attempt,
          body: null,
          retryable: true,
          status: null,
        })
      }
    }
    await sleep(retryDelay(response, attempt))
  }

  throw new ProviderHttpError('No se pudo completar la llamada a Verifacti', { attempts: maxAttempts, retryable: true })
}

