import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'
import type { BridgeRecord } from './bridgeClient.ts'
import type { FiscalInstallation } from './installation.ts'
import { readLocalFiscalHead, readLocalFiscalRecord, reconcileLocalFiscalCopies, type LocalFiscalEntry,
  type RestorableFiscalCopy } from './localLedger.ts'

const recordSchema = z.object({
  idempotencyKey: z.uuid(), environment: z.literal('production'), tenantId: z.uuid(),
  fiscalSubjectId: z.uuid(), issuerNif: z.string(), venueId: z.uuid(), cashRegisterId: z.uuid(),
  installationId: z.uuid(), deviceId: z.uuid(), invoiceId: z.uuid(),
  chainPosition: z.number().int().positive(), hash: z.string().regex(/^[0-9A-F]{64}$/),
  generatedAt: z.string(), canonicalSchema: z.literal('aeat-registro-v1'),
  canonicalRecord: z.record(z.string(), z.unknown()),
  previous: z.object({ issuerNif: z.string(), seriesAndNumber: z.string(), issueDate: z.string(), hash: z.string() }).nullable(),
  lease: z.object({ leaseId: z.string(), fencingToken: z.number().int().positive() }).optional(),
})
const lineSchema = z.object({ description: z.string(), grossCents: z.number().int(), discountCents: z.number().int(),
  baseCents: z.number().int(), taxCents: z.number().int(), taxRate: z.string() })
const invoiceSchema = z.object({
  issuerName: z.string(), issuerNif: z.string(), issuerAddress: z.string().optional(),
  series: z.string(), number: z.number().int().positive(), issuedAt: z.string(), qrUrl: z.url(),
  ticketId: z.uuid(), saleId: z.uuid(), paymentId: z.uuid().nullable(),
  lines: z.array(lineSchema), recipient: z.object({ name: z.string(), nif: z.string() }).nullable(),
  totalCents: z.number().int(), taxCents: z.number().int(),
  transmissionMode: z.enum(['bridge', 'local-only']).optional(),
})
const rowSchema = z.object({
  id: z.uuid(), tenant_id: z.uuid(), fiscal_subject_id: z.uuid(), installation_id: z.uuid(),
  ticket_id: z.uuid().nullable(), sale_id: z.uuid().nullable(), refund_request_id: z.uuid().nullable(),
  record_kind: z.enum(['alta', 'anulacion']), chain_position: z.number().int().positive(),
  hash: z.string().regex(/^[0-9A-F]{64}$/), record_envelope: recordSchema,
  invoice_snapshot: invoiceSchema, economic_snapshot: z.record(z.string(), z.unknown()).nullable(),
  rpc_result: z.record(z.string(), z.unknown()).nullable(),
})
type Row = z.infer<typeof rowSchema>

function toCopy(row: Row, installation: FiscalInstallation): RestorableFiscalCopy {
  const record: BridgeRecord = row.record_envelope
  if (row.id !== record.idempotencyKey || row.chain_position !== record.chainPosition
    || row.hash !== record.hash || row.tenant_id !== installation.tenantId
    || row.fiscal_subject_id !== installation.fiscalSubjectId || row.installation_id !== installation.installationId) {
    throw new Error('La copia fiscal del servidor no coincide con su ámbito o huella.')
  }
  const paymentId = row.rpc_result?.paymentId
  const invoice: LocalFiscalEntry['invoice'] = {
    ...row.invoice_snapshot,
    ticketId: row.ticket_id ?? row.invoice_snapshot.ticketId,
    saleId: row.sale_id ?? row.invoice_snapshot.saleId,
    paymentId: typeof paymentId === 'string' ? paymentId : row.invoice_snapshot.paymentId,
  }
  const annulment = row.record_kind === 'anulacion'
    ? { issuerName: invoice.issuerName, issuerNif: invoice.issuerNif, series: invoice.series, number: invoice.number,
      issuedAt: invoice.issuedAt, ticketId: invoice.ticketId, saleId: invoice.saleId,
      reason: typeof row.economic_snapshot?.reason === 'string' ? row.economic_snapshot.reason : 'Anulación fiscal recuperada' }
    : undefined
  return { entry: {
    id: row.id, scope: `${installation.tenantId}:${installation.fiscalSubjectId}:${installation.installationId}`,
    record, invoice, ...(annulment ? { annulment } : {}),
    delivery: { state: 'LOCAL_PENDING', attempts: 0, lastError: null, nextAttemptAt: null, result: null },
  }, economicPayload: null, eventId: null }
}

/** Rebuilds a lost local tail from the immutable copy committed by the restaurant RPC. */
async function runServerConfirmedFiscalChainRecovery(installation: FiscalInstallation, preparedHead?: { record: unknown }): Promise<number> {
  const client = supabase
  if (!client) throw new Error('No se puede conciliar sin Supabase.')
  const scope = { tenantId: installation.tenantId, fiscalSubjectId: installation.fiscalSubjectId,
    installationId: installation.installationId }
  const scopeKey = `${scope.tenantId}:${scope.fiscalSubjectId}:${scope.installationId}`
  const { entry: lastLocal } = await readLocalFiscalHead(scopeKey)
  const scopeQuery = () => client.from('fiscal_local_records').select(
    'id,tenant_id,fiscal_subject_id,installation_id,ticket_id,sale_id,refund_request_id,record_kind,chain_position,hash,record_envelope,invoice_snapshot,economic_snapshot,rpc_result',
  ).eq('tenant_id', installation.tenantId).eq('fiscal_subject_id', installation.fiscalSubjectId)
    .eq('installation_id', installation.installationId)
  const latest = preparedHead ? { data: preparedHead.record, error: null }
    : await scopeQuery().order('chain_position', { ascending: false }).limit(1).maybeSingle()
  if (latest.error) throw latest.error
  if (!latest.data) return 0
  const lastServer = rowSchema.parse(latest.data)
  if (lastLocal && lastServer.chain_position <= lastLocal.record.chainPosition) {
    const atServerPosition = lastServer.chain_position === lastLocal.record.chainPosition
      ? lastLocal : await readLocalFiscalRecord(scopeKey, lastServer.id)
    if (!atServerPosition || atServerPosition.id !== lastServer.id || atServerPosition.record.chainPosition !== lastServer.chain_position || atServerPosition.record.hash !== lastServer.hash) {
      throw new Error('La cadena local no coincide con el último registro del servidor.')
    }
    return 0
  }
  const copies: RestorableFiscalCopy[] = []
  let offset = 0
  for (;;) {
    const page = await scopeQuery().gte('chain_position', lastLocal?.record.chainPosition ?? 1)
      .order('chain_position', { ascending: true }).range(offset, offset + 499)
    if (page.error) throw page.error
    const rows = (page.data ?? []).map(row => toCopy(rowSchema.parse(row), installation))
    copies.push(...rows)
    if (rows.length < 500) break
    offset += rows.length
  }
  return reconcileLocalFiscalCopies(scope, installation.deviceId, copies)
}

const inFlightRecoveries = new Map<string, Promise<number>>()

export function recoverServerConfirmedFiscalChain(installation: FiscalInstallation, preparedHead?: { record: unknown }): Promise<number> {
  const key = `${installation.tenantId}:${installation.fiscalSubjectId}:${installation.installationId}:${installation.deviceId}`
  const alreadyRunning = inFlightRecoveries.get(key)
  if (alreadyRunning) return alreadyRunning
  const pending = runServerConfirmedFiscalChainRecovery(installation, preparedHead)
  inFlightRecoveries.set(key, pending)
  const release = () => { if (inFlightRecoveries.get(key) === pending) inFlightRecoveries.delete(key) }
  void pending.then(release, release)
  return pending
}
