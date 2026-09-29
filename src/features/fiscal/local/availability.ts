import { BridgeHttpError } from './bridgeClient.ts'

/** Only transport outages may fall back to the local queue. Authorization and conflicts still block. */
export function isFiscalTransportUnavailable(error: unknown): boolean {
  if (error instanceof BridgeHttpError) return [404, 408, 425, 429].includes(error.status) || error.status >= 500
  if (error instanceof DOMException) return error.name === 'AbortError' || error.name === 'TimeoutError'
  if (error instanceof TypeError) return true
  if (!error || typeof error !== 'object') return false
  const candidate = error as { message?: unknown; status?: unknown }
  if (typeof candidate.status === 'number' && candidate.status >= 500) return true
  const message = typeof candidate.message === 'string' ? candidate.message.toLocaleLowerCase('en-US') : ''
  return message.includes('failed to fetch')
    || message.includes('networkerror')
    || message.includes('network error')
    || message.includes('load failed')
    || message.includes('fetch resource')
    || message.includes('timeout')
}
