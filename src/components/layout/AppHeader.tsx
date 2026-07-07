import { Euro, LayoutDashboard, RefreshCw, Settings, Store, Wifi, WifiOff } from 'lucide-react'
import type { CashSession } from '../../types'
import { cx } from '../../utils/cx'
import { Button, Chip } from '../ui'

type AppHeaderProps = {
  activeView: 'pos' | 'crm'
  cashSession: CashSession | null
  isLoading: boolean
  isOnline: boolean
  onCloseCash: () => void
  onOpenConfig: () => void
  onRefreshCatalog: () => void
  onViewChange: (view: 'pos' | 'crm') => void
  pendingCount: number
}

export function AppHeader({
  activeView,
  cashSession,
  isLoading,
  isOnline,
  onCloseCash,
  onOpenConfig,
  onRefreshCatalog,
  onViewChange,
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
          <Button active={activeView === 'pos'} onClick={() => onViewChange('pos')} size="sm" type="button">
            <Store className="h-4 w-4" />
            TPV
          </Button>
          <Button active={activeView === 'crm'} onClick={() => onViewChange('crm')} size="sm" type="button">
            <LayoutDashboard className="h-4 w-4" />
            CRM
          </Button>
          <Chip tone={cashSession ? 'success' : 'danger'}>
            {cashSession ? 'Caja abierta' : 'Caja cerrada'}
          </Chip>
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'}>
            {isOnline ? 'Online' : 'Offline'}
          </Chip>
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
