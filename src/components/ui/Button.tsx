import { Button as HeroButton } from '@heroui/react'
import type { ComponentProps } from 'react'

export type ButtonProps = Omit<ComponentProps<'button'>, 'disabled'> & {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger' | 'dangerSoft'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  active?: boolean
  disabled?: boolean
}

const variantMap = {
  primary: 'primary',
  secondary: 'secondary',
  tertiary: 'tertiary',
  danger: 'danger',
  dangerSoft: 'danger-soft',
} as const

export function Button({
  active = false,
  className,
  disabled,
  fullWidth = false,
  size = 'md',
  variant = 'tertiary',
  ...props
}: ButtonProps) {
  const heroProps = props as unknown as ComponentProps<typeof HeroButton>

  return (
    <HeroButton
      {...heroProps}
      aria-pressed={active || props['aria-pressed']}
      className={className}
      fullWidth={fullWidth}
      isDisabled={disabled}
      size={size}
      variant={active ? 'primary' : variantMap[variant]}
    />
  )
}
