import { afterEach, expect, it, vi } from 'vitest'
import { OdooGateway, OdooRequestError } from '../../supabase/functions/_shared/billing/odoo'
import { odooFromEnv } from '../../supabase/functions/_shared/billing/env'

afterEach(() => { vi.unstubAllGlobals() })

const KEY = 'secret-odoo-key-123'
function gateway(respond: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const requests: { url: string; init: RequestInit }[] = []
  const transport = (async (url: string, init: RequestInit) => { requests.push({ url, init }); return respond(url, init) }) as unknown as typeof fetch
  return { odoo: new OdooGateway('https://odoo.test/', 'Alteil', KEY, transport), requests }
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

it('posts JSON-2 calls with bearer key and database header', async () => {
  const { odoo, requests } = gateway(() => json([{ id: 7 }]))
  const params = { domain: [['vat', '=', 'ESB12345678']], fields: ['id'], limit: 1 }
  await expect(odoo.call('res.partner', 'search_read', params)).resolves.toEqual([{ id: 7 }])
  expect(requests[0].url).toBe('https://odoo.test/json/2/res.partner/search_read')
  expect(requests[0].init.method).toBe('POST')
  expect(requests[0].init.headers).toMatchObject({ Authorization: `bearer ${KEY}`, 'X-Odoo-Database': 'Alteil', 'Content-Type': 'application/json' })
  expect(JSON.parse(String(requests[0].init.body))).toEqual(params)
  expect(requests[0].init.signal).toBeInstanceOf(AbortSignal)
})

it('maps failures to codes without leaking bodies', async () => {
  const cases: [() => Response, string][] = [
    [() => { throw new TypeError('network down') }, 'ODOO_UNAVAILABLE'],
    [() => json({ message: 'Traceback NIF ESB12345678' }, 500), 'ODOO_UNAVAILABLE'],
    [() => json({ message: 'bad key' }, 401), 'ODOO_AUTH'],
    [() => json({ message: 'denied' }, 403), 'ODOO_AUTH'],
    [() => json({ message: 'ValidationError ESB12345678' }, 400), 'ODOO_REJECTED'],
    [() => json({ message: 'UserError' }, 422), 'ODOO_REJECTED'],
  ]
  for (const [respond, code] of cases) {
    const error = await gateway(respond).odoo.call('res.partner', 'create', {}).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(OdooRequestError)
    expect((error as Error).message).toBe(code)
    const serialized = JSON.stringify(error) + String(error) + JSON.stringify((error as OdooRequestError).diagnostic)
    expect(serialized).not.toContain(KEY)
    expect(serialized).not.toContain('ESB12345678')
  }
})

it('only downloads portal PDFs', async () => {
  const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
  await expect(gateway(() => new Response(pdf)).odoo.pdf('/web/content/1')).rejects.toThrow('ODOO_REJECTED')
  await expect(gateway(() => new Response('<html>', { headers: { 'content-type': 'text/html' } })).odoo.pdf('/my/invoices/1?access_token=x')).rejects.toThrow('ODOO_REJECTED')
  const { odoo, requests } = gateway(() => new Response(pdf, { headers: { 'content-type': 'application/pdf' } }))
  await expect(odoo.pdf('/my/invoices/1?access_token=x&report_type=pdf')).resolves.toEqual(pdf)
  expect(requests[0].url).toBe('https://odoo.test/my/invoices/1?access_token=x&report_type=pdf')
  expect(requests[0].init.method).toBe('GET')
})

it('is disabled without the three env vars', () => {
  const values: Record<string, string> = { ODOO_URL: 'https://odoo.test', ODOO_DB: 'Alteil' }
  vi.stubGlobal('Deno', { env: { get: (name: string) => values[name] } })
  expect(odooFromEnv()).toBeNull()
  values.ODOO_API_KEY = KEY
  expect(odooFromEnv()).toBeInstanceOf(OdooGateway)
})
