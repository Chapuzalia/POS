import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'
import type { CashSession, TenantContext } from '../../../types/index.ts'
import type { FiscalSystem } from './canonical.ts'
import { createBridgeClient } from './bridgeClient.ts'
import { assertFiscalLease, type FiscalLease } from './clock.ts'
import { loadFiscalPosSettings, type FiscalPosSettings } from './settings.ts'

const installationSchema = z.object({
  id: z.uuid(), tenant_id: z.uuid(), fiscal_subject_id: z.uuid(), venue_id: z.uuid(),
  cash_register_id: z.uuid(), device_id: z.uuid(), installation_number: z.string().min(1),
  venue_code: z.string().regex(/^[A-Z0-9]{1,8}$/), register_code: z.string().regex(/^[A-Z0-9]{1,8}$/),
  installation_code: z.string().regex(/^[A-Z0-9]{1,8}$/), mode: z.literal('production'), retired_at: z.null(),
})
const subjectSchema = z.object({ id: z.uuid(), tenant_id: z.uuid(), legal_name: z.string().min(1), nif: z.string().regex(/^[A-Z0-9]{9}$/) })

export type FiscalInstallation = {
  tenantId: string; fiscalSubjectId: string; issuerName: string; issuerNif: string
  venueId: string; cashRegisterId: string; deviceId: string; installationId: string; installationNumber: string
  venueCode: string; registerCode: string; installationCode: string; timezone: string
  system: FiscalSystem; bridgeUrl: string
}

const leases = new Map<string, FiscalLease>()
const bridgeUrls = new Map<string, string>()

function publicSystem(installationNumber: string, settings: FiscalPosSettings): FiscalSystem {
  return {
    NombreRazon: settings.producer_name, NIF: settings.producer_nif, NombreSistemaInformatico: 'Tickit',
    IdSistemaInformatico: settings.system_id, Version: settings.system_version, NumeroInstalacion: installationNumber,
    TipoUsoPosibleSoloVerifactu: 'S', TipoUsoPosibleMultiOT: 'S', IndicadorMultiplesOT: 'S',
  }
}

function cacheKey(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): string {
  return `tickit:fiscal-installation:v1:${context.tenantId}:${context.venueId}:${cashSession.cashRegisterId}:${context.deviceId}`
}

export async function loadFiscalInstallation(context: TenantContext, cashSession: Pick<CashSession, 'cashRegisterId'>): Promise<FiscalInstallation> {
  const key = cacheKey(context, cashSession)
  if (!supabase) throw new Error('Supabase no está configurado para cargar la instalación fiscal.')
  let cached: { installation: unknown; subject: unknown } | null = null
  try {
    const raw = window.localStorage.getItem(key)
    if (raw) cached = JSON.parse(raw) as { installation: unknown; subject: unknown }
  } catch { /* A damaged cache is ignored. */ }

  const installationResult = await supabase.from('fiscal_sif_installations')
    .select('id,tenant_id,fiscal_subject_id,venue_id,cash_register_id,device_id,installation_number,venue_code,register_code,installation_code,mode,retired_at')
    .eq('tenant_id', context.tenantId).eq('venue_id', context.venueId)
    .eq('cash_register_id', cashSession.cashRegisterId).eq('device_id', context.deviceId)
    .is('retired_at', null).maybeSingle()
  const installation = installationSchema.parse(installationResult.error ? cached?.installation : installationResult.data)
  if (installation.tenant_id !== context.tenantId || installation.venue_id !== context.venueId
    || installation.cash_register_id !== cashSession.cashRegisterId || installation.device_id !== context.deviceId) {
    throw new Error('La instalación fiscal no pertenece a esta caja y dispositivo.')
  }
  const subjectResult = await supabase.from('fiscal_subjects')
    .select('id,tenant_id,legal_name,nif').eq('tenant_id', context.tenantId).eq('id', installation.fiscal_subject_id).maybeSingle()
  const subject = subjectSchema.parse(subjectResult.error ? cached?.subject : subjectResult.data)
  if (subject.id !== installation.fiscal_subject_id || subject.tenant_id !== context.tenantId) {
    throw new Error('El titular fiscal no coincide con la instalación.')
  }
  const settings = await loadFiscalPosSettings(context.tenantId)
  bridgeUrls.set(context.tenantId, settings.bridge_url)
  if (!installationResult.error && !subjectResult.error) {
    try { window.localStorage.setItem(key, JSON.stringify({ installation, subject })) } catch { /* The fiscal ledger checks durable storage separately. */ }
  }
  return {
    tenantId: context.tenantId, fiscalSubjectId: subject.id, issuerName: subject.legal_name, issuerNif: subject.nif,
    venueId: context.venueId, cashRegisterId: cashSession.cashRegisterId, deviceId: context.deviceId,
    installationId: installation.id, installationNumber: installation.installation_number,
    venueCode: installation.venue_code, registerCode: installation.register_code,
    installationCode: installation.installation_code, timezone: context.venueTimeZone || 'Europe/Madrid',
    system: publicSystem(installation.installation_number, settings), bridgeUrl: settings.bridge_url,
  }
}

export function fiscalBridgeBaseUrl(tenantId: string): string {
  const value = bridgeUrls.get(tenantId)
  if (!value) throw new Error('Falta la URL HTTPS del puente fiscal.')
  return value
}

export async function fiscalBridgeAccessToken(): Promise<string> {
  const { data, error } = await supabase?.auth.getSession() ?? { data: { session: null }, error: new Error('Supabase no está configurado.') }
  if (error || !data.session?.access_token) throw new Error('No hay sesión autorizada para el puente fiscal.')
  return data.session.access_token
}

export async function getFiscalInstallationLease(installation: FiscalInstallation): Promise<FiscalLease> {
  const leaseKey = `${installation.installationId}:${installation.bridgeUrl}`
  const existing = leases.get(leaseKey)
  if (existing) {
    try {
      assertFiscalLease(existing, installation.installationId, installation.deviceId, Date.now(), performance.now())
      return existing
    } catch { leases.delete(leaseKey) }
  }
  const client = createBridgeClient({ mode: 'production', baseUrl: installation.bridgeUrl, getAccessToken: fiscalBridgeAccessToken })
  const lease = await client.acquireInstallationLease(installation.installationId, installation.deviceId)
  assertFiscalLease(lease, installation.installationId, installation.deviceId, Date.now(), performance.now())
  leases.set(leaseKey, lease)
  return lease
}
