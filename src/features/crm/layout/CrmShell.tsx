import { notifyOperationalError } from '../../../utils/notifications.ts'
import { Boxes, ChevronRight, LayoutDashboard, LogOut, Moon, Package, ReceiptText, ShoppingCart, Sun } from 'lucide-react'
import { useEffect, type ReactNode } from 'react'
import type { CrmVenue, TenantContext } from '../../../types'
import { CrmVenueSelector } from '../../../components/crm/CrmVenueSelector'
import { DashboardShell, LiveStatus, dashboardMenuItemClass, type DashboardNavEntry, type DashboardNavGroup, type DashboardSearch } from '../../../components/layout/DashboardShell'
import { loadCrmSearchItems, type CrmSearchItem } from '../search/crmSearchService'
import {
  allNavItems,
  getSectionTitle,
  inventoryNavItems,
  navItems,
  productNavItems,
  purchaseNavItems,
  reportNavItems,
  type CrmNavItem,
  type CrmSection,
} from '../routing/crmNavigation'
import { canAccessCrmSection } from '../routing/crmPermissions'
import { useCrmTheme } from './crmTheme'

type Props = {
  activeSection: CrmSection
  children: ReactNode
  context: TenantContext
  disabled: boolean
  error: string | null
  inventoryEnabled: boolean
  isOnline: boolean
  onLogout: () => void
  onSearchSelect?: (item: CrmSearchItem) => void
  onSectionChange: (section: CrmSection) => void
  onVenueChange: (venueId: string) => void
  onboarding?: ReactNode
  selectedVenueId: string
  venues: CrmVenue[]
}

const goKeys: Record<string, CrmSection> = { o: 'dashboard', p: 'products', i: 'inventory-stock', v: 'reports', e: 'stats', s: 'settings' }

function buildGroups(context: TenantContext, selectedVenue: CrmVenue | undefined, inventoryEnabled: boolean): DashboardNavGroup[] {
  const allowed = (items: CrmNavItem[]) => items.filter((item) => canAccessCrmSection(context.role, item.id, context.features, selectedVenue, context.billingActivationRequired))
  const parent = (id: string, label: string, icon: DashboardNavEntry['icon'], items: CrmNavItem[]): DashboardNavEntry[] => items.length ? [{ id, label, icon, items }] : []
  const inventoryItems = inventoryNavItems
    .filter((item) => item.id === 'inventory-stock' || canAccessCrmSection(context.role, item.id, context.features, selectedVenue, context.billingActivationRequired))
    .filter((item) => inventoryEnabled || item.id === 'inventory-stock')
  const account = { label: 'Cuenta', items: allowed(navItems.slice(7)) }
  if (context.billingActivationRequired) return [account]
  return [
    { label: 'Principal', items: allowed(navItems.slice(0, 2)) },
    {
      label: 'Gestión',
      items: [
        ...parent('group-products', 'Productos', Boxes, allowed(productNavItems)),
        ...parent('group-inventory', 'Inventario', Package, inventoryItems),
        ...parent('group-purchases', 'Compras', ShoppingCart, allowed(purchaseNavItems)),
        ...allowed(navItems.slice(2, 3)),
        ...parent('group-reports', 'Informes de ventas', ReceiptText, allowed(reportNavItems)),
        ...allowed(navItems.slice(3, 7)),
      ],
    },
    account,
  ]
}

export function CrmShell({ activeSection, children, context, disabled, error, inventoryEnabled, isOnline, onLogout, onSearchSelect, onSectionChange, onVenueChange, onboarding, selectedVenueId, venues }: Props) {
  useEffect(() => { if (error) notifyOperationalError(error) }, [error])
  const [crmTheme, toggleCrmTheme] = useCrmTheme()
  const selectedVenue = venues.find((venue) => venue.id === selectedVenueId)
  const groups = buildGroups(context, selectedVenue, inventoryEnabled)
  const allowedSections = new Set(groups.flatMap((group) => group.items.flatMap((entry) => 'items' in entry ? entry.items : [entry])).map((item) => item.id as CrmSection))
  const search: DashboardSearch | undefined = selectedVenue && onSearchSelect ? {
    load: async () => (await loadCrmSearchItems(context, selectedVenue, allowedSections)).map((item) => ({ ...item, onSelect: () => onSearchSelect(item) })),
    placeholder: 'Buscar secciones, productos, formatos, cierres…',
  } : undefined

  return (
    <DashboardShell
      account={{
        name: context.userName,
        detail: context.tenantName,
        menu: <>
          <button aria-label={crmTheme === 'dark' ? 'Cambiar CRM a modo claro' : 'Cambiar CRM a modo oscuro'} className={dashboardMenuItemClass} onClick={toggleCrmTheme} type="button">
            {crmTheme === 'dark' ? <Sun aria-hidden="true" className="size-4" /> : <Moon aria-hidden="true" className="size-4" />}
            <span>{crmTheme === 'dark' ? 'Modo claro' : 'Modo oscuro'}</span>
          </button>
          <button className={dashboardMenuItemClass} onClick={onLogout} type="button">
            <LogOut aria-hidden="true" className="size-4" />
            <span>Salir</span>
          </button>
        </>,
      }}
      activeId={activeSection}
      brand={<div className="flex min-w-0 items-center gap-3">
        <img alt="Tickit" className="size-9 shrink-0 rounded-[10px]" src="/icons/apple-touch-icon.png" />
        <div className="min-w-0">
          <p className="m-0 truncate text-sm leading-tight font-bold tracking-[0.04em] text-[var(--crm-sidebar-text)]">TICKIT POS</p>
          <p className="m-0 mt-0.5 text-[10px] font-semibold tracking-[0.16em] text-[var(--crm-sidebar-muted)] uppercase">Back Office</p>
        </div>
      </div>}
      eyebrow={<>
        <LayoutDashboard aria-hidden="true" className="size-3.5" />
        <span>{allNavItems.find((item) => item.id === activeSection)?.label}</span>
        <ChevronRight aria-hidden="true" className="size-3.5" />
        <span className="truncate">{context.tenantName}</span>
      </>}
      goKeys={goKeys}
      groups={groups}
      notices={!isOnline ? (
        <div className="mx-auto mt-3 w-[calc(100%-32px)] max-w-[1440px] rounded-[14px] bg-[var(--crm-yellow-soft)] px-4 py-3 text-[13px] font-semibold text-[var(--crm-yellow)] md:w-[calc(100%-48px)]">
          El CRM requiere conexión para guardar cambios en Supabase.
        </div>
      ) : null}
      onNavigate={(id) => onSectionChange(id as CrmSection)}
      search={search}
      sideFooter={<LiveStatus isOnline={isOnline} />}
      theme={crmTheme}
      title={getSectionTitle(activeSection)}
      tools={<>
        {onboarding}
        {!context.billingActivationRequired ? <div className="w-[150px] min-w-0 md:w-auto">
          <CrmVenueSelector disabled={disabled} onChange={onVenueChange} value={selectedVenueId} venues={venues} />
        </div> : null}
      </>}
      workspace={<div className="rounded-xl border border-[var(--crm-sidebar-border)] bg-[var(--crm-sidebar-hover)] px-3 py-2.5">
        <p className="m-0 text-[10px] font-semibold tracking-[0.12em] text-[var(--crm-sidebar-muted)] uppercase">Negocio</p>
        <p className="m-0 mt-0.5 truncate text-sm font-semibold text-[var(--crm-sidebar-text)]">{context.tenantName}</p>
      </div>}
    >
      {venues.some((venue) => venue.id === selectedVenueId && !venue.isActive) ? <p role="status" className="mb-4 rounded-[var(--crm-radius-md)] bg-[var(--crm-yellow-soft)] p-4 text-sm text-[var(--crm-text)]">Este local está inactivo por el plan contratado. Se conservan sus datos, pero sus terminales TPV no pueden operar. Para reactivarlo, amplía el plan desde Mi Plan.</p> : null}
      <div data-onboarding="section-content" data-crm-section={activeSection}>{children}</div>
    </DashboardShell>
  )
}
