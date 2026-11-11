import { expect, it, vi } from 'vitest'
import { forwardPersonalActivation } from '../../supabase/functions/_shared/personal-activation'

const tenantId = '11111111-1111-4111-8111-111111111111'
const config = { url: 'https://personal-auth.example', anonKey: 'public-key' }
const password = 'Chosen-personal-password-123'
const request = (body: unknown = { tenantId, password }, authorized = true) => new Request('https://pos-auth.example/functions/v1/activate-personal', {
  method: 'POST', headers: authorized ? { authorization: 'Bearer pos-session' } : {}, body: JSON.stringify(body),
})

it('forwards only to the configured Personal backend and returns no password, session or shared secret', async () => {
  const result = { connectionId: tenantId, organizationId: tenantId, personalUrl: 'https://personal.example', password, secret: 'server-only', access_token: 'server-session' }
  const fetcher = vi.fn().mockResolvedValue(Response.json(result))
  const response = await forwardPersonalActivation(request(), config, fetcher)
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({ connectionId: tenantId, organizationId: tenantId, personalUrl: 'https://personal.example' })
  const [url, init] = fetcher.mock.calls[0]
  expect(String(url)).toBe('https://personal-auth.example/functions/v1/pos-activate')
  expect(init.redirect).toBe('error')
  expect(init.headers.authorization).toBe('Bearer pos-session')
  expect(JSON.parse(init.body)).toEqual({ tenantId, password })
})

it('rejects missing authentication, malformed identity and extra destination fields without forwarding', async () => {
  const fetcher = vi.fn()
  expect((await forwardPersonalActivation(request({}, false), config, fetcher)).status).toBe(401)
  for (const body of [{ tenantId, password, url: 'https://attacker.example' }, { tenantId: [tenantId], password }, { tenantId, password: '' }])
    expect((await forwardPersonalActivation(request(body), config, fetcher)).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it('requires an HTTPS destination without embedded credentials', async () => {
  const fetcher = vi.fn()
  for (const url of ['http://personal.example', 'https://user:password@personal.example', 'https://personal.example/other-path'])
    expect((await forwardPersonalActivation(request(), { ...config, url }, fetcher)).status).toBe(503)
  expect(fetcher).not.toHaveBeenCalled()
})

it('rejects fewer than six characters before forwarding and accepts exactly six', async () => {
  const fetcher = vi.fn().mockImplementation(async () => Response.json({ connectionId: tenantId, organizationId: tenantId, personalUrl: 'https://personal.example' }))
  for (const short of ['', '12345']) expect((await forwardPersonalActivation(request({ tenantId, password: short }), config, fetcher)).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
  expect((await forwardPersonalActivation(request({ tenantId, password: 'abc123' }), config, fetcher)).status).toBe(200)
  expect(JSON.parse(fetcher.mock.calls[0][1].body).password).toBe('abc123')
})

it('limits the request body before sending credentials to Personal', async () => {
  const fetcher = vi.fn()
  expect((await forwardPersonalActivation(request({ tenantId, password: 'x'.repeat(9000) }), config, fetcher)).status).toBe(413)
  expect(fetcher).not.toHaveBeenCalled()
})

it('preserves actionable activation errors and handles backend outages', async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({ error: 'Contraseña incorrecta.' }, { status: 401 }))
  const failed = await forwardPersonalActivation(request(), config, fetcher)
  expect(failed.status).toBe(401)
  expect(await failed.json()).toEqual({ error: 'Contraseña incorrecta.' })
  fetcher.mockRejectedValue(new Error('private network diagnostic'))
  const unavailable = await forwardPersonalActivation(request(), config, fetcher)
  expect(unavailable.status).toBe(502)
  expect(JSON.stringify(await unavailable.json())).not.toContain('private network diagnostic')
})
