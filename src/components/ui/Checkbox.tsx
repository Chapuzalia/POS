import { Checkbox as HeroCheckbox, Label } from '@heroui/react'
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
  return (
    <HeroCheckbox
      {...props}
      className={className}
      isDisabled={disabled}
      isSelected={checked}
      onChange={onChange}
    >
      <HeroCheckbox.Content>
        <HeroCheckbox.Control>
          <HeroCheckbox.Indicator />
        </HeroCheckbox.Control>
        {children ? <Label>{children}</Label> : null}
      </HeroCheckbox.Content>
    </HeroCheckbox>
  )
}