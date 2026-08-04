import { supabase } from '../../lib/supabase'

export type FiscalReceiptData = {
  invoiceId: string
  provider: 'verifactu' | 'ticketbai'
  status: 'pending' | 'accepted' | 'accepted_with_errors' | 'rejected' | 'cancelled' | 'error'
  uuid: string | null
  qrBase64: string | null
  verificationUrl: string | null
  externalCode: string | null
}

export async function invokeFiscalBackend<T>(body: Record<string, unknown>, fallback: string): Promise<T> {
  if (!supabase) throw new Error('Supabase no esta configurado.')
  const { data, error } = await supabase.functions.invoke<T & { error?: string }>('verifacti-api', { body })
  if (data?.error) throw new Error(data.error)
  if (error) {
    if (typeof error === 'object' && error !== null && 'context' in error && error.context instanceof Response) {
      try {
        const responseBody = await error.context.clone().json() as { error?: unknown }
        if (typeof responseBody.error === 'string') throw new Error(responseBody.error)
      } catch (contextError) {
        if (contextError instanceof Error && contextError.message !== 'Unexpected end of JSON input') throw contextError
      }
    }
    throw new Error(error.message || fallback)
  }
  return data as T
}

export function autoIssueFiscalTicket(tenantId: string, ticketId: string) {
  return invokeFiscalBackend<{ skipped: boolean; reason?: string; fiscal?: FiscalReceiptData }>({
    action: 'auto-issue-ticket', tenantId, ticketId,
  }, 'La venta se guardo, pero no se pudo enviar automaticamente a Verifacti.')
}

export function voidTicketWithFiscalCancellation(tenantId: string, ticketId: string) {
  return invokeFiscalBackend<{
    ticketStatus: 'void'
    fiscalCancellationQueued: boolean
    fiscalStatus: FiscalReceiptData['status'] | null
    response: Record<string, unknown> | null
  }>({
    action: 'void-ticket', tenantId, ticketId,
  }, 'No se pudo anular el ticket y su factura fiscal.')
}

export async function loadFiscalReceiptData(tenantId: string, ticketId: string): Promise<FiscalReceiptData | null> {
  if (!supabase) throw new Error('Supabase no esta configurado.')
  const { data, error } = await supabase.from('fiscal_invoices')
    .select('id, provider, status, external_uuid, external_code, qr_base64, verification_url')
    .eq('tenant_id', tenantId)
    .eq('ticket_id', ticketId)
    .maybeSingle()
  if (error) throw error
  if (!data) return null
  return {
    invoiceId: data.id,
    provider: data.provider,
    status: data.status,
    uuid: data.external_uuid,
    externalCode: data.external_code,
    qrBase64: data.qr_base64,
    verificationUrl: data.verification_url,
  } as FiscalReceiptData
}
