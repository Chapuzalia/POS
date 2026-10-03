import { z } from 'zod'
import { supabase } from '../../../lib/supabase.ts'

const bridgeUrlSchema = z.url().refine((value) => {
  const url = new URL(value)
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/'
}, 'La URL del puente debe ser un origen HTTPS sin credenciales ni parámetros.')

const settingsSchema = z.object({
  tenant_id: z.uuid(),
  bridge_url: z.preprocess((value) => value ?? '', z.union([z.literal(''), bridgeUrlSchema])),
  aeat_environment: z.enum(['test', 'production']),
  print_ticket_qr: z.preprocess((value) => value ?? true, z.boolean()),
  producer_name: z.string().trim().min(1).max(120),
  producer_nif: z.string().regex(/^[A-Z0-9]{9}$/),
  system_id: z.string().regex(/^[A-Z0-9]{2}$/),
  system_version: z.string().trim().min(1).max(40),
})

export type FiscalPosSettings = z.infer<typeof settingsSchema>

function storageKey(tenantId: string): string {
  return `tickit:fiscal-pos-settings:v1:${tenantId}`
}

export const FISCAL_SETTINGS_CHANGED = 'tickit:fiscal-settings-changed'

function cacheSettings(settings: FiscalPosSettings) {
  try { window.localStorage.setItem(storageKey(settings.tenant_id), JSON.stringify(settings)) } catch { /* Public metadata only. */ }
  window.dispatchEvent(new CustomEvent(FISCAL_SETTINGS_CHANGED, { detail: settings.tenant_id }))
}

/** The cached values are public invoice metadata, never transport credentials. */
export async function loadFiscalPosSettings(tenantId: string, allowCached = true): Promise<FiscalPosSettings> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const { data, error } = await supabase.from('fiscal_pos_bridge_settings')
    .select('*')
    .eq('tenant_id', tenantId).maybeSingle()
  if (!error) {
    if (!data) throw new Error('Configura el puente y el productor SIF en Integraciones del CRM antes de facturar.')
    const settings = settingsSchema.parse(data)
    if (settings.tenant_id !== tenantId) throw new Error('El puente fiscal pertenece a otro tenant.')
    try { window.localStorage.setItem(storageKey(tenantId), JSON.stringify(settings)) } catch { /* The ledger checks durable storage. */ }
    return settings
  }
  if (!allowCached) throw new Error('No se puede confirmar en Supabase el entorno fiscal. Reintenta la comprobación con conexión.')
  if (allowCached) try {
    const cached = window.localStorage.getItem(storageKey(tenantId))
    if (cached) {
      const settings = settingsSchema.parse(JSON.parse(cached))
      if (settings.tenant_id === tenantId) return settings
    }
  } catch { /* No usable offline configuration. */ }
  throw new Error('No se puede consultar la configuración fiscal del tenant y no existe una copia local válida.')
}

export async function saveFiscalPosSettings(settings: FiscalPosSettings): Promise<FiscalPosSettings> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const validated = settingsSchema.parse(settings)
  const { data, error } = await supabase.from('fiscal_pos_bridge_settings')
    .upsert({ ...validated, bridge_url: validated.bridge_url || null }, { onConflict: 'tenant_id' })
    .select('*').single()
  if (error) throw error
  const saved = settingsSchema.parse(data)
  cacheSettings(saved)
  return saved
}

/** Save this switch immediately without overwriting unsaved producer form fields. */
export async function saveFiscalAeatEnvironment(tenantId: string, environment: FiscalPosSettings['aeat_environment']): Promise<FiscalPosSettings> {
  if (!supabase) throw new Error('Supabase no está configurado.')
  const tenant = z.uuid().parse(tenantId)
  const aeatEnvironment = settingsSchema.shape.aeat_environment.parse(environment)
  const { data, error } = await supabase.from('fiscal_pos_bridge_settings')
    .update({ aeat_environment: aeatEnvironment }).eq('tenant_id', tenant)
    .select('tenant_id,bridge_url,aeat_environment,producer_name,producer_nif,system_id,system_version').single()
  if (error) throw error
  const saved = settingsSchema.parse(data)
  cacheSettings(saved)
  return saved
}
