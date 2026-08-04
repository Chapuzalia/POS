import { Button as UiButton } from '../../../components/ui/Button'
import { Boxes, ChevronDown, LogOut, Moon, Package, ReceiptText, Store, Sun, X, type LucideIcon } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { TenantContext } from '../../../types'
import {
  inventoryNavItems,
  inventorySections,
  navItems,
  productNavItems,
  productSections,
  reportNavItems,
  reportSections,
  type CrmNavItem,
  type CrmSection,
} from '../routing/crmNavigation'
import { canAccessCrmSection } from '../routing/crmPermissions'
import type { CrmTheme } from './crmTheme'

type Props = {
  activeSection: CrmSection
  context: TenantContext
  inventoryEnabled: boolean
  isOpen: boolean
  onClose: () => void
  onLogout: () => void
  onSectionChange: (section: CrmSection) => void
  onToggleTheme: () => void
  theme: CrmTheme
}

type SidebarNavItemProps = {
  activeSection: CrmSection
  item: CrmNavItem
  onNavigate: (section: CrmSection) => void
  subtle?: boolean
}

type SidebarCollapsibleProps = {
  activeSection: CrmSection
  icon: LucideIcon
  isOpen: boolean
  items: CrmNavItem[]
  label: string
  onNavigate: (section: CrmSection) => void
  onToggle: () => void
  sections: ReadonlySet<CrmSection>
}

const itemClass = '!relative !flex !min-h-11 !w-full !min-w-0 !items-center !justify-start !gap-3 !rounded-xl !border-0 !bg-transparent !px-3 !text-left !text-[13px] !font-medium !text-[var(--crm-sidebar-muted)] !shadow-none !transition-[background-color,color,transform] !duration-150 hover:!bg-[var(--crm-sidebar-hover)] hover:!text-[var(--crm-sidebar-text)]'
const activeItemClass = '!bg-[var(--crm-sidebar-active)] !text-white !shadow-[0_8px_18px_rgba(20,120,237,0.2)] hover:!bg-[var(--crm-sidebar-active)] hover:!text-white'

function ActiveRail() {
  return <span aria-hidden="true" className="!absolute !top-1/2 !-left-3 !h-[22px] !w-[3px] !-translate-y-1/2 !rounded-r-full !bg-[#79b7ff]" />
}

function SidebarNavItem({ activeSection, item, onNavigate, subtle = false }: SidebarNavItemProps) {
  const Icon = item.icon
  const isActive = activeSection === item.id

  return (
    <UiButton
      aria-current={isActive ? 'page' : undefined}
      className={`${itemClass} ${isActive ? activeItemClass : ''} ${subtle ? '!min-h-10 !text-xs' : ''}`}
      onClick={() => onNavigate(item.id)}
      type="button"
    >
      {isActive ? <ActiveRail /> : null}
      <Icon className="!size-[18px]" />
      <span className="!min-w-0 !flex-1 !truncate">{item.label}</span>
    </UiButton>
  )
}

function SidebarCollapsible({ activeSection, icon: Icon, isOpen, items, label, onNavigate, onToggle, sections }: SidebarCollapsibleProps) {
  const isActive = sections.has(activeSection)
  const submenuId = `crm-${label.toLowerCase().replaceAll(' ', '-')}-submenu`

  return (
    <div className="!grid !gap-[3px]">
      <UiButton
        aria-controls={submenuId}
        aria-expanded={isOpen}
        className={`${itemClass} ${isActive ? activeItemClass : ''}`}
        onClick={onToggle}
        type="button"
      >
        {isActive ? <ActiveRail /> : null}
        <Icon className="!size-[18px]" />
        <span className="!min-w-0 !flex-1 !truncate">{label}</span>
        <ChevronDown className={`!size-4 !transition-transform !duration-200 ${isOpen ? '!rotate-180' : ''}`} />
      </UiButton>
      {isOpen ? (
        <div className="!mt-1 !mb-[7px] !ml-5 !grid !gap-0.5 !border-l !border-[var(--crm-sidebar-border)] !pl-2.5" id={submenuId}>
          {items.map((item) => (
            <SidebarNavItem activeSection={activeSection} item={item} key={item.id} onNavigate={onNavigate} subtle />
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function CrmSidebar({ activeSection, context, inventoryEnabled, isOpen, onClose, onLogout, onSectionChange, onToggleTheme, theme }: Props) {
  const [isProductsOpen, setIsProductsOpen] = useState(productSections.has(activeSection))
  const [isInventoryOpen, setIsInventoryOpen] = useState(inventorySections.has(activeSection))
  const [isReportsOpen, setIsReportsOpen] = useState(reportSections.has(activeSection))

  useEffect(() => {
    if (!isOpen) return undefined
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isOpen, onClose])

  useEffect(() => {
    if (productSections.has(activeSection)) setIsProductsOpen(true)
    if (inventorySections.has(activeSection)) setIsInventoryOpen(true)
    if (reportSections.has(activeSection)) setIsReportsOpen(true)
  }, [activeSection])

  const allowed = (items: CrmNavItem[]) => items.filter((item) => canAccessCrmSection(context.role, item.id))
  const allowedInventoryItems = allowed(inventoryNavItems)
    .filter((item) => inventoryEnabled || item.id === 'inventory-stock')
  const navigate = (section: CrmSection) => {
    onSectionChange(section)
    onClose()
  }

  return (
    <>
      <div
        aria-hidden="true"
        className={isOpen
          ? '!fixed !inset-0 !z-[39] !block !border-0 !bg-black/55 !opacity-100 !transition-opacity !duration-200 xl:!hidden'
          : '!pointer-events-none !fixed !inset-0 !z-[39] !block !border-0 !bg-black/55 !opacity-0 !transition-opacity !duration-200 xl:!hidden'}
        onClick={onClose}
      />
      <aside
        aria-label="Sidebar del CRM"
        className={`${isOpen ? '!translate-x-0' : '!-translate-x-[102%]'} !fixed !inset-y-0 !left-0 !z-40 !flex !h-full !w-[min(88vw,var(--crm-sidebar-width))] !min-w-[min(88vw,var(--crm-sidebar-width))] !flex-col !overflow-hidden !border-r !border-[var(--crm-sidebar-border)] !bg-[var(--crm-sidebar-bg)] !bg-[linear-gradient(180deg,rgba(255,255,255,0.025),transparent_34%)] !text-[var(--crm-sidebar-text)] !shadow-[var(--crm-shadow-floating)] !isolate !transition-transform !duration-200 [.pwa-standalone_&]:!pt-[env(safe-area-inset-top,0px)] xl:!relative xl:!w-[var(--crm-sidebar-width)] xl:!min-w-[var(--crm-sidebar-width)] xl:!translate-x-0 xl:!shadow-none`}
        id="crm-sidebar"
      >
        <header className="!flex !min-h-[88px] !items-center !gap-3 !border-b !border-[var(--crm-sidebar-border)] !px-5 !py-4">
          <div className="!grid !size-11 !shrink-0 !place-items-center !rounded-xl !bg-[var(--crm-sidebar-accent)] !text-white !shadow-[0_8px_22px_rgba(20,120,237,0.28)]">
            <Store className="!size-5" />
          </div>
          <div className="!min-w-0 !flex-1">
            <p className="!m-0 !truncate !text-sm !leading-tight !font-semibold !text-[var(--crm-sidebar-text)]">{context.tenantName}</p>
            <p className="!mt-1 !mb-0 !text-[10px] !font-semibold !tracking-[0.16em] !text-[var(--crm-sidebar-muted)] !uppercase">TICKIT CRM</p>
          </div>
          <UiButton
            aria-label="Cerrar menu de navegacion"
            className="!grid !size-10 !min-h-10 !min-w-10 !shrink-0 !place-items-center !rounded-[10px] !border-0 !bg-white/[0.06] !p-0 !text-[var(--crm-sidebar-text)] !shadow-none xl:!hidden"
            onClick={onClose}
            type="button"
          >
            <X className="!size-5" />
          </UiButton>
        </header>

        <nav aria-label="Navegacion del CRM" className="!flex !min-h-0 !flex-1 !flex-col !overflow-y-auto !px-3 !py-5 [scrollbar-color:rgba(255,255,255,0.14)_transparent] [scrollbar-width:thin]">
          <section aria-labelledby="crm-nav-primary">
            <p className="!mx-2.5 !mt-0 !mb-2 !text-[10px] !leading-tight !font-bold !tracking-[0.14em] !text-[var(--crm-sidebar-muted)] !uppercase" id="crm-nav-primary">Principal</p>
            <div className="!grid !gap-[3px]">
              {allowed(navItems.slice(0, 2)).map((item) => (
                <SidebarNavItem activeSection={activeSection} item={item} key={item.id} onNavigate={navigate} />
              ))}
            </div>
          </section>

          <section aria-labelledby="crm-nav-management" className="!mt-[22px]">
            <p className="!mx-2.5 !mt-0 !mb-2 !text-[10px] !leading-tight !font-bold !tracking-[0.14em] !text-[var(--crm-sidebar-muted)] !uppercase" id="crm-nav-management">Gestion</p>
            <div className="!grid !gap-[3px]">
              <SidebarCollapsible activeSection={activeSection} icon={Boxes} isOpen={isProductsOpen} items={allowed(productNavItems)} label="Productos" onNavigate={navigate} onToggle={() => setIsProductsOpen((value) => !value)} sections={productSections} />
              <SidebarCollapsible activeSection={activeSection} icon={Package} isOpen={isInventoryOpen} items={allowedInventoryItems} label="Inventario" onNavigate={navigate} onToggle={() => setIsInventoryOpen((value) => !value)} sections={inventorySections} />
              {allowed(navItems.slice(2, 3)).map((item) => (
                <SidebarNavItem activeSection={activeSection} item={item} key={item.id} onNavigate={navigate} />
              ))}
              <SidebarCollapsible activeSection={activeSection} icon={ReceiptText} isOpen={isReportsOpen} items={allowed(reportNavItems)} label="Informes de ventas" onNavigate={navigate} onToggle={() => setIsReportsOpen((value) => !value)} sections={reportSections} />
              {allowed(navItems.slice(3, 6)).map((item) => (
                <SidebarNavItem activeSection={activeSection} item={item} key={item.id} onNavigate={navigate} />
              ))}
            </div>
          </section>

          <section aria-labelledby="crm-nav-account" className="!mt-[22px]">
            <p className="!mx-2.5 !mt-0 !mb-2 !text-[10px] !leading-tight !font-bold !tracking-[0.14em] !text-[var(--crm-sidebar-muted)] !uppercase" id="crm-nav-account">Cuenta</p>
            <div className="!grid !gap-[3px]">
              {allowed(navItems.slice(6)).map((item) => (
                <SidebarNavItem activeSection={activeSection} item={item} key={item.id} onNavigate={navigate} />
              ))}
            </div>
          </section>
        </nav>

        <footer className="!grid !grid-cols-2 !gap-2 !border-t !border-[var(--crm-sidebar-border)] !px-3 !py-4">
          <UiButton aria-label={theme === 'dark' ? 'Cambiar CRM a modo claro' : 'Cambiar CRM a modo oscuro'} className={`${itemClass} !min-h-10 !justify-center !bg-white/[0.035] !px-2 !text-xs`} onClick={onToggleTheme} title={theme === 'dark' ? 'Cambiar a modo claro' : 'Cambiar a modo oscuro'} type="button">
            {theme === 'dark' ? <Sun className="!size-4" /> : <Moon className="!size-4" />}
            <span>{theme === 'dark' ? 'Claro' : 'Oscuro'}</span>
          </UiButton>
          <UiButton className={`${itemClass} !min-h-10 !justify-center !bg-white/[0.035] !px-2 !text-xs`} onClick={onLogout} type="button">
            <LogOut className="!size-4" />
            <span>Salir</span>
          </UiButton>
        </footer>
      </aside>
    </>
  )
}
