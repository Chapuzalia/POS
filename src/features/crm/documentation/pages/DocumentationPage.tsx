import { BookOpen, Download, FileText, type LucideIcon } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import type { TenantContext } from '../../../../types'
import { legalDocuments, userManuals, type DocumentationEntry } from '../documentationCatalog'
import { TenantDataExport } from '../TenantDataExport'

type Props = {
  canStartOnboarding: boolean
  onStartOnboarding: () => void
  tenantContext: TenantContext
}

const card = 'grid gap-4 rounded-2xl bg-[var(--crm-surface)] p-6 shadow-[var(--crm-shadow-card)] max-[700px]:p-4'

function DocumentList({ entries, icon: Icon, title, subtitle }: { entries: DocumentationEntry[]; icon: LucideIcon; title: string; subtitle: string }) {
  return (
    <section aria-label={title} className={card}>
      <div>
        <h2 className="m-0 text-lg font-bold">{title}</h2>
        <p className="m-0 mt-1 text-sm text-[var(--crm-text-muted)]">{subtitle}</p>
      </div>
      <ul className="m-0 grid list-none gap-2 p-0">
        {entries.map((entry) => (
          <li className="flex min-h-14 items-center gap-3 rounded-xl bg-[var(--crm-surface-soft)] px-4 py-3 max-[700px]:flex-wrap" key={entry.id}>
            <Icon aria-hidden="true" className="size-5 shrink-0 text-[var(--crm-blue)]" />
            <div className="min-w-0 flex-1">
              <p className="m-0 text-sm font-semibold">{entry.title}</p>
              <p className="m-0 mt-0.5 text-xs text-[var(--crm-text-muted)]">{entry.description}</p>
            </div>
            {entry.href ? (
              <a aria-label={`Descargar ${entry.title}`} className="inline-flex min-h-11 shrink-0 items-center gap-2 rounded-[10px] bg-[var(--crm-blue-soft)] px-3 text-sm font-semibold text-[var(--crm-blue)] outline-none focus-visible:outline-2 focus-visible:outline-[var(--crm-blue)]" download href={entry.href} rel="noreferrer" target="_blank">
                <Download aria-hidden="true" className="size-4" />Descargar
              </a>
            ) : (
              <span className="shrink-0 rounded-full border border-[var(--crm-border)] px-2.5 py-1 text-xs font-semibold text-[var(--crm-text-muted)]">Próximamente</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

export function DocumentationCrm({ canStartOnboarding, onStartOnboarding, tenantContext }: Props) {
  return (
    <div className="grid gap-5">
      <section aria-label="Inicio guiado" className={`${card} sm:grid-cols-[auto_1fr_auto] sm:items-center`}>
        <div className="grid size-12 place-items-center rounded-2xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]"><BookOpen aria-hidden="true" className="size-6" /></div>
        <div>
          <h2 className="m-0 text-lg font-bold">Inicio guiado</h2>
          <p className="m-0 mt-1 text-sm text-[var(--crm-text-muted)]">Recorre paso a paso cómo crear productos, configurar el stock, las mesas y los usuarios del local.</p>
        </div>
        <Button className="!min-h-11 !gap-2" disabled={!canStartOnboarding} onClick={onStartOnboarding} type="button" variant="primary">
          <BookOpen aria-hidden="true" className="size-4" />Abrir inicio guiado
        </Button>
      </section>
      {tenantContext.role === 'owner' ? <TenantDataExport key={tenantContext.tenantId} tenantId={tenantContext.tenantId} /> : null}
      <DocumentList entries={legalDocuments} icon={FileText} subtitle="Contratos y condiciones entre tu empresa y Alteil Solutions SL." title="Documentación legal" />
      <DocumentList entries={userManuals} icon={BookOpen} subtitle="Guías de uso descargables de Tickit." title="Manuales" />
    </div>
  )
}
