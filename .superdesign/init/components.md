# Shared UI components

## `src/components/ui/Button.tsx`

HeroUI-backed button used throughout POS, CRM, and superadmin.

```tsx
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
  primary: 'primary', secondary: 'secondary', tertiary: 'tertiary',
  danger: 'danger', dangerSoft: 'danger-soft',
} as const

export function Button({ active = false, className, disabled, fullWidth = false, size = 'md', variant = 'tertiary', ...props }: ButtonProps) {
  const heroProps = props as unknown as ComponentProps<typeof HeroButton>
  return <HeroButton {...heroProps} aria-pressed={active || props['aria-pressed']} className={className} fullWidth={fullWidth} isDisabled={disabled} size={size} variant={active ? 'primary' : variantMap[variant]} />
}
```

## `src/components/ui/Checkbox.tsx`

Controlled HeroUI checkbox used for feature assignment.

```tsx
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
    <HeroCheckbox {...props} className={className} isDisabled={disabled} isSelected={checked} onChange={onChange}>
      <HeroCheckbox.Content>
        <HeroCheckbox.Control><HeroCheckbox.Indicator /></HeroCheckbox.Control>
        {children ? <Label>{children}</Label> : null}
      </HeroCheckbox.Content>
    </HeroCheckbox>
  )
}
```

## `src/components/ui/Input.tsx`

Shared HeroUI input wrapper.

```tsx
import { Input as HeroInput } from '@heroui/react'
import type { ComponentProps } from 'react'

export type InputProps = ComponentProps<'input'>

export function Input({ className, type, ...props }: InputProps) {
  if (type === 'hidden') return <input {...props} className={className} type="hidden" />
  const heroProps = props as unknown as ComponentProps<typeof HeroInput>
  return <HeroInput {...heroProps} className={`!p-2 border-0 w-full !shadow-none !outline-none !ring-0 ${className ?? ''}`} type={type} />
}
```

## `src/components/ui/AppModal.tsx`

Shared accessible modal policy with backdrop, focus trap, and responsive container.

```tsx
import { Modal } from '@heroui/react'
import type { CSSProperties, ReactNode } from 'react'

type AppModalProps = {
  backdropClassName?: string
  children: ReactNode
  containerClassName?: string
  dialogClassName?: string
  dismissDisabled?: boolean
  label?: string
  maxWidth?: CSSProperties['maxWidth']
  onClose: () => void
  placement?: 'center' | 'bottom'
}

export function AppModal({ backdropClassName = '', children, containerClassName = '!p-3 sm:!p-6', dialogClassName = '', dismissDisabled = false, label, maxWidth = 1200, onClose, placement = 'center' }: AppModalProps) {
  return (
    <Modal isOpen onOpenChange={(isOpen) => { if (!isOpen && !dismissDisabled) onClose() }}>
      <Modal.Trigger aria-hidden="true" className="hidden" tabIndex={-1} />
      <Modal.Backdrop className={`!z-[70] !bg-black/55 ${backdropClassName}`} isDismissable={!dismissDisabled} isKeyboardDismissDisabled={dismissDisabled}>
        <Modal.Container className={`!max-w-none ${containerClassName}`} placement={placement} scroll="inside">
          <Modal.Dialog aria-label={label} className={`!w-full !max-h-[calc(100dvh-24px)] !overflow-hidden !rounded-[var(--radius)] !border !border-[var(--separator)] !bg-[var(--surface)] !p-0 !text-[var(--foreground)] !shadow-[var(--shadow)] [&>*]:!max-w-none ${dialogClassName}`} style={{ maxWidth }}>
            {children}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
```
