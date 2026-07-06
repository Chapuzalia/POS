import { X } from 'lucide-react'
import type { TenantContext, ThemeDefinition } from '../../types'
import { Button, Metric } from '../ui'

type ConfigModalProps = {
  context: TenantContext
  onClose: () => void
  onLogout: () => void
  pendingCount: number
  themeId: string
  themes: ThemeDefinition[]
}

export function ConfigModal({ context, onClose, onLogout, pendingCount, themeId, themes }: ConfigModalProps) {
  const theme = themes.find((item) => item.id === themeId)

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
          <Metric label="Tema" value={theme?.name ?? themeId} />
          <Metric label="Pendiente sync" value={String(pendingCount)} tone={pendingCount ? 'danger' : 'success'} />
        </div>

        <Button className="mt-5" fullWidth onClick={onLogout} type="button" variant="secondary">
          Cambiar negocio
        </Button>
      </section>
    </div>
  )
}
