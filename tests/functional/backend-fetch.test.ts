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

it.each(['sql-timeout', 'network-error'])('keeps a background ranking failure out of session recovery: %s', async (failure) => {
  const { dispatchEvent, fetch } = setup()
  if (failure === 'sql-timeout') fetch.mockResolvedValue(new Response(JSON.stringify({ code: '57014' }), { status: 500 }))
  else fetch.mockRejectedValue(new TypeError('Failed to fetch'))
  await expect(backendFetch('https://example.invalid/rest/v1/rpc/pos_product_sales_stats', { method: 'POST' })).rejects.toBeInstanceOf(TypeError)
  expect(dispatchEvent).not.toHaveBeenCalled()
})

it.each(['/auth/v1/token', '/rest/v1/rpc/create_sale'])('still triggers session recovery for an operational failure: %s', async (path) => {
  const { dispatchEvent, fetch } = setup()
  fetch.mockResolvedValue(new Response(null, { status: 503 }))
  await expect(backendFetch(`https://example.invalid${path}`, { method: 'POST' })).rejects.toBeInstanceOf(TypeError)
  expect(dispatchEvent).toHaveBeenCalledOnce()
  expect(dispatchEvent.mock.calls[0][0].type).toBe(backendUnavailableEvent)
})
