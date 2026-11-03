import type { ReactNode } from 'react'

type CheckboxProps = {
  'aria-label'?: string
  checked: boolean
  children?: ReactNode
  className?: string
  disabled?: boolean
  onChange: (checked: boolean) => void
}

export function Checkbox({ children, checked, className, disabled, onChange, ...props }: CheckboxProps) {
  return <label className={`!inline-flex !min-h-11 !items-center !gap-2 !text-sm !font-medium ${disabled ? '!cursor-default !opacity-50' : '!cursor-pointer'} ${className ?? ''}`}>
    <input {...props} type="checkbox" checked={checked} disabled={disabled} onChange={event => onChange(event.currentTarget.checked)} className="!h-5 !w-5 !shrink-0 !cursor-inherit !accent-[var(--crm-blue,var(--accent))] focus-visible:!outline-2 focus-visible:!outline-offset-2 focus-visible:!outline-[var(--crm-blue,var(--accent))]" />
    {children ? <span>{children}</span> : null}
  </label>
}
