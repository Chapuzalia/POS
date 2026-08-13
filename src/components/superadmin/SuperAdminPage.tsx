import { Input as UiInput } from '../ui/Input'
import { Button as UiButton } from '../ui/Button'
import { Checkbox as UiCheckbox } from '../ui/Checkbox'
import { AppModal } from '../ui/AppModal'
import { Building2, Check, ChevronRight, Crown, Eye, LockKeyhole, LogOut, Menu, Pencil, Plus, Power, RefreshCw, Store, Trash2, UserRound, X } from 'lucide-react'
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  createPlatformTenant,
  deletePlatformTenant,
  loadPlatformTenants,
  setPlatformTenantActive,
  updatePlatformTenant,
  type PlatformFeature,
  type PlatformTenantFeature,
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

type TenantModalState =
  | { mode: 'create' }
  | { mode: 'details' | 'edit'; tenant: PlatformTenant }
  | null

type SuperAdminModalProps = {
  children: ReactNode
  label: string
  onClose: () => void
  size?: 'compact' | 'large'
}

function SuperAdminModal({ children, label, onClose, size = 'compact' }: SuperAdminModalProps) {
  return (
    <AppModal
      backdropClassName="crm-shell"
      containerClassName="!p-3 sm:!p-6"
      maxWidth={size === 'large' ? 820 : 560}
      dialogClassName="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !flex !max-h-[calc(100dvh-24px)] !flex-col !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] sm:!max-h-[calc(100dvh-48px)] sm:!rounded-[var(--crm-radius-lg)]"
      label={label}
      onClose={onClose}
    >
      {children}
    </AppModal>
  )
}

export function SuperAdminPage({ context, error, isOnline, onError, onLogout }: SuperAdminPageProps) {
  const [tenants, setTenants] = useState<PlatformTenant[]>([])
  const [platformFeatures, setPlatformFeatures] = useState<PlatformFeature[]>([])
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [tenantModal, setTenantModal] = useState<TenantModalState>(null)
  const [isBusy, setIsBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)
  const [tenantName, setTenantName] = useState('')
  const [tenantSlug, setTenantSlug] = useState('')
  const [slugEdited, setSlugEdited] = useState(false)
  const [venueName, setVenueName] = useState('Sala principal')
  const [ownerFullName, setOwnerFullName] = useState('')
  const [ownerEmail, setOwnerEmail] = useState('')
  const [ownerPassword, setOwnerPassword] = useState('')
  const [maxVenues, setMaxVenues] = useState(1)
  const [maxDevices, setMaxDevices] = useState(5)
  const [editingTenantName, setEditingTenantName] = useState('')
  const [editingTenantSlug, setEditingTenantSlug] = useState('')
  const [editingMaxVenues, setEditingMaxVenues] = useState(1)
  const [editingMaxDevices, setEditingMaxDevices] = useState(5)
  const [editingTenantFeatures, setEditingTenantFeatures] = useState<PlatformTenantFeature[]>([])

  const refresh = useCallback(async () => {
    const platform = await loadPlatformTenants()
    setTenants(platform.tenants)
    setPlatformFeatures(platform.features)
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

  useEffect(() => {
    if (!isSidebarOpen) return undefined

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSidebarOpen(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isSidebarOpen])

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
        maxDevices,
        maxVenues,
      })
      setTenantName('')
      setTenantSlug('')
      setSlugEdited(false)
      setVenueName('Sala principal')
      setOwnerFullName('')
      setOwnerEmail('')
      setOwnerPassword('')
      setTenantModal(null)
      setSuccess(`${created.name} y su cuenta OWNER se han creado correctamente.`)
      await refresh()
    })
  }

  function openCreateModal() {
    setTenantName('')
    setTenantSlug('')
    setSlugEdited(false)
    setVenueName('Sala principal')
    setOwnerFullName('')
    setOwnerEmail('')
    setOwnerPassword('')
    setMaxVenues(1)
    setMaxDevices(5)
    setTenantModal({ mode: 'create' })
  }

  function openEditModal(tenant: PlatformTenant) {
    setEditingTenantName(tenant.name)
    setEditingTenantSlug(tenant.slug)
    setEditingMaxVenues(tenant.limits.venues)
    setEditingMaxDevices(tenant.limits.devices)
    setEditingTenantFeatures(Array.isArray(tenant.features) ? tenant.features : [])
    setTenantModal({ mode: 'edit', tenant })
  }

  function setEditingFeature(feature: PlatformTenantFeature, enabled: boolean) {
    setEditingTenantFeatures((current) => {
      const next = new Set(current)
      if (enabled) next.add(feature)
      else next.delete(feature)
      return platformFeatures.filter((candidate) => !candidate.isCore && next.has(candidate.key)).map((candidate) => candidate.key)
    })
  }

  async function handleUpdateTenant(event: FormEvent<HTMLFormElement>, tenant: PlatformTenant) {
    event.preventDefault()
    await runAction(async () => {
      await updatePlatformTenant({
        tenantId: tenant.id,
        tenantName: editingTenantName.trim(),
        tenantSlug: editingTenantSlug.trim(),
        maxDevices: editingMaxDevices,
        maxVenues: editingMaxVenues,
        features: editingTenantFeatures,
      })
      await refresh()
      setTenantModal(null)
      setSuccess(`${editingTenantName.trim()} se ha actualizado correctamente.`)
    })
  }

  async function toggleTenant(tenant: PlatformTenant) {
    const nextActive = !tenant.isActive
    if (!window.confirm(`¿${nextActive ? 'Activar' : 'Desactivar'} el negocio "${tenant.name}"?`)) return

    await runAction(async () => {
      await setPlatformTenantActive(tenant.id, nextActive)
      await refresh()
      setSuccess(`${tenant.name} se ha ${nextActive ? 'activado' : 'desactivado'} correctamente.`)
    })
  }

  async function removeTenant(tenant: PlatformTenant) {
    if (!window.confirm(`¿Eliminar "${tenant.name}" de forma permanente? Se borrarán todos sus locales, productos, ventas y usuarios exclusivos. Esta acción no se puede deshacer.`)) return

    await runAction(async () => {
      await deletePlatformTenant(tenant.id)
      await refresh()
      setTenantModal(null)
      setSuccess(`${tenant.name} se ha eliminado definitivamente.`)
    })
  }

  const inputClassName = 'h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150'
  const coreFeatures = platformFeatures.filter((feature) => feature.isCore)
  const optionalFeatures = platformFeatures.filter((feature) => !feature.isCore)

  return (
    <div className="crm-shell !flex !h-full !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased">
      <UiButton
        aria-label="Cerrar menú de navegación"
        className={isSidebarOpen
          ? '!fixed !inset-0 !z-[39] !block !border-0 !bg-[rgba(0,0,0,0.52)] !opacity-100 !transition-opacity !duration-200 xl:!hidden'
          : '!pointer-events-none !fixed !inset-0 !z-[39] !block !border-0 !bg-[rgba(0,0,0,0.52)] !opacity-0 !transition-opacity !duration-200 xl:!hidden'}
        onClick={() => setIsSidebarOpen(false)}
        tabIndex={isSidebarOpen ? 0 : -1}
        type="button"
      />

      <aside
        className={isSidebarOpen
          ? '!fixed !top-0 !bottom-0 !left-0 !z-40 !flex !h-full !w-[min(88vw,var(--crm-sidebar-width))] !min-w-[min(88vw,var(--crm-sidebar-width))] !translate-x-0 !flex-col !overflow-y-auto !border-r !border-[var(--crm-border-subtle)] !bg-[var(--crm-sidebar-bg)] !px-5 !pt-6 !pb-[18px] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] !transition-transform !duration-200 xl:!relative xl:!w-[var(--crm-sidebar-width)] xl:!min-w-[var(--crm-sidebar-width)] xl:!translate-x-0 xl:!shadow-none'
          : '!fixed !top-0 !bottom-0 !left-0 !z-40 !flex !h-full !w-[min(88vw,var(--crm-sidebar-width))] !min-w-[min(88vw,var(--crm-sidebar-width))] !-translate-x-[102%] !flex-col !overflow-y-auto !border-r !border-[var(--crm-border-subtle)] !bg-[var(--crm-sidebar-bg)] !px-5 !pt-6 !pb-[18px] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] !transition-transform !duration-200 xl:!relative xl:!w-[var(--crm-sidebar-width)] xl:!min-w-[var(--crm-sidebar-width)] xl:!translate-x-0 xl:!shadow-none'}
        id="superadmin-sidebar"
      >
        <div className="!grid !min-h-11 !grid-cols-[40px_minmax(0,1fr)] !items-center !justify-stretch !gap-[11px] !border-0 !p-0">
          <div className="!grid !size-10 !place-items-center !rounded-[10px] !border !border-[var(--crm-border)] !bg-[var(--crm-surface)] !text-[var(--crm-blue)]">
            <Crown className="size-5 stroke-[1.8]" />
          </div>
          <div>
            <p className="!m-0 !block !overflow-hidden !text-ellipsis !whitespace-nowrap !text-sm !leading-tight !font-semibold !text-[var(--crm-text)]">TICKIT</p>
            <p className="!mt-0.5 !mb-0 !block !overflow-hidden !text-ellipsis !whitespace-nowrap !text-[11px] !font-medium !text-[var(--crm-text-muted)]">Superadmin</p>
          </div>
        </div>

        <nav aria-label="Navegación del Superadmin" className="!mt-[30px] !flex !flex-col !gap-[5px]">
          <p className="!mx-0 !mt-0 !mb-[7px] !ml-[3px] !text-[11px] !font-medium !text-[var(--crm-text-muted)]">Menú principal</p>
          <UiButton
            aria-current="page"
            className="!flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !shadow-none"
            onClick={() => setIsSidebarOpen(false)}
            type="button"
          >
            <Building2 className="h-4 w-4" />
            <span>Negocios</span>
          </UiButton>
        </nav>

        <div className="!mt-auto !grid !gap-[5px] !border-0 !pt-7">
          <UiButton className="!flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !bg-transparent !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none" onClick={onLogout} type="button">
            <LogOut className="h-4 w-4" />
            <span>Cerrar sesión</span>
          </UiButton>
        </div>
      </aside>

      <section className="!flex !min-h-0 !min-w-0 !flex-1 !flex-col !overflow-hidden !bg-[var(--crm-canvas)]">
        <header className="!relative !z-30 !flex !min-h-16 [.pwa-standalone_&]:!pt-[calc(0.625rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!min-h-[calc(5rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!basis-[calc(5rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!pt-[env(safe-area-inset-top,0px)] !w-full !flex-[0_0_auto] !flex-row !items-center !justify-between !gap-2.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-topbar-bg)] !px-4 !py-2.5 md:!min-h-20 md:!flex-[0_0_80px] md:!gap-[22px] md:!px-7 md:!py-0">
          <UiButton
            aria-controls="superadmin-sidebar"
            aria-expanded={isSidebarOpen}
            aria-label="Abrir menú de navegación"
            className="!inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface)] !text-[var(--crm-text-secondary)] !shadow-none xl:!hidden"
            onClick={() => setIsSidebarOpen(true)}
            type="button"
          >
            <Menu className="h-5 w-5" />
          </UiButton>

          <div className="!mr-auto !min-w-0 md:!min-w-[180px]">
            <div className="!hidden !items-center !gap-1.5 !text-[11px] !font-medium !text-[var(--crm-text-muted)] md:!flex">
              <Crown className="size-3.5" />
              <span>Plataforma</span>
              <ChevronRight className="size-3.5" />
              <span>Negocios</span>
            </div>
            <h1 className="!mt-0 !min-h-0 !overflow-hidden !text-[17px] !leading-tight !font-bold !tracking-[-0.025em] !text-ellipsis !whitespace-nowrap !text-[var(--crm-text)] md:!mt-1 md:!text-xl">Gestión global de negocios</h1>
          </div>

          <div className="!flex !w-auto !min-w-0 !items-center !justify-end !gap-2.5 !overflow-visible">
            <div className={isOnline
              ? '!hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-green-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-green)] sm:!inline-flex'
              : '!hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-red-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-red)] sm:!inline-flex'}>
              {isOnline ? 'Online' : 'Offline'}
            </div>
            <div className="!hidden !min-h-[42px] !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-xs !font-medium !whitespace-nowrap !text-[var(--crm-text-secondary)] md:!inline-flex">
              <UserRound className="h-4 w-4" />
              <span>{context.userName}</span>
            </div>
          </div>
        </header>

        {error ? <div className="!mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-red-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-red)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">{error}</div> : null}
        {success ? <div className="!mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-green-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-green)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">{success}</div> : null}
        {!isOnline ? <div className="!mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-yellow-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-yellow)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">La administración global requiere conexión.</div> : null}

        <main className="!mx-auto !min-h-0 !w-full !max-w-[1720px] !flex-1 !overflow-auto !px-4 !pt-[26px] !pb-7 md:!px-7 md:!pt-[42px] md:!pb-9">
          <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !w-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
            <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 sm:!flex-row sm:!items-center md:!px-[22px]">
              <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]"><h2>Negocios</h2><p>{tenants.length} tenants configurados</p></div>
              <div className="!flex !items-center !justify-end !gap-2">
                <UiButton aria-label="Actualizar negocios" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)] !shadow-none" disabled={!isOnline || isBusy} onClick={() => void runAction(refresh)} title="Actualizar" type="button"><RefreshCw className="h-4 w-4" /></UiButton>
                <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none" disabled={!isOnline || isBusy} onClick={openCreateModal} type="button"><Plus className="h-4 w-4" />Nuevo negocio</UiButton>
              </div>
            </div>

            <div className="!w-full !overflow-x-auto">
              <div className="!min-w-[1120px]">
                <div className="!grid !grid-cols-[minmax(170px,1fr)_minmax(220px,1.2fr)_75px_80px_95px_100px_200px] !items-center !gap-3 !border-b !border-[var(--crm-border)] !bg-[var(--crm-surface-soft)] !px-[22px] !py-3 !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
                  <span>Negocio</span><span>Propietario</span><span>Locales</span><span>Usuarios</span><span>Estado</span><span>Alta</span><span className="!text-right">Acciones</span>
                </div>
                {tenants.map((tenant) => (
                  <div className="!grid !min-h-[76px] !grid-cols-[minmax(170px,1fr)_minmax(220px,1.2fr)_75px_80px_95px_100px_200px] !items-center !gap-3 !border-b !border-[var(--crm-border)] !px-[22px] !py-3 !text-xs !font-medium !text-[var(--crm-text-secondary)] last:!border-b-0" key={tenant.id}>
                    <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]"><strong>{tenant.name}</strong><span>{tenant.slug}</span></div>
                    <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]"><strong>{tenant.owner?.fullName || 'Sin OWNER'}</strong><span>{tenant.owner?.email || 'Cuenta no configurada'}</span></div>
                    <span>{tenant.venueCount}</span>
                    <span>{tenant.memberCount}</span>
                    <span className={tenant.isActive
                      ? 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-green-soft)] text-[var(--crm-green)] !inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]'
                      : 'inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold bg-[var(--crm-surface-soft)] text-[var(--crm-text-muted)] !inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-red-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-red)]'}>{tenant.isActive ? 'Activo' : 'Inactivo'}</span>
                    <span>{dateFormatter.format(new Date(tenant.createdAt))}</span>
                    <div className="!flex !items-center !justify-end !gap-1.5">
                      <UiButton aria-label={`Ver detalles de ${tenant.name}`} className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-secondary)]" onClick={() => setTenantModal({ mode: 'details', tenant })} title="Ver detalles" type="button"><Eye className="!size-4" /></UiButton>
                      <UiButton aria-label={`Editar ${tenant.name}`} className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-secondary)]" disabled={!isOnline || isBusy} onClick={() => openEditModal(tenant)} title="Editar" type="button"><Pencil className="!size-4" /></UiButton>
                      <UiButton aria-label={`${tenant.isActive ? 'Desactivar' : 'Activar'} ${tenant.name}`} className={tenant.isActive ? 'inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-yellow-soft)] !p-0 !text-[var(--crm-yellow)]' : 'inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-green-soft)] !p-0 !text-[var(--crm-green)]'} disabled={!isOnline || isBusy} onClick={() => void toggleTenant(tenant)} title={tenant.isActive ? 'Desactivar' : 'Activar'} type="button"><Power className="!size-4" /></UiButton>
                      <UiButton aria-label={`Eliminar ${tenant.name}`} className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95 !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-red-soft)] !p-0 !text-[var(--crm-red)]" disabled={!isOnline || isBusy} onClick={() => void removeTenant(tenant)} title="Eliminar" type="button"><Trash2 className="!size-4" /></UiButton>
                    </div>
                  </div>
                ))}
                {!tenants.length && !isBusy ? <div className="!grid !min-h-[260px] !place-items-center !content-center !gap-2 !text-[13px] !font-medium !text-[var(--crm-text-muted)]"><Store className="h-6 w-6" /><span>Todavía no hay negocios.</span></div> : null}
              </div>
            </div>
          </section>
        </main>
      </section>

      {tenantModal?.mode === 'create' ? (
        <SuperAdminModal label="Crear nuevo negocio" onClose={() => setTenantModal(null)} size="large">
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4 sm:!px-6">
            <div><h2 className="!m-0 !text-lg !font-bold">Nuevo negocio</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Crea el tenant, su primer local y la cuenta propietaria.</p></div>
            <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={() => setTenantModal(null)} type="button"><X className="!size-4" /></UiButton>
          </div>
          <form className="!grid !min-h-0 !grid-cols-1 !gap-4 !overflow-y-auto !px-5 !py-5 sm:!grid-cols-2 sm:!px-6" onSubmit={(event) => void handleSubmit(event)}>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Nombre del negocio</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} onChange={(event) => { const name = event.target.value; setTenantName(name); if (!slugEdited) setTenantSlug(slugify(name)) }} required value={tenantName} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Slug</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} onChange={(event) => { setSlugEdited(true); setTenantSlug(slugify(event.target.value)) }} pattern="[a-z0-9]+(?:(?:_|-)[a-z0-9]+)*" required value={tenantSlug} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Primer local</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} onChange={(event) => setVenueName(event.target.value)} required value={venueName} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Nombre del OWNER</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} onChange={(event) => setOwnerFullName(event.target.value)} required value={ownerFullName} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Email del OWNER</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} onChange={(event) => setOwnerEmail(event.target.value)} required type="email" value={ownerEmail} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Contraseña inicial</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} minLength={8} onChange={(event) => setOwnerPassword(event.target.value)} required type="password" value={ownerPassword} /></label>
            <fieldset className="!col-span-full !grid !grid-cols-1 !gap-3 !rounded-[12px] !border-0 !bg-[var(--crm-surface-soft)] !p-4 sm:!grid-cols-2">
              <legend className="!mb-2 !px-1 !text-xs !font-bold">Límites del plan</legend>
              <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Locales</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} min={1} onChange={(event) => setMaxVenues(Number(event.target.value))} required type="number" value={maxVenues} /></label>
              <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Dispositivos</span><UiInput className={inputClassName} disabled={!isOnline || isBusy} min={0} onChange={(event) => setMaxDevices(Number(event.target.value))} required type="number" value={maxDevices} /></label>
            </fieldset>
            <div className="!col-span-full !flex !justify-end !gap-2 !border-t !border-[var(--crm-border)] !pt-4">
              <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text)]" onClick={() => setTenantModal(null)} type="button">Cancelar</UiButton>
              <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={!isOnline || isBusy || !tenantSlug || ownerPassword.length < 8} type="submit"><Plus className="!size-4" />Crear negocio</UiButton>
            </div>
          </form>
        </SuperAdminModal>
      ) : null}

      {tenantModal?.mode === 'edit' ? (
        <SuperAdminModal label={`Editar ${tenantModal.tenant.name}`} onClose={() => setTenantModal(null)} size="large">
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4">
            <div><h2 className="!m-0 !text-lg !font-bold">Editar negocio</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Actualiza sus datos, límites del plan y módulos disponibles.</p></div>
            <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={() => setTenantModal(null)} type="button"><X className="!size-4" /></UiButton>
          </div>
          <form className="!grid !min-h-0 !gap-4 !overflow-y-auto !px-5 !py-5 sm:!grid-cols-2 sm:!px-6" onSubmit={(event) => void handleUpdateTenant(event, tenantModal.tenant)}>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Nombre del negocio</span><UiInput className={inputClassName} disabled={isBusy} onChange={(event) => setEditingTenantName(event.target.value)} required value={editingTenantName} /></label>
            <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[11px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Slug</span><UiInput className={inputClassName} disabled={isBusy} onChange={(event) => setEditingTenantSlug(slugify(event.target.value))} pattern="[a-z0-9]+(?:(?:_|-)[a-z0-9]+)*" required value={editingTenantSlug} /></label>
            <fieldset className="!col-span-full !grid !grid-cols-2 !gap-3 !rounded-[12px] !border-0 !bg-[var(--crm-surface-soft)] !p-4">
              <legend className="!mb-2 !px-1 !text-xs !font-bold">Límites del plan</legend>
              <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[10px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Locales</span><UiInput className={inputClassName} disabled={isBusy} min={tenantModal.tenant.venueCount} onChange={(event) => setEditingMaxVenues(Number(event.target.value))} required type="number" value={editingMaxVenues} /></label>
              <label className="block"><span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !text-[10px] !font-semibold !normal-case !text-[var(--crm-text-secondary)]">Dispositivos</span><UiInput className={inputClassName} disabled={isBusy} min={tenantModal.tenant.deviceCount} onChange={(event) => setEditingMaxDevices(Number(event.target.value))} required type="number" value={editingMaxDevices} /></label>
            </fieldset>
            <section className="!col-span-full !grid !gap-3" aria-labelledby="tenant-features-heading">
              <div>
                <h3 className="!m-0 !text-sm !font-bold" id="tenant-features-heading">Features del negocio</h3>
                <p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">El núcleo está siempre incluido. Activa los módulos adicionales contratados.</p>
              </div>
              <div className="!overflow-hidden !rounded-[14px] !border !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)]">
                <div className="!border-b !border-[var(--crm-border-subtle)] !p-4">
                  <div className="!mb-3 !flex !items-center !gap-2">
                    <span className="!grid !size-7 !place-items-center !rounded-lg !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]"><LockKeyhole className="!size-3.5" /></span>
                    <div><strong className="!block !text-xs">Núcleo básico</strong><span className="!text-[10px] !font-semibold !text-[var(--crm-green)]">Siempre incluido</span></div>
                  </div>
                  <div className="!flex !flex-wrap !gap-1.5">{coreFeatures.map((feature) => <span className="!inline-flex !items-center !gap-1 !rounded-full !bg-[var(--crm-surface)] !px-2.5 !py-1.5 !text-[10px] !font-semibold !text-[var(--crm-text-secondary)]" key={feature.key}><Check className="!size-3 !text-[var(--crm-green)]" />{feature.name}</span>)}</div>
                </div>
                <div className="!bg-[var(--crm-surface)]">
                  <div className="!flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-4 !py-3">
                    <span className="!text-[11px] !font-bold !uppercase !tracking-[0.08em] !text-[var(--crm-text-secondary)]">Módulos opcionales</span>
                    <span className="!shrink-0 !rounded-md !bg-[var(--crm-blue-soft)] !px-2 !py-1 !text-[10px] !font-bold !text-[var(--crm-blue)]">{editingTenantFeatures.length} de {optionalFeatures.length} activos</span>
                  </div>
                  <div className="!grid sm:!grid-cols-2">
                    {optionalFeatures.map((feature) => (
                      <UiCheckbox
                        aria-label={feature.name}
                        checked={editingTenantFeatures.includes(feature.key)}
                        className="!min-h-[70px] !items-start !rounded-none !border-0 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface)] !px-4 !py-3.5 !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)] data-[selected=true]:!bg-[var(--crm-surface)] last:!border-b-0 sm:[&:nth-child(odd)]:!border-r sm:[&:nth-last-child(-n+2)]:!border-b-0"
                        disabled={isBusy}
                        key={feature.key}
                        onChange={(enabled) => setEditingFeature(feature.key, enabled)}
                      >
                        <span className="!grid !gap-0.5"><strong className="!text-[13px] !font-semibold !text-[var(--crm-text)]">{feature.name}</strong><span className="!text-[11px] !font-medium !leading-snug !text-[var(--crm-text-muted)]">{feature.description}</span></span>
                      </UiCheckbox>
                    ))}
                  </div>
                </div>
              </div>
            </section>
            <div className="!col-span-full !flex !justify-end !gap-2 !border-t !border-[var(--crm-border)] !pt-4">
              <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text)]" onClick={() => setTenantModal(null)} type="button">Cancelar</UiButton>
              <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={isBusy || !editingTenantName.trim() || !editingTenantSlug} type="submit"><Pencil className="!size-4" />Guardar cambios</UiButton>
            </div>
          </form>
        </SuperAdminModal>
      ) : null}

      {tenantModal?.mode === 'details' ? (
        <SuperAdminModal label={`Detalles de ${tenantModal.tenant.name}`} onClose={() => setTenantModal(null)} size="large">
          <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border)] !px-5 !py-4 sm:!px-6">
            <div><h2 className="!m-0 !text-lg !font-bold">{tenantModal.tenant.name}</h2><p className="!mt-1 !mb-0 !text-xs !text-[var(--crm-text-muted)]">Información general del negocio</p></div>
            <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" onClick={() => setTenantModal(null)} type="button"><X className="!size-4" /></UiButton>
          </div>
          <div className="!grid !min-h-0 !gap-5 !overflow-y-auto !px-5 !py-5 sm:!px-6">
            <div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2 lg:!grid-cols-4">
              {[
                ['Estado', tenantModal.tenant.isActive ? 'Activo' : 'Inactivo'],
                ['Slug', tenantModal.tenant.slug],
                ['Usuarios', String(tenantModal.tenant.memberCount)],
                ['Fecha de alta', dateFormatter.format(new Date(tenantModal.tenant.createdAt))],
              ].map(([label, value]) => <div className="!grid !gap-1 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3" key={label}><span className="!text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">{label}</span><strong className="!text-[13px]">{value}</strong></div>)}
            </div>
            <div className="!grid !gap-2"><h3 className="!m-0 !text-sm !font-bold">Propietario</h3><div className="!grid !gap-1 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-4"><strong className="!text-[13px]">{tenantModal.tenant.owner?.fullName || 'Sin OWNER'}</strong><span className="!text-xs !text-[var(--crm-text-muted)]">{tenantModal.tenant.owner?.email || 'Cuenta no configurada'}</span></div></div>
            <div className="!grid !gap-2"><h3 className="!m-0 !text-sm !font-bold">Límites del plan</h3><div className="!grid !grid-cols-1 !gap-3 sm:!grid-cols-2">{[
              ['Locales', tenantModal.tenant.venueCount, tenantModal.tenant.limits.venues],
              ['Dispositivos', tenantModal.tenant.deviceCount, tenantModal.tenant.limits.devices],
            ].map(([label, usage, limit]) => <div className="!grid !gap-1 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3" key={String(label)}><span className="!text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">{label}</span><strong className="!text-lg">{usage} / {limit}</strong></div>)}</div></div>
            <div className="!grid !gap-2"><h3 className="!m-0 !text-sm !font-bold">Locales ({tenantModal.tenant.venueCount})</h3><div className="!grid !gap-2 sm:!grid-cols-2">{tenantModal.tenant.venues.map((venue) => <div className="!flex !items-center !justify-between !gap-3 !rounded-[10px] !bg-[var(--crm-surface-soft)] !p-3" key={venue.id}><span className="!text-[13px] !font-semibold">{venue.name}</span><span className={venue.isActive ? '!text-[11px] !font-semibold !text-[var(--crm-green)]' : '!text-[11px] !font-semibold !text-[var(--crm-text-muted)]'}>{venue.isActive ? 'Activo' : 'Inactivo'}</span></div>)}{!tenantModal.tenant.venues.length ? <p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">No hay locales configurados.</p> : null}</div></div>
            <div className="!flex !justify-between !gap-3 !border-t !border-[var(--crm-border)] !pt-4"><code className="!self-center !text-[10px] !text-[var(--crm-text-muted)]">ID: {tenantModal.tenant.id}</code><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text)]" onClick={() => setTenantModal(null)} type="button">Cerrar</UiButton></div>
          </div>
        </SuperAdminModal>
      ) : null}
    </div>
  )
}
