import { ChevronDown, Euro, ReceiptText, RefreshCw, Settings, Store, Wifi, WifiOff } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { CashSession } from '../../types'
import { cx } from '../../utils/cx'
import { Chip } from '../ui'
import { PrintAgentStatusBadge } from '../../features/local-printing'

type AppHeaderProps = {
  cashSession: CashSession | null
  canCloseCash: boolean
  isLoading: boolean
  isOnline: boolean
  onCloseCash: () => void
  onOpenConfig: () => void
  onOpenTicketHistory: () => void
  onRefreshCatalog: () => void
  pendingCount: number
}

export function AppHeader({
  cashSession,
  canCloseCash,
  isLoading,
  isOnline,
  onCloseCash,
  onOpenConfig,
  onOpenTicketHistory,
  onRefreshCatalog,
  pendingCount,
}: AppHeaderProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current?.contains(event.target as Node)) {
        return
      }

      setMenuOpen(false)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setMenuOpen(false)
      }
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  function runMenuAction(action: () => void) {
    setMenuOpen(false)
    action()
  }

  return (
    <header className="shrink-0 border-b border-[var(--separator)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-2">
        <div className="relative min-w-0" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] border border-transparent px-2 text-[var(--foreground)] transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
            onClick={() => setMenuOpen((current) => !current)}
            type="button"
          >
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface-secondary)]">
              <Store className="h-5 w-5" />
            </span>
            <span className="text-2xl font-black">TPV</span>
            <ChevronDown className={cx('h-4 w-4 transition-transform', menuOpen && 'rotate-180')} />
          </button>

          {menuOpen ? (
            <div
              className="absolute left-0 top-full z-50 mt-2 flex flex-col gap-2 w-64 max-w-[calc(100vw-2rem)] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-2 shadow-xl"
              role="menu"
            >
              {cashSession ? (
                <>
                  {canCloseCash ? <button
                    className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius)] px-3 text-left text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                    onClick={() => runMenuAction(onOpenTicketHistory)}
                    role="menuitem"
                    type="button"
                  >
                    <ReceiptText className="h-4 w-4" />
                    <span>Historico de tickets</span>
                  </button> : null}
                  <button
                    className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius)] px-3 text-left text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                    onClick={() => runMenuAction(onCloseCash)}
                    role="menuitem"
                    type="button"
                  >
                    <Euro className="h-4 w-4" />
                    <span>Cerrar caja</span>
                  </button>
                </>
              ) : null}
              <button
                className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius)] px-3 text-left text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
                onClick={() => runMenuAction(onOpenConfig)}
                role="menuitem"
                type="button"
              >
                <Settings className="h-4 w-4" />
                <span>Ajustes</span>
              </button>
              <button
                className="flex min-h-11 w-full items-center gap-3 rounded-[var(--radius)] px-3 text-left text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--accent-soft)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={isLoading || !isOnline}
                onClick={() => runMenuAction(onRefreshCatalog)}
                role="menuitem"
                type="button"
              >
                <RefreshCw className={cx('h-4 w-4', isLoading && 'animate-spin')} />
                <span>Recargar catalogo</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {cashSession ? <Chip>{`Caja: ${cashSession.cashRegisterName}`}</Chip> : null}
          <PrintAgentStatusBadge />
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'} />
          {pendingCount ? <Chip tone="warning">{`${pendingCount} pendientes`}</Chip> : null}
        </div>
      </div>
    </header>
  )
}
