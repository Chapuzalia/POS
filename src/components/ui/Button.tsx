import type { ComponentProps } from 'react'
import { cx } from '../../utils/cx'

export type ButtonProps = ComponentProps<'button'> & {
  variant?: 'primary' | 'secondary' | 'tertiary' | 'danger'
  size?: 'sm' | 'md' | 'lg'
  fullWidth?: boolean
  active?: boolean
}

export function Button({
  active = false,
  className,
  fullWidth = false,
  size = 'md',
  variant = 'tertiary',
  ...props
}: ButtonProps) {
  return (
    <button
      {...props}
      className={cx(
        'inline-flex items-center justify-center gap-2 border font-semibold transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45',
        'rounded-[var(--radius)] border-[var(--separator)]',
        size === 'sm' && 'min-h-9 px-3 py-1.5 text-sm',
        size === 'md' && 'min-h-11 px-4 py-2 text-sm',
        size === 'lg' && 'min-h-16 px-4 py-3 text-base',
        fullWidth && 'w-full',
        (variant === 'primary' || active) &&
          'border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] hover:brightness-105',
        variant === 'secondary' &&
          !active &&
          'bg-[var(--surface-secondary)] text-[var(--foreground)] hover:border-[var(--accent)]',
        variant === 'tertiary' &&
          !active &&
          'bg-[var(--surface)] text-[var(--foreground)] hover:border-[var(--accent)] hover:bg-[var(--accent-soft)]',
        variant === 'danger' &&
          'border-[var(--danger)] bg-[var(--danger)] text-white hover:brightness-105',
        className,
      )}
    />
  )
}
