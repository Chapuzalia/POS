import { supabase } from '../../../lib/supabase.ts'
import type { CashSession, PaymentMethod, SessionTicketRecord, TenantContext } from '../../../types/index.ts'
import { confirmLocalRectificative, findLocalFiscalEntryByTicket, listLocalFiscalEntries, markLocalFiscalIncidence, type LocalFiscalEntry } from './localLedger.ts'
import { isFiscalTransportFailure } from './deliveryIncidence.ts'
import { fiscalBridgeAccessToken, getFiscalInstallationLease } from './installation.ts'
import { preflightFiscalInstallation } from './posInvoice.ts'
import { synchronizeFiscalEconomicSales } from './economicSync.ts'
import { recoverServerConfirmedFiscalChain } from './serverRecovery.ts'
import { synchronizeLocalFiscalQueue } from './sync.ts'

/** The existing refund RPC commits the economic refund and immutable rectificative together. */
export async function issuePosRefund(context: TenantContext, cashSession: CashSession, ticket: SessionTicketRecord,
  lines: Array<{ lineId: string; quantity: number }>, paymentMethod: PaymentMethod): Promise<LocalFiscalEntry> {
  const client = supabase
  if (!client) throw new Error('Supabase no está disponible para confirmar la devolución.')
  if (ticket.cashSessionId !== cashSession.id || ticket.payload.ticket.tenantId !== context.tenantId
    || ticket.payload.ticket.venueId !== context.venueId || ticket.payload.ticket.cashRegisterId !== cashSession.cashRegisterId) {
    throw new Error('La devolución no pertenece a esta caja y local.')
  }
  const installation = await preflightFiscalInstallation(context, cashSession)
  // An offline original or predecessor must reach Supabase before adding its refund.
  await synchronizeFiscalEconomicSales(installation)
  const original = await findLocalFiscalEntryByTicket(installation, ticket.payload.ticket.id)
  if (!original) throw new Error('No se encontró la factura fiscal local original del ticket.')
  const originalAlta = original.record.canonicalRecord.RegistroAlta
  if (!originalAlta || typeof originalAlta !== 'object' || !('TipoFactura' in originalAlta)
    || !['F1', 'F2'].includes(String(originalAlta.TipoFactura))) throw new Error('La factura fiscal original no contiene un alta válida.')
  if (!lines.length || new Set(lines.map(line => line.lineId)).size !== lines.length) throw new Error('Selecciona líneas distintas para la devolución.')
  const selectedLines = lines.map(line => {
    const index = ticket.payload.lines.findIndex(item => item.id === line.lineId)
    if (index < 0) throw new Error('La línea seleccionada no pertenece al ticket original.')
    return { lineId: String(index), quantity: line.quantity, originalQuantity: ticket.payload.lines[index].quantity }
  })
  const lease = await getFiscalInstallationLease(installation)
  const attempt: { entry: LocalFiscalEntry | null } = { entry: null }
  let entry: LocalFiscalEntry
  try {
    entry = await confirmLocalRectificative({ installation, lease, original,
      type: originalAlta.TipoFactura === 'F1' ? 'R1' : 'R5', reason: 'Devolución de bienes o servicios',
      system: installation.system, timezone: installation.timezone, environment: 'production',
      qrEnvironment: installation.aeatEnvironment, selectedLines, refundRequestId: crypto.randomUUID(),
    }, async prepared => {
      attempt.entry = prepared
      const { error } = await client.rpc('create_ticket_refund', {
        p_tenant_id: context.tenantId, p_original_ticket_id: ticket.payload.ticket.id,
        p_original_sale_id: ticket.payload.sale.id, p_refund_request_id: prepared.invoice.ticketId,
        p_refund_cash_session_id: cashSession.id, p_refund_method: paymentMethod,
        p_lines: lines.map(line => ({ originalTicketLineId: line.lineId, quantity: line.quantity })),
        p_idempotency_key: prepared.record.idempotencyKey, p_record: prepared.record, p_invoice: prepared.invoice,
      }).abortSignal(AbortSignal.timeout(20_000))
      if (error) throw error
    })
  } catch (error) {
    // If the server committed but the acknowledgement/local write failed, recover
    // its exact record instead of rebuilding or replacing an issued document.
    await recoverServerConfirmedFiscalChain(installation).catch(() => {})
    if (isFiscalTransportFailure(error)) await markLocalFiscalIncidence(installation).catch(() => {})
    const restored = attempt.entry ? (await listLocalFiscalEntries(installation)).find(copy => copy.id === attempt.entry?.id
      && copy.record.hash === attempt.entry.record.hash) : undefined
    if (!restored) throw error
    entry = restored
  }
  if (entry.invoice.transmissionMode === 'bridge' && installation.bridgeUrl) {
    // Delivery has its own durable retry queue; an outage cannot undo the refund.
    void synchronizeLocalFiscalQueue({ ...installation, mode: 'production', baseUrl: installation.bridgeUrl,
      getAccessToken: fiscalBridgeAccessToken }).catch(() => {})
  }
  return entry
}
