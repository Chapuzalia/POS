import type { ButtonHTMLAttributes, ReactNode } from 'react'
import './catalog-ui.css'

type PanelProps = { children: ReactNode; className?: string }
type HeaderProps = { actions?: ReactNode; children?: ReactNode; description: ReactNode; title: ReactNode }
type SectionHeaderProps = { actions?: ReactNode; description?: ReactNode; title: ReactNode }

export function CatalogPanel({ children, className = '' }: PanelProps) {
  return <section className={`crm-panel crm-catalog-panel ${className}`.trim()}>{children}</section>
}

export function CatalogPanelHeader({ actions, children, description, title }: HeaderProps) {
  return (
    <header className="crm-catalog-panel-header">
      <div className="crm-catalog-panel-heading"><h2>{title}</h2><p>{description}</p></div>
      {actions ? <div className="crm-catalog-header-actions">{actions}</div> : null}
      {children ? <div className="crm-catalog-header-content">{children}</div> : null}
    </header>
  )
}

export function CatalogSectionHeader({ actions, description, title }: SectionHeaderProps) {
  return (
    <div className="crm-catalog-section-header">
      <div><h3>{title}</h3>{description ? <p>{description}</p> : null}</div>
      {actions ? <div className="crm-catalog-header-actions">{actions}</div> : null}
    </div>
  )
}

export function CatalogStatus({ active, activeLabel = 'Activo', inactiveLabel = 'Inactivo' }: { active: boolean; activeLabel?: string; inactiveLabel?: string }) {
  return <span className={`crm-status-pill ${active ? 'crm-status-pill-active' : 'crm-status-pill-inactive'}`}>{active ? activeLabel : inactiveLabel}</span>
}

export function CatalogCheckbox({ checked, children, disabled, onChange }: { checked: boolean; children: ReactNode; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <label className="crm-catalog-checkbox"><input checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} type="checkbox" /><span>{children}</span></label>
}

export function CatalogIconButton({ className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`crm-action-button ${className}`.trim()} type="button" {...props} />
}
