import { Input as HeroInput } from '@heroui/react'
import type { ComponentProps } from 'react'

export type InputProps = ComponentProps<'input'>

export function Input({ className, type, ...props }: InputProps) {
  if (type === 'hidden') {
    return <input {...props} className={className} type="hidden" />
  }

  const heroProps = props as unknown as ComponentProps<typeof HeroInput>

  return (
    <HeroInput
      {...heroProps}
      className={`!w-full !border !border-[var(--crm-input-border,var(--separator))] !bg-[var(--crm-input-bg,var(--surface-secondary))] !p-2 !text-[var(--crm-text,var(--foreground))] !shadow-none !outline-none !ring-0 placeholder:!text-[var(--crm-text-muted,var(--muted))] focus:!border-[var(--crm-blue,var(--accent))] ${className ?? ''}`}
      type={type}
    />
  )
}
