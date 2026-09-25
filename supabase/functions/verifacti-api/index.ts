import { createClient } from 'jsr:@supabase/supabase-js@2'
import { decryptSecret, encryptSecret, generateWebhookSecret } from '../_shared/verifacti/crypto.ts'
import { ProviderHttpError, requestVerifactiJson } from '../_shared/verifacti/client.ts'
import {
  mapFiscalCancellation,
  mapCommercialFiscalDocument,
  mapProviderStatus,
  mapTicketBaiInvoice,
  mapVerifactuInvoice,
  stableFiscalIdempotencyKey,
} from '../_shared/verifacti/mapping.ts'
import { createFiscalProvider, OdooBridgeError, OdooFiscalProvider } from '../_shared/verifacti/providers.ts'
import { FiscalTotalDiscrepancyError } from '../_shared/verifacti/types.ts'
import { authorizeSuperadmin } from '../_shared/verifacti/authorization.ts'
import type { FiscalInvoiceRow, FiscalTicket, NormalizedFiscalResult, ProviderStatusResponse } from '../_shared/verifacti/types.ts'


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
    integrationProvider: invoice.integration_provider ?? 'verifacti',
    status: invoice.status,
    uuid: invoice.external_uuid ?? null,
    externalCode: invoice.external_code ?? null,
    fiscalNumber: invoice.fiscal_number ?? invoice.external_code ?? null,
    qrBase64: invoice.qr_base64 ?? null,
    qrPayload: invoice.qr_payload ?? null,
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

async function loadSuperadminFiscalEntitySummary(admin: ReturnType<typeof createClient>, tenantId: string, entityId: string) {
  const { data: entity, error: entityError } = await admin.from('fiscal_entities').select('id, legal_name, tax_id, integration_provider, provisioning_status, provisioning_error, odoo_company_id').eq('tenant_id', tenantId).eq('id', entityId).maybeSingle()
  if (entityError) throw entityError
  if (!entity) return null
  const { data: assignments, error: assignmentError } = await admin.from('fiscal_entity_venues').select('venue_id').eq('tenant_id', tenantId).eq('fiscal_entity_id', entityId)
  if (assignmentError) throw assignmentError
  const venueIds = (assignments ?? []).map((assignment) => assignment.venue_id)
  const { data: venues, error: venuesError } = venueIds.length
    ? await admin.from('venues').select('id, name').eq('tenant_id', tenantId).in('id', venueIds)
    : { data: [], error: null }
  if (venuesError) throw venuesError
  const venueNamesById = new Map((venues ?? []).map((venue) => [venue.id, venue.name]))
  return {
    id: entity.id,
    legalName: entity.legal_name,
    taxId: entity.tax_id,
    provider: entity.integration_provider,
    provisioningStatus: entity.provisioning_status,
    provisioningError: entity.provisioning_error,
    odooCompanyId: entity.odoo_company_id,
    venueIds,
    venueNames: venueIds.map((venueId) => venueNamesById.get(venueId) ?? venueId),
  }
}

async function loadFiscalContext(admin: ReturnType<typeof createClient>, tenantId: string, venueId: string, ticketId?: string) {
  const { data: assignment, error: assignmentError } = await admin.from('fiscal_entity_venues')
    .select('fiscal_entity_id').eq('tenant_id', tenantId).eq('venue_id', venueId).maybeSingle()
  if (assignmentError) throw assignmentError
  if (!assignment) return null
  const [{ data: entity, error: entityError }, documentResult] = await Promise.all([
    admin.from('fiscal_entities').select('*').eq('tenant_id', tenantId).eq('id', assignment.fiscal_entity_id).maybeSingle(),
    ticketId
      ? admin.from('fiscal_documents').select('*').eq('tenant_id', tenantId).eq('ticket_id', ticketId).maybeSingle()
      : Promise.resolve({ data: null, error: null }),
  ])
  if (entityError || documentResult.error) throw entityError ?? documentResult.error
  return entity ? { entity: entity as Record<string, unknown>, document: documentResult.data as Record<string, unknown> | null } : null
}

function publicFiscalEntity(row: Record<string, unknown> | null) {
  if (!row) return null
  return {
    id: row.id,
    legalAddress: row.fiscal_address ?? null,
    postalCode: row.fiscal_postal_code ?? null,
    city: row.fiscal_city ?? null,
    countryCode: row.fiscal_country_code ?? 'ES',
    provisioningStatus: row.provisioning_status ?? 'ready',
    provisioningError: row.provisioning_error ?? null,
    venueIds: [],
    enabled: row.enabled === true,
    integrationProvider: row.integration_provider,
    provider: row.tax_system,
    environment: row.environment,
    legalName: row.legal_name,
    taxId: row.tax_id,
    odooBridgeUrl: row.integration_provider === 'odoo' ? row.bridge_url : null,
    odooEntityReference: row.integration_provider === 'odoo' ? row.provider_entity_ref : null,
    hasBridgeSecret: row.integration_provider === 'odoo' && typeof row.bridge_secret_ciphertext === 'string',
    automaticSubmission: row.automatic_submission !== false,
  }
}

function normalizedFiscalReceipt(invoice: Record<string, unknown>, result: NormalizedFiscalResult) {
  return fiscalReceipt({
    ...invoice,
    status: result.status === 'generated' ? 'pending' : result.status,
    integration_provider: 'odoo',
    external_uuid: result.documentId,
    external_code: result.fiscalNumber ?? null,
    fiscal_number: result.fiscalNumber ?? null,
    qr_payload: result.qrPayload ?? null,
    verification_url: result.qrUrl ?? null,
  })
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
  const { invoice, ticket } = await loadInvoiceBundle(admin, tenantId, ticketId)
  if (invoice.external_uuid) return { fiscal: fiscalReceipt(invoice as unknown as Record<string, unknown>), skipped: true, reason: 'already_submitted' }
  const context = await loadFiscalContext(admin, tenantId, ticket.venue_id, ticketId)
  if (context?.entity.integration_provider === 'odoo') {
    if (context.entity.enabled !== true) return { skipped: true, reason: 'integration_disabled' }
    if (automatic && context.entity.automatic_submission === false) return { skipped: true, reason: 'automatic_submission_disabled' }
    if (!context.document) throw new Error('Documento fiscal no encontrado')
    const documentId = String(context.document.id)
    const workerId = `edge:${crypto.randomUUID()}`
    const { data: claimed, error: claimError } = await admin.rpc('fiscal_outbox_claim_document', {
      p_document_id: documentId, p_worker_id: workerId, p_lease_seconds: 60,
    })
    if (claimError) throw claimError
    if (!claimed) return { fiscal: fiscalReceipt(invoice as unknown as Record<string, unknown>), skipped: true, reason: 'already_processing' }
    try {
      const bridgeUrl = String(context.entity.bridge_url ?? '')
      const entityRef = String(context.entity.provider_entity_ref ?? '')
      const secretCiphertext = context.entity.bridge_secret_ciphertext
      if (!bridgeUrl || !entityRef || typeof secretCiphertext !== 'string') throw new Error('Configura el puente Odoo antes de emitir facturas')
      const provider = new OdooFiscalProvider({ bridgeUrl, fiscalEntityRef: entityRef, bridgeSecret: await decryptSecret(secretCiphertext, requireEncryptionKey(encryptionKey)) })
      const commercial = mapCommercialFiscalDocument(invoice, ticket, entityRef)
       const result = await provider.issue(commercial, { idempotencyKey: String(context.document.idempotency_key) })
       const { error: completeError } = await admin.rpc('fiscal_complete_operation', {
         p_outbox_id: claimed.id, p_worker_id: workerId, p_status: result.status,
         p_provider_external_id: result.documentId, p_fiscal_number: result.fiscalNumber ?? null,
         p_fiscal_type: result.fiscalType ?? null, p_fiscal_date: result.fiscalDate ?? null,
         p_returned_total_cents: result.finalTotalCents ?? null, p_provider_qr: result.qrPayload === false ? null : result.qrPayload ?? null,
         p_provider_url: result.qrUrl === false ? null : result.qrUrl ?? null, p_response: result,
       })

      if (completeError) throw completeError
      return { fiscal: normalizedFiscalReceipt(invoice as unknown as Record<string, unknown>, result), skipped: false }
    } catch (error) {
      const retryable = error instanceof OdooBridgeError && error.retryable
      const code = error instanceof FiscalTotalDiscrepancyError ? 'total_discrepancy' : error instanceof OdooBridgeError ? `bridge_${error.status ?? 'network'}` : 'odoo_validation'
      const safeMessage = error instanceof FiscalTotalDiscrepancyError ? 'Los totales devueltos por Odoo no coinciden con la venta.' : retryable ? 'Odoo no está disponible temporalmente.' : 'No se pudo generar el documento fiscal en Odoo.'
      await admin.rpc('fiscal_fail_operation', {
        p_outbox_id: claimed.id, p_worker_id: workerId, p_error_code: code, p_safe_error: safeMessage,
        p_retry_at: retryable ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null,
        p_incident_code: code,
      })
      throw new Error(safeMessage)
    }
  }
  if (!settings?.enabled) return { skipped: true, reason: 'integration_disabled' }
  if (automatic && settings.automatic_submission !== true) return { skipped: true, reason: 'automatic_submission_disabled' }
  if (typeof settings.api_key_ciphertext !== 'string') throw new Error('Configura una API key antes de emitir facturas')
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
  const context = await loadFiscalContext(admin, invoice.tenant_id, invoice.venue_id, invoice.ticket_id)
  if (context?.entity.integration_provider === 'odoo' && context.document) {
    const documentId = String(context.document.id)
    const externalId = String(context.document.provider_external_id ?? invoice.external_uuid ?? '')
    if (!externalId) throw new Error('El documento de Odoo aún no tiene identificador fiscal')
    const key = `${invoice.tenant_id}:${documentId}:cancel`
    const { error: enqueueError } = await admin.rpc('fiscal_outbox_enqueue', {
      p_document_id: documentId, p_operation: 'cancel', p_idempotency_key: key,
      p_tenant_id: invoice.tenant_id, p_venue_id: invoice.venue_id, p_entity_id: context.entity.id,
    })
    if (enqueueError) throw enqueueError
    const workerId = `edge:${crypto.randomUUID()}`
    const { data: claimed, error: claimError } = await admin.rpc('fiscal_outbox_claim_document', {
      p_document_id: documentId, p_worker_id: workerId, p_lease_seconds: 60,
    })
    if (claimError) throw claimError
    if (!claimed) return { status: 'pending' as const, response: {} }
    try {
      const secretCiphertext = context.entity.bridge_secret_ciphertext
      if (typeof secretCiphertext !== 'string') throw new Error('Integración Odoo incompleta')
      const provider = new OdooFiscalProvider({
        bridgeUrl: String(context.entity.bridge_url), fiscalEntityRef: String(context.entity.provider_entity_ref),
        bridgeSecret: await decryptSecret(secretCiphertext, requireEncryptionKey(encryptionKey)),
      })
       const result = await provider.cancel(externalId, { idempotencyKey: key })
       const { error: completeError } = await admin.rpc('fiscal_complete_operation', {
         p_outbox_id: claimed.id, p_worker_id: workerId, p_status: result.status,
         p_provider_external_id: result.documentId, p_fiscal_number: result.fiscalNumber ?? null,
         p_fiscal_type: result.fiscalType ?? null, p_fiscal_date: result.fiscalDate ?? null,
         p_returned_total_cents: result.finalTotalCents ?? null, p_provider_qr: result.qrPayload === false ? null : result.qrPayload ?? null,
         p_provider_url: result.qrUrl === false ? null : result.qrUrl ?? null, p_response: result,
       })

      if (completeError) throw completeError
      return { status: result.status === 'generated' ? 'pending' as const : result.status, response: result }
    } catch (error) {
      const retryable = error instanceof OdooBridgeError && error.retryable
      const safeMessage = retryable ? 'Odoo no está disponible temporalmente.' : 'No se pudo solicitar la anulación en Odoo.'
      await admin.rpc('fiscal_fail_operation', {
        p_outbox_id: claimed.id, p_worker_id: workerId, p_error_code: 'odoo_cancel_error', p_safe_error: safeMessage,
        p_retry_at: retryable ? new Date(Date.now() + 5 * 60 * 1000).toISOString() : null, p_incident_code: 'odoo_cancel_error',
      })
      throw new Error(safeMessage)
    }
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
    const [{ data: membership, error: membershipError }, { data: tenant, error: tenantError }, { data: callerProfile, error: callerProfileError }] = await Promise.all([
      admin.from('tenant_memberships').select('role, is_active').eq('tenant_id', tenantId).eq('user_id', authData.user.id).maybeSingle(),
      admin.from('tenants').select('is_active').eq('id', tenantId).maybeSingle(),
      admin.from('profiles').select('is_superadmin').eq('id', authData.user.id).maybeSingle(),
    ])
    if (tenantError || !tenant?.is_active) {
      return json({ error: 'No tienes acceso a este negocio' }, 403)
    }
    const superadminAuthorization = authorizeSuperadmin(authData.user.id, null, callerProfile, callerProfileError)
    if (callerProfileError) console.error('Could not validate fiscal superadmin permission', { name: callerProfileError instanceof Error ? callerProfileError.name : 'DatabaseError' })
    const isSuperadmin = superadminAuthorization.authorized
    if (!isSuperadmin && (membershipError || !membership?.is_active)) {
      return json({ error: 'No tienes acceso a este negocio' }, 403)
    }
    const isAdmin = membership?.is_active === true && (membership?.role === 'owner' || membership?.role === 'manager')
    const isOwner = membership?.is_active === true && membership?.role === 'owner'
    const url = webhookUrl(env.supabaseUrl, tenantId)

    if (action === 'superadmin-list-fiscal-entities') {
       if (!superadminAuthorization.authorized) return json({ error: superadminAuthorization.error }, superadminAuthorization.status)
       const { data: entities, error: entitiesError } = await admin.from('fiscal_entities').select('id, legal_name, tax_id, integration_provider, provisioning_status, provisioning_error, odoo_company_id').eq('tenant_id', tenantId).order('created_at', { ascending: false })
       if (entitiesError) throw entitiesError
       const entityIds = (entities ?? []).map((entity) => entity.id)
       const { data: assignments, error: assignmentError } = entityIds.length ? await admin.from('fiscal_entity_venues').select('fiscal_entity_id, venue_id').eq('tenant_id', tenantId).in('fiscal_entity_id', entityIds) : { data: [], error: null }
       if (assignmentError) throw assignmentError
       const venueIds = [...new Set((assignments ?? []).map((item) => item.venue_id))]
       const { data: venues, error: venuesError } = venueIds.length ? await admin.from('venues').select('id, name').eq('tenant_id', tenantId).in('id', venueIds) : { data: [], error: null }
       if (venuesError) throw venuesError
       return json({ entities: (entities ?? []).map((entity) => {
         const entityVenueIds = (assignments ?? []).filter((item) => item.fiscal_entity_id === entity.id).map((item) => item.venue_id)
         return { id: entity.id, legalName: entity.legal_name, taxId: entity.tax_id, provider: entity.integration_provider, provisioningStatus: entity.provisioning_status, provisioningError: entity.provisioning_error, odooCompanyId: entity.odoo_company_id, venueIds: entityVenueIds, venueNames: entityVenueIds.map((venueId) => (venues ?? []).find((venue) => venue.id === venueId)?.name ?? venueId) }
       }) })
     }

     if (action === 'superadmin-create-fiscal-entity') {
       if (!isSuperadmin) return json({ error: 'Solo un superadmin puede crear entidades fiscales' }, 403)
       const venueIds = Array.isArray(body.venueIds) ? body.venueIds.filter((value): value is string => typeof value === 'string') : []
       const legalName = String(body.legalName ?? '').trim()
       const taxId = String(body.taxId ?? '').trim()
       const normalizedTaxId = taxId.replace(/[ .-]/g, '').toUpperCase()
       if (!legalName || !taxId || !venueIds.length) return json({ error: 'Completa los datos fiscales y selecciona locales' }, 400)
       const { data: existingEntities, error: duplicateError } = await admin.from('fiscal_entities').select('tax_id').eq('tenant_id', tenantId)
       if (duplicateError) throw duplicateError
       if ((existingEntities ?? []).some((existing) => existing.tax_id.replace(/[ .-]/g, '').toUpperCase() === normalizedTaxId)) return json({ error: `Ya existe una entidad fiscal con el NIF ${taxId}. Configura o edita la entidad existente.` }, 409)
       const { data: created, error: createError } = await admin.from('fiscal_entities').insert({ tenant_id: tenantId, display_name: legalName, legal_name: legalName, tax_id: taxId, fiscal_address: String(body.address ?? '').trim(), fiscal_postal_code: String(body.postalCode ?? '').trim(), fiscal_city: String(body.city ?? '').trim(), fiscal_country_code: String(body.countryCode ?? 'ES').trim().toUpperCase(), integration_provider: 'verifacti', tax_system: 'verifactu', environment: 'test', provisioning_status: 'ready' }).select('id, legal_name, tax_id, integration_provider, provisioning_status, provisioning_error, odoo_company_id').single()
       if (createError || !created) throw createError ?? new Error('No se pudo crear la entidad fiscal')
       const { data: validVenues, error: venuesError } = await admin.from('venues').select('id').eq('tenant_id', tenantId).in('id', venueIds)
       if (venuesError) throw venuesError
       if ((validVenues ?? []).length !== venueIds.length) return json({ error: 'Uno o más locales no pertenecen al negocio' }, 400)
       const { error: assignmentError } = await admin.from('fiscal_entity_venues').insert(venueIds.map((venueId) => ({ tenant_id: tenantId, fiscal_entity_id: created.id, venue_id: venueId })))
       if (assignmentError) throw assignmentError
       return json({ entity: { id: created.id, legalName: created.legal_name, taxId: created.tax_id, provider: 'verifacti', provisioningStatus: 'ready', provisioningError: null, odooCompanyId: null, venueIds: venueIds, venueNames: [] } })
     }

     if (action === 'superadmin-configure-fiscal-entity' || action === 'superadmin-retry-fiscal-entity' || action === 'provision-odoo-fiscal-entity') {
      if (!isSuperadmin) return json({ error: 'Solo un superadmin puede provisionar entidades fiscales' }, 403)
       const entityId = String(body.entityId ?? '')
       const entity = await admin.from('fiscal_entities').select('*').eq('tenant_id', tenantId).eq('id', entityId).maybeSingle()
       if (entity.error) throw entity.error
       if (!entity.data) return json({ error: 'Entidad fiscal no encontrada' }, 404)
       const requestedProvider = action === 'superadmin-configure-fiscal-entity' ? String(body.provider ?? '') : 'odoo'
       if (requestedProvider !== 'odoo') {
         const { data: updated, error: updateError } = await admin.from('fiscal_entities').update({ integration_provider: 'verifacti', provisioning_status: 'ready', provisioning_error: null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', entityId).select('id, legal_name, tax_id, integration_provider, provisioning_status, provisioning_error, odoo_company_id').single()
         if (updateError || !updated) throw updateError ?? new Error('No se pudo configurar Verifacti')
         const assignments = await admin.from('fiscal_entity_venues').select('venue_id').eq('tenant_id', tenantId).eq('fiscal_entity_id', entityId)
         if (assignments.error) throw assignments.error
         return json({ entity: { id: updated.id, legalName: updated.legal_name, taxId: updated.tax_id, provider: updated.integration_provider, provisioningStatus: updated.provisioning_status, provisioningError: updated.provisioning_error, odooCompanyId: updated.odoo_company_id, venueIds: (assignments.data ?? []).map((item) => item.venue_id), venueNames: [] } })
       }
       const existingAssignments = await admin.from('fiscal_entity_venues').select('venue_id').eq('tenant_id', tenantId).eq('fiscal_entity_id', entityId)
      if (existingAssignments.error) throw existingAssignments.error
      const venues = Array.isArray(body.venueIds) ? body.venueIds.filter((value): value is string => typeof value === 'string') : (existingAssignments.data ?? []).map((item) => item.venue_id)
      if (!venues.length) return json({ error: 'Selecciona al menos un local' }, 400)
      const validVenues = await admin.from('venues').select('id').eq('tenant_id', tenantId).in('id', venues)
      if (validVenues.error) throw validVenues.error
      if ((validVenues.data ?? []).length !== venues.length) return json({ error: 'Uno o más locales no pertenecen al negocio' }, 400)
      const providerUrl = Deno.env.get('ODOO_BRIDGE_URL')
      const provisioningSecret = Deno.env.get('ODOO_PROVISIONING_SECRET')
      if (!providerUrl || !provisioningSecret) return json({ error: 'Provisioning Odoo no configurado' }, 500)
      const ref = entity.data.provider_entity_ref || `fe_${entity.data.id}`
      const bridgeSecret = entity.data.bridge_secret_ciphertext ? await decryptSecret(entity.data.bridge_secret_ciphertext, env.encryptionKey) : generateWebhookSecret()
      const now = new Date().toISOString()
      await admin.from('fiscal_entities').update({ provider_entity_ref: ref, bridge_url: providerUrl, provisioning_status: 'provisioning', provisioning_error: null, provisioning_started_at: now, updated_at: now }).eq('id', entityId).eq('tenant_id', tenantId)
      try {
        const response = await fetch(`${providerUrl.replace(/\/$/, '')}/fiscal/admin/companies`, { method: 'POST', headers: { Authorization: `Bearer ${provisioningSecret}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ provider_entity_ref: ref, bridge_secret: bridgeSecret, company: { name: entity.data.legal_name, vat: entity.data.tax_id, street: entity.data.fiscal_address, zip: entity.data.fiscal_postal_code, city: entity.data.fiscal_city, country_code: entity.data.fiscal_country_code || 'ES' } }) })
        const result = await response.json() as Record<string, unknown>
        if (!response.ok) throw new Error(typeof result.message === 'string' ? result.message : 'Odoo rechazó el provisioning')
        const health = await fetch(`${providerUrl.replace(/\/$/, '')}/fiscal/health?fiscal_entity_ref=${encodeURIComponent(ref)}`, { headers: { Authorization: `Bearer ${bridgeSecret}` } })
        if (!health.ok) throw new Error('No se pudo verificar la conexión Odoo')
        const finalNow = new Date().toISOString()
        const { error: finalError } = await admin.from('fiscal_entities').update({ integration_provider: 'odoo', tax_system: 'verifactu', provider_entity_ref: ref, bridge_url: providerUrl, bridge_secret_ciphertext: await encryptSecret(bridgeSecret, env.encryptionKey), odoo_company_id: typeof result.odoo_company_id === 'number' ? result.odoo_company_id : null, provisioning_status: 'ready', provisioning_error: null, provisioning_completed_at: finalNow, updated_at: finalNow }).eq('id', entityId).eq('tenant_id', tenantId)
        if (finalError) throw finalError
        if (action === 'superadmin-create-fiscal-entity') {
          const { error: assignmentError } = await admin.from('fiscal_entity_venues').insert(venues.map((venueId) => ({ tenant_id: tenantId, fiscal_entity_id: entityId, venue_id: venueId })))
          if (assignmentError) throw assignmentError
        }
        return json({ entity: { id: entityId, legalName: entity.data.legal_name, taxId: entity.data.tax_id, provider: 'odoo', provisioningStatus: 'ready', provisioningError: null, odooCompanyId: typeof result.odoo_company_id === 'number' ? result.odoo_company_id : null, venueIds: venues, venueNames: [] } })
      } catch (provisioningError) {
        const message = provisioningError instanceof Error ? provisioningError.message : 'No se pudo configurar Odoo'
        await admin.from('fiscal_entities').update({ provisioning_status: 'error', provisioning_error: message.slice(0, 500), updated_at: new Date().toISOString() }).eq('id', entityId).eq('tenant_id', tenantId)
        return json({ error: 'No se pudo completar la configuración Odoo', provisioningStatus: 'error' }, 502)
      }
    }

    if (action === 'get-config') {
      if (!isAdmin) return json({ error: 'No tienes permiso para consultar la integracion' }, 403)
      return json(publicSettings(await loadSettings(admin, tenantId), url))
    }

    if (action === 'get-fiscal-entity-config') {
      if (!isAdmin && !isSuperadmin) return json({ error: 'No tienes permiso para consultar la configuración fiscal' }, 403)
      const venueId = String(body.venueId ?? '')
      if (!venueId) return json({ error: 'venueId es obligatorio' }, 400)
      const context = await loadFiscalContext(admin, tenantId, venueId)
      const entity = context?.entity ?? null
      if (!entity) return json({ integrationProvider: 'verifacti' })
      const { data: assignments, error: assignmentsError } = await admin.from('fiscal_entity_venues').select('venue_id').eq('tenant_id', tenantId).eq('fiscal_entity_id', entity.id)
      if (assignmentsError) throw assignmentsError
      return json({ ...publicFiscalEntity(entity), venueIds: (assignments ?? []).map((item) => item.venue_id) })
    }

    if (action === 'save-fiscal-entity-config') {
      if (!isOwner) return json({ error: 'Solo el propietario puede configurar la fiscalidad' }, 403)
      const venueId = String(body.venueId ?? '')
      const integrationProvider = body.provider === 'odoo' ? 'odoo' : 'verifacti'
      const taxSystem = body.taxSystem === 'ticketbai' ? 'ticketbai' : 'verifactu'
      const legalName = String(body.legalName ?? '').trim()
      const taxId = String(body.taxId ?? '').trim().toUpperCase()
      const environment = body.environment === 'production' ? 'production' : 'test'
      if (!venueId || !legalName || !taxId) return json({ error: 'Local, razón social y NIF son obligatorios' }, 400)
      if (integrationProvider === 'odoo' && taxSystem !== 'verifactu') return json({ error: 'Odoo solo está habilitado para VeriFactu' }, 400)
      const { data: accessibleVenue } = await authClient.from('venues').select('id').eq('tenant_id', tenantId).eq('id', venueId).maybeSingle()
      if (!accessibleVenue) return json({ error: 'Local no encontrado o sin acceso' }, 404)
      const current = await loadFiscalContext(admin, tenantId, venueId)
      const bridgeSecret = typeof body.bridgeSecret === 'string' && body.bridgeSecret.trim() ? body.bridgeSecret.trim() : null
      const encryptedBridgeSecret = bridgeSecret ? await encryptSecret(bridgeSecret, requireEncryptionKey(env.encryptionKey)) : current?.entity.bridge_secret_ciphertext ?? null
      const entityValues = {
        tenant_id: tenantId, display_name: legalName, legal_name: legalName, tax_id: taxId,
        integration_provider: integrationProvider, tax_system: taxSystem, environment,
        enabled: body.enabled === true, automatic_submission: body.automaticSubmission !== false,
        provider_entity_ref: integrationProvider === 'odoo' ? String(body.odooEntityReference ?? '').trim() || null : null,
        bridge_url: integrationProvider === 'odoo' ? String(body.odooBridgeUrl ?? '').trim() || null : null,
        bridge_secret_ciphertext: integrationProvider === 'odoo' ? encryptedBridgeSecret : null,
        updated_at: new Date().toISOString(),
      }
      let entityId = current?.entity.id as string | undefined
      if (entityId) {
        const { error } = await admin.from('fiscal_entities').update(entityValues).eq('tenant_id', tenantId).eq('id', entityId)
        if (error) throw error
      } else {
        const { data, error } = await admin.from('fiscal_entities').insert(entityValues).select('id').single()
        if (error) throw error
        entityId = data.id
        const { error: assignmentError } = await admin.from('fiscal_entity_venues').insert({ tenant_id: tenantId, venue_id: venueId, fiscal_entity_id: entityId })
        if (assignmentError) throw assignmentError
      }
      const refreshed = await loadFiscalContext(admin, tenantId, venueId)
      return json({ ...publicSettings(await loadSettings(admin, tenantId), url), ...publicFiscalEntity(refreshed?.entity ?? null) })
    }

    if (action === 'list-fiscal-incidents') {
      if (!isAdmin) return json({ error: 'No tienes permiso para consultar incidencias fiscales' }, 403)
      const venueId = String(body.venueId ?? '')
      const { data, error } = await admin.from('fiscal_outbox').select('id, operation, status, created_at, available_at')
        .eq('tenant_id', tenantId).eq('venue_id', venueId).in('status', ['pending', 'failed']).order('created_at', { ascending: false }).limit(100)
      if (error) throw error
      return json({ incidents: (data ?? []).map((item) => ({ id: item.id, operation: item.operation, status: item.status, occurredAt: item.created_at, retryable: item.status === 'failed' })) })
    }

    if (action === 'retry-fiscal-operation') {
      if (!isOwner) return json({ error: 'Solo el propietario puede reintentar operaciones fiscales' }, 403)
      const venueId = String(body.venueId ?? '')
      const incidentId = String(body.incidentId ?? '')
      const { data, error } = await admin.from('fiscal_outbox').update({ status: 'pending', available_at: new Date().toISOString(), incident_code: null, last_error: null, updated_at: new Date().toISOString() })
        .eq('tenant_id', tenantId).eq('venue_id', venueId).eq('id', incidentId).eq('status', 'failed').select('id').maybeSingle()
      if (error) throw error
      if (!data) return json({ error: 'Incidencia no encontrada o no reintentable' }, 404)
      return json({ ok: true })
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
          const [{ error: cancelLocalError }, { error: documentCancelError }] = await Promise.all([
            admin.from('fiscal_invoices').update({
              status: 'cancelled', pending_operation: 'none', confirmed_at: now,
              cancelled_at: now, next_retry_at: null, error_code: null,
              error_message: null, updated_at: now,
            }).eq('tenant_id', tenantId).eq('id', invoice.id),
            admin.from('fiscal_documents').update({ status: 'cancelled', updated_at: now }).eq('tenant_id', tenantId).eq('ticket_id', ticketId),
          ])
          if (cancelLocalError || documentCancelError) throw cancelLocalError ?? documentCancelError
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
      if (invoice.integration_provider === 'odoo') {
        if (!invoice.external_uuid) return json({ error: 'El documento aún no tiene identificador de Odoo' }, 409)
        const context = await loadFiscalContext(admin, tenantId, invoice.venue_id, invoice.ticket_id)
        if (!context?.entity || !context.document || typeof context.entity.bridge_secret_ciphertext !== 'string') return json({ error: 'Integración Odoo incompleta' }, 400)
        const provider = new OdooFiscalProvider({
          bridgeUrl: String(context.entity.bridge_url), fiscalEntityRef: String(context.entity.provider_entity_ref),
          bridgeSecret: await decryptSecret(context.entity.bridge_secret_ciphertext, requireEncryptionKey(env.encryptionKey)),
        })
        const result = await provider.status(invoice.external_uuid)
        if (result.finalTotalCents !== undefined && result.finalTotalCents !== Number(context.document.expected_total_cents)) {
          throw new FiscalTotalDiscrepancyError(Number(context.document.expected_total_cents), result.finalTotalCents)
        }
        const legacyStatus = result.status === 'generated' ? 'pending' : result.status
        const [{ error: documentError }, { error: invoiceUpdateError }] = await Promise.all([
          admin.from('fiscal_documents').update({ status: result.status, provider_external_id: result.documentId, provider_fiscal_number: result.fiscalNumber ?? null, returned_total_cents: result.finalTotalCents ?? null, provider_qr: result.qrPayload ?? null, provider_url: result.qrUrl ?? null, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', context.document.id),
          admin.from('fiscal_invoices').update({ status: legacyStatus, external_uuid: result.documentId, external_code: result.fiscalNumber ?? null, fiscal_number: result.fiscalNumber ?? null, qr_payload: result.qrPayload ?? null, verification_url: result.qrUrl ?? null, response_payload: result, updated_at: new Date().toISOString() }).eq('tenant_id', tenantId).eq('id', invoice.id),
        ])
        if (documentError || invoiceUpdateError) throw documentError ?? invoiceUpdateError
        return json({ status: result.status, response: result })
      }
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
    console.error('fiscal-api failed', error instanceof ProviderHttpError ? { name: error.name, status: error.status } : { name: error instanceof Error ? error.name : 'UnknownError' })
    const status = error instanceof ProviderHttpError && error.status && error.status >= 400 && error.status < 500 ? 400 : 500
    return json({
      error: error instanceof ProviderHttpError && error.status && error.status < 500
        ? 'El proveedor fiscal ha rechazado la operación.'
        : error instanceof OdooBridgeError ? 'No se pudo comunicar con Odoo.'
          : error instanceof Error ? error.message : 'Error interno',
    }, status)
  }
})
