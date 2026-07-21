import { Boxes, ChevronDown, ChevronRight, LayoutDashboard, LogOut, Menu, Moon, Store, Sun, UserRound } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { CrmVenue, TenantContext } from '../../../types'
import { CrmVenueSelector } from '../../../components/crm/CrmVenueSelector'
import { allNavItems, getSectionTitle, navItems, productNavItems, productSections, type CrmSection } from '../routing/crmNavigation'
import { CRM_THEME_STORAGE_KEY, getInitialCrmTheme, type CrmTheme } from './crmTheme'

type Props = {
  activeSection: CrmSection
  children: ReactNode
  context: TenantContext
  disabled: boolean
  error: string | null
  isOnline: boolean
  onLogout: () => void
  onSectionChange: (section: CrmSection) => void
  onVenueChange: (venueId: string) => void
  selectedVenueId: string
  venues: CrmVenue[]
}

export function CrmShell({ activeSection, children, context, disabled, error, isOnline, onLogout, onSectionChange, onVenueChange, selectedVenueId, venues }: Props) {
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isProductsMenuOpen, setIsProductsMenuOpen] = useState(false)
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

  useEffect(() => {
    if (!isSidebarOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSidebarOpen(false)
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isSidebarOpen])

  return (
    <div className="crm-shell crm-dashboard-shell !flex !h-dvh !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased" data-crm-theme={crmTheme}>
      <button
        aria-label="Cerrar menu de navegacion"
        className={isSidebarOpen
          ? 'crm-sidebar-backdrop !fixed !inset-0 !z-[39] !block !border-0 !bg-[rgba(0,0,0,0.52)] !opacity-100 !transition-opacity !duration-200 xl:!hidden'
          : 'crm-sidebar-backdrop !pointer-events-none !fixed !inset-0 !z-[39] !block !border-0 !bg-[rgba(0,0,0,0.52)] !opacity-0 !transition-opacity !duration-200 xl:!hidden'}
        onClick={() => setIsSidebarOpen(false)}
        tabIndex={isSidebarOpen ? 0 : -1}
        type="button"
      />
      <aside
        className={isSidebarOpen
          ? 'crm-sidebar crm-sidebar-open !fixed !top-0 !bottom-0 !left-0 !z-40 !flex !h-dvh !w-[min(88vw,var(--crm-sidebar-width))] !min-w-[min(88vw,var(--crm-sidebar-width))] !translate-x-0 !flex-col !overflow-y-auto !border-r !border-[var(--crm-border-subtle)] !bg-[var(--crm-sidebar-bg)] !px-5 !pt-6 !pb-[18px] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] !transition-transform !duration-200 xl:!relative xl:!w-[var(--crm-sidebar-width)] xl:!min-w-[var(--crm-sidebar-width)] xl:!translate-x-0 xl:!shadow-none'
          : 'crm-sidebar !fixed !top-0 !bottom-0 !left-0 !z-40 !flex !h-dvh !w-[min(88vw,var(--crm-sidebar-width))] !min-w-[min(88vw,var(--crm-sidebar-width))] !-translate-x-[102%] !flex-col !overflow-y-auto !border-r !border-[var(--crm-border-subtle)] !bg-[var(--crm-sidebar-bg)] !px-5 !pt-6 !pb-[18px] !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] !transition-transform !duration-200 xl:!relative xl:!w-[var(--crm-sidebar-width)] xl:!min-w-[var(--crm-sidebar-width)] xl:!translate-x-0 xl:!shadow-none'}
        id="crm-sidebar"
      >
        <div className="crm-brand !grid !min-h-11 !grid-cols-[40px_minmax(0,1fr)] !items-center !justify-stretch !gap-[11px] !border-0 !p-0">
          <div className="crm-brand-mark !grid !size-10 !place-items-center !rounded-[10px] !border !border-[var(--crm-border)] !bg-[var(--crm-surface)] !text-[var(--crm-blue)]">
            <Store className="size-5 stroke-[1.8]" />
          </div>
          <div>
            <p className="crm-brand-title !m-0 !block !overflow-hidden !text-ellipsis !whitespace-nowrap !text-sm !leading-tight !font-semibold !text-[var(--crm-text)]">{context.tenantName}</p>
            <p className="crm-brand-subtitle !mt-0.5 !mb-0 !block !overflow-hidden !text-ellipsis !whitespace-nowrap !text-[11px] !font-medium !text-[var(--crm-text-muted)]">CRM · CLUB POS</p>
          </div>
        </div>

        <nav aria-label="Navegacion del CRM" className="crm-nav !mt-[30px] !flex !flex-col !gap-[5px]">
          <p className="crm-nav-label !mx-0 !mt-0 !mb-[7px] !ml-[3px] !text-[11px] !font-medium !text-[var(--crm-text-muted)]">Menu principal</p>
          {navItems.slice(0, 2).map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={activeSection === item.id ? 'page' : undefined}
                className={activeSection === item.id
                  ? 'crm-nav-item crm-nav-item-active !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !shadow-none !transition-[background-color,color,transform] !duration-150'
                  : 'hover:bg-white/5 !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
                key={item.id}
                onClick={() => {
                  onSectionChange(item.id)
                  setIsSidebarOpen(false)
                }}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span className="!inline">{item.label}</span>
              </button>
            )
          })}
          <div className="!grid !gap-[5px]">
            <button
              aria-controls="crm-products-submenu"
              aria-expanded={isProductsMenuOpen}
              className={productSections.has(activeSection)
                ? 'crm-nav-item crm-nav-item-active !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !shadow-none !transition-[background-color,color,transform] !duration-150'
                : 'hover:bg-white/5 !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
              onClick={() => setIsProductsMenuOpen((isOpen) => !isOpen)}
              type="button"
            >
              <Boxes className="h-4 w-4" />
              <span className="!inline">Productos</span>
              <ChevronDown className={`!ml-auto !size-4 !transition-transform !duration-200 ${isProductsMenuOpen ? '!rotate-180' : ''}`} />
            </button>
            {isProductsMenuOpen ? (
              <div className="!grid !gap-1 !pl-3" id="crm-products-submenu">
                {productNavItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <button
                      aria-current={activeSection === item.id ? 'page' : undefined}
                      className={activeSection === item.id
                        ? 'crm-nav-item crm-nav-item-active !flex !min-h-10 !min-w-0 !items-center !justify-start !gap-3 !rounded-[10px] !border-0 !px-3.5 !text-left !text-[13px] !font-medium !shadow-none !transition-[background-color,color,transform] !duration-150'
                        : 'hover:bg-white/5 !flex !min-h-10 !min-w-0 !items-center !justify-start !gap-3 !rounded-[10px] !border-0 !px-3.5 !text-left !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
                      key={item.id}
                      onClick={() => {
                        onSectionChange(item.id)
                        setIsSidebarOpen(false)
                      }}
                      type="button"
                    >
                      <Icon className="!size-3.5" />
                      <span>{item.label}</span>
                    </button>
                  )
                })}
              </div>
            ) : null}
          </div>
          {navItems.slice(2).map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={activeSection === item.id ? 'page' : undefined}
                className={activeSection === item.id
                  ? 'crm-nav-item crm-nav-item-active !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !shadow-none !transition-[background-color,color,transform] !duration-150'
                  : 'hover:bg-white/5 !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
                key={item.id}
                onClick={() => {
                  onSectionChange(item.id)
                  setIsSidebarOpen(false)
                }}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span className="!inline">{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="crm-sidebar-footer !mt-auto !grid !grid-cols-2 !gap-[5px] !pt-7">
          <button aria-label={crmTheme === 'dark' ? 'Cambiar CRM a modo claro' : 'Cambiar CRM a modo oscuro'} className="crm-nav-item !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-2 !rounded-[10px] !border-0 !bg-transparent !px-3 !text-left !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150" onClick={toggleCrmTheme} title={crmTheme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} type="button">
            {crmTheme === 'dark' ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            <span className="!truncate">{crmTheme === 'dark' ? 'Claro' : 'Oscuro'}</span>
          </button>
          <button className="crm-nav-item !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !bg-transparent !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150" onClick={onLogout} type="button">
            <LogOut className="h-4 w-4" />
            <span className="!truncate">Salir</span>
          </button>
        </div>
      </aside>

      <section className="crm-workspace !flex !min-h-0 !min-w-0 !flex-1 !flex-col !overflow-hidden !bg-[var(--crm-canvas)]">
        <header className="crm-topbar !relative !z-30 !flex !min-h-16 !w-full !flex-[0_0_auto] !flex-row !items-center !justify-between !gap-2.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-topbar-bg)] !px-4 !py-2.5 md:!min-h-20 md:!flex-[0_0_80px] md:!gap-[22px] md:!px-7 md:!py-0">
          <button
            aria-controls="crm-sidebar"
            aria-expanded={isSidebarOpen}
            aria-label="Abrir menu de navegacion"
            className="crm-mobile-menu !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface)] !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 xl:!hidden"
            onClick={() => setIsSidebarOpen(true)}
            type="button"
          >
            <Menu className="h-5 w-5" />
          </button>
          <div className="crm-page-heading !mr-auto !min-w-0 md:!min-w-[180px] xl:!mr-0">
            <div className="crm-breadcrumb !hidden !items-center !gap-1.5 !text-[11px] !font-medium !text-[var(--crm-text-muted)] md:!flex">
              <LayoutDashboard className="size-3.5" />
              <span>{allNavItems.find((item) => item.id === activeSection)?.label}</span>
              <ChevronRight className="size-3.5" />
              <span>{context.tenantName}</span>
            </div>
            <h1 className="!mt-0 !min-h-0 !overflow-hidden !text-[17px] !leading-tight !font-bold !tracking-[-0.025em] !text-ellipsis !whitespace-nowrap !text-[var(--crm-text)] md:!mt-1 md:!text-xl">{getSectionTitle(activeSection)}</h1>
          </div>

          <div className="crm-topbar-actions !flex !w-auto !min-w-0 !basis-[130px] !items-center !justify-end !gap-2.5 !overflow-visible sm:!basis-[180px] md:!basis-auto">
            <CrmVenueSelector
              disabled={disabled}
              onChange={onVenueChange}
              value={selectedVenueId}
              venues={venues}
            />
            <div className="crm-date-chip !hidden !min-h-[42px] !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-xs !font-medium !whitespace-nowrap !text-[var(--crm-text-secondary)] lg:!inline-flex">{new Intl.DateTimeFormat('es-ES').format(new Date())}</div>
            <div className={isOnline ? 'crm-status crm-status-online !hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-green-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-green)] md:!inline-flex' : 'crm-status crm-status-offline !hidden !min-h-7 !items-center !gap-2 !rounded-full !border !border-transparent !bg-[var(--crm-red-soft)] !px-2.5 !text-[11px] !font-semibold !whitespace-nowrap !text-[var(--crm-red)] md:!inline-flex'}>
              {isOnline ? 'Online' : 'Offline'}
            </div>
            <div className="crm-user-chip !hidden !min-h-[42px] !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-xs !font-medium !whitespace-nowrap !text-[var(--crm-text-secondary)] md:!inline-flex">
              <UserRound className="h-4 w-4" />
              <span>{context.userName}</span>
            </div>
          </div>
        </header>

        {error ? (
          <div className="crm-error !mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-red-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-red)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">
            {error}
          </div>
        ) : null}
        {!isOnline ? (
          <div className="crm-warning !mx-auto !mt-3 !-mb-3 !w-[calc(100%_-_32px)] !max-w-[1664px] !rounded-[14px] !border-0 !bg-[var(--crm-yellow-soft)] !px-4 !py-3 !text-[13px] !font-semibold !text-[var(--crm-yellow)] md:!mt-[18px] md:!-mb-5 md:!w-[calc(100%_-_56px)]">
            El CRM requiere conexion para guardar cambios en Supabase.
          </div>
        ) : null}

        <main className="crm-content !mx-auto !min-h-0 !w-full !max-w-[1720px] !flex-1 !overflow-auto !px-4 !pt-[26px] !pb-7 md:!px-7 md:!pt-[42px] md:!pb-9">
          {children}
        </main>
      </section>
    </div>
  )
}
