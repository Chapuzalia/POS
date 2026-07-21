import { createPortal } from 'react-dom'
import { type ReactNode, useEffect, useRef } from 'react'

export type CrmModalProps = {
  children: ReactNode
  label: string
  onClose: () => void
  size?: 'compact' | 'large'
}

const crmModalWidths = {
  compact: '!max-w-[520px]',
  large: '!max-w-[820px]',
} as const

export function CrmModal({ children, label, onClose, size = 'compact' }: CrmModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const modalRoot = document.querySelector<HTMLElement>('.crm-shell') ?? document.body
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleModalKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusableElements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ))
        const firstElement = focusableElements[0]
        const lastElement = focusableElements.at(-1)

        if (!firstElement || !lastElement) {
          event.preventDefault()
        } else if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault()
          lastElement.focus()
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault()
          firstElement.focus()
        }
      }
    }

    window.addEventListener('keydown', handleModalKeyboard)
    return () => {
      window.removeEventListener('keydown', handleModalKeyboard)
      previouslyFocused?.focus()
    }
  }, [])

  return createPortal(
    <div
      className="!fixed !inset-0 !z-[80] !grid !place-items-center !overflow-y-auto !bg-black/55 !p-3 !backdrop-blur-sm sm:!p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <dialog
        aria-label={label}
        aria-modal="true"
        className={`crm-panel !relative !m-0 !flex !max-h-[calc(100dvh-24px)] !w-full !flex-col !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !p-0 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] sm:!max-h-[calc(100dvh-48px)] sm:!rounded-[var(--crm-radius-lg)] ${crmModalWidths[size]}`}
        onCancel={(event) => {
          event.preventDefault()
          onClose()
        }}
        open
        ref={dialogRef}
      >
        {children}
      </dialog>
    </div>,
    modalRoot,
  )
}
