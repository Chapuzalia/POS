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
      className={`!p-2 border-0 w-full !shadow-none !outline-none !ring-0 ${className ?? ''}`}
      type={type}
    />
  )
}
