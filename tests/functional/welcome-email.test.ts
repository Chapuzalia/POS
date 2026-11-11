import { expect, it, vi } from 'vitest'
import { sendWelcomeEmail } from '../../supabase/functions/_shared/welcome-email'
import { readFileSync } from 'node:fs'

const input = { ownerId: 'owner-fixture', ownerEmail: 'owner@example.test', ownerPassword: ' A&<"234 ', ownerFullName: 'Ana <img src=x onerror=alert(1)>', tenantName: 'Café & Bar', billingMode: 'stripe' as const }
const config = { apiKey: 're_fixture_secret', appUrl: 'https://crm.example.test/base?secret=discard#fragment' }

it('uses the published Stripe template with the five escaped HTML variables and a trusted CRM link', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const status = await sendWelcomeEmail(input, config, async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return Response.json({ id: 'email-fixture' })
  })
  expect(status).toBe('sent')
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('https://api.resend.com/emails')
  expect(calls[0].init).toMatchObject({ method: 'POST', redirect: 'error' })
  expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer re_fixture_secret')
  const body = JSON.parse(String(calls[0].init.body))
  expect(body).toEqual({
    to: [input.ownerEmail],
    template: {
      id: '23a9523e-2c39-405f-8cf4-99dfa8ba8160',
      variables: {
        OWNER_NAME: 'Ana &lt;img src=x onerror=alert(1)&gt;',
        BUSINESS_NAME: 'Café &amp; Bar',
        USER_EMAIL: input.ownerEmail,
        INITIAL_PASSWORD: ' A&amp;&lt;&quot;234 ',
        LOGIN_URL: 'https://crm.example.test/crm',
      },
    },
  })
  // No HTML/text or header overrides: content, logo and defaults live in Resend.
  expect(String(calls[0].init.body)).not.toContain(config.apiKey)
  expect(String(calls[0].init.body)).not.toContain('secret=discard')
})

it('preserves the manual welcome sender, reply address, logo, credentials and CRM link with HTML escaping', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const status = await sendWelcomeEmail({ ...input, billingMode: 'manual' }, config, async (url, init = {}) => {
    calls.push({ url: String(url), init })
    return Response.json({ id: 'email-fixture' })
  })
  expect(status).toBe('sent')
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe('https://api.resend.com/emails')
  expect(calls[0].init).toMatchObject({ method: 'POST', redirect: 'error' })
  expect(new Headers(calls[0].init.headers).get('Authorization')).toBe('Bearer re_fixture_secret')
  const body = JSON.parse(String(calls[0].init.body))
  expect(body).toMatchObject({ from: 'Tickit <bienvenida@notificaciones.tickitpos.com>', reply_to: 'info@tickitpos.com', to: [input.ownerEmail] })
  expect(body.text).toContain(`Contraseña inicial: ${input.ownerPassword}`)
  expect(body.html).toContain(' A&amp;&lt;&quot;234 ')
  expect(body.html).toContain('&lt;img src=x onerror=alert(1)&gt;')
  expect(body.html).not.toContain('<img src=x')
  expect(body.html.match(/<img /g)).toHaveLength(1)
  expect(body.html).toContain('src="cid:tickit-welcome-logo"')
  expect(body.html).toContain('alt="Tickit"')
  expect(body.attachments).toHaveLength(1)
  expect(body.attachments[0]).toMatchObject({ filename: 'tickit-logo.png', content_id: 'tickit-welcome-logo' })
  expect(Buffer.from(body.attachments[0].content, 'base64')).toEqual(readFileSync(new URL('../../public/logo_black.png', import.meta.url)))
  expect(body.html).toContain('Café &amp; Bar')
  expect(body.html).toContain('href="https://crm.example.test/crm"')
  expect(body.text).toContain('Ya puedes iniciar sesión')
  expect(body.text).not.toContain('Stripe')
  expect(body).not.toHaveProperty('template')
  expect(String(calls[0].init.body)).not.toContain(config.apiKey)
  expect(body.html).not.toContain('secret=discard')
})

it('does not send without server configuration or with invalid or unsafe login URLs', async () => {
  let calls = 0
  const send: typeof fetch = async () => { calls++; return Response.json({ id: 'unexpected' }) }
  for (const invalid of [{}, { ...config, apiKey: ' ' }, { ...config, appUrl: undefined }, { ...config, appUrl: 'broken' }, { ...config, appUrl: 'javascript:alert(1)' }, { ...config, appUrl: 'http://public.example.test' }, { ...config, appUrl: 'https://user:password@example.test' }]) {
    expect(await sendWelcomeEmail(input, invalid, send)).toBe('not_configured')
  }
  expect(calls).toBe(0)
})

it('retries a lost response using the identical payload and idempotency key', async () => {
  const calls: RequestInit[] = []
  const status = await sendWelcomeEmail(input, config, async (_url, init = {}) => {
    calls.push(init)
    if (calls.length === 1) throw new Error(`lost response ${input.ownerPassword} ${config.apiKey}`)
    return Response.json({ id: 'accepted-first-time' })
  })
  expect(status).toBe('sent')
  expect(calls).toHaveLength(2)
  expect(calls[0].body).toBe(calls[1].body)
  const key = new Headers(calls[0].headers).get('Idempotency-Key')
  expect(key).toBe('tickit-welcome/owner-fixture/v1')
  expect(new Headers(calls[1].headers).get('Idempotency-Key')).toBe(key)
})

it('reports a rejected template without falling back to a different email or exposing provider content', async () => {
  const send = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body))
    expect(body.template.id).toBe('23a9523e-2c39-405f-8cf4-99dfa8ba8160')
    expect(body).not.toHaveProperty('html')
    return Response.json({ message: `Unpublished template ${input.ownerEmail} ${input.ownerPassword}` }, { status: 422 })
  })
  expect(await sendWelcomeEmail(input, config, send)).toBe('failed')
  expect(send).toHaveBeenCalledOnce()
})

it('distinguishes definitive rejections from uncertain deliveries without exposing provider errors', async () => {
  let requests = 0
  expect(await sendWelcomeEmail(input, config, async () => {
    requests++
    return Response.json({ message: `private ${config.apiKey}` }, { status: 401 })
  })).toBe('failed')
  expect(requests).toBe(1)
  expect(await sendWelcomeEmail(input, config, async () => { throw new Error('network lost') })).toBe('unknown')
  expect(await sendWelcomeEmail(input, config, async () => new Response('invalid JSON'))).toBe('unknown')
  expect(await sendWelcomeEmail(input, config, async () => Response.json({ message: 'Missing receipt' }))).toBe('unknown')
  expect(await sendWelcomeEmail(input, config, async () => new Response(null, { status: 503 }))).toBe('unknown')
  expect(await sendWelcomeEmail(input, config, async () => new Response(null, { status: 429 }))).toBe('failed')
  let attempt = 0
  expect(await sendWelcomeEmail(input, config, async () => {
    if (++attempt === 1) throw new Error('first attempt might be accepted')
    return new Response(null, { status: 400 })
  })).toBe('unknown')
})

it('uses a distinct idempotency key for each new owner', async () => {
  const keys: Array<string | null> = []
  const send: typeof fetch = async (_url, init) => { keys.push(new Headers(init?.headers).get('Idempotency-Key')); return Response.json({ id: 'email' }) }
  await sendWelcomeEmail(input, config, send)
  await sendWelcomeEmail({ ...input, ownerId: 'another-owner' }, config, send)
  expect(keys[0]).not.toBe(keys[1])
})
