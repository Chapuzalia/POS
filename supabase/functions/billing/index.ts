import { createClient } from 'npm:@supabase/supabase-js@2.115.0'
import { billingErrorMessages } from '../_shared/billing/errors.ts'
import { billingFailureDiagnostic } from '../_shared/billing/diagnostics.ts'
import { BillingService } from '../_shared/billing/service.ts'
import { requestSchema } from '../_shared/billing/schemas.ts'
import { StripeGateway } from '../_shared/billing/stripe.ts'

Deno.serve(async request => {
  const appUrl = Deno.env.get('BILLING_APP_URL')?.replace(/\/$/, '') ?? ''
  const headers = { 'Access-Control-Allow-Origin': appUrl ? new URL(appUrl).origin : 'null', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' }
  let admin = false
  // Stripe URLs grant access to the customer's payment pages, including nested results.
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body, (key, value: unknown) => admin && ['url', 'hosted_invoice_url', 'invoice_pdf'].includes(key) ? undefined : value), { status, headers })
  if (request.method === 'OPTIONS') return reply({})
  if (request.method !== 'POST') return reply({ error: 'Método no permitido.' }, 405)
  let action = 'unvalidated'
  try {
    const url = Deno.env.get('SUPABASE_URL')
    const publicKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    const stripeKey = Deno.env.get('STRIPE_TEST_SECRET_KEY')
    if (!url || !publicKey || !serviceKey || !stripeKey || !appUrl) return reply({ error: 'Facturación sandbox pendiente de configuración.' }, 503)
    const db = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
    const service = new BillingService(db, new StripeGateway(stripeKey), appUrl, Deno.env.get('STRIPE_TEST_PORTAL_CONFIGURATION_ID') ?? '')
    const authorization = request.headers.get('Authorization') ?? ''
    const auth = createClient(url, publicKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } })
    const { data: user, error: authError } = await auth.auth.getUser()
    if (authError || !user.user) return reply({ error: 'Sesión no válida.' }, 401)
    const profile = await db.from('profiles').select('is_superadmin').eq('id', user.user.id).single()
    if (profile.error) return reply({ error: 'Acceso no autorizado.' }, 403)
    admin = profile.data.is_superadmin === true
    const raw = await request.text()
    if (raw.length > 100_000) return reply({ error: 'Solicitud demasiado grande.' }, 413)
    let input: unknown
    try { input = JSON.parse(raw) } catch { throw new Error('BILLING_INVALID_REQUEST') }
    const parsed = requestSchema.safeParse(input)
    if (!parsed.success) throw new Error('BILLING_INVALID_REQUEST')
    const body = parsed.data
    action = body.action
    if ('tenantId' in body && !admin) {
      const membership = await db.from('tenant_memberships').select('role,is_active').eq('tenant_id', body.tenantId).eq('user_id', user.user.id).maybeSingle()
      if (membership.error || membership.data?.role !== 'owner' || !membership.data.is_active) return reply({ error: 'Solo el propietario puede acceder a la facturación de su empresa.' }, 403)
    }
    const adminActions = ['overview','catalog-save','catalog-publish','retry-operation','retry-event','reconcile-batch','settings','quote-cancel']
    if (adminActions.includes(body.action) && !admin) return reply({ error: 'Esta operación requiere Superadmin.' }, 403)
    if (body.action === 'portal' && admin) return reply({ error: 'El portal de pago solo está disponible desde la cuenta del cliente.' }, 403)
    switch (body.action) {
      case 'catalog': {
        const catalog = await service.catalog()
        return reply(admin ? catalog : { ...catalog, products: catalog.products.filter(row => row.active), versions: catalog.versions.filter(row => row.published) })
      }
      case 'overview': return reply(await service.overview())
      case 'get': return reply(await service.detail(body.tenantId, admin))
      case 'save-onboarding': return reply(await service.saveOnboarding(body.tenantId, body.selection))
      case 'restart-checkout': return reply(await service.restartCheckout(body.tenantId))
      case 'catalog-save': {
        const catalog = await service.catalog()
        const valid = new Set(catalog.features.map(row => row.key))
        if ((body.product.featureKey && !valid.has(body.product.featureKey)) || body.version?.features.some(key => !valid.has(key)) || body.version?.requires.some(key => !valid.has(key))) return reply({ error: 'La funcionalidad no existe en Tickit.' }, 400)
        return reply(await service.transition('catalog_save', { actorId: user.user.id, product: body.product, version: body.version, reason: body.reason }))
      }
      case 'catalog-publish': return reply(await service.publish(body.versionId))
      case 'quote': {
        if (body.exception && !admin) return reply({ error: 'Las excepciones comerciales requieren Superadmin.' }, 403)
        return reply(await service.quote(body.tenantId, user.user.id, body.selection, body.exception, body.reason, admin))
      }
      case 'quote-cancel': return reply(await service.quoteCancel(body.tenantId, user.user.id, body.immediate, body.reason))
      case 'confirm': return reply(await service.confirm(body.tenantId, user.user.id, body.operationId))
      case 'retry-operation': return reply(await service.confirm(body.tenantId, user.user.id, body.operationId, true))
      case 'portal': return reply(await service.portal(body.tenantId))
      case 'reconcile': return reply(await service.reconcile(body.tenantId))
      case 'settings': return reply(await service.transition('settings', { ...body, actorId: user.user.id }))
      case 'retry-event': {
        const stored = await db.from('billing_stripe_events').select('event_id,event_type,stripe_created,stripe_customer_id,status').eq('event_id', body.eventId).single()
        if (stored.error || stored.data.status !== 'failed') return reply({ error: 'El evento no admite reintento.' }, 409)
        await service.processEvent({ id: stored.data.event_id, type: stored.data.event_type, created: stored.data.stripe_created, livemode: false, data: { object: { customer: stored.data.stripe_customer_id ?? undefined } } })
        return reply({ retried: true })
      }
      case 'reconcile-batch': {
        const accounts = await db.from('billing_accounts').select('tenant_id').not('stripe_customer_id','is',null).order('last_attempt_at', { nullsFirst: true }).limit(20)
        if (accounts.error) throw new Error('BILLING_DB_BATCH')
        const results = []
        for (const account of accounts.data) {
          try { await service.reconcile(account.tenant_id); results.push({ tenantId: account.tenant_id, ok: true }) }
          catch { results.push({ tenantId: account.tenant_id, ok: false }) }
        }
        return reply({ results })
      }
    }
  } catch (error) {
    console.error(JSON.stringify(billingFailureDiagnostic(action, error)))
    const message = error instanceof Error ? error.message : ''
    if (message === 'BILLING_INVALID_REQUEST') return reply({ error: billingErrorMessages[message], code: message }, 400)
    if (billingErrorMessages[message]) return reply({ error: billingErrorMessages[message], code: message }, 409)
    const invalid = message.startsWith('BILLING_INVALID') || message.includes('BELOW_USAGE') || message.includes('QUANTITY') || message.includes('PREREQUISITE') || message.includes('FOREIGN_ASSIGNMENT')
    const code = invalid ? 'BILLING_INVALID_SELECTION' : 'BILLING_ACTION_REQUIRED'
    return reply({ error: billingErrorMessages[code], code }, invalid ? 400 : 409)
  }
})
