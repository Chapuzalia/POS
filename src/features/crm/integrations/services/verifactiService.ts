import { requireSupabase } from '../../shared/services/crmServiceSupport'
import type { TenantContext } from '../../../../types'
import { autoIssueFiscalTicket, invokeFiscalBackend, loadFiscalReceiptData } from '../../../fiscal/service'

export { autoIssueFiscalTicket }

export type FiscalProvider = 'verifactu' | 'ticketbai'
export type FiscalEnvironment = 'test' | 'production'
export type FiscalStatus = 'pending' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'cancelled' | 'error'

export type VerifactiConfiguration = {
  enabled: boolean
  provider: FiscalProvider
  environment: FiscalEnvironment
  hasApiKey: boolean
  hasManagementApiKey: boolean
  automaticSubmission: boolean
  webhooksEnabled: boolean
  webhookUrl: string
  connectionStatus: 'untested' | 'connected' | 'error'
  connectionCheckedAt: string | null
  connectionError: string | null
}

export type FiscalInvoiceSummary = {
  id: string
  provider: FiscalProvider
  environment: FiscalEnvironment
  invoice_type: 'normal' | 'simplified' | 'corrective'
  series: string
  number: string
  status: FiscalStatus
  external_uuid: string | null
  external_code: string | null
  qr_base64: string | null
  verification_url: string | null
  error_code: string | null
  error_message: string | null
  attempts: number
  sent_at: string | null
  confirmed_at: string | null
}

export type FiscalCommunicationEvent = {
  id: string
  source: 'system' | 'outbound' | 'status' | 'webhook' | 'user'
  event_type: string
  status: FiscalStatus | null
  http_status: number | null
  error_code: string | null
  error_message: string | null
  created_at: string
}

async function invoke<T>(body: Record<string, unknown>, fallback: string) {
  return invokeFiscalBackend<T>(body, fallback)
}

export function loadVerifactiConfiguration(context: TenantContext) {
  return invoke<VerifactiConfiguration>({ action: 'get-config', tenantId: context.tenantId }, 'No se pudo cargar la configuración de Verifacti.')
}

export function saveVerifactiConfiguration(context: TenantContext, input: {
  enabled: boolean
  provider: FiscalProvider
  environment: FiscalEnvironment
  apiKey?: string
  managementApiKey?: string
  automaticSubmission: boolean
  webhooksEnabled: boolean
}) {
  return invoke<VerifactiConfiguration>({ action: 'save-config', tenantId: context.tenantId, ...input }, 'No se pudo guardar la configuración de Verifacti.')
}

export function testVerifactiConnection(context: TenantContext) {
  return invoke<{ ok: true; status: 'connected'; checkedAt: string; nif: string | null; hacienda: string | null }>({
    action: 'test-connection',
    tenantId: context.tenantId,
  }, 'No se pudo probar la conexión con Verifacti.')
}

export function issueFiscalTicket(context: TenantContext, ticketId: string) {
  return invoke<{ skipped: boolean; reason?: string; fiscal?: {
    invoiceId: string
    provider: FiscalProvider
    status: FiscalStatus
    uuid: string | null
    externalCode: string | null
    qrBase64: string | null
    verificationUrl: string | null
  } }>({
    action: 'issue-ticket', tenantId: context.tenantId, ticketId,
  }, 'No se pudo enviar la factura a Verifacti.')
}

export function refreshFiscalInvoiceStatus(context: TenantContext, invoiceId: string) {
  return invoke<{ status: FiscalStatus; response: Record<string, unknown> }>({
    action: 'status', tenantId: context.tenantId, invoiceId,
  }, 'No se pudo consultar el estado fiscal.')
}

export function cancelFiscalInvoice(context: TenantContext, invoiceId: string) {
  return invoke<{ status: FiscalStatus; response: Record<string, unknown> }>({
    action: 'cancel', tenantId: context.tenantId, invoiceId,
  }, 'No se pudo solicitar la anulación fiscal.')
}

export async function loadFiscalInvoiceEvents(context: TenantContext, invoiceId: string) {
  const { data, error } = await requireSupabase().from('fiscal_invoice_events')
    .select('id, source, event_type, status, http_status, error_code, error_message, created_at')
    .eq('tenant_id', context.tenantId)
    .eq('fiscal_invoice_id', invoiceId)
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as FiscalCommunicationEvent[]
}

export async function loadFiscalReceipt(tenantId: string, ticketId: string): Promise<FiscalInvoiceSummary | null> {
  const { data, error } = await requireSupabase().from('fiscal_invoices')
    .select('id, provider, environment, invoice_type, series, number, status, external_uuid, external_code, qr_base64, verification_url, error_code, error_message, attempts, sent_at, confirmed_at')
    .eq('tenant_id', tenantId)
    .eq('ticket_id', ticketId)
    .maybeSingle()
  if (error) throw error
  return data as FiscalInvoiceSummary | null
}

export { loadFiscalReceiptData }

export function fiscalQrDataUrl(value: string | null | undefined) {
  if (!value) return null
  return value.startsWith('data:') ? value : `data:image/png;base64,${value}`
}
