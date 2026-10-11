import { BridgeHttpError } from './bridgeClient.ts'

/** A validation/rejection response is not a network outage. */
export function isFiscalTransportFailure(error: unknown): boolean {
  if (error instanceof BridgeHttpError) return error.status >= 500 || error.status === 408 || error.status === 429
  if (error instanceof TypeError || (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name))) return true
  if (!error || typeof error !== 'object' || !('message' in error)) return false
  if ('name' in error && ['AbortError', 'TimeoutError', 'TypeError'].includes(String(error.name))) return true
  return /failed to fetch|fetch failed|network|connection|timeout|temporarily unavailable|backend unavailable/i.test(String(error.message))
}
