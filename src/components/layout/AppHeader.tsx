import { Euro, RefreshCw, Settings, Store, Wifi, WifiOff } from 'lucide-react'
import type { CashSession } from '../../types'
import { cx } from '../../utils/cx'
import { Button, Chip } from '../ui'

type AppHeaderProps = {
  cashSession: CashSession | null
  isLoading: boolean
  isOnline: boolean
  onCloseCash: () => void
  onOpenConfig: () => void
  onRefreshCatalog: () => void
  pendingCount: number
}

export function AppHeader({
  cashSession,
  isLoading,
  isOnline,
  onCloseCash,
  onOpenConfig,
  onRefreshCatalog,
  pendingCount,
}: AppHeaderProps) {
  return (
    <header className="shrink-0 border-b border-[var(--separator)] bg-[var(--surface)]">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <Store className="h-6 w-6 text-[var(--accent)]" />
            <h1 className="text-2xl font-black">TPV</h1>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'} />
          {pendingCount ? <Chip tone="warning">{`${pendingCount} pendientes`}</Chip> : null}
          {cashSession ? (
            <Button onClick={onCloseCash} size="sm" type="button" variant="secondary">
              <Euro className="h-4 w-4" />
              Cierre de caja
            </Button>
          ) : null}
          <Button onClick={onOpenConfig} size="sm" type="button" variant="tertiary">
            <Settings className="h-4 w-4" />
          </Button>
          <Button disabled={isLoading || !isOnline} onClick={onRefreshCatalog} size="sm" type="button" variant="tertiary">
            <RefreshCw className={cx('h-4 w-4', isLoading && 'animate-spin')} />
          </Button>
        </div>
      </div>
    </header>
  )
}
