import { supabase } from '../../../lib/supabase.ts'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { createAnulacionRecord } from './canonical.ts'
import { loadFiscalInstallation, getFiscalInstallationLease, type FiscalInstallation } from './installation.ts'
import { assertFiscalLease, type FiscalLease } from './clock.ts'
import { findLocalFiscalEntryByTicket, persistLocalFiscalAnnulment, type LocalFiscalEntry } from './localLedger.ts'
import { localDateParts } from './localLedger.ts'

export async function prepareLocalFiscalAnnulment(
  context: TenantContext,
  cashSession: CashSession,
  ticketId: string,
  reason: string,
): Promise<LocalFiscalEntry> {
  if (!reason.trim()) throw new Error('La anulación fiscal requiere un motivo.')
  const installation = await loadFiscalInstallation(context, cashSession)
  const lease = await getFiscalInstallationLease(installation)
  assertFiscalLease(lease, installation.installationId, installation.deviceId, Date.now(), performance.now())
  const original = await findLocalFiscalEntryByTicket(installation, ticketId)
  if (!original) throw new Error('No se encontró la factura fiscal local del ticket.')
  const entry = await buildLocalFiscalAnnulment({ installation, lease, original, reason: reason.trim() })
  if (!supabase) throw new Error('Supabase no está disponible para confirmar la anulación fiscal.')
  const { error } = await supabase.rpc('sync_local_fiscal_ticket_annulment', {
    p_event_id: crypto.randomUUID(), p_record: entry.record, p_invoice: entry.invoice, p_reason: reason.trim(),
  })
  if (error) throw error
  return entry
}

async function buildLocalFiscalAnnulment(input: {
  installation: FiscalInstallation
  lease: FiscalLease
  original: LocalFiscalEntry
  reason: string
}): Promise<LocalFiscalEntry> {
  const { installation, lease, original, reason } = input
  const time = localDateParts(new Date(), installation.timezone)
  const issueDate = timeFromInvoice(original.invoice.issuedAt)
  const built = await createAnulacionRecord({
    invoice: { issuerNif: original.invoice.issuerNif, seriesAndNumber: `${original.invoice.series}/${original.invoice.number}`, issueDate },
    system: installation.system,
    previous: {
      IDEmisorFactura: original.record.issuerNif,
      NumSerieFactura: `${original.invoice.series}/${original.invoice.number}`,
      FechaExpedicionFactura: issueDate,
      Huella: original.record.hash,
    },
    generatedAt: time.generatedAt,
  })
  return persistLocalFiscalAnnulment({ installation, lease, original, canonicalRecord: built.canonicalRecord, hash: built.hash, generatedAt: time.generatedAt, reason })
}

function timeFromInvoice(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.valueOf())) throw new Error('La factura fiscal original tiene una fecha inválida.')
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
  return `${values.day}-${values.month}-${values.year}`
}
