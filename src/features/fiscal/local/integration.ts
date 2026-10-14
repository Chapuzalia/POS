import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'
import { UserFacingError } from '../../../utils/UserFacingError.ts'
import { readFiscalBackend } from './backendRead.ts'
import { isFiscalTransportUnavailable } from './availability.ts'
import { validateFiscalPosSettings, type FiscalPosSettings } from './settings.ts'

const integrationSchema = z.object({
  tenant_id: z.uuid(), requested_at: z.string().nullable(), enabled_at: z.string().nullable(),
  aeat_environment: z.enum(['test', 'production']), print_ticket_qr: z.boolean(),
})
export type VerifactuIntegration = z.infer<typeof integrationSchema>
const cache = new Map<string, { value: VerifactuIntegration; expiresAt: number }>()
const key = (tenantId: string) => `tickit:verifactu-integration:v1:${tenantId}`

function remember(value: unknown, tenantId: string): VerifactuIntegration {
  const integration = integrationSchema.parse(value)
  if (integration.tenant_id !== tenantId) throw new Error('La integración pertenece a otra empresa.')
  cache.set(tenantId, { value: integration, expiresAt: Date.now() + 15_000 })
  try { window.localStorage.setItem(key(tenantId), JSON.stringify(integration)) } catch { /* Public offline state. */ }
  return integration
}

export async function loadVerifactuIntegration(tenantId: string, allowCached = true): Promise<VerifactuIntegration> {
  if (!supabase) throw new UserFacingError('Supabase no está configurado.')
  const tenant = z.uuid().parse(tenantId)
  const cached = cache.get(tenant)
  if (allowCached && cached && cached.expiresAt > Date.now()) return cached.value
  const client = supabase
  const { data, error } = await readFiscalBackend(signal => client.from('tenant_verifactu_integrations')
    .select('*').eq('tenant_id', tenant).abortSignal(signal).maybeSingle())
  if (!error) return remember(data ?? { tenant_id: tenant, requested_at: null, enabled_at: null,
    aeat_environment: 'production', print_ticket_qr: true }, tenant)
  if (allowCached && isFiscalTransportUnavailable(error)) {
    try {
      const stored = window.localStorage.getItem(key(tenant))
      if (stored) return remember(JSON.parse(stored), tenant)
    } catch { /* Never assume legacy when the saved state is invalid. */ }
  }
  throw new UserFacingError('No se puede confirmar la integración Verifactu. Reintenta con conexión.')
}

export async function requestVerifactuActivation(tenantId: string): Promise<VerifactuIntegration> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc('request_verifactu_activation', { p_tenant_id: z.uuid().parse(tenantId) })
  if (error) throw error
  return remember(data, tenantId)
}

export async function saveVerifactuPreferences(tenantId: string, environment: 'test' | 'production', printQr: boolean): Promise<VerifactuIntegration> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.rpc('save_verifactu_preferences', {
    p_tenant_id: z.uuid().parse(tenantId), p_aeat_environment: environment, p_print_ticket_qr: printQr,
  })
  if (error) throw error
  return remember(data, tenantId)
}

export async function loadPlatformVerifactuIntegrations(): Promise<VerifactuIntegration[]> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const result: VerifactuIntegration[] = []
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await supabase.from('tenant_verifactu_integrations').select('*').order('tenant_id').range(offset, offset + 499)
    if (error) throw error
    const page = z.array(integrationSchema).parse(data)
    result.push(...page)
    if (page.length < 500) return result
  }
}

export async function configureVerifactuIntegration(settings: FiscalPosSettings, activate: boolean): Promise<VerifactuIntegration> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  settings = validateFiscalPosSettings({ ...settings, bridge_url: settings.bridge_url.trim(),
    producer_name: settings.producer_name.trim(), producer_nif: settings.producer_nif.trim().toUpperCase(),
    system_id: settings.system_id.trim().toUpperCase(), system_version: settings.system_version.trim() })
  const { data, error } = await supabase.rpc('configure_verifactu_integration', {
    p_tenant_id: settings.tenant_id, p_bridge_url: settings.bridge_url.trim(),
    p_producer_name: settings.producer_name.trim(), p_producer_nif: settings.producer_nif.trim().toUpperCase(),
    p_system_id: settings.system_id.trim().toUpperCase(), p_system_version: settings.system_version.trim(), p_activate: activate,
  })
  if (error) throw error
  return remember(data, settings.tenant_id)
}
