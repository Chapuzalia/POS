import { ArrowLeft, LayoutList, Palette, Printer, RefreshCw, X } from 'lucide-react'
import { useState } from 'react'
import type { CatalogStartTab, TenantContext, ThemeDefinition } from '../../types'
import { PrintAgentSettings } from '../../features/local-printing'
import { Button, Metric } from '../ui'

type ConfigModalProps = {
  catalogStartTab: CatalogStartTab
  context: TenantContext
  lastSyncError: string | null
  onCatalogStartTabChange: (startTab: CatalogStartTab) => void
  onClose: () => void
  onLogout: () => void
  onRetrySync: () => void
  onThemeChange: (themeId: string) => void
  pendingCount: number
  themeId: string
  themes: ThemeDefinition[]
}

export function ConfigModal({
  catalogStartTab,
  context,
  lastSyncError,
  onCatalogStartTabChange,
  onClose,
  onLogout,
  onRetrySync,
  onThemeChange,
  pendingCount,
  themeId,
  themes,
}: ConfigModalProps) {
  const [section, setSection] = useState<'general' | 'printing'>('general')
  const theme = themes.find((item) => item.id === themeId)
  const canManageHardware = context.canManageCash === true || ['manager', 'admin', 'owner', 'superadmin'].includes(context.role)

  if (section === 'printing') {
    return (
      <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/55 sm:items-center sm:p-4">
        <section className="flex max-h-[100svh] w-full flex-col bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)] sm:max-h-[94svh] sm:max-w-5xl sm:rounded-[var(--radius)] sm:border sm:border-[var(--separator)]">
          <div className="flex items-center justify-between gap-3 border-b border-[var(--separator)] p-4">
            <Button onClick={() => setSection('general')} size="sm" type="button" variant="tertiary"><ArrowLeft className="h-4 w-4" />Ajustes</Button>
            <Button onClick={onClose} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-5"><PrintAgentSettings canConfigure={canManageHardware} canOpenDrawer={canManageHardware} /></div>
        </section>
      </div>
    )
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <section className="w-full max-w-xl rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">Configuracion</h2>
            <p className="text-sm text-[var(--muted)]">Contexto local de este TPV.</p>
          </div>
          <Button onClick={onClose} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Metric label="Negocio" value={context.tenantName} />
          <Metric label="Local" value={context.venueName} />
          <Metric label="Dispositivo" value={context.deviceName} />
          <Metric label="Usuario" value={context.userName} />
          <Metric label="Pendiente sync" value={String(pendingCount)} tone={pendingCount ? 'danger' : 'success'} />
        </div>

        <button className="mt-5 flex min-h-14 w-full items-center justify-between rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] px-4 text-left transition hover:border-[var(--accent)]" onClick={() => setSection('printing')} type="button">
          <span className="flex items-center gap-3"><Printer className="h-5 w-5 text-[var(--accent)]" /><span><strong className="block">Hardware · Impresion</strong><small className="text-[var(--muted)]">Agente local, impresoras, cajon y diagnostico</small></span></span>
          <span aria-hidden="true">›</span>
        </button>

        {lastSyncError ? (
          <div className="mt-4 rounded-[var(--radius)] border border-red-400/45 bg-red-500/10 p-3 text-sm">
            <p className="font-bold text-red-600 dark:text-red-300">Error de sincronizacion</p>
            <p className="mt-1 break-words text-[var(--foreground)]">{lastSyncError}</p>
            <Button className="mt-3" onClick={onRetrySync} size="sm" type="button" variant="secondary">
              <RefreshCw className="h-4 w-4" />
              Reintentar ahora
            </Button>
          </div>
        ) : null}

        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <label className="mt-5 block">
            <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--muted)]">
              <Palette className="h-4 w-4" />
              Tema
            </span>
            <select
              className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 font-semibold text-[var(--field-foreground)] outline-none"
              onChange={(event) => onThemeChange(event.target.value)}
              value={theme?.id ?? themeId}
            >
              {themes.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="mt-5 block">
            <span className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--muted)]">
              <LayoutList className="h-4 w-4" />
              Primera pestana del catalogo
            </span>
            <select
              className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 font-semibold text-[var(--field-foreground)] outline-none"
              onChange={(event) => onCatalogStartTabChange(event.target.value as CatalogStartTab)}
              value={catalogStartTab}
            >
              <option value="all">Todo</option>
              <option value="top">Top items</option>
            </select>
          </label>
        </div>

        <Button className="mt-5" fullWidth onClick={onLogout} type="button" variant="secondary">
          Cambiar negocio
        </Button>
      </section>
    </div>
  )
}
