import { afterEach, expect, it, vi } from 'vitest'
import { backendFetch, backendUnavailableEvent } from '../../src/lib/backendFetch'

afterEach(() => vi.unstubAllGlobals())

function setup() {
  const dispatchEvent = vi.fn()
  const fetch = vi.fn()
  vi.stubGlobal('window', { dispatchEvent })
  vi.stubGlobal('fetch', fetch)
  return { dispatchEvent, fetch }
}

it.each([
  ['pos_product_sales_stats', 'sql-timeout'], ['pos_product_sales_stats', 'network-error'],
  ['crm_dashboard_period_summary', 'sql-timeout'], ['crm_stats_period', 'sql-timeout'],
  ['crm_stats_live', 'sql-timeout'], ['crm_stats_period', 'gateway-timeout'],
  ['crm_sales_report_ticket_page', 'sql-timeout'], ['crm_sales_report_summary', 'gateway-timeout'],
  ['crm_sales_report_aggregate_page', 'sql-timeout'], ['crm_sales_report_filter_suggestions', 'sql-timeout'],
])('keeps a slow analytics read out of session recovery: %s %s', async (rpc, failure) => {
  const { dispatchEvent, fetch } = setup()
  if (failure === 'sql-timeout') fetch.mockResolvedValue(new Response(JSON.stringify({ code: '57014' }), { status: 500 }))
  else if (failure === 'gateway-timeout') fetch.mockResolvedValue(new Response(null, { status: 504 }))
  else fetch.mockRejectedValue(new TypeError('Failed to fetch'))
  const request = backendFetch(`https://example.invalid/rest/v1/rpc/${rpc}`, { method: 'POST' })
  if (failure === 'sql-timeout') {
    const response = await request
    expect(response.status).toBe(500)
    await expect(response.json()).resolves.toEqual({ code: '57014' })
  } else await expect(request).rejects.toBeInstanceOf(TypeError)
  expect(dispatchEvent).not.toHaveBeenCalled()
})

it('preserves a fiscal SQL timeout and its body without triggering session recovery', async () => {
  const { dispatchEvent, fetch } = setup()
  const error = { code: '57014', details: null, hint: null, message: 'canceling statement due to statement timeout' }
  fetch.mockResolvedValue(Response.json(error, { status: 500 }))
  const response = await backendFetch('https://example.invalid/rest/v1/fiscal_local_records?limit=50')
  await expect(response.json()).resolves.toEqual(error)
  expect(dispatchEvent).not.toHaveBeenCalled()
})

it.each([null, '<html>Bad gateway</html>', JSON.stringify({ code: 'XX000' }), 'null'])(
  'retains session recovery for other REST server failures: %s', async (body) => {
    const { dispatchEvent, fetch } = setup()
    fetch.mockResolvedValue(new Response(body, { status: 500 }))
    await expect(backendFetch('https://example.invalid/rest/v1/fiscal_local_records')).rejects.toBeInstanceOf(TypeError)
    expect(dispatchEvent).toHaveBeenCalledOnce()
  },
)

it.each(['/auth/v1/token', '/rest/v1/rpc/create_sale', '/rest/v1/rpc/crm_stats_period_extra'])('still triggers session recovery for an operational failure: %s', async (path) => {
  const { dispatchEvent, fetch } = setup()
  fetch.mockResolvedValue(new Response(null, { status: 503 }))
  await expect(backendFetch(`https://example.invalid${path}`, { method: 'POST' })).rejects.toBeInstanceOf(TypeError)
  expect(dispatchEvent).toHaveBeenCalledOnce()
  expect(dispatchEvent.mock.calls[0][0].type).toBe(backendUnavailableEvent)
})
