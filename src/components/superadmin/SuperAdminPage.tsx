import { Building2, Crown, LogOut, Plus, RefreshCw, Store, UserRound } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent } from 'react'
import {
  createPlatformTenant,
  loadPlatformTenants,
  type PlatformTenant,
} from '../../services/platformService'
import type { TenantContext } from '../../types'
import { getReadableError } from '../../utils/errors'

type SuperAdminPageProps = {
  context: TenantContext
  error: string | null
  isOnline: boolean
  onError: (error: string | null) => void
  onLogout: () => void
}

function slugify(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const dateFormatter = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
})

export function SuperAdminPage({ context, error, isOnline, onError, onLogout }: SuperAdminPageProps) {
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [isBusy, setIsBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [tenantName, setTenantName] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [venueName, setVenueName] = useState('Sala principal')
  const [ownerFullName, setOwnerFullName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')

  const refresh = useCallback(async () => {
    setTenants(await loadPlatformTenants())
  }, [])

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true)
    setSuccess(null)
    onError(null)
    try {
      await action()
    } catch (actionError) {
      onError(getReadableError(actionError))
    } finally {
      setIsBusy(false)
    }
  }, [onError])

  useEffect(() => {
    if (isOnline) {
      void runAction(refresh)
    }
  }, [isOnline, refresh, runAction])

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      const created = await createPlatformTenant({
        tenantName: tenantName.trim(),
        tenantSlug: tenantSlug.trim(),
        venueName: venueName.trim(),
        ownerEmail: ownerEmail.trim(),
        ownerPassword,
        ownerFullName: ownerFullName.trim(),
      })
      setTenantName('')
      setTenantSlug('')
      setSlugEdited(false)
      setVenueName('Sala principal')
      setOwnerFullName('')
      setOwnerEmail('')
      setOwnerPassword('')
      setSuccess(`${created.name} y su cuenta OWNER se han creado correctamente.`)
      await refresh()
    })
  }

  return (
    <div className="crm-shell">
      <aside className="crm-sidebar">
        <div className="crm-brand">
          <div className="crm-brand-mark"><Crown className="h-7 w-7" /></div>
          <div><p className="crm-brand-title">CLUB POS</p><p className="crm-brand-subtitle">Superadmin</p></div>
        </div>
        <nav className="crm-nav">
          <div className="crm-nav-item crm-nav-item-active"><Building2 className="h-4 w-4" /><span>Negocios</span></div>
        </nav>
        <div className="crm-sidebar-footer">
          <button className="crm-nav-item" onClick={onLogout} type="button"><LogOut className="h-4 w-4" /><span>Cerrar sesion</span></button>
        </div>
      </aside>

      <section className="crm-workspace">
        <header className="crm-topbar">
          <div><div className="crm-breadcrumb"><Crown className="h-4 w-4" /><span>Plataforma</span></div><h1>Gestion global de tenants</h1></div>
          <div className="crm-topbar-actions">
            <div className={isOnline ? 'crm-status crm-status-online' : 'crm-status crm-status-offline'}>{isOnline ? 'Online' : 'Offline'}</div>
            <div className="crm-user-chip"><UserRound className="h-4 w-4" /><span>{context.userName}</span></div>
          </div>
        </header>

        {error ? <div className="crm-error">{error}</div> : null}
        {success ? <div className="crm-success">{success}</div> : null}
        {!isOnline ? <div className="crm-warning">La administracion global requiere conexion.</div> : null}

        <main className="crm-content">
          <div className="crm-access-layout">
            <section className="crm-panel">
              <div className="crm-panel-header"><span>Nuevo tenant y owner</span><Plus className="h-4 w-4" /></div>
              <form className="crm-form-stack" onSubmit={(event) => void handleSubmit(event)}>
                <label className="block"><span className="crm-field-label">Nombre del negocio</span><input className="crm-input" disabled={!isOnline || isBusy} onChange={(event) => { const name = event.target.value; setTenantName(name); if (!slugEdited) setTenantSlug(slugify(name)) }} required value={tenantName} /></label>
                <label className="block"><span className="crm-field-label">Slug</span><input className="crm-input" disabled={!isOnline || isBusy} onChange={(event) => { setSlugEdited(true); setTenantSlug(slugify(event.target.value)) }} pattern="[a-z0-9]+(?:[_-][a-z0-9]+)*" required value={tenantSlug} /></label>
                <label className="block"><span className="crm-field-label">Primer local</span><input className="crm-input" disabled={!isOnline || isBusy} onChange={(event) => setVenueName(event.target.value)} required value={venueName} /></label>
                <label className="block"><span className="crm-field-label">Nombre del OWNER</span><input className="crm-input" disabled={!isOnline || isBusy} onChange={(event) => setOwnerFullName(event.target.value)} required value={ownerFullName} /></label>
                <label className="block"><span className="crm-field-label">Email del OWNER</span><input className="crm-input" disabled={!isOnline || isBusy} onChange={(event) => setOwnerEmail(event.target.value)} required type="email" value={ownerEmail} /></label>
                <label className="block"><span className="crm-field-label">Contrasena inicial</span><input className="crm-input" disabled={!isOnline || isBusy} minLength={8} onChange={(event) => setOwnerPassword(event.target.value)} required type="password" value={ownerPassword} /></label>
                <button className="crm-primary-button" disabled={!isOnline || isBusy || !tenantSlug || ownerPassword.length < 8} type="submit"><Plus className="h-4 w-4" />Crear tenant y OWNER</button>
              </form>
            </section>

            <section className="crm-panel crm-access-users">
              <div className="crm-list-toolbar">
                <div className="crm-list-title"><h2>Tenants</h2><p>{tenants.length} negocios configurados</p></div>
                <button className="crm-secondary-button" disabled={!isOnline || isBusy} onClick={() => void runAction(refresh)} type="button"><RefreshCw className="h-4 w-4" />Actualizar</button>
              </div>
              <div className="crm-access-user-list">
                {tenants.map((tenant) => (
                  <div className="platform-tenant-row" key={tenant.id}>
                    <div className="crm-cell-main"><strong>{tenant.name}</strong><span>{tenant.slug}</span></div>
                    <div className="crm-cell-main"><strong>{tenant.owner?.fullName || 'Sin OWNER'}</strong><span>{tenant.owner?.email || 'Cuenta no configurada'}</span></div>
                    <span>{tenant.venueCount} locales</span>
                    <span>{dateFormatter.format(new Date(tenant.createdAt))}</span>
                    <span className={tenant.owner?.isActive ? 'crm-status-pill crm-status-pill-active' : 'crm-status-pill crm-status-pill-muted'}>{tenant.owner?.isActive ? 'Activo' : 'Pendiente'}</span>
                  </div>
                ))}
                {!tenants.length && !isBusy ? <div className="platform-empty"><Store className="h-6 w-6" /><span>Todavia no hay tenants.</span></div> : null}
              </div>
            </section>
          </div>
        </main>
      </section>
    </div>
  )
}
