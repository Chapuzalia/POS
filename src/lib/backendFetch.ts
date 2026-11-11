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
  // Read-only analytics can exceed the SQL timeout on high-volume venues; that
  // is a slow query, not a lost backend, so it must not degrade the session.
  const backgroundStats = /\/rest\/v1\/rpc\/(?:pos_product_sales_stats|crm_stats_period|crm_stats_live|crm_dashboard_period_summary|crm_sales_report_ticket_page|crm_sales_report_summary|crm_sales_report_aggregate_page|crm_sales_report_filter_suggestions)(?:[?#]|$)/.test(requestUrl)
  const timer = requestUrl.includes('/auth/v1/') ? setTimeout(abort, 15_000) : undefined
  try {
    const response = await fetch(input, { ...init, signal: controller.signal })
    if (response.status === 500 && requestUrl.includes('/rest/v1/')) {
      // Preserve SQL timeouts so callers can reduce their queries instead of resetting the session.
      const failure: unknown = await response.clone().json().catch(() => null)
      if (failure && typeof failure === 'object' && 'code' in failure && failure.code === '57014') return response
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) {
      // Let Supabase classify infrastructure failures as retryable, preserving
      // its own persisted session even for a proxy's non-JSON error response.
      throw new TypeError(`Servidor temporalmente inaccesible (${response.status})`)
    }
    return response
  } catch (error) {
    // Ranking failures are retried independently and must not degrade the POS session.
    if (!signal?.aborted && !backgroundStats) window.dispatchEvent(new Event(backendUnavailableEvent))
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', abort)
  }
}
