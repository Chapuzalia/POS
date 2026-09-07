export const backendUnavailableEvent = 'pos:backend-unavailable'

/** Report transport failures even when navigator.onLine still says true. */
export const backendFetch: typeof fetch = async (input, init) => {
  const controller = new AbortController()
  const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  // Bound auth validation only; long-running business RPCs keep their existing
  // timeouts (for example, document processing).
  const requestUrl = input instanceof Request ? input.url : String(input)
  const timer = requestUrl.includes('/auth/v1/') ? setTimeout(abort, 15_000) : undefined
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      // Let Supabase classify infrastructure failures as retryable, preserving
      // its own persisted session even for a proxy's non-JSON error response.
      throw new TypeError(`Servidor temporalmente inaccesible (${response.status})`)
    }
    return response
  } catch (error) {
    if (!signal?.aborted) window.dispatchEvent(new Event(backendUnavailableEvent))
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
