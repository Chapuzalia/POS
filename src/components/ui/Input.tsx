import { Input as HeroInput } from '@heroui/react'
import type { ComponentProps } from 'react'

export type InputProps = ComponentProps<'input'>

export function Input({ className, type, ...props }: InputProps) {
  if (type === 'hidden') {
    return <input {...props} className={className} type="hidden" />
  }

  const heroProps = props as unknown as ComponentProps<typeof HeroInput>

  return <HeroInput {...heroProps} className={className} type={type} />
}
