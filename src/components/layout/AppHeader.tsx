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
  Vault,
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
  cashlogyConnected: boolean;
  isLoading: boolean;
  isOnline: boolean;
  onCloseCash: () => void;
  onOpenConfig: () => void;
  onOpenReservations: () => void;
  onOpenTicketHistory: () => void;
  onOpenCashMovements: () => void;
  onOpenCashClosingHistory: () => void;
  onOpenCashlogyMachine: () => void;
  onRefreshCatalog: () => void;
  onLogout: () => void;
  pendingCount: number;
  themeMode: "light" | "dark";
  compactMobile?: boolean;
};

export function AppHeader({
  cashSession,
  canCloseCash,
  canManageCash,
  canOpenCashDrawer,
  canOpenReservations,
  cashlogyConnected,
  isLoading,
  isOnline,
  onCloseCash,
  onOpenConfig,
  onOpenReservations,
  onOpenTicketHistory,
  onOpenCashMovements,
  onOpenCashClosingHistory,
  onOpenCashlogyMachine,
  onRefreshCatalog,
  onLogout,
  pendingCount,
  themeMode,
  compactMobile = false,
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
  if (cashlogyConnected) menuItems.push({ action: onOpenCashlogyMachine, icon: Vault, id: 'cashlogy-machine', label: 'Máquina de efectivo' })
  menuItems.push(
    { action: onOpenConfig, icon: Settings, id: 'settings', label: 'Ajustes' },
    { action: onLogout, danger: true, icon: LogOut, id: 'logout', label: 'Cerrar sesión' },
  )

  return (
    <header className={`shrink-0 border-b border-[var(--separator)] bg-[var(--surface)] ${compactMobile ? 'pt-[max(.5rem,env(safe-area-inset-top))]' : 'pt-[max(1.5rem,env(safe-area-inset-top))]'}`}>
      <div className={`mx-auto flex max-w-[1600px] items-center justify-between py-0 ${compactMobile ? 'flex-nowrap gap-1 px-2' : 'flex-wrap gap-3 px-4'}`}>
        <div className="flex min-w-0 flex-row gap-2">
          <Dropdown>
            <Dropdown.Trigger aria-label="Abrir menú principal de TICKIT" className="inline-flex min-h-11 items-center gap-2 rounded-[var(--radius)] px-2 text-[var(--foreground)] transition-colors hover:bg-[var(--surface-muted)]">
                <img src={themeMode === 'dark' ? '/logo_white.png' : '/logo_black.png'} alt="TICKIT" className={`${compactMobile ? 'h-5' : 'h-6'} w-auto max-w-36 object-contain`} />
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
                    <Dropdown.Item className="flex items-center gap-2 h-12" id={item.id} key={item.id} textValue={item.label} variant={item.danger ? 'danger' : undefined}>
                      <Icon className={item.id === 'refresh' && isLoading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
                      <Label>{item.label}</Label>
                    </Dropdown.Item>
                  )
                })}
              </Dropdown.Menu>
            </Dropdown.Popover>
          </Dropdown>

          {canOpenReservations ? (
            <UiButton aria-label="Reservas" className="flex min-h-11 items-center gap-0 px-3 text-sm font-semibold sm:gap-3 " disabled={isLoading || !isOnline} onClick={onOpenReservations} type="button">
              <CalendarDays className="h-4 w-4" />
              <span className='not-sr-only pl-2'>Reservas</span>
            </UiButton>
          ) : null}
        </div>

        <div className={`flex items-center justify-end ${compactMobile ? 'flex-nowrap gap-1' : 'flex-wrap gap-2'}`}>
          {cashSession ? <Chip>{`Caja: ${cashSession.cashRegisterName}`}</Chip> : null}
          <div className={compactMobile ? 'hidden' : 'contents'}>
            <ManualCashDrawerButton canOpenDrawer={canOpenCashDrawer} />
          </div>
          <div className={compactMobile ? 'hidden' : 'hidden sm:block'}>
            <PrintAgentStatusBadge />
          </div>
          <Chip icon={isOnline ? Wifi : WifiOff} tone={isOnline ? 'success' : 'danger'} />
          {pendingCount ? <div className={compactMobile ? 'hidden' : 'contents'}><Chip tone="warning">{`${pendingCount} pendientes`}</Chip></div> : null}
        </div>
      </div>
    </header>
  )
}
