import { createClient } from 'jsr:@supabase/supabase-js@2'
import { constantTimeEqual, decryptSecret, webhookSignature } from '../_shared/verifacti/crypto.ts'
import { mapProviderStatus } from '../_shared/verifacti/mapping.ts'
import type { ProviderStatusResponse } from '../_shared/verifacti/types.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' }, status })
}

function requiredEnvironment() {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const encryptionKey = Deno.env.get('VERIFACTI_ENCRYPTION_KEY')
  if (!supabaseUrl || !serviceRoleKey || !encryptionKey) throw new Error('Configuracion del webhook incompleta')
  return { encryptionKey, serviceRoleKey, supabaseUrl }
}

Deno.serve(async (request) => {
  if (request.method !== 'POST') return json({ error: 'Metodo no permitido' }, 405)

  const env = requiredEnvironment()
  const admin = createClient(env.supabaseUrl, env.serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } })
  const tenantId = new URL(request.url).searchParams.get('tenant_id') ?? ''
  const signature = request.headers.get('X-Webhook-Signature') ?? ''
  const webhookId = request.headers.get('X-Webhook-Id') ?? ''
  const rawBody = await request.text()

  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  const webhookUuidV4Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
  if (!uuidPattern.test(tenantId) || !signature || !webhookUuidV4Pattern.test(webhookId)) {
    return json({ error: 'Cabeceras de webhook no validas' }, 400)
  }

  try {
    const { data: settings, error: settingsError } = await admin.from('fiscal_integration_settings')
      .select('webhooks_enabled, webhook_secret_ciphertext')
      .eq('tenant_id', tenantId)
      .maybeSingle()
    if (settingsError) throw settingsError
    if (!settings?.webhooks_enabled || !settings.webhook_secret_ciphertext) return json({ error: 'Webhook no activo' }, 404)

    const secret = await decryptSecret(settings.webhook_secret_ciphertext, env.encryptionKey)
    const expectedSignature = await webhookSignature(rawBody, secret)
    const signatureValid = constantTimeEqual(signature, expectedSignature)
    if (!signatureValid) {
      await admin.from('fiscal_webhook_deliveries').insert({
        tenant_id: tenantId,
        webhook_id: webhookId,
        signature,
        signature_valid: false,
        processing_error: 'invalid_signature',
      })
      return json({ error: 'Firma no valida' }, 401)
    }

    let payload: unknown
    try {
      payload = JSON.parse(rawBody)
    } catch {
      return json({ error: 'JSON no valido' }, 400)
    }
    if (!Array.isArray(payload)) return json({ error: 'El payload debe ser un array' }, 400)

    const { data: delivery, error: deliveryError } = await admin.from('fiscal_webhook_deliveries').insert({
      tenant_id: tenantId,
      webhook_id: webhookId,
      signature,
      signature_valid: true,
      payload,
    }).select('id').maybeSingle()
    if (deliveryError?.code === '23505') return json({ ok: true, duplicate: true })
    if (deliveryError || !delivery) throw deliveryError ?? new Error('No se pudo registrar el webhook')

    for (const rawItem of payload) {
      if (!rawItem || typeof rawItem !== 'object') continue
      const item = rawItem as ProviderStatusResponse
      let query = admin.from('fiscal_invoices').select('*').eq('tenant_id', tenantId)
      if (typeof item.uuid === 'string' && item.uuid) {
        query = query.eq('external_uuid', item.uuid)
      } else {
        query = query.eq('series', String(item.serie ?? '')).eq('number', String(item.numero ?? ''))
      }
      const { data: invoice, error: invoiceError } = await query.maybeSingle()
      if (invoiceError) throw invoiceError
      if (!invoice) continue

      const status = mapProviderStatus(item.estado)
      const terminal = ['accepted', 'accepted_with_errors', 'rejected', 'cancelled'].includes(status)
      const now = new Date().toISOString()
      const { error: updateError } = await admin.from('fiscal_invoices').update({
        status,
        pending_operation: terminal ? 'none' : invoice.pending_operation,
        response_payload: item,
        external_uuid: item.uuid ?? invoice.external_uuid,
        external_code: item.tbai ?? invoice.external_code,
        verification_url: item.url ?? invoice.verification_url,
        error_code: item.codigo_error ?? null,
        error_message: item.mensaje_error ?? null,
        next_retry_at: null,
        confirmed_at: terminal ? now : invoice.confirmed_at,
        cancelled_at: status === 'cancelled' ? now : invoice.cancelled_at,
        updated_at: now,
      }).eq('id', invoice.id).eq('tenant_id', tenantId)
      if (updateError) throw updateError

      const { error: eventError } = await admin.from('fiscal_invoice_events').insert({
        tenant_id: tenantId,
        venue_id: invoice.venue_id,
        fiscal_invoice_id: invoice.id,
        source: 'webhook',
        event_type: 'webhook_received',
        status,
        payload: item,
        error_code: item.codigo_error ?? null,
        error_message: item.mensaje_error ?? null,
      })
      if (eventError) throw eventError
    }

    await admin.from('fiscal_webhook_deliveries').update({ processed_at: new Date().toISOString() }).eq('id', delivery.id)
    return json({ ok: true })
  } catch (error) {
    console.error('verifacti-webhook failed', error)
    const message = error instanceof Error ? error.message : 'Error interno'
    await admin.from('fiscal_webhook_deliveries').update({ processing_error: message }).eq('tenant_id', tenantId).eq('webhook_id', webhookId)
    return json({ error: message }, 500)
  }
})
