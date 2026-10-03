import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import type { FiscalSystem } from './canonical.ts'
import { createBridgeClient } from './bridgeClient.ts'
import { assertFiscalLease, createLocalFallbackLease, type FiscalLease } from './clock.ts'
import { isFiscalTransportUnavailable } from './availability.ts'
import { loadFiscalPosSettings, rememberFiscalPosSettings, type FiscalPosSettings } from './settings.ts'
import { FiscalIdentityMissingError, readFiscalIdentity, persistFiscalIdentity, fiscalActivationRequest, assertFiscalLedgerHeadValid, clearFiscalActivationRequest } from './localIdentity.ts'
import { recoverServerConfirmedFiscalChain } from './serverRecovery.ts'
import { UserFacingError } from '../../../utils/UserFacingError.ts'

export class FiscalActivationConfirmationError extends UserFacingError {}

const installationSchema = z.object({
  id: z.uuid(), tenant_id: z.uuid(), fiscal_subject_id: z.uuid(), venue_id: z.uuid(),
  cash_register_id: z.uuid(), device_id: z.uuid(), installation_number: z.string().min(1),
  venue_code: z.string().regex(/^[A-Z0-9]{1,8}$/), register_code: z.string().regex(/^[A-Z0-9]{1,8}$/),
  installation_code: z.string().regex(/^[A-Z0-9]{1,8}$/), mode: z.literal('production'), retired_at: z.null(),
  installation_sequence: z.number().int().positive(), series_version: z.union([z.literal(1), z.literal(2)]),
})
const subjectSchema = z.object({ id: z.uuid(), tenant_id: z.uuid(), legal_name: z.string().min(1), nif: z.string().regex(/^[A-Z0-9]{9}$/) })

export type FiscalInstallation = {
  tenantId: string; fiscalSubjectId: string; issuerName: string; issuerNif: string
  venueId: string; cashRegisterId: string; deviceId: string; installationId: string; installationNumber: string
  venueCode: string; registerCode: string; installationCode: string; timezone: string
  installationSequence: number; seriesVersion: 1 | 2
  system: FiscalSystem; bridgeUrl: string | null; aeatEnvironment: 'test' | 'production'
  preparedServerHead?: { record: unknown }
}

const leases = new Map<string, FiscalLease>()
const bridgeUrls = new Map<string, string | null>()

function publicSystem(installationNumber: string, settings: FiscalPosSettings): FiscalSystem {
  return {
    NombreRazon: settings.producer_name, NIF: settings.producer_nif, NombreSistemaInformatico: 'Tickit',
    IdSistemaInformatico: settings.system_id, Version: settings.system_version, NumeroInstalacion: installationNumber,
    TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
  }
}

export function fiscalIdentityKey(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): string {
  return `tickit:fiscal-installation:v1:${context.tenantId}:${context.venueId}:${cashSession.cashRegisterId}:${context.deviceId}`
}

const installationLoads = new Map<string, Promise<FiscalInstallation>>()
export async function loadFiscalInstallation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): Promise<FiscalInstallation> {
  const key = fiscalIdentityKey(context, cashSession) + ':' + context.userId
  const current = installationLoads.get(key)
  if (current) return current
  const pending = fetchFiscalInstallation(context, cashSession)
  installationLoads.set(key, pending)
  try { return await pending } finally { if (installationLoads.get(key) === pending) installationLoads.delete(key) }
}

async function fetchFiscalInstallation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): Promise<FiscalInstallation> {
  const key = fiscalIdentityKey(context, cashSession)
  const cached = snapshotSchema.parse(await readRequiredIdentity(key))
  if (supabase) {
    const response = await supabase.rpc('pos_fiscal_preparation', {
      p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_register_id: cashSession.cashRegisterId,
      p_device_id: context.deviceId, p_installation_id: cached.installation.id,
    })
    if (!response.error) {
      if (!response.data) throw new UserFacingError('La instalación fiscal fue retirada o su configuración no está disponible. Se bloquea la emisión.')
      const value = response.data as { installation: unknown; subject: unknown; settings: unknown; head: unknown }
      const snapshot = snapshotSchema.parse(value)
      if (snapshot.installation.tenant_id !== context.tenantId || snapshot.installation.venue_id !== context.venueId
        || snapshot.installation.device_id !== context.deviceId || snapshot.installation.cash_register_id !== cashSession.cashRegisterId
        || snapshot.subject.id !== snapshot.installation.fiscal_subject_id || snapshot.subject.tenant_id !== context.tenantId) throw new Error('La instalación fiscal no pertenece a esta caja y dispositivo.')
      const settings = rememberFiscalPosSettings(value.settings, context.tenantId)
      await assertFiscalLedgerHeadValid(`${context.tenantId}:${snapshot.installation.fiscal_subject_id}:${snapshot.installation.id}`, context.deviceId, snapshot.installation.series_version === 1, snapshot.installation.installation_number)
      const installation = await installationFromSnapshot(context, cashSession, snapshot, settings)
      installation.preparedServerHead = { record: value.head }
      return installation
    }
    if (!['PGRST202','42883'].includes(response.error.code) && !isFiscalTransportUnavailable(response.error)) throw response.error
  }
  const [snapshot, settings] = await Promise.all([
    fetchFiscalSnapshot(context, cashSession, cached.installation.id, cached),
    loadFiscalPosSettings(context.tenantId),
    assertFiscalLedgerHeadValid(`${context.tenantId}:${cached.installation.fiscal_subject_id}:${cached.installation.id}`,
      context.deviceId, cached.installation.series_version === 1, cached.installation.installation_number),
  ])
  const installation = await installationFromSnapshot(context, cashSession, snapshot, settings)
  return installation
}

const snapshotSchema = z.object({ installation: installationSchema, subject: subjectSchema })
type Snapshot = z.infer<typeof snapshotSchema>
const installationColumns = 'id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode,retired_at,installation_sequence,series_version'

async function readRequiredIdentity(key: string): Promise<unknown> {
  const identity = await readFiscalIdentity(key)
  if (identity === null) throw new FiscalIdentityMissingError()
  return identity
}

export function fiscalLedgerScope(installation: FiscalInstallation): string {
  return `${installation.tenantId}:${installation.fiscalSubjectId}:${installation.installationId}`
}

async function fetchFiscalSnapshot(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>, id: string, cached?: Snapshot): Promise<Snapshot> {
  if (!supabase) throw new Error('Supabase no está configurado para cargar la instalación fiscal.')
  const installationResult = await supabase.from('fiscal_sif_installations')
    .select(installationColumns).eq('id', id)
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
    .eq('cash_register_id', cashSession.cashRegisterId).eq('device_id', context.deviceId)
    .is('retired_at', null).maybeSingle()
  if (installationResult.error && (!cached || !isFiscalTransportUnavailable(installationResult.error))) throw installationResult.error
  if (!installationResult.error && !installationResult.data) throw new UserFacingError('La instalación fiscal fue retirada o no está autorizada. Se bloquea la emisión; su sincronización pendiente puede continuar.')
  const installation = installationSchema.parse(installationResult.error ? cached?.installation : installationResult.data)
  if (installation.tenant_id !== context.tenantId || installation.venue_id !== context.venueId
    || installation.cash_register_id !== cashSession.cashRegisterId || installation.device_id !== context.deviceId) {
    throw new Error('La instalación fiscal no pertenece a esta caja y dispositivo.')
  }
  const subjectResult = await supabase.from('fiscal_subjects')
    .select('id,tenant_id,legal_name,nif').eq('tenant_id', context.tenantId).eq('id', installation.fiscal_subject_id).maybeSingle()
  if (subjectResult.error && (!cached || !isFiscalTransportUnavailable(subjectResult.error))) throw subjectResult.error
  const subject = subjectSchema.parse(subjectResult.error ? cached?.subject : subjectResult.data)
  if (subject.id !== installation.fiscal_subject_id || subject.tenant_id !== context.tenantId) {
    throw new Error('El titular fiscal no coincide con la instalación.')
  }
  return { installation, subject }
}

async function installationFromSnapshot(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>, { installation, subject }: Snapshot,
  settings?: FiscalPosSettings): Promise<FiscalInstallation> {
  settings ??= await loadFiscalPosSettings(context.tenantId)
  bridgeUrls.set(context.tenantId, settings.bridge_url || null)
  return {
    tenantId: context.tenantId, fiscalSubjectId: subject.id, issuerName: subject.legal_name, issuerNif: subject.nif,
    venueId: context.venueId, cashRegisterId: cashSession.cashRegisterId, deviceId: context.deviceId,
    installationId: installation.id, installationNumber: installation.installation_number,
    venueCode: installation.venue_code, registerCode: installation.register_code,
    installationCode: installation.installation_code, timezone: context.venueTimeZone || 'Europe/Madrid',
    installationSequence: installation.installation_sequence, seriesVersion: installation.series_version,
    system: publicSystem(installation.installation_number, settings), bridgeUrl: settings.bridge_url || null, aeatEnvironment: settings.aeat_environment,
  }
}

/** Online preview for the confirmation dialog; never adopts the returned identity. */
export async function latestFiscalInstallation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): Promise<{ id: string; number: string } | null> {
  if (!supabase) throw new Error('Conéctate a Supabase para activar la instalación.')
  const { data, error } = await supabase.from('fiscal_sif_installations').select('id,installation_number')
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
    .eq('cash_register_id', cashSession.cashRegisterId).is('retired_at', null).maybeSingle()
  if (error) throw error
  return data ? { id: z.uuid().parse(data.id), number: z.string().parse(data.installation_number) } : null
}

/** Temporary test-only recovery is checked again by the RPC, not just hidden in the UI. */
export async function activateFiscalInstallation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>, expectedId: string | null, recoverForTesting = false): Promise<FiscalInstallation> {
  if (!navigator.locks?.request) throw new Error('Web Locks no está disponible para activar la instalación fiscal.')
  const key = fiscalIdentityKey(context, cashSession)
  return navigator.locks.request(`tickit-fiscal-identity:${key}`, { mode: 'exclusive' }, async () => {
    if (await readFiscalIdentity(key) !== null) throw new UserFacingError('Ya existe identidad local. Recarga o concilia su ledger antes de continuar.')
    if (!supabase) throw new Error('Conéctate a Supabase para activar la instalación.')
    const pending = await fiscalActivationRequest(key, expectedId, recoverForTesting)
    const { data, error } = await supabase.rpc('activate_pwa_fiscal_installation', {
      p_tenant_id: context.tenantId, p_venue_id: context.venueId, p_register_id: cashSession.cashRegisterId,
      p_device_id: context.deviceId, p_request_id: pending.requestId,
      p_expected_installation_id: pending.expectedInstallationId, p_recover_for_testing: recoverForTesting,
    })
    if (error) {
      if (/FISCAL_ACTIVATION_CONFIRMATION_STALE|FISCAL_ACTIVATION_ALREADY_RETIRED/.test(error.message)) {
        await clearFiscalActivationRequest(key)
        throw new FiscalActivationConfirmationError('La instalación activa cambió. Vuelve a comprobar la caja y confirma su estado actual.')
      }
      throw error
    }
    const id = z.uuid().parse(data)
    const snapshot = await fetchFiscalSnapshot(context, cashSession, id)
    const installation = await installationFromSnapshot(context, cashSession, snapshot)
    // A successful server read is mandatory here, including when recovering a completed request.
    await recoverServerConfirmedFiscalChain(installation)
    await persistFiscalIdentity(key, snapshot, fiscalLedgerScope(installation), context.deviceId)
    await assertFiscalLedgerHeadValid(fiscalLedgerScope(installation), context.deviceId, installation.seriesVersion === 1, installation.installationNumber)
    return installation
  })
}

export function fiscalBridgeBaseUrl(tenantId: string): string | null {
  return bridgeUrls.get(tenantId) ?? null
}

export async function fiscalBridgeAccessToken(): Promise<string> {
  const { data, error } = await supabase?.auth.getSession() ?? { data: { session: null }, error: new Error('Supabase no está configurado.') }
  if (error || !data.session?.access_token) throw new Error('No hay sesión autorizada para el puente fiscal.')
  return data.session.access_token
}

export async function getFiscalInstallationLease(installation: FiscalInstallation): Promise<FiscalLease> {
  if (!installation.bridgeUrl) return createLocalFallbackLease(installation.installationId, installation.deviceId)
  const leaseKey = `${installation.installationId}:${installation.bridgeUrl}`
  const existing = leases.get(leaseKey)
  if (existing) {
    try {
      assertFiscalLease(existing, installation.installationId, installation.deviceId, Date.now(), performance.now())
      return existing
    } catch { leases.delete(leaseKey) }
  }
  try {
    const client = createBridgeClient({ mode: 'production', baseUrl: installation.bridgeUrl, getAccessToken: fiscalBridgeAccessToken })
    const lease = { ...await client.acquireInstallationLease(installation.installationId, installation.deviceId), source: 'bridge' as const }
    assertFiscalLease(lease, installation.installationId, installation.deviceId, Date.now(), performance.now())
    leases.set(leaseKey, lease)
    return lease
  } catch (error) {
    if (!isFiscalTransportUnavailable(error)) throw error
    return createLocalFallbackLease(installation.installationId, installation.deviceId)
  }
}
