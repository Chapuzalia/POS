import { z } from 'zod'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import { supabase } from '../../../lib/supabase.ts'
import { openLedger, request, transactionDone } from './localLedger.ts'
import { readFiscalIdentity, FiscalInstallationRevokedError } from './localIdentity.ts'
import { readFiscalBackend } from './backendRead.ts'
import { isFiscalTransportUnavailable } from './availability.ts'

export const FISCAL_INSTALLATION_REVOKED = 'tickit:fiscal-installation-revoked'
const revocationSchema = z.object({ installationId: z.uuid(), revokedAt: z.string().datetime({ offset: true }), reason: z.string().min(1).max(500) })
type Revocation = z.infer<typeof revocationSchema>

export async function readFiscalInstallationRevocation(id: string): Promise<Revocation | null> {
  const db = await openLedger()
  try {
    const tx = db.transaction('bindings', 'readonly')
    const done = transactionDone(tx)
    const row = await request(tx.objectStore('bindings').get(`pwa-revoked:${id}`))
    await done
    return row ? revocationSchema.parse(row) : null
  } finally { db.close() }
}

export async function assertFiscalInstallationNotRevoked(id: string): Promise<void> {
  if (await readFiscalInstallationRevocation(id)) throw new FiscalInstallationRevokedError()
}

export async function refreshFiscalInstallationRevocation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>, id: string): Promise<boolean> {
  if (await readFiscalInstallationRevocation(id)) return true
  if (!supabase) return false
  const client = supabase
  const { data, error } = await readFiscalBackend(signal => client.rpc('pos_fiscal_installation_revocation', {
    p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_register_id: cashSession.cashRegisterId,
    p_device_id: context.deviceId, p_installation_id: id,
  }).abortSignal(signal))
  if (error) {
    if (isFiscalTransportUnavailable(error) || ['PGRST202', '42883'].includes(error.code)) return false
    throw error
  }
  if (!data) return false
  const revocation = revocationSchema.parse(data)
  if (revocation.installationId !== id) throw new Error('La revocación fiscal no corresponde a esta instalación.')
  const db = await openLedger()
  try {
    const tx = db.transaction('bindings', 'readwrite')
    const done = transactionDone(tx)
    tx.objectStore('bindings').put({ scope: `pwa-revoked:${id}`, ...revocation })
    await done
  } finally { db.close() }
  window.dispatchEvent(new CustomEvent(FISCAL_INSTALLATION_REVOKED, { detail: id }))
  return true
}

/** Cheap status check for a running TPV; never activates or replaces an identity. */
export async function checkFiscalInstallationRevocation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>, key: string): Promise<void> {
  const snapshot = await readFiscalIdentity(key)
  if (!snapshot) return
  const { installation: i } = z.object({ installation: z.object({ id: z.uuid(), tenant_id: z.uuid(), venue_id: z.uuid(), cash_register_id: z.uuid(), device_id: z.uuid() }) }).parse(snapshot)
  if (i.tenant_id !== context.tenantId || i.venue_id !== context.venueId || i.cash_register_id !== cashSession.cashRegisterId || i.device_id !== context.deviceId) throw new Error('La identidad fiscal no corresponde a esta caja.')
  if (await refreshFiscalInstallationRevocation(context, cashSession, i.id)) throw new FiscalInstallationRevokedError()
}
