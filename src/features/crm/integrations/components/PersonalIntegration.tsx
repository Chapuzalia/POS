import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '../../../../components/ui/Button'
import { requireSupabase } from '../../../../services/backendService'
import type { TenantContext } from '../../../../types'

const configSchema = z.object({
  connectionId: z.uuid(), organizationId: z.uuid(), secret: z.string().regex(/^[a-f0-9]{64}$/),
  venueMappings: z.record(z.uuid(), z.uuid()).refine(mappings => Object.keys(mappings).length > 0),
})
const statusSchema = z.object({ enabled: z.boolean(), linked: z.boolean(), connectionId: z.uuid().nullable(), organizationId: z.uuid().nullable(), venueMappings: z.record(z.string(), z.string()) })
type Status = z.infer<typeof statusSchema>

export function PersonalIntegration({ tenantContext, disabled }: { tenantContext: TenantContext; disabled: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [venues, setVenues] = useState<Array<{ id: string; name: string }>>([])
  const [connectionId, setConnectionId] = useState('')
  const [organizationId, setOrganizationId] = useState('')
  const [secret, setSecret] = useState('')
  const [venueMappings, setVenueMappings] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const canEdit = tenantContext.role === 'owner'
  const refresh = useCallback(async () => {
    const client = requireSupabase()
    const [configuration, locations] = await Promise.all([
      client.rpc('tickit_personal_configure', { p_tenant_id: tenantContext.tenantId, p_config: null }),
      client.from('venues').select('id,name').eq('tenant_id', tenantContext.tenantId).eq('is_active', true).order('name'),
    ])
    if (configuration.error || locations.error) throw configuration.error ?? locations.error
    return { configuration: statusSchema.parse(configuration.data), venues: z.array(z.object({ id: z.uuid(), name: z.string() })).parse(locations.data) }
  }, [tenantContext.tenantId])
  useEffect(() => {
    if (!canEdit) return
    let active = true
    void refresh().then(result => {
      if (!active) return
      setStatus(result.configuration); setVenues(result.venues)
      setConnectionId(result.configuration.connectionId ?? ''); setOrganizationId(result.configuration.organizationId ?? '')
      setVenueMappings(Object.fromEntries(Object.entries(result.configuration.venueMappings).map(([personal, pos]) => [pos, personal])))
    }).catch(() => { if (active) setMessage('No se pudo cargar la conexión de Tickit Personal.') })
    return () => { active = false }
  }, [canEdit, refresh])

  async function configure(enabled: boolean) {
    if (!canEdit || disabled || busy) return
    const entries = Object.entries(venueMappings).filter(([, personal]) => personal.trim()).map(([pos, personal]) => [personal.trim(), pos])
    const config = configSchema.safeParse({ connectionId: connectionId.trim(), organizationId: organizationId.trim(), secret: secret.trim(), venueMappings: Object.fromEntries(entries) })
    if (enabled && (!config.success || new Set(entries.map(([personal]) => personal)).size !== entries.length)) {
      setMessage('Revisa los identificadores, la clave de 64 caracteres y la correspondencia de al menos un local. Cada local de Personal solo puede vincularse una vez.'); return
    }
    setBusy(true); setMessage('')
    try {
      const { error } = await requireSupabase().rpc('tickit_personal_configure', { p_tenant_id: tenantContext.tenantId, p_config: enabled ? config.data : { enabled: false } })
      if (error) throw error
      setSecret('')
      const result = await refresh()
      setStatus(result.configuration)
      setMessage(enabled ? 'Conexión preparada. Confirma ahora la vinculación desde Tickit Personal y solicita la reconciliación de trabajadores.' : 'Integración desactivada. Los dispositivos volverán a la operativa habitual al actualizar su configuración.')
    } catch { setMessage('No se pudo guardar la integración. Comprueba tus permisos y vuelve a intentarlo.') }
    finally { setBusy(false) }
  }

  const fieldClass = 'min-h-11 w-full rounded border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3 text-sm'
  return <section className="grid gap-4 rounded-lg border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-5 text-[var(--crm-text)]">
    <div><h2 className="text-lg font-semibold">Tickit Personal</h2><p className="mt-1 text-sm text-[var(--crm-text-muted)]">Trabajadores, roles y PIN se gestionan en Personal. Los accesos de dispositivos, owners y managers siguen en Tickit POS.</p></div>
    {!canEdit ? <p className="text-sm">El owner configura esta integración.</p> : <>
      <p role="status" className="text-sm">{status?.enabled ? status.linked ? 'Vinculada' : 'Pendiente de vinculación' : 'Desactivada'}</p>
      <p className="text-sm">En Personal, prepara una conexión con el endpoint <code>https://tu-api-existente/personal</code> y la empresa externa <code>{tenantContext.tenantId}</code>. Copia aquí los datos de esa conexión.</p>
      <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void configure(true) }}>
        <label className="grid gap-1 text-sm">ID de conexión de Personal<input className={fieldClass} value={connectionId} onChange={event => setConnectionId(event.target.value)} required disabled={disabled || busy} /></label>
        <label className="grid gap-1 text-sm">ID de empresa de Personal<input className={fieldClass} value={organizationId} onChange={event => setOrganizationId(event.target.value)} required disabled={disabled || busy} /></label>
        <label className="grid gap-1 text-sm">Clave compartida de Personal<input className={fieldClass} type="password" autoComplete="new-password" value={secret} onChange={event => setSecret(event.target.value)} required disabled={disabled || busy} /></label>
        {venues.map(venue => <label className="grid gap-1 text-sm" key={venue.id}>{venue.name}: ID del local en Personal<input className={fieldClass} value={venueMappings[venue.id] ?? ''} onChange={event => setVenueMappings(current => ({ ...current, [venue.id]: event.target.value }))} disabled={disabled || busy} /><span className="text-xs text-[var(--crm-text-muted)]">ID en POS: {venue.id}. Deja vacío para mantener este local sin integración.</span></label>)}
        <div className="flex flex-wrap gap-2"><Button type="submit" disabled={disabled || busy}>Guardar vinculación</Button><Button type="button" disabled={disabled || busy || !status?.enabled} onClick={() => void configure(false)}>Desactivar</Button><Button type="button" disabled={disabled || busy} onClick={() => { void refresh().then(result => setStatus(result.configuration)).catch(() => setMessage('No se pudo actualizar el estado.')) }}>Actualizar estado</Button></div>
      </form>
      <p className="text-sm text-[var(--crm-text-muted)]">Tras la primera sincronización, el dispositivo conserva trabajadores y permisos para seguir operando sin conexión. Los cambios se reciben al recuperar el servicio.</p>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </>}
  </section>
}
