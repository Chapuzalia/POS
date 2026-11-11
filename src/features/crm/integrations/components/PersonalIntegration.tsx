import { useCallback, useEffect, useState } from 'react'
import { z } from 'zod'
import { Button } from '../../../../components/ui/Button'
import { requireSupabase } from '../../../../services/backendService'
import type { TenantContext } from '../../../../types'

const statusSchema = z.object({ enabled: z.boolean(), linked: z.boolean() })
type Status = z.infer<typeof statusSchema>

export function PersonalIntegration({ tenantContext, disabled }: { tenantContext: TenantContext; disabled: boolean }) {
  const [status, setStatus] = useState<Status | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [password, setPassword] = useState('')
  const [personalUrl, setPersonalUrl] = useState('')
  const canEdit = tenantContext.role === 'owner'
  const refresh = useCallback(async () => {
    const { data, error } = await requireSupabase().rpc('tickit_personal_configure', {
      p_tenant_id: tenantContext.tenantId, p_config: null,
    })
    if (error) throw error
    return statusSchema.parse(data)
  }, [tenantContext.tenantId])
  useEffect(() => {
    if (!canEdit) return
    let active = true
    void refresh().then(result => {
      if (active) setStatus(result)
    }).catch(() => { if (active) setMessage('No se pudo cargar la conexión de Tickit Personal.') })
    return () => { active = false }
  }, [canEdit, refresh])

  async function activate() {
    if (!canEdit || disabled || busy || !status || password.length < 6) return
    const personalPassword = password
    setPassword(''); setBusy(true); setMessage('')
    try {
      const result = await requireSupabase().functions.invoke('activate-personal', {
        body: { tenantId: tenantContext.tenantId, password: personalPassword },
      })
      if (result.error) {
        let detail = 'No se pudo vincular Personal. Reintenta la operación.'
        if (result.error.context instanceof Response) {
          try {
            const body = await result.error.context.json()
            if (typeof body?.error === 'string' && body.error.length < 400) detail = body.error
          } catch { /* Use the generic error when the gateway returned no JSON. */ }
        }
        throw new Error(detail)
      }
      const data = z.object({ personalUrl: z.url().startsWith('https://') }).parse(result.data)
      setPersonalUrl(data.personalUrl)
      setStatus(await refresh())
      setMessage('Personal vinculado. Accede con tu correo y la contraseña que has elegido para Personal.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'No se pudo vincular Personal.')
    } finally { setBusy(false) }
  }

  async function disconnect() {
    if (!canEdit || disabled || busy || !status?.enabled) return
    if (!confirm('¿Desvincular Tickit Personal? El POS volverá a su operativa habitual al actualizar los dispositivos.')) return
    setBusy(true); setMessage('')
    try {
      const { error } = await requireSupabase().rpc('tickit_personal_configure', {
        p_tenant_id: tenantContext.tenantId, p_config: { enabled: false },
      })
      if (error) throw error
      setStatus(await refresh())
      setMessage('Personal desvinculado.')
    } catch { setMessage('No se pudo desvincular Personal. Vuelve a intentarlo.') }
    finally { setBusy(false) }
  }

  const fieldClass = 'min-h-11 w-full rounded border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3 text-sm'
  return <section className="grid gap-4 rounded-lg border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-5 text-[var(--crm-text)]">
    <div><h2 className="text-lg font-semibold">Tickit Personal</h2><p className="mt-1 text-sm text-[var(--crm-text-muted)]">Añade trabajadores en Personal y estarán disponibles automáticamente en los POS de sus locales. Cada trabajador elige su PIN desde su cuenta de Personal.</p></div>
    {!canEdit ? <p className="text-sm">El owner vincula Tickit Personal.</p> : <>
      <p role="status" className="text-sm">{!status ? 'Cargando conexión…' : status.enabled && status.linked ? 'Vinculado' : status.enabled ? 'Pendiente de vinculación' : 'Sin vincular'}</p>
      {status && (!status.enabled || !status.linked) ? <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void activate() }}>
        <p className="text-sm">Crearemos tu cuenta de Personal y conectaremos la empresa y sus locales. No necesitas configurar códigos.</p>
        <label className="grid gap-1 text-sm">Contraseña para Tickit Personal<input className={fieldClass} type="password" autoComplete="new-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={disabled || busy} minLength={6} maxLength={1024} /></label>
        <p className="text-sm text-[var(--crm-text-muted)]">Mínimo 6 caracteres. Si ya tienes cuenta en Personal, usa su contraseña actual.</p>
        <Button type="submit" disabled={disabled || busy || password.length < 6}>{busy ? 'Vinculando…' : 'Vincular Tickit Personal'}</Button>
      </form> : null}
      {personalUrl ? <a className="text-sm underline" href={personalUrl} target="_blank" rel="noreferrer">Abrir Tickit Personal</a> : null}
      {status?.enabled ? <Button type="button" disabled={disabled || busy} onClick={() => void disconnect()}>Desvincular</Button> : null}
      <Button type="button" disabled={disabled || busy} onClick={() => {
        setBusy(true)
        void refresh().then(setStatus).catch(() => setMessage('No se pudo actualizar el estado.')).finally(() => setBusy(false))
      }}>Actualizar estado</Button>
      {message ? <p role="status" className="text-sm">{message}</p> : null}
    </>}
  </section>
}
