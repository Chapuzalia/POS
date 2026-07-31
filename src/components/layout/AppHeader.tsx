import { Button as UiButton } from '../ui/Button'
import { Dropdown, Label } from '@heroui/react'
import {
  ArrowLeftRight,
  CalendarDays,
  ChevronDown,
  Euro,
  LogOut,
  ReceiptText,
  RefreshCw,
  Settings,
  WalletCards,
  Wifi,
  WifiOff,
} from "lucide-react";

import type { CashSession } from "../../types";

import { Chip } from "../ui";
import {
  ManualCashDrawerButton,
  PrintAgentStatusBadge,
} from "../../features/local-printing";

type AppHeaderProps = {
  cashSession: CashSession | null;
  canCloseCash: boolean;
  canManageCash: boolean;
  canOpenCashDrawer: boolean;
  canOpenReservations: boolean;
  isLoading: boolean;
  isOnline: boolean;
  onCloseCash: () => void;
  onOpenConfig: () => void;
  onOpenReservations: () => void;
  onOpenTicketHistory: () => void;
  onOpenCashMovements: () => void;
  onOpenCashClosingHistory: () => void;
  onRefreshCatalog: () => void;
  onLogout: () => void;
  pendingCount: number;
  themeMode: "light" | "dark";
};

export function AppHeader({
  cashSession,
  canCloseCash,
  canManageCash,
  canOpenCashDrawer,
  canOpenReservations,
  isLoading,
  isOnline,
  onCloseCash,
  onOpenConfig,
  onOpenReservations,
  onOpenTicketHistory,
  onOpenCashMovements,
  onOpenCashClosingHistory,
  onRefreshCatalog,
  onLogout,
  pendingCount,
  themeMode,
}: AppHeaderProps) {
  const menuItems: Array<{
    action: () => void
    danger?: boolean
    disabled?: boolean
    icon: typeof RefreshCw
    id: string
    label: string
  }> = [
    { action: onRefreshCatalog, disabled: isLoading || !isOnline, icon: RefreshCw, id: 'refresh', label: 'Recargar catálogo' },
  ]

  if (cashSession) {
    if (canCloseCash) menuItems.push({ action: onOpenTicketHistory, icon: ReceiptText, id: 'tickets', label: 'Histórico de tickets' })
    if (canManageCash) menuItems.push({ action: onOpenCashMovements, disabled: isLoading || !isOnline, icon: ArrowLeftRight, id: 'movements', label: 'Entradas / salidas' })
    menuItems.push({ action: onCloseCash, icon: Euro, id: 'close-cash', label: 'Cerrar caja' })
  }
  if (canCloseCash) menuItems.push({ action: onOpenCashClosingHistory, icon: WalletCards, id: 'closings', label: 'Histórico de cierres' })
  menuItems.push(
    { action: onOpenConfig, icon: Settings, id: 'settings', label: 'Ajustes' },
    { action: onLogout, danger: true, icon: LogOut, id: 'logout', label: 'Cerrar sesión' },
  )

  return (
    <header className="shrink-0 border-b border-[var(--separator)] bg-[var(--surface)] pt-[max(1.5rem,env(safe-area-inset-top))]">
      <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-3 px-4 py-0">
        <div className="flex min-w-0 flex-row gap-2">
          <Dropdown>
            <Dropdown.Trigger aria-label="Abrir menú principal de TICKIT" className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] px-2 text-[var(--foreground)] transition-colors hover:bg-[var(--surface-muted)]">
                <img src={themeMode === 'dark' ? '/logo_white.png' : '/logo_black.png'} alt="TICKIT" className="h-6 w-auto max-w-36 object-contain" />
                <ChevronDown className="h-4 w-4" />
              </Dropdown.Trigger>
            <Dropdown.Popover className="!w-64 !max-w-[calc(100vw-2rem)]">
              <Dropdown.Menu
                disabledKeys={new Set(menuItems.filter((item) => item.disabled).map((item) => item.id))}
                onAction={(key) => menuItems.find((item) => item.id === String(key))?.action()}
              >
                {menuItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <Dropdown.Item id={item.id} key={item.id} textValue={item.label} variant={item.danger ? 'danger' : undefined}>
                      <Icon className={item.id === 'refresh' && isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                      <Label>{item.label}</Label>
                    </Dropdown.Item>
                  )
                })}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>

          {canOpenReservations ? (
            <UiButton className="flex min-h-11 items-center gap-3 px-3 text-sm font-semibold" disabled={isLoading || !isOnline} onClick={onOpenReservations} type="button">
              <CalendarDays className="h-4 w-4" />
              <span>Reservas</span>
            </UiButton>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-2">
          {cashSession ? <Chip>{`Caja: ${cashSession.cashRegisterName}`}</Chip> : null}
          <ManualCashDrawerButton canOpenDrawer={canOpenCashDrawer} />
          <PrintAgentStatusBadge />
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'} />
          {pendingCount ? <Chip tone="warning">{`${pendingCount} pendientes`}</Chip> : null}
        </div>
      </div>
    </header>
  )
}