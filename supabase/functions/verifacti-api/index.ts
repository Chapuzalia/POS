import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decryptSecret, encryptSecret, generateWebhookSecret } from '../_shared/verifacti/crypto.ts'
import { ProviderHttpError, requestVerifactiJson } from '../_shared/verifacti/client.ts'
import {
  mapFiscalCancellation,
  mapProviderStatus,
  mapTicketBaiInvoice,
  mapVerifactuInvoice,
  stableFiscalIdempotencyKey,
} from '../_shared/verifacti/mapping.ts'
import { createFiscalProvider } from '../_shared/verifacti/providers.ts'
import type { FiscalInvoiceRow, FiscalTicket, ProviderStatusResponse } from '../_shared/verifacti/types.ts'

const corsHeaders = {
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: corsHeaders, status })
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const encryptionKey = Deno.env.get('VERIFACTI_ENCRYPTION_KEY')
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    throw new Error('Falta configurar Supabase')
  }
  return { anonKey, encryptionKey, serviceRoleKey, supabaseUrl }
}

function requireEncryptionKey(encryptionKey: string | undefined) {
  if (!encryptionKey) throw new Error('Falta configurar VERIFACTI_ENCRYPTION_KEY')
  return encryptionKey
}

function webhookUrl(supabaseUrl: string, tenantId: string) {
  return `${supabaseUrl.replace(/\/$/, '')}/functions/v1/verifacti-webhook?tenant_id=${encodeURIComponent(tenantId)}`
}

function publicSettings(row: Record<string, unknown> | null, url: string) {
  return {
    enabled: row?.enabled === true,
    provider: row?.provider === 'ticketbai' ? 'ticketbai' : 'verifactu',
    environment: row?.environment === 'production' ? 'production' : 'test',
    hasApiKey: typeof row?.api_key_ciphertext === 'string' && row.api_key_ciphertext.length > 0,
    hasManagementApiKey: typeof row?.management_api_key_ciphertext === 'string' && row.management_api_key_ciphertext.length > 0,
    automaticSubmission: row?.automatic_submission !== false,
    webhooksEnabled: row?.webhooks_enabled === true,
    webhookUrl: url,
    connectionStatus: typeof row?.connection_status === 'string' ? row.connection_status : 'untested',
    connectionCheckedAt: typeof row?.connection_checked_at === 'string' ? row.connection_checked_at : null,
    connectionError: typeof row?.connection_error === 'string' ? row.connection_error : null,
  }
}

function normalizeProviderEnvironment(value: unknown) {
  const normalized = String(value ?? '').toLowerCase()
  return normalized === 'production' || normalized === 'prod' ? 'production' : normalized
}

function errorCode(error: ProviderHttpError) {
  if (error.body && typeof error.body === 'object' && 'error' in error.body) return String(error.body.error)
  if (error.status) return `http_${error.status}`
  return 'network_error'
}

function fiscalReceipt(invoice: Record<string, unknown>) {
  return {
    invoiceId: String(invoice.id),
    provider: invoice.provider,
    status: invoice.status,
    uuid: invoice.external_uuid ?? null,
    externalCode: invoice.external_code ?? null,
    qrBase64: invoice.qr_base64 ?? null,
    verificationUrl: invoice.verification_url ?? null,
  }
}

async function insertEvent(admin: ReturnType<typeof createClient>, invoice: FiscalInvoiceRow, values: Record<string, unknown>) {
  const { error } = await admin.from('fiscal_invoice_events').insert({
    tenant_id: invoice.tenant_id,
    venue_id: invoice.venue_id,
    fiscal_invoice_id: invoice.id,
    ...values,
  })
  if (error) console.error('Could not persist fiscal event', error)
}

async function loadSettings(admin: ReturnType<typeof createClient>, tenantId: string) {
  const { data, error } = await admin.from('fiscal_integration_settings').select('*').eq('tenant_id', tenantId).maybeSingle()
  if (error) throw error
  return data as Record<string, unknown> | null
}

async function loadInvoiceBundle(admin: ReturnType<typeof createClient>, tenantId: string, ticketId: string) {
  const [{ data: invoice, error: invoiceError }, { data: ticket, error: ticketError }] = await Promise.all([
    admin.from('fiscal_invoices').select('*').eq('tenant_id', tenantId).eq('ticket_id', ticketId).maybeSingle(),
    admin.from('tickets').select(`
      id, tenant_id, venue_id, total_cents, local_created_at,
      ticket_lines (
        id, product_name, variant_name, quantity, allocated_quantity,
        net_total_cents, taxable_base_cents, tax_amount_cents, tax_rate
      )
    `).eq('tenant_id', tenantId).eq('id', ticketId).maybeSingle(),
  ])
  if (invoiceError || ticketError) throw invoiceError ?? ticketError
  if (!invoice || !ticket) throw new Error('Factura fiscal o ticket no encontrado')

  const normalizedTicket = {
    ...ticket,
    ticket_lines: (ticket.ticket_lines ?? []).map((line: Record<string, unknown>) => ({
      ...line,
      quantity: Number(line.allocated_quantity ?? line.quantity),
      net_total_cents: Number(line.net_total_cents),
      taxable_base_cents: line.taxable_base_cents === null ? null : Number(line.taxable_base_cents),
      tax_amount_cents: line.tax_amount_cents === null ? null : Number(line.tax_amount_cents),
      tax_rate: line.tax_rate === null ? null : Number(line.tax_rate),
    })),
  } as FiscalTicket
  return { invoice: invoice as FiscalInvoiceRow, ticket: normalizedTicket }
}

async function applyStatus(
  admin: ReturnType<typeof createClient>,
  invoice: FiscalInvoiceRow,
  response: ProviderStatusResponse,
  source: 'status' | 'webhook',
  httpStatus?: number,
) {
  const status = mapProviderStatus(response.estado)
  const terminal = ['accepted', 'accepted_with_errors', 'rejected', 'cancelled'].includes(status)
  const now = new Date().toISOString()
  const { error } = await admin.from('fiscal_invoices').update({
    status,
    pending_operation: terminal ? 'none' : invoice.pending_operation,
    response_payload: response,
    external_uuid: response.uuid ?? invoice.external_uuid,
    external_code: response.tbai ?? undefined,
    qr_base64: response.qr ?? undefined,
    verification_url: response.url ?? undefined,
    error_code: response.codigo_error ?? null,
    error_message: response.mensaje_error ?? null,
    next_retry_at: null,
    confirmed_at: terminal ? now : null,
    cancelled_at: status === 'cancelled' ? now : null,
    updated_at: now,
  }).eq('id', invoice.id).eq('tenant_id', invoice.tenant_id)
  if (error) throw error
  await insertEvent(admin, invoice, {
    source,
    event_type: source === 'status' ? 'status_checked' : 'webhook_received',
    status,
    http_status: httpStatus ?? null,
    payload: response,
    error_code: response.codigo_error ?? null,
    error_message: response.mensaje_error ?? null,
  })
  return status
}

async function issueInvoice(
  admin: ReturnType<typeof createClient>,
  encryptionKey: string | undefined,
  tenantId: string,
  ticketId: string,
  automatic: boolean,
) {
  const settings = await loadSettings(admin, tenantId)
  if (!settings?.enabled) return { skipped: true, reason: 'integration_disabled' }
  if (automatic && settings.automatic_submission !== true) return { skipped: true, reason: 'automatic_submission_disabled' }
  if (typeof settings.api_key_ciphertext !== 'string') throw new Error('Configura una API key antes de emitir facturas')

  const { invoice, ticket } = await loadInvoiceBundle(admin, tenantId, ticketId)
  if (invoice.external_uuid) return { fiscal: fiscalReceipt(invoice as unknown as Record<string, unknown>), skipped: true, reason: 'already_submitted' }
  const apiKey = await decryptSecret(settings.api_key_ciphertext, requireEncryptionKey(encryptionKey))
  const provider = createFiscalProvider(invoice.provider, { apiKey })

  try {
    const payload = invoice.provider === 'ticketbai'
      ? mapTicketBaiInvoice(invoice, ticket)
      : mapVerifactuInvoice(invoice, ticket)
    const idempotencyKey = stableFiscalIdempotencyKey(invoice.tenant_id, invoice.id, 'create')
    await admin.from('fiscal_invoices').update({ request_payload: payload, idempotency_key: idempotencyKey, updated_at: new Date().toISOString() }).eq('id', invoice.id)
    await insertEvent(admin, invoice, { source: 'outbound', event_type: 'create_requested', status: 'pending', payload })
    const result = await provider.create(payload, idempotencyKey)
    // /create only confirms that Verifacti queued the record. The definitive
    // fiscal status is applied exclusively from /status or a signed webhook.
    const nextStatus = 'pending' as const
    const now = new Date().toISOString()
    const { error } = await admin.from('fiscal_invoices').update({
      status: nextStatus,
      pending_operation: 'create',
      external_uuid: result.data.uuid,
      external_code: result.data.tbai ?? null,
      qr_base64: result.data.qr ?? null,
      verification_url: result.data.url ?? null,
      response_payload: result.data,
      error_code: null,
      error_message: null,
      attempts: invoice.attempts + result.attempts,
      next_retry_at: null,
      sent_at: now,
      updated_at: now,
    }).eq('id', invoice.id).eq('tenant_id', tenantId)
    if (error) throw error
    await insertEvent(admin, invoice, { source: 'outbound', event_type: 'create_queued', status: nextStatus, http_status: result.httpStatus, payload: result.data })
    return {
      fiscal: fiscalReceipt({
        ...invoice,
        status: nextStatus,
        external_uuid: result.data.uuid,
        external_code: result.data.tbai ?? null,
        qr_base64: result.data.qr ?? null,
        verification_url: result.data.url ?? null,
      }),
      skipped: false,
    }
  } catch (error) {
    const providerError = error instanceof ProviderHttpError ? error : null
    const status = providerError?.status === 400 ? 'rejected' : 'error'
    const retryAt = providerError?.retryable ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null
    const code = providerError ? errorCode(providerError) : 'mapping_validation'
    const message = error instanceof Error ? error.message : 'Error al emitir la factura fiscal'
    await admin.from('fiscal_invoices').update({
      status,
      response_payload: providerError?.body ?? null,
      error_code: code,
      error_message: message,
      attempts: invoice.attempts + (providerError?.attempts ?? 0),
      next_retry_at: retryAt,
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id).eq('tenant_id', tenantId)
    await insertEvent(admin, invoice, { source: 'outbound', event_type: 'create_failed', status, http_status: providerError?.status ?? null, payload: providerError?.body ?? null, error_code: code, error_message: message })
    throw error
  }
}

async function queueInvoiceCancellation(
  admin: ReturnType<typeof createClient>,
  encryptionKey: string | undefined,
  settings: Record<string, unknown> | null,
  invoice: FiscalInvoiceRow & Record<string, unknown>,
) {
  if (invoice.status === 'cancelled') {
    return { status: 'cancelled' as const, response: (invoice.response_payload ?? {}) as Record<string, unknown> }
  }
  if (invoice.pending_operation === 'cancel') {
    return { status: 'pending' as const, response: (invoice.response_payload ?? {}) as Record<string, unknown> }
  }
  if (!settings || typeof settings.api_key_ciphertext !== 'string') {
    throw new Error('Integracion sin API key')
  }

  const payload = mapFiscalCancellation(invoice)
  const key = stableFiscalIdempotencyKey(invoice.tenant_id, invoice.id, 'cancel')
  await insertEvent(admin, invoice, { source: 'user', event_type: 'cancel_requested', status: 'pending', payload })

  try {
    const provider = createFiscalProvider(invoice.provider, {
      apiKey: await decryptSecret(settings.api_key_ciphertext, requireEncryptionKey(encryptionKey)),
    })
    const result = await provider.cancel(payload, key)
    const now = new Date().toISOString()
    const { error } = await admin.from('fiscal_invoices').update({
      status: 'pending',
      pending_operation: 'cancel',
      idempotency_key: key,
      external_uuid: result.data.uuid ?? invoice.external_uuid,
      response_payload: result.data,
      attempts: invoice.attempts + result.attempts,
      error_code: null,
      error_message: null,
      sent_at: now,
      updated_at: now,
    }).eq('id', invoice.id).eq('tenant_id', invoice.tenant_id)
    if (error) throw error
    await insertEvent(admin, invoice, {
      source: 'outbound', event_type: 'cancel_queued', status: 'pending',
      http_status: result.httpStatus, payload: result.data,
    })
    return { status: 'pending' as const, response: result.data }
  } catch (error) {
    const providerError = error instanceof ProviderHttpError ? error : null
    const code = providerError ? errorCode(providerError) : 'cancel_error'
    const message = error instanceof Error ? error.message : 'No se pudo solicitar la anulacion fiscal'
    await admin.from('fiscal_invoices').update({
      error_code: code,
      error_message: message,
      attempts: invoice.attempts + (providerError?.attempts ?? 0),
      updated_at: new Date().toISOString(),
    }).eq('id', invoice.id).eq('tenant_id', invoice.tenant_id)
    await insertEvent(admin, invoice, {
      source: 'outbound', event_type: 'cancel_failed', status: invoice.status,
      http_status: providerError?.status ?? null, payload: providerError?.body ?? null,
      error_code: code, error_message: message,
    })
    throw error
  }
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return json({ error: 'Metodo no permitido' }, 405)

  try {
    const env = requiredEnvironment()
    const authorization = request.headers.get('Authorization')
    if (!authorization) return json({ error: 'Autorizacion requerida' }, 401)
    const authClient = createClient(env.supabaseUrl, env.anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false },
    })
    const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data: authData, error: authError } = await authClient.auth.getUser()
    if (authError || !authData.user) return json({ error: 'Sesion no valida' }, 401)

    const body = await request.json() as Record<string, unknown>
    const action = String(body.action ?? '')
    const tenantId = String(body.tenantId ?? '')
    if (!tenantId) return json({ error: 'tenantId es obligatorio' }, 400)
    const [{ data: membership, error: membershipError }, { data: tenant, error: tenantError }] = await Promise.all([
      admin.from('tenant_memberships').select('role, is_active').eq('tenant_id', tenantId).eq('user_id', authData.user.id).maybeSingle(),
      admin.from('tenants').select('is_active').eq('id', tenantId).maybeSingle(),
    ])
    if (membershipError || tenantError || !membership?.is_active || !tenant?.is_active) {
      return json({ error: 'No tienes acceso a este negocio' }, 403)
    }
    const isAdmin = membership.role === 'owner' || membership.role === 'manager'
    const isOwner = membership.role === 'owner'
    const url = webhookUrl(env.supabaseUrl, tenantId)

    if (action === 'get-config') {
      if (!isAdmin) return json({ error: 'No tienes permiso para consultar la integracion' }, 403)
      return json(publicSettings(await loadSettings(admin, tenantId), url))
    }

    if (action === 'save-config') {
      if (!isOwner) return json({ error: 'Solo el propietario puede configurar Verifacti' }, 403)
      const existing = await loadSettings(admin, tenantId)
      const provider = body.provider === 'ticketbai' ? 'ticketbai' : body.provider === 'verifactu' ? 'verifactu' : null
      const environment = body.environment === 'production' ? 'production' : body.environment === 'test' ? 'test' : null
      if (!provider || !environment) return json({ error: 'Proveedor o entorno no valido' }, 400)
      const rawApiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : ''
      const rawManagementApiKey = typeof body.managementApiKey === 'string' ? body.managementApiKey.trim() : ''
      const apiKeyCiphertext = rawApiKey
        ? await encryptSecret(rawApiKey, requireEncryptionKey(env.encryptionKey))
        : typeof existing?.api_key_ciphertext === 'string' ? existing.api_key_ciphertext : null
      const managementApiKeyCiphertext = rawManagementApiKey
        ? await encryptSecret(rawManagementApiKey, requireEncryptionKey(env.encryptionKey))
        : typeof existing?.management_api_key_ciphertext === 'string' ? existing.management_api_key_ciphertext : null
      const connectionContextChanged = Boolean(rawApiKey)
        || existing?.provider !== provider
        || existing?.environment !== environment
      if ((body.enabled === true || body.webhooksEnabled === true) && !apiKeyCiphertext) {
        return json({ error: 'La API key de facturacion es obligatoria para activar la integracion o sus webhooks' }, 400)
      }
      if (body.webhooksEnabled === true && !managementApiKeyCiphertext) {
        return json({ error: 'La API key de gestion es obligatoria para registrar webhooks' }, 400)
      }

      let webhookSecretCiphertext = typeof existing?.webhook_secret_ciphertext === 'string' ? existing.webhook_secret_ciphertext : null
      let webhookExternalId = typeof existing?.webhook_external_id === 'string' ? existing.webhook_external_id : null
      if (apiKeyCiphertext && managementApiKeyCiphertext && (body.webhooksEnabled === true || webhookExternalId)) {
        const encryptionKey = requireEncryptionKey(env.encryptionKey)
        const apiKey = await decryptSecret(apiKeyCiphertext, encryptionKey)
        const managementApiKey = await decryptSecret(managementApiKeyCiphertext, encryptionKey)
        const secret = webhookSecretCiphertext
          ? await decryptSecret(webhookSecretCiphertext, encryptionKey)
          : generateWebhookSecret()
        if (!webhookSecretCiphertext) webhookSecretCiphertext = await encryptSecret(secret, encryptionKey)
        const health = await createFiscalProvider(provider, { apiKey }).health()
        const nif = typeof health.data.nif === 'string' ? health.data.nif : null
        const environmentChanged = existing?.environment !== undefined && existing.environment !== environment
        if (webhookExternalId && environmentChanged) {
          await requestVerifactiJson({ apiKey: managementApiKey, body: { activo: false }, method: 'PUT', path: `/webhooks/${encodeURIComponent(webhookExternalId)}` })
          webhookExternalId = null
        }
        if (body.webhooksEnabled === true) {
          const webhookBody = { url, secret, activo: true, ...(nif ? { nifs: [nif] } : {}) }
          if (webhookExternalId) {
            await requestVerifactiJson({ apiKey: managementApiKey, body: webhookBody, method: 'PUT', path: `/webhooks/${encodeURIComponent(webhookExternalId)}` })
          } else {
            const created = await requestVerifactiJson<{ id: string }>({
              apiKey: managementApiKey,
              body: { url, entorno: environment === 'production' ? 'prod' : 'test', secret, ...(nif ? { nifs: [nif] } : {}) },
              method: 'POST',
              path: '/webhooks',
            })
            webhookExternalId = created.data.id
          }
        } else if (webhookExternalId) {
          await requestVerifactiJson({ apiKey: managementApiKey, body: { activo: false }, method: 'PUT', path: `/webhooks/${encodeURIComponent(webhookExternalId)}` })
        }
      }

      const { data, error } = await admin.from('fiscal_integration_settings').upsert({
        tenant_id: tenantId,
        enabled: body.enabled === true,
        provider,
        environment,
        api_key_ciphertext: apiKeyCiphertext,
        management_api_key_ciphertext: managementApiKeyCiphertext,
        automatic_submission: body.automaticSubmission === true,
        webhooks_enabled: body.webhooksEnabled === true,
        webhook_url: url,
        webhook_secret_ciphertext: webhookSecretCiphertext,
        webhook_external_id: webhookExternalId,
        connection_status: connectionContextChanged ? 'untested' : existing?.connection_status ?? 'untested',
        connection_checked_at: connectionContextChanged ? null : existing?.connection_checked_at ?? null,
        connection_error: connectionContextChanged ? null : existing?.connection_error ?? null,
        updated_at: new Date().toISOString(),
      }).select('*').single()
      if (error) throw error
      return json(publicSettings(data, url))
    }

    if (action === 'test-connection') {
      if (!isOwner) return json({ error: 'Solo el propietario puede probar la conexion' }, 403)
      const settings = await loadSettings(admin, tenantId)
      if (!settings || typeof settings.api_key_ciphertext !== 'string') return json({ error: 'Guarda primero una API key' }, 400)
      try {
        const apiKey = await decryptSecret(settings.api_key_ciphertext, requireEncryptionKey(env.encryptionKey))
        const result = await createFiscalProvider(settings.provider === 'ticketbai' ? 'ticketbai' : 'verifactu', { apiKey }).health()
        const actualEnvironment = normalizeProviderEnvironment(result.data.entorno)
        if (actualEnvironment !== settings.environment) throw new Error(`La API key pertenece al entorno ${String(result.data.entorno)}`)
        const checkedAt = new Date().toISOString()
        await admin.from('fiscal_integration_settings').update({ connection_status: 'connected', connection_checked_at: checkedAt, connection_error: null, updated_at: checkedAt }).eq('tenant_id', tenantId)
        return json({ ok: true, status: 'connected', checkedAt, provider: settings.provider, environment: settings.environment, nif: result.data.nif ?? null, hacienda: result.data.hacienda ?? null })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'No se pudo conectar con Verifacti'
        const checkedAt = new Date().toISOString()
        await admin.from('fiscal_integration_settings').update({ connection_status: 'error', connection_checked_at: checkedAt, connection_error: message, updated_at: checkedAt }).eq('tenant_id', tenantId)
        return json({ error: message, status: 'error', checkedAt }, 400)
      }
    }

    if (action === 'issue-ticket' || action === 'auto-issue-ticket') {
      const ticketId = String(body.ticketId ?? '')
      if (!ticketId) return json({ error: 'ticketId es obligatorio' }, 400)
      const result = await issueInvoice(admin, env.encryptionKey, tenantId, ticketId, action === 'auto-issue-ticket')
      return json(result)
    }

    if (action === 'void-ticket') {
      const ticketId = String(body.ticketId ?? '')
      if (!ticketId) return json({ error: 'ticketId es obligatorio' }, 400)

      // Use the caller-scoped client first so service-role mutations can never
      // be used to void a ticket hidden by tenant/venue RLS.
      const { data: accessibleTicket, error: ticketAccessError } = await authClient
        .from('tickets')
        .select('id, status')
        .eq('tenant_id', tenantId)
        .eq('id', ticketId)
        .maybeSingle()
      if (ticketAccessError) throw ticketAccessError
      if (!accessibleTicket) return json({ error: 'Ticket no encontrado o sin acceso' }, 404)

      const { data: invoice, error: invoiceError } = await admin.from('fiscal_invoices')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('ticket_id', ticketId)
        .maybeSingle()
      if (invoiceError) throw invoiceError

      let cancellation: { status: 'pending' | 'cancelled'; response: Record<string, unknown> } | null = null
      if (invoice) {
        const fiscalInvoice = invoice as FiscalInvoiceRow & Record<string, unknown>
        const wasSubmitted = Boolean(invoice.sent_at || invoice.external_uuid || invoice.request_payload)
        if (wasSubmitted) {
          cancellation = await queueInvoiceCancellation(
            admin,
            env.encryptionKey,
            await loadSettings(admin, tenantId),
            fiscalInvoice,
          )
        } else if (invoice.status !== 'cancelled') {
          const now = new Date().toISOString()
          const { error: cancelLocalError } = await admin.from('fiscal_invoices').update({
            status: 'cancelled', pending_operation: 'none', confirmed_at: now,
            cancelled_at: now, next_retry_at: null, error_code: null,
            error_message: null, updated_at: now,
          }).eq('tenant_id', tenantId).eq('id', invoice.id)
          if (cancelLocalError) throw cancelLocalError
          await insertEvent(admin, fiscalInvoice, {
            source: 'system', event_type: 'unsent_invoice_cancelled', status: 'cancelled',
            payload: { reason: 'ticket_voided_before_submission' },
          })
          cancellation = { status: 'cancelled', response: {} }
        } else {
          cancellation = { status: 'cancelled', response: (invoice.response_payload ?? {}) as Record<string, unknown> }
        }
      }

      const { error: voidError } = await admin.rpc('finalize_ticket_void', {
        p_actor_id: authData.user.id,
        p_tenant_id: tenantId,
        p_ticket_id: ticketId,
      })
      if (voidError) throw voidError

      return json({
        ticketStatus: 'void',
        fiscalCancellationQueued: cancellation?.status === 'pending',
        fiscalStatus: cancellation?.status ?? null,
        response: cancellation?.response ?? null,
      })
    }

    if (action === 'status') {
      if (!isAdmin) return json({ error: 'No tienes permiso para consultar estados fiscales' }, 403)
      const invoiceId = String(body.invoiceId ?? '')
      const { data: invoice, error } = await admin.from('fiscal_invoices').select('*').eq('tenant_id', tenantId).eq('id', invoiceId).maybeSingle()
      if (error) throw error
      if (!invoice) return json({ error: 'Factura fiscal no encontrada' }, 404)
      const settings = await loadSettings(admin, tenantId)
      if (!settings || typeof settings.api_key_ciphertext !== 'string') return json({ error: 'Integracion sin API key' }, 400)
      if (!invoice.external_uuid) return json({ error: 'La factura aun no tiene uuid externo' }, 409)
      const provider = createFiscalProvider(invoice.provider, { apiKey: await decryptSecret(settings.api_key_ciphertext, requireEncryptionKey(env.encryptionKey)) })
      const result = await provider.getStatus(invoice.external_uuid)
      const status = await applyStatus(admin, invoice as FiscalInvoiceRow, result.data, 'status', result.httpStatus)
      return json({ status, response: result.data })
    }

    if (action === 'cancel') {
      if (!isAdmin) return json({ error: 'No tienes permiso para anular facturas' }, 403)
      const invoiceId = String(body.invoiceId ?? '')
      const { data: invoice, error } = await admin.from('fiscal_invoices').select('*').eq('tenant_id', tenantId).eq('id', invoiceId).maybeSingle()
      if (error) throw error
      if (!invoice) return json({ error: 'Factura fiscal no encontrada' }, 404)
      if (!['accepted', 'accepted_with_errors'].includes(invoice.status)) return json({ error: 'La factura no se puede anular en su estado actual' }, 409)
      const settings = await loadSettings(admin, tenantId)
      return json(await queueInvoiceCancellation(
        admin,
        env.encryptionKey,
        settings,
        invoice as FiscalInvoiceRow & Record<string, unknown>,
      ))
    }

    if (action === 'list') {
      if (!isAdmin) return json({ error: 'No tienes permiso para listar facturas' }, 403)
      const settings = await loadSettings(admin, tenantId)
      if (!settings || typeof settings.api_key_ciphertext !== 'string') return json({ error: 'Integracion sin API key' }, 400)
      const provider = createFiscalProvider(settings.provider === 'ticketbai' ? 'ticketbai' : 'verifactu', { apiKey: await decryptSecret(settings.api_key_ciphertext, requireEncryptionKey(env.encryptionKey)) })
      const result = await provider.list((body.payload && typeof body.payload === 'object' ? body.payload : {}) as Record<string, unknown>)
      return json(result.data)
    }

    return json({ error: 'Accion no valida' }, 400)
  } catch (error) {
    console.error('verifacti-api failed', error)
    const status = error instanceof ProviderHttpError && error.status && error.status >= 400 && error.status < 500 ? 400 : 500
    return json({
      error: error instanceof Error ? error.message : 'Error interno',
      ...(error instanceof ProviderHttpError ? { providerStatus: error.status, providerResponse: error.body } : {}),
    }, status)
  }
})
