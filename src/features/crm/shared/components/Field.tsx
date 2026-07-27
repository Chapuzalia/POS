import { type ReactNode } from 'react'

export type FieldProps = {
  children: ReactNode
  className?: string
  label: string
}

export function Field({ children, className, label }: FieldProps) {
  return (
    <label className={className ? `block ${className}` : 'block'}>
      <span className="mb-[5px] block text-[11px] font-bold uppercase text-[var(--crm-text-secondary)] !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">{label}</span>
      {children}
    </label>
  )
}
