import { ReceiptText, X } from 'lucide-react'
import { useEffect, useRef, type ReactNode } from 'react'
import { formatMoney } from '../../lib/format'
import { Button } from '../ui'

type MobileTicketModalProps = {
  children: ReactNode
  isOpen: boolean
  itemCount: number
  onClose: () => void
  onOpen: () => void
  title: string
  totalCents: number
}

export function MobileTicketModal({
  children,
  isOpen,
  itemCount,
  onClose,
  onOpen,
  title,
  totalCents,
}: MobileTicketModalProps) {
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const triggerButtonRef = useRef<HTMLButtonElement>(null)
  const wasOpenRef = useRef(false)

  useEffect(() => {
    if (isOpen) {
      closeButtonRef.current?.focus()
    } else if (wasOpenRef.current) {
      triggerButtonRef.current?.focus()
    }

    wasOpenRef.current = isOpen
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  useEffect(() => {
    const desktopQuery = window.matchMedia('(min-width: 1024px)')

    function closeOnDesktop(event: MediaQueryListEvent | MediaQueryList) {
      if (event.matches && isOpen) {
        onClose()
      }
    }

    closeOnDesktop(desktopQuery)
    desktopQuery.addEventListener('change', closeOnDesktop)
    return () => desktopQuery.removeEventListener('change', closeOnDesktop)
  }, [isOpen, onClose])

  return (
    <>
      <button
        aria-controls="mobile-ticket-modal"
        aria-expanded={isOpen}
        aria-label={`Abrir ${title.toLowerCase()}: ${itemCount} productos, total ${formatMoney(totalCents)}`}
        className="fixed z-30 grid h-16 w-16 place-items-center rounded-full border border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)] shadow-[0_12px_32px_rgba(17,24,39,0.32)] transition hover:brightness-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] lg:hidden"
        ref={triggerButtonRef}
        style={{ bottom: 'max(1rem, env(safe-area-inset-bottom))', right: 'max(1rem, env(safe-area-inset-right))' }}
        type="button"
        onClick={onOpen}
      >
        <ReceiptText aria-hidden="true" className="h-7 w-7" />
        <span className="absolute -right-1 -top-1 grid min-h-6 min-w-6 place-items-center rounded-full border-2 border-[var(--surface)] bg-[var(--danger)] px-1 text-xs font-black leading-none text-white">
          {itemCount > 99 ? '99+' : itemCount}
        </span>
      </button>

      {isOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button
            aria-label={`Cerrar ${title.toLowerCase()}`}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60"
            onClick={onClose}
            type="button"
          />
          <section
            aria-labelledby="mobile-ticket-title"
            aria-modal="true"
            className="absolute inset-x-0 bottom-0 flex max-h-[calc(100dvh-1rem)] min-h-[65dvh] flex-col overflow-hidden rounded-t-2xl border border-b-0 border-[var(--separator)] bg-[var(--background)] text-[var(--foreground)] shadow-[var(--shadow)]"
            id="mobile-ticket-modal"
            role="dialog"
          >
            <header className="flex items-center justify-between gap-4 border-b border-[var(--separator)] bg-[var(--surface)] px-4 py-3">
              <div className="min-w-0">
                <h2 className="text-xl font-black" id="mobile-ticket-title">{title}</h2>
                <p className="truncate text-sm font-semibold text-[var(--muted)]">
                  {itemCount} {itemCount === 1 ? 'producto' : 'productos'} - {formatMoney(totalCents)}
                </p>
              </div>
              <Button aria-label={`Cerrar ${title.toLowerCase()}`} onClick={onClose} ref={closeButtonRef} size="sm" type="button" variant="tertiary">
                <X className="h-5 w-5" />
              </Button>
            </header>
            {children}
          </section>
        </div>
      ) : null}
    </>
  )
}
