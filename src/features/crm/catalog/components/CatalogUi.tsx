import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Button as UiButton } from '../../../../components/ui/Button'
import type { ButtonHTMLAttributes, ReactNode } from 'react'

type PanelProps = { children: ReactNode; className?: string }
type HeaderProps = { actions?: ReactNode; children?: ReactNode; description: ReactNode; title: ReactNode }
type SectionHeaderProps = { actions?: ReactNode; description?: ReactNode; title: ReactNode }

export function CatalogPanel({ children, className = '' }: PanelProps) {
  return <section className={`min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] ${className}`.trim()}>{children}</section>
}

export function CatalogPanelHeader({ actions, children, description, title }: HeaderProps) {
  return (
    <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-[var(--crm-border-subtle)] px-[22px] py-5 max-[640px]:grid-cols-1 max-[640px]:p-[18px]">
      <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:leading-[1.45] [&_p]:text-[var(--crm-text-muted)]"><h2>{title}</h2><p>{description}</p></div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-[640px]:justify-start max-[640px]:[&>button]:flex-1 max-[640px]:[&>label]:flex-1">{actions}</div> : null}
      {children ? <div className="col-span-full grid min-w-0 gap-2.5">{children}</div> : null}
    </header>
  )
}

export function CatalogSectionHeader({ actions, description, title }: SectionHeaderProps) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-4 [&_h3]:m-0 [&_h3]:text-[15px] [&_h3]:font-bold [&_h3]:tracking-[-0.012em] [&_h3]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:leading-[1.45] [&_p]:text-[var(--crm-text-muted)]">
      <div><h3>{title}</h3>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 max-[640px]:justify-start max-[640px]:[&>button]:flex-1 max-[640px]:[&>label]:flex-1">{actions}</div> : null}
    </div>
  )
}

export function CatalogStatus({ active, activeLabel = 'Activo', inactiveLabel = 'Inactivo' }: { active: boolean; activeLabel?: string; inactiveLabel?: string }) {
  return <span className={`inline-flex min-h-6 w-fit items-center whitespace-nowrap rounded-full px-[9px] text-[11px] font-semibold ${active ? 'bg-[var(--crm-green-soft)] text-[var(--crm-green)]' : 'bg-[var(--crm-red-soft)] text-[var(--crm-red)]'}`}>{active ? activeLabel : inactiveLabel}</span>
}

export function CatalogCheckbox({ checked, children, disabled, onChange }: { checked: boolean; children: ReactNode; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <UiCheckbox checked={checked} className="inline-flex min-h-9 w-fit cursor-pointer items-center gap-[9px] text-[13px] font-medium text-[var(--crm-text-secondary)]" disabled={disabled} onChange={onChange}>{children}</UiCheckbox>
}

export function CatalogIconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <UiButton className={`inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] ${className}`.trim()} type="button" {...props} />
}
