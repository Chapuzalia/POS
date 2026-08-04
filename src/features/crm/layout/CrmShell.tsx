import { Button as UiButton } from '../../../components/ui/Button'
import { ChevronRight, LayoutDashboard, Menu, UserRound } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { CrmVenue, TenantContext } from '../../../types'
import { CrmVenueSelector } from '../../../components/crm/CrmVenueSelector'
import { allNavItems, getSectionTitle, type CrmSection } from '../routing/crmNavigation'
import { CrmSidebar } from './CrmSidebar'
import { CRM_THEME_STORAGE_KEY, getInitialCrmTheme, type CrmTheme } from './crmTheme'

type Props = {
  activeSection: CrmSection
  children: ReactNode
  context: TenantContext
  disabled: boolean
  error: string | null
  inventoryEnabled: boolean
  isOnline: boolean
  onLogout: () => void
  onSectionChange: (section: CrmSection) => void
  onVenueChange: (venueId: string) => void
  selectedVenueId: string
  venues: CrmVenue[]
}

export function CrmShell({ activeSection, children, context, disabled, error, inventoryEnabled, isOnline, onLogout, onSectionChange, onVenueChange, selectedVenueId, venues }: Props) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [crmTheme, setCrmTheme] = useState<CrmTheme>(getInitialCrmTheme)

  function toggleCrmTheme() {
    const nextTheme: CrmTheme = crmTheme === 'dark' ? 'light' : 'dark'
    setCrmTheme(nextTheme)
    try {
      window.localStorage.setItem(CRM_THEME_STORAGE_KEY, nextTheme)
    } catch {
      // El cambio sigue activo durante la sesion aunque no pueda persistirse.
    }
  }

  return (
    <div className="crm-shell !flex !h-full !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased" data-crm-theme={crmTheme} data-theme={crmTheme}>
      <CrmSidebar
        activeSection={activeSection}
        context={context}
        inventoryEnabled={inventoryEnabled}
        isOpen={isSidebarOpen}
        onClose={() => setIsSidebarOpen(false)}
        onLogout={onLogout}
        onSectionChange={onSectionChange}
        onToggleTheme={toggleCrmTheme}
        theme={crmTheme}
      />
      <section className="!flex !min-h-0 !min-w-0 !flex-1 !flex-col !overflow-hidden !bg-[var(--crm-canvas)]">
        <header className="!relative !z-30 !flex !min-h-16 [.pwa-standalone_&]:!pt-[calc(0.625rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!min-h-[calc(5rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!basis-[calc(5rem+env(safe-area-inset-top,0px))] md:[.pwa-standalone_&]:!pt-[env(safe-area-inset-top,0px)] !w-full !flex-[0_0_auto] !flex-row !items-center !justify-between !gap-2.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-topbar-bg)] !px-4 !py-2.5 md:!min-h-20 md:!flex-[0_0_80px] md:!gap-[22px] md:!px-7 md:!py-0">
          <UiButton
            aria-controls="crm-sidebar"
            aria-expanded={isSidebarOpen}
            aria-label="Abrir menu de navegacion"
            className="!inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface)] !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 xl:!hidden"
            onClick={() => setIsSidebarOpen(true)}
            type="button"
          >
            <Menu className="h-5 w-5" />
          </UiButton>
          <div className="!mr-auto !min-w-0 md:!min-w-[180px] xl:!mr-0">
            <div className="!hidden !items-center !gap-1.5 !text-[11px] !font-medium !text-[var(--crm-text-muted)] md:!flex">
              <LayoutDashboard className="size-3.5" />
              <span>{allNavItems.find((item) => item.id === activeSection)?.label}</span>
              <ChevronRight className="size-3.5" />
              <span>{context.tenantName}</span>
            </div>
            <h1 className="!mt-0 !min-h-0 !overflow-hidden !text-[17px] !leading-tight !font-bold !tracking-[-0.025em] !text-ellipsis !whitespace-nowrap !text-[var(--crm-text)] md:!mt-1 md:!text-xl">{getSectionTitle(activeSection)}</h1>
          </div>

          <div className="!flex !w-auto !min-w-0 !basis-[130px] !items-center !justify-end !gap-2.5 !overflow-visible sm:!basis-[180px] md:!basis-auto">
            <CrmVenueSelector
              disabled={disabled}
              onChange={onVenueChange}
              value={selectedVenueId}
              venues={venues}
            />
            <div className="!hidden !min-h-[42px] !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-xs !font-medium !whitespace-nowrap !text-[var(--crm-text-secondary)] lg:!inline-flex">{new Intl.DateTimeFormat('es-ES').format(new Date())}</div>
            <div className={isOnline ? '!hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-green-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-green)] md:!inline-flex' : '!hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-red-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-red)] md:!inline-flex'}>
              {isOnline ? 'Online' : 'Offline'}
            </div>
            <div className="!hidden !min-h-[42px] !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-xs !font-medium !whitespace-nowrap !text-[var(--crm-text-secondary)] md:!inline-flex">
              <UserRound className="h-4 w-4" />
              <span>{context.userName}</span>
            </div>
          </div>
        </header>

        {error ? (
          <div className="!mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-red-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-red)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">
            {error}
          </div>
        ) : null}
        {!isOnline ? (
          <div className="!mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-yellow-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-yellow)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">
            El CRM requiere conexion para guardar cambios en Supabase.
          </div>
        ) : null}

        <main className="!mx-auto !min-h-0 !w-full !max-w-[1720px] !flex-1 !overflow-auto !px-4 !pt-[26px] !pb-7 md:!px-7 md:!pt-[42px] md:!pb-9">
          {children}
        </main>
      </section>
    </div>
  )
}
