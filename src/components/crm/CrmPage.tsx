import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  Armchair,
  Boxes,
  Building2,
  ChevronLeft,
  ChevronRight,
  Download,
  LayoutDashboard,
  LogOut,
  Menu,
  MonitorSmartphone,
  Pencil,
  Plus,
  ReceiptText,
  RefreshCw,
  Save,
  Search,
  SlidersHorizontal,
  Store,
  Tags,
  Trash2,
  Upload,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type CSSProperties, type FormEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { sileo } from 'sileo'
import {
  canSellProductStandalone,
  canUseProductAsMixer,
  categoryKindOptions,
  findProductVariantForSaleFormat,
  getAvailableSaleFormats,
  getDefaultSaleFormatsForKind,
  getKindLabel,
  getProductSaleFormats,
  getSaleFormatLabel,
  productKindOptions,
} from '../../lib/catalog'
import { centsToInput, formatMoney, normalizeText, parseMoneyToCents } from '../../lib/format'
import { exportCatalogZip, parseCatalogZip, type ParsedCatalogTransfer } from '../../lib/catalogTransfer'
import { getDefaultProductImageFillColor } from '../../lib/productImages'
import { parseRevoItemsCsv, type RevoImportParseResult } from '../../lib/revoImport'
import {
  calculateGrossFromNet,
  calculateTaxFromGross,
  COMMON_TAX_RATES,
  resolveEffectiveTaxRate,
} from '../../lib/tax'
import {
  createCategory,
  createCrmDevice,
  createCrmPosUser,
  createCrmVenue,
  createProductWithVariant,
  createSaleFormat,
  createVariant,
  deleteCategory,
  deleteCrmPosUser,
  deleteProductImage,
  deleteProduct,
  deleteSaleFormat,
  deleteVariant,
  importRevoCatalogProducts,
  importCatalogBackup,
  loadCrmStats,
  loadCrmSalesReports,
  loadCrmAccessData,
  loadCrmVenues,
  releaseCrmPosUserLogin,
  setCrmPosUserActive,
  subscribeToCrmStatsChanges,
  updateCategory,
  updateCrmVenueDefaultTaxRate,
  updateCrmPosUser,
  updateProduct,
  updateSaleFormat,
  updateVariant,
  uploadProductImage,
  type CatalogImportResult,
  type CatalogBackupImportResult,
  type CrmAccessData,
} from '../../services/crmService'
import type {
  Catalog,
  CatalogKind,
  Category,
  CrmPosUser,
  CrmSalesReportAggregate,
  CrmSalesReports,
  CrmStats,
  CrmVenue,
  DeviceMode,
  PaymentMethod,
  Product,
  ProductVariant,
  SaleFormat,
  SaleFormatDefinition,
  TenantContext,
} from '../../types'
import { getReadableError } from '../../utils/errors'
import { TableManagementPage } from '../../features/table-management/TableManagementPage'
import './crm.css'

type CrmSection = 'dashboard' | 'access' | 'products' | 'categories' | 'sale-formats' | 'tables' | 'reports' | 'import' | 'stats'

type CrmPageProps = {
  catalog: Catalog | null
  context: TenantContext
  error: string | null
  isOnline: boolean
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onLogout: () => void
}

const navItems: Array<{ id: CrmSection; label: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'access', label: 'Accesos', icon: Users },
  { id: 'products', label: 'Productos', icon: Boxes },
  { id: 'categories', label: 'Categorias', icon: Tags },
  { id: 'sale-formats', label: 'Formatos', icon: SlidersHorizontal },
  { id: 'tables', label: 'Mesas y zonas', icon: Armchair },
  { id: 'reports', label: 'Informes de ventas', icon: ReceiptText },
  { id: 'import', label: 'Importar / exportar', icon: Upload },
  { id: 'stats', label: 'Estadisticas', icon: BarChart3 },
]

const crmDateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  month: '2-digit',
})

const crmReportDateTimeFormatter = new Intl.DateTimeFormat('es-ES', {
  dateStyle: 'medium',
  timeStyle: 'short',
})

const paymentLabels: Record<PaymentMethod, string> = {
  card: 'Tarjeta',
  cash: 'Efectivo',
  invitation: 'Invitacion',
  other: 'Otros',
}

const CRM_PAGE_SIZE = 12

type CrmPaginationProps = {
  currentPage: number
  onPageChange: (page: number) => void
  totalResults: number
}

function CrmPagination({ currentPage, onPageChange, totalResults }: CrmPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalResults / CRM_PAGE_SIZE))
  const firstResult = totalResults ? (currentPage - 1) * CRM_PAGE_SIZE + 1 : 0
  const lastResult = Math.min(currentPage * CRM_PAGE_SIZE, totalResults)
  const firstVisiblePage = Math.max(1, Math.min(currentPage - 2, totalPages - 4))
  const lastVisiblePage = Math.min(totalPages, firstVisiblePage + 4)
  const visiblePages = Array.from(
    { length: lastVisiblePage - firstVisiblePage + 1 },
    (_, index) => firstVisiblePage + index,
  )

  return (
    <div className="!flex !min-h-[68px] !flex-col !items-center !justify-between !gap-3 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-3.5 sm:!flex-row md:!px-[22px]">
      <p className="!m-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">
        Mostrando {firstResult}-{lastResult} de {totalResults} resultados
      </p>
      <nav aria-label="Paginacion de resultados" className="!flex !flex-wrap !items-center !justify-center !gap-1.5">
        <button
          aria-label="Pagina anterior"
          className="crm-secondary-button !inline-flex !min-h-9 !items-center !justify-center !gap-1.5 !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !px-2.5 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          type="button"
        >
          <ChevronLeft className="!size-4" />
          <span className="!hidden sm:!inline">Anterior</span>
        </button>
        {visiblePages.map((page) => (
          <button
            aria-current={page === currentPage ? 'page' : undefined}
            aria-label={`Pagina ${page}`}
            className={page === currentPage
              ? '!inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-blue)] !p-0 !text-xs !font-bold !text-white !shadow-none !transition-[background-color,color,transform] !duration-150'
              : 'crm-secondary-button !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
            key={page}
            onClick={() => onPageChange(page)}
            type="button"
          >
            {page}
          </button>
        ))}
        <button
          aria-label="Pagina siguiente"
          className="crm-secondary-button !inline-flex !min-h-9 !items-center !justify-center !gap-1.5 !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !px-2.5 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          type="button"
        >
          <span className="!hidden sm:!inline">Siguiente</span>
          <ChevronRight className="!size-4" />
        </button>
      </nav>
    </div>
  )
}

type CrmModalProps = {
  children: ReactNode
  label: string
  onClose: () => void
  size?: 'compact' | 'large'
}

const crmModalWidths = {
  compact: '!max-w-[520px]',
  large: '!max-w-[820px]',
} as const

function CrmModal({ children, label, onClose, size = 'compact' }: CrmModalProps) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const onCloseRef = useRef(onClose)
  const modalRoot = document.querySelector<HTMLElement>('.crm-shell') ?? document.body
  onCloseRef.current = onClose

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const handleModalKeyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
        return
      }

      if (event.key === 'Tab' && dialogRef.current) {
        const focusableElements = Array.from(dialogRef.current.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ))
        const firstElement = focusableElements[0]
        const lastElement = focusableElements.at(-1)

        if (!firstElement || !lastElement) {
          event.preventDefault()
        } else if (event.shiftKey && document.activeElement === firstElement) {
          event.preventDefault()
          lastElement.focus()
        } else if (!event.shiftKey && document.activeElement === lastElement) {
          event.preventDefault()
          firstElement.focus()
        }
      }
    }

    window.addEventListener('keydown', handleModalKeyboard)
    return () => {
      window.removeEventListener('keydown', handleModalKeyboard)
      previouslyFocused?.focus()
    }
  }, [])

  return createPortal(
    <div
      className="!fixed !inset-0 !z-[80] !grid !place-items-center !overflow-y-auto !bg-black/55 !p-3 !backdrop-blur-sm sm:!p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          onClose()
        }
      }}
    >
      <dialog
        aria-label={label}
        aria-modal="true"
        className={`crm-panel !relative !m-0 !flex !max-h-[calc(100dvh-24px)] !w-full !flex-col !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !p-0 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-floating)] sm:!max-h-[calc(100dvh-48px)] sm:!rounded-[var(--crm-radius-lg)] ${crmModalWidths[size]}`}
        onCancel={(event) => {
          event.preventDefault()
          onClose()
        }}
        open
        ref={dialogRef}
      >
        {children}
      </dialog>
    </div>,
    modalRoot,
  )
}

export function CrmPage({
  catalog,
  context,
  error,
  isOnline,
  onCatalogChanged,
  onError,
  onLogout,
}: CrmPageProps) {
  const [activeSection, setActiveSection] = useState<CrmSection>('dashboard')
  const [isSidebarOpen, setIsSidebarOpen] = useState(false)
  const [isBusy, setIsBusy] = useState(false)
  const [stats, setStats] = useState<CrmStats | null>(null)
  const [venues, setVenues] = useState<CrmVenue[]>([])
  const [selectedVenueId, setSelectedVenueId] = useState('')
  const categories = catalog?.categories ?? []
  const products = catalog?.products ?? []
  const saleFormats = getAvailableSaleFormats(catalog?.saleFormats)
  const venueProducts = products.filter((product) => product.venueId === selectedVenueId)
  const venueCategoryIds = new Set(venueProducts.map((product) => product.categoryId))
  const venueCategories = categories.filter((category) => venueCategoryIds.has(category.id))
  const activeProducts = venueProducts.filter((product) => product.isActive)
  const activeCategories = venueCategories.filter((category) => category.isActive)

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true)
    onError(null)
    try {
      await action()
    } catch (actionError) {
      onError(getReadableError(actionError))
    } finally {
      setIsBusy(false)
    }
  }, [onError])

  const refreshVenues = useCallback(async () => {
    const nextVenues = await loadCrmVenues(context)
    setVenues(nextVenues)
    setSelectedVenueId((current) =>
      nextVenues.some((venue) => venue.id === current && venue.isActive)
        ? current
        : (nextVenues.find((venue) => venue.isActive)?.id ?? ''),
    )
  }, [context])

  useEffect(() => {
    if (!isOnline) {
      return
    }

    void runAction(refreshVenues)
  }, [isOnline, refreshVenues, runAction])

  const refreshStats = useCallback(async (options: { silent?: boolean } = {}) => {
    const loadStats = async () => {
      onError(null)
      if (!selectedVenueId) {
        setStats(null)
        return
      }
      setStats(await loadCrmStats(context, selectedVenueId))
    }

    if (options.silent) {
      try {
        await loadStats()
      } catch (statsError) {
        onError(getReadableError(statsError))
      }
      return
    }

    await runAction(loadStats)
  }, [context, onError, runAction, selectedVenueId])

  useEffect(() => {
    if ((activeSection === 'dashboard' || activeSection === 'stats') && isOnline && selectedVenueId) {
      void refreshStats()
    }
  }, [activeSection, isOnline, refreshStats, selectedVenueId])

  useEffect(() => {
    if (!isOnline || (activeSection !== 'dashboard' && activeSection !== 'stats')) {
      return undefined
    }

    let refreshTimer: ReturnType<typeof window.setTimeout> | null = null
    const unsubscribe = subscribeToCrmStatsChanges(context, () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
      }

      refreshTimer = window.setTimeout(() => void refreshStats({ silent: true }), 250)
    })

    return () => {
      if (refreshTimer) {
        window.clearTimeout(refreshTimer)
      }
      unsubscribe()
    }
  }, [activeSection, context, isOnline, refreshStats])

  useEffect(() => {
    if (!isSidebarOpen) return undefined

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsSidebarOpen(false)
    }

    window.addEventListener('keydown', closeOnEscape)
    return () => window.removeEventListener('keydown', closeOnEscape)
  }, [isSidebarOpen])

  return (
    <div className="crm-shell crm-dashboard-shell !flex !h-dvh !min-h-0 !w-screen !overflow-hidden !bg-[var(--crm-canvas)] !text-[var(--crm-text)] !antialiased">
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
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                aria-current={activeSection === item.id ? 'page' : undefined}
                className={activeSection === item.id
                  ? 'crm-nav-item crm-nav-item-active !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !shadow-none !transition-[background-color,color,transform] !duration-150'
                  : 'hover:bg-white/5 !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
                key={item.id}
                onClick={() => {
                  setActiveSection(item.id)
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

        <div className="crm-sidebar-footer !mt-auto !grid !gap-[5px] !pt-7">
          <button className="crm-nav-item !flex !min-h-[46px] !min-w-0 !items-center !justify-start !gap-[13px] !rounded-[10px] !border-0 !bg-transparent !px-3.5 !text-left !text-sm !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150" onClick={onLogout} type="button">
            <LogOut className="h-4 w-4" />
            <span className="!inline">Cerrar sesion</span>
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
              <span>{navItems.find((item) => item.id === activeSection)?.label}</span>
              <ChevronRight className="size-3.5" />
              <span>{context.tenantName}</span>
            </div>
            <h1 className="!mt-0 !min-h-0 !overflow-hidden !text-[17px] !leading-tight !font-bold !tracking-[-0.025em] !text-ellipsis !whitespace-nowrap !text-[var(--crm-text)] md:!mt-1 md:!text-xl">{getSectionTitle(activeSection)}</h1>
          </div>

          <div className="crm-topbar-actions !flex !w-auto !min-w-0 !basis-[130px] !items-center !justify-end !gap-2.5 !overflow-visible sm:!basis-[180px] md:!basis-auto">
            <label className="crm-venue-selector !inline-flex !min-h-10 !w-full !min-w-0 !items-center !gap-2 !rounded-[11px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !transition-[border-color,box-shadow] !duration-150 md:!min-h-[42px] md:!w-auto md:!min-w-[220px]">
              <Building2 className="hidden h-4 w-4 sm:block" />
              <select
                className="min-w-0 flex-1 border-0 bg-transparent text-[13px] font-semibold text-inherit outline-none"
                disabled={!isOnline || isBusy}
                onChange={(event) => {
                  setStats(null)
                  setSelectedVenueId(event.target.value)
                }}
                value={selectedVenueId}
              >
                {venues.filter((venue) => venue.isActive).map((venue) => (
                  <option key={venue.id} value={venue.id}>{venue.name}</option>
                ))}
              </select>
            </label>
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
          {activeSection === 'dashboard' ? (
            <DashboardCrm
              activeCategories={activeCategories.length}
              activeProducts={activeProducts.length}
              categories={venueCategories}
              disabled={!isOnline || isBusy}
              onRefresh={refreshStats}
              products={venueProducts}
              stats={stats}
            />
          ) : null}

          {activeSection === 'products' ? (
            <ProductsCrm
              defaultTaxRate={venues.find((venue) => venue.id === selectedVenueId)?.defaultTaxRate ?? 21}
              categories={categories}
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={venueProducts}
              runAction={runAction}
              saleFormats={saleFormats}
              selectedVenueId={selectedVenueId}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'access' ? (
            <AccessManagementCrm
              disabled={!isOnline || isBusy}
              onVenuesChanged={refreshVenues}
              runAction={runAction}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'categories' ? (
            <CategoriesCrm
              categories={categories}
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={products}
              runAction={runAction}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'sale-formats' ? (
            <SaleFormatsCrm
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={products}
              runAction={runAction}
              saleFormats={saleFormats}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'import' ? (
            <RevoImportCrm
              categories={categories}
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={venueProducts}
              runAction={runAction}
              saleFormats={saleFormats}
              selectedVenueId={selectedVenueId}
              tenantContext={context}
              venueName={venues.find((venue) => venue.id === selectedVenueId)?.name ?? ''}
            />
          ) : null}

          {activeSection === 'tables' ? (
            <TableManagementPage
              context={context}
              disabled={!isOnline || isBusy}
              onError={onError}
              venueId={selectedVenueId}
            />
          ) : null}

          {activeSection === 'reports' ? (
            <SalesReportsCrm
              disabled={!isOnline || isBusy}
              runAction={runAction}
              selectedVenueId={selectedVenueId}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'stats' ? (
            <StatsCrm disabled={!isOnline || isBusy} onRefresh={refreshStats} stats={stats} />
          ) : null}
        </main>
      </section>
    </div>
  )
}

function getSectionTitle(section: CrmSection) {
  if (section === 'access') {
    return 'Locales, dispositivos y usuarios'
  }
  if (section === 'products') {
    return 'Gestion de productos y precios'
  }
  if (section === 'categories') {
    return 'Categorias del catalogo'
  }
  if (section === 'sale-formats') {
    return 'Formatos de venta'
  }
  if (section === 'import') {
    return 'Importar y exportar catalogo'
  }
  if (section === 'tables') {
    return 'Mesas y zonas del local'
  }
  if (section === 'reports') {
    return 'Informes de ventas'
  }
  if (section === 'stats') {
    return 'Analitica comercial'
  }

  return 'Panel de control'
}

type RunAction = (action: () => Promise<void>) => Promise<void>

type AccessManagementCrmProps = {
  disabled: boolean
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
}

function AccessManagementCrm({
  disabled,
  onVenuesChanged,
  runAction,
  tenantContext,
}: AccessManagementCrmProps) {
  const [data, setData] = useState<CrmAccessData>({ devices: [], users: [], venues: [] })
  const [venueName, setVenueName] = useState('')
  const [deviceName, setDeviceName] = useState('')
  const [deviceVenueId, setDeviceVenueId] = useState('')
  const [deviceMode, setDeviceMode] = useState<'satellite' | 'checkout' | 'hybrid'>('checkout')
  const [userName, setUserName] = useState('')
  const [userEmail, setUserEmail] = useState('')
  const [userPassword, setUserPassword] = useState('')
  const [userDeviceId, setUserDeviceId] = useState('')
  const [editingUserId, setEditingUserId] = useState<string | null>(null)
  const [editingUserName, setEditingUserName] = useState('')
  const [editingUserEmail, setEditingUserEmail] = useState('')
  const [editingUserPassword, setEditingUserPassword] = useState('')
  const [editingUserDeviceId, setEditingUserDeviceId] = useState('')
  const [editingUserDeviceMode, setEditingUserDeviceMode] = useState<DeviceMode>('checkout')

  const refresh = useCallback(async () => {
    setData(await loadCrmAccessData(tenantContext))
  }, [tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  useEffect(() => {
    if (!deviceVenueId && data.venues.length) {
      setDeviceVenueId(data.venues[0].id)
    }

    const assignedDevices = new Set(data.users.filter((user) => user.isActive).map((user) => user.deviceId))
    const firstAvailableDevice = data.devices.find((device) => device.isActive && !assignedDevices.has(device.id))

    if (!userDeviceId || assignedDevices.has(userDeviceId)) {
      setUserDeviceId(firstAvailableDevice?.id ?? '')
    }
  }, [data, deviceVenueId, userDeviceId])

  async function submitVenue(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      await createCrmVenue(tenantContext, venueName)
      setVenueName('')
      await Promise.all([refresh(), onVenuesChanged()])
    })
  }

  async function submitVenueTax(event: FormEvent<HTMLFormElement>, venue: CrmVenue) {
    event.preventDefault()
    const defaultTaxRate = Number(new FormData(event.currentTarget).get('defaultTaxRate'))

    await runAction(async () => {
      await updateCrmVenueDefaultTaxRate(tenantContext, venue.id, defaultTaxRate)
      await Promise.all([refresh(), onVenuesChanged()])
      sileo.success({
        description: `Los productos que heredan IVA en ${venue.name} usaran el ${defaultTaxRate} % en futuras ventas.`,
        title: 'IVA por defecto actualizado',
      })
    })
  }

  async function submitDevice(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      await createCrmDevice(tenantContext, deviceVenueId, deviceName, deviceMode)
      setDeviceName('')
      await refresh()
    })
  }

  async function submitUser(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    await runAction(async () => {
      await createCrmPosUser(tenantContext, {
        deviceId: userDeviceId,
        email: userEmail.trim(),
        fullName: userName.trim(),
        password: userPassword,
      })
      setUserName('')
      setUserEmail('')
      setUserPassword('')
      await refresh()
    })
  }

  async function toggleUser(userId: string, isActive: boolean) {
    await runAction(async () => {
      await setCrmPosUserActive(tenantContext, userId, isActive)
      await refresh()
    })
  }

  function startEditingUser(user: CrmPosUser) {
    const assignedDevice = data.devices.find((device) => device.id === user.deviceId)
    setEditingUserId(user.id)
    setEditingUserName(user.fullName)
    setEditingUserEmail(user.email)
    setEditingUserPassword('')
    setEditingUserDeviceId(user.deviceId)
    setEditingUserDeviceMode(assignedDevice?.deviceMode ?? 'checkout')
  }

  async function releaseUserLogin(user: CrmPosUser) {
    if (!window.confirm(`Liberar la sesion de "${user.fullName || user.email}"? El dispositivo se desconectara en menos de 30 segundos.`)) return

    await runAction(async () => {
      await releaseCrmPosUserLogin(tenantContext, user.id)
      await refresh()
    })
  }

  function cancelEditingUser() {
    setEditingUserId(null)
    setEditingUserName('')
    setEditingUserEmail('')
    setEditingUserPassword('')
    setEditingUserDeviceId('')
    setEditingUserDeviceMode('checkout')
  }

  function changeEditingUserDevice(deviceId: string) {
    setEditingUserDeviceId(deviceId)
    const selectedDevice = data.devices.find((device) => device.id === deviceId)
    if (selectedDevice) setEditingUserDeviceMode(selectedDevice.deviceMode)
  }

  async function submitUserEdit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!editingUserId) return

    await runAction(async () => {
      await updateCrmPosUser(tenantContext, editingUserId, {
        deviceId: editingUserDeviceId,
        deviceMode: editingUserDeviceMode,
        email: editingUserEmail.trim(),
        fullName: editingUserName.trim(),
        password: editingUserPassword || undefined,
      })
      cancelEditingUser()
      await refresh()
    })
  }

  async function removeUser(user: CrmPosUser) {
    if (!window.confirm(`Eliminar la cuenta TPV de "${user.fullName || user.email}"? Esta accion no se puede deshacer.`)) return

    await runAction(async () => {
      await deleteCrmPosUser(tenantContext, user.id)
      if (editingUserId === user.id) cancelEditingUser()
      await refresh()
    })
  }

  const venueById = new Map(data.venues.map((venue) => [venue.id, venue]))
  const deviceById = new Map(data.devices.map((device) => [device.id, device]))
  const assignedDeviceIds = new Set(data.users.filter((user) => user.isActive).map((user) => user.deviceId))
  const availableDevices = data.devices.filter((device) => device.isActive && !assignedDeviceIds.has(device.id))

  return (
    <div className="crm-access-layout !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[340px_minmax(0,1fr)] xl:!gap-6">
      <div className="crm-access-forms">
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Nuevo local</span><Building2 className="h-4 w-4" /></div>
          <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitVenue(event)}>
            <Field label="Nombre del local">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setVenueName(event.target.value)} required value={venueName} />
            </Field>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !venueName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear local
            </button>
          </form>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Configuracion de locales</span><Building2 className="h-4 w-4" /></div>
          <div className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]">
            {data.venues.map((venue) => (
              <form className="!grid !gap-2 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !p-3.5" key={venue.id} onSubmit={(event) => void submitVenueTax(event, venue)}>
                <strong className="!text-[13px] !text-[var(--crm-text)]">{venue.name}</strong>
                <Field label="IVA por defecto">
                  <select
                    className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none"
                    defaultValue={String(venue.defaultTaxRate)}
                    disabled={disabled}
                    name="defaultTaxRate"
                  >
                    {COMMON_TAX_RATES.map((rate) => <option key={rate} value={rate}>{rate} %</option>)}
                  </select>
                </Field>
                <p className="crm-form-help">Se aplicara a los productos que no tengan un IVA especifico.</p>
                <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)]" disabled={disabled} type="submit">
                  <Save className="h-4 w-4" /> Guardar IVA
                </button>
              </form>
            ))}
          </div>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Nuevo dispositivo</span><MonitorSmartphone className="h-4 w-4" /></div>
          <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitDevice(event)}>
            <Field label="Local">
              <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setDeviceVenueId(event.target.value)} required value={deviceVenueId}>
                {data.venues.filter((venue) => venue.isActive).map((venue) => <option key={venue.id} value={venue.id}>{venue.name}</option>)}
              </select>
            </Field>
            <Field label="Nombre del dispositivo">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setDeviceName(event.target.value)} required value={deviceName} />
            </Field>
            <Field label="Modo"><select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setDeviceMode(event.target.value as typeof deviceMode)} value={deviceMode}><option value="satellite">Satelite</option><option value="checkout">Caja</option><option value="hybrid">Hibrido</option></select></Field>
            <p className="crm-form-help">Los dispositivos Caja e Hibrido crean automaticamente su propio punto de caja. Los Satelite solo trabajan con cajas ya abiertas.</p>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !deviceVenueId || !deviceName.trim()} type="submit">
              <Plus className="h-4 w-4" /> Crear dispositivo
            </button>
          </form>
        </section>

        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]"><span>Nuevo usuario TPV</span><UserRound className="h-4 w-4" /></div>
          <form className="crm-form-stack !grid !gap-3.5 !px-[22px] !pt-5 !pb-[22px]" onSubmit={(event) => void submitUser(event)}>
            <Field label="Nombre">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setUserName(event.target.value)} required value={userName} />
            </Field>
            <Field label="Email">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setUserEmail(event.target.value)} required type="email" value={userEmail} />
            </Field>
            <Field label="Contrasena inicial">
              <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} minLength={8} onChange={(event) => setUserPassword(event.target.value)} required type="password" value={userPassword} />
            </Field>
            <Field label="Dispositivo">
              <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setUserDeviceId(event.target.value)} required value={userDeviceId}>
                {availableDevices.map((device) => (
                  <option key={device.id} value={device.id}>{venueById.get(device.venueId)?.name} / {device.name}</option>
                ))}
              </select>
            </Field>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !userDeviceId || userPassword.length < 8} type="submit">
              <Plus className="h-4 w-4" /> Crear usuario
            </button>
          </form>
        </section>
      </div>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-access-users">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title"><h2>Usuarios de caja</h2><p>{data.users.length} cuentas configuradas · cierre tras 30 min sin actividad</p></div>
          <button aria-label="Actualizar usuarios" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void runAction(refresh)} type="button"><RefreshCw className="h-4 w-4" /></button>
        </div>
        <div className="crm-access-user-list">
          {data.users.map((user) => {
            const device = deviceById.get(user.deviceId)
            const venue = venueById.get(user.venueId)
            const deviceModeLabel = device?.deviceMode === 'satellite' ? 'Satelite' : device?.deviceMode === 'hybrid' ? 'Hibrido' : 'Caja'
            const editDevices = data.devices.filter((candidate) => (
              candidate.isActive
              && (!assignedDeviceIds.has(candidate.id) || (user.isActive && candidate.id === user.deviceId))
            ))
            const isEditing = editingUserId === user.id
            return (
              <div className="crm-access-user-entry" key={user.id}>
                <div className="crm-access-user-row !grid !min-h-[72px] !grid-cols-1 !items-center !gap-3.5 !py-2.5 sm:!grid-cols-[minmax(0,1fr)_auto] lg:!grid-cols-[minmax(180px,1fr)_minmax(170px,0.8fr)_100px_minmax(300px,auto)]">
                  <div className="crm-cell-main"><strong>{user.fullName || user.email}</strong><span>{user.email}</span></div>
                  <div className="crm-cell-main !col-span-1 sm:!col-span-full lg:!col-span-1">
                    <strong>{venue?.name ?? (user.hasDeviceAssignment ? 'Local no disponible' : 'Pendiente de asignar')}</strong>
                    <span>{device ? `${device.name} · ${deviceModeLabel}` : user.hasDeviceAssignment ? 'Dispositivo no disponible' : 'Edita el usuario para asignarle un dispositivo'}</span>
                  </div>
                  <div className="crm-user-statuses !col-start-1 !grid !justify-items-start !gap-[5px] sm:!col-auto">
                    <span className={user.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
                      {user.isActive ? 'Activo' : user.hasDeviceAssignment ? 'Inactivo' : 'Sin asignar'}
                    </span>
                    <span
                      className={user.hasActiveLogin ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}
                      title={user.loginHeartbeatAt ? `Ultima actividad: ${formatCrmDateTime(user.loginHeartbeatAt)}` : undefined}
                    >
                      {user.hasActiveLogin ? 'En sesion' : 'Libre'}
                    </span>
                  </div>
                  <div className="crm-access-user-actions !col-start-1 !flex !items-center !justify-start !gap-2 sm:!col-span-full lg:!col-auto lg:!justify-end">
                    <button aria-label="Editar usuario" className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => startEditingUser(user)} title="Editar y reasignar" type="button"><Pencil className="h-4 w-4" /></button>
                    {tenantContext.role === 'owner' ? (
                      <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !user.hasActiveLogin} onClick={() => void releaseUserLogin(user)} title="Cerrar la sesion abierta de este usuario" type="button">
                        <LogOut className="h-4 w-4" /> Liberar
                      </button>
                    ) : null}
                    <button className={user.isActive ? 'crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150'} disabled={disabled || !user.hasDeviceAssignment} onClick={() => void toggleUser(user.id, !user.isActive)} type="button">
                      {user.isActive ? 'Desactivar' : 'Activar'}
                    </button>
                    <button aria-label="Eliminar usuario" className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void removeUser(user)} title="Eliminar usuario" type="button"><Trash2 className="h-4 w-4" /></button>
                  </div>
                </div>
                {isEditing ? (
                  <form className="crm-access-user-editor !grid !grid-cols-1 !gap-3 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-surface-soft)] !p-4 !mb-3.5 md:!grid-cols-2" onSubmit={(event) => void submitUserEdit(event)}>
                    <Field label="Nombre">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setEditingUserName(event.target.value)} required value={editingUserName} />
                    </Field>
                    <Field label="Email">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setEditingUserEmail(event.target.value)} required type="email" value={editingUserEmail} />
                    </Field>
                    <Field label="Nueva contrasena (opcional)">
                      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} minLength={8} onChange={(event) => setEditingUserPassword(event.target.value)} placeholder="Dejar vacio para conservarla" type="password" value={editingUserPassword} />
                    </Field>
                    <Field label="Dispositivo">
                      <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => changeEditingUserDevice(event.target.value)} required value={editingUserDeviceId}>
                        <option disabled value="">Selecciona un dispositivo libre</option>
                        {editDevices.map((candidate) => (
                          <option key={candidate.id} value={candidate.id}>{venueById.get(candidate.venueId)?.name} / {candidate.name}</option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Modo de trabajo">
                      <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" disabled={disabled} onChange={(event) => setEditingUserDeviceMode(event.target.value as DeviceMode)} value={editingUserDeviceMode}>
                        <option value="checkout">Caja</option>
                        <option value="satellite">Satelite</option>
                        <option value="hybrid">Hibrido</option>
                      </select>
                    </Field>
                    <div className="crm-access-user-editor-actions !col-auto !flex !items-center !justify-stretch !gap-2 [&>button]:!flex-1 md:!col-span-full md:!justify-end md:[&>button]:!flex-none">
                      <button className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={cancelEditingUser} type="button"><X className="h-4 w-4" /> Cancelar</button>
                      <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !editingUserName.trim() || !editingUserEmail.trim() || !editingUserDeviceId || (editingUserPassword.length > 0 && editingUserPassword.length < 8)} type="submit"><Save className="h-4 w-4" /> Guardar cambios</button>
                    </div>
                  </form>
                ) : null}
              </div>
            )
          })}
          {!data.users.length ? <EmptyList message="No hay usuarios TPV creados." /> : null}
        </div>
      </section>
    </div>
  )
}

type DashboardCrmProps = {
  activeCategories: number
  activeProducts: number
  categories: Category[]
  disabled: boolean
  onRefresh: () => Promise<void>
  products: Product[]
  stats: CrmStats | null
}

function DashboardCrm({
  activeCategories,
  activeProducts,
  categories,
  disabled,
  onRefresh,
  products,
  stats,
}: DashboardCrmProps) {
  const categoryBars = categories.map((category) => ({
    ...category,
    count: products.filter((product) => product.categoryId === category.id).length,
  }))
  const maxCategoryCount = Math.max(1, ...categoryBars.map((category) => category.count))
  const activeRatio = products.length ? Math.round((activeProducts / products.length) * 100) : 0

  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Resumen del catalogo</span>
          <button aria-label="Actualizar resumen" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="blue" label="Productos activos" value={activeProducts} />
          <KpiCard color="neutral" label="Productos totales" value={products.length} />
          <KpiCard color="neutral" label="Categorias" value={categories.length} />
          <KpiCard color="green" label="Activas" value={activeCategories} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Cajas abiertas</span>
          <button aria-label="Actualizar cajas abiertas" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <OpenCashSessionsList stats={stats} />
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Estado de catalogo</span>
        </div>
        <div className="crm-donut-row !grid !grid-cols-1 !items-center !gap-[18px] !px-[22px] !pt-[18px] !pb-6 md:!grid-cols-[190px_minmax(0,1fr)]">
          <div className="crm-donut" style={{ '--crm-progress': `${activeRatio}%` } as CSSProperties}>
            <span>{activeRatio}%</span>
          </div>
          <div className="crm-stat-list">
            <div>
              <span>Activos</span>
              <strong>{activeProducts}</strong>
            </div>
            <div>
              <span>Ocultos</span>
              <strong>{products.length - activeProducts}</strong>
            </div>
            <div>
              <span>Ventas mes</span>
              <strong>{formatMoney(stats?.monthSalesCents ?? 0)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Actividad del mes</span>
        </div>
        <div className="crm-mini-metrics">
          <MiniMetric label="Tickets" value={String(stats?.monthTicketCount ?? 0)} />
          <MiniMetric label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <MiniMetric label="Ingresos" value={formatMoney(stats?.monthSalesCents ?? 0)} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos por categoria</span>
        </div>
        <div className="crm-horizontal-bars">
          {categoryBars.map((category) => (
            <div className="crm-bar-row" key={category.id}>
              <span>{category.name}</span>
              <div>
                <i style={{ width: `${Math.max(8, (category.count / maxCategoryCount) * 100)}%` }} />
              </div>
              <strong>{category.count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  )
}

function formatCrmDateTime(value: string) {
  const date = new Date(value)

  if (Number.isNaN(date.getTime())) {
    return value
  }

  return crmDateTimeFormatter.format(date)
}

function OpenCashSessionsList({ stats }: { stats: CrmStats | null }) {
  const sessions = stats?.openCashSessions ?? []
  const totalOpenSalesCents = sessions.reduce((total, session) => total + session.salesCents, 0)

  if (!stats) {
    return <EmptyList message="Cargando cajas abiertas." />
  }

  if (!sessions.length) {
    return <EmptyList message="No hay cajas abiertas." />
  }

  return (
    <div className="crm-open-cash">
      <div className="crm-open-cash-summary !flex !min-h-[62px] !flex-col !items-start !justify-between !gap-3 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-green-soft)] !px-4 !py-3 md:!flex-row md:!items-center">
        <span>{sessions.length} cajas abiertas</span>
        <strong>{formatMoney(totalOpenSalesCents)}</strong>
      </div>
      <div className="crm-open-cash-list">
        {sessions.map((session) => (
          <div className="crm-open-cash-row !grid !grid-cols-2 !items-center !gap-3.5 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !py-[13px] md:!grid-cols-[minmax(0,1fr)_repeat(3,minmax(80px,max-content))] xl:!grid-cols-[minmax(210px,1fr)_minmax(104px,0.32fr)_minmax(78px,0.2fr)_minmax(92px,0.26fr)_minmax(240px,0.8fr)]" key={session.id}>
            <div className="crm-cell-main !col-span-full md:!col-span-1">
              <strong>{session.deviceName}</strong>
              <span>{`${session.venueName} - abierta ${formatCrmDateTime(session.openedAt)}`}</span>
            </div>
            <div className="crm-open-cash-metric">
              <span>Facturado</span>
              <strong>{formatMoney(session.salesCents)}</strong>
            </div>
            <div className="crm-open-cash-metric">
              <span>Tickets</span>
              <strong>{session.ticketCount}</strong>
            </div>
            <div className="crm-open-cash-metric">
              <span>Fondo</span>
              <strong>{formatMoney(session.openingFloatCents)}</strong>
            </div>
            <div className="crm-open-cash-breakdown !col-span-full !flex !min-w-0 !flex-wrap !justify-start !gap-[5px] xl:!col-span-1 xl:!justify-end">
              <span>{`${paymentLabels.cash}: ${formatMoney(session.cashCents)}`}</span>
              <span>{`${paymentLabels.card}: ${formatMoney(session.cardCents)}`}</span>
              <span>{`${paymentLabels.invitation}: ${formatMoney(session.invitationCents)}`}</span>
              <span>{`${paymentLabels.other}: ${formatMoney(session.otherCents)}`}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const kpiColorClasses = {
  blue: {
    card: '!bg-[var(--crm-blue)]',
    label: '!text-white/85',
    value: '!text-white',
  },
  green: {
    card: '!bg-[var(--crm-green)]',
    label: '!text-white/85',
    value: '!text-white',
  },
  neutral: {
    card: '!bg-[var(--crm-surface-soft)]',
    label: '!text-[var(--crm-text-secondary)]',
    value: '!text-[var(--crm-text)]',
  },
} as const

function KpiCard({ color, label, value }: { color: keyof typeof kpiColorClasses; label: string; value: number | string }) {
  const colorClasses = kpiColorClasses[color]

  return (
    <div className={`crm-kpi !flex !min-h-[126px] !flex-col !items-start !justify-end !rounded-[18px] !border-0 !p-[22px] !text-left md:!min-h-[150px] ${colorClasses.card}`}>
      <strong className={`!text-[26px] !leading-none !font-bold !tracking-[-0.04em] !tabular-nums ${colorClasses.value}`}>{value}</strong>
      <span className={`!mt-[9px] !text-xs !font-medium ${colorClasses.label}`}>{label}</span>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-mini-metric !flex !min-h-[52px] !min-w-0 !items-center !justify-between !gap-3 !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !py-[11px]">
      <span className="!text-xs !font-medium !text-[var(--crm-text-secondary)]">{label}</span>
      <strong className="!text-[15px] !font-semibold !whitespace-nowrap !text-[var(--crm-text)] !tabular-nums">{value}</strong>
    </div>
  )
}

type RevoImportCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
  venueName: string
}

function RevoImportCrm({
  categories,
  disabled,
  onCatalogChanged,
  products: catalogProducts,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
  venueName,
}: RevoImportCrmProps) {
  const [backupFileError, setBackupFileError] = useState<string | null>(null)
  const [backupFileName, setBackupFileName] = useState('')
  const [backupImportResult, setBackupImportResult] = useState<CatalogBackupImportResult | null>(null)
  const [catalogTransfer, setCatalogTransfer] = useState<ParsedCatalogTransfer | null>(null)
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [importResult, setImportResult] = useState<CatalogImportResult | null>(null)
  const [parseResult, setParseResult] = useState<RevoImportParseResult | null>(null)
  const products = useMemo(() => parseResult?.products ?? [], [parseResult])
  const variantCount = products.reduce((total, product) => total + product.variants.length, 0)
  const allWarnings = useMemo(() => {
    const productWarnings = products.flatMap((product) =>
      product.warnings.map((warning) => `${product.name}: ${warning}`),
    )
    return [...(parseResult?.warnings ?? []), ...productWarnings]
  }, [parseResult?.warnings, products])

  async function handleExportCatalog() {
    if (!selectedVenueId) {
      return
    }

    await runAction(async () => {
      await exportCatalogZip({
        categories,
        products: catalogProducts,
        saleFormats,
        tenantName: tenantContext.tenantName,
        venueName: venueName || 'local',
      })
    })
  }

  async function handleBackupFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setBackupFileError(null)
    setBackupImportResult(null)

    if (!file) {
      return
    }

    setBackupFileName(file.name)
    try {
      setCatalogTransfer(await parseCatalogZip(file))
    } catch (readError) {
      setCatalogTransfer(null)
      setBackupFileError(getReadableError(readError))
    }
  }

  async function handleBackupImport() {
    if (!catalogTransfer || !selectedVenueId) {
      return
    }

    setBackupImportResult(null)
    await runAction(async () => {
      const nextResult = await importCatalogBackup(tenantContext, catalogTransfer, selectedVenueId)
      setBackupImportResult(nextResult)
      await onCatalogChanged()
    })
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setFileError(null)
    setImportResult(null)

    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const nextResult = parseRevoItemsCsv(text)
      setFileName(file.name)
      setParseResult(nextResult)

      if (!nextResult.products.length) {
        setFileError('No se han encontrado productos importables en el CSV.')
      }
    } catch (readError) {
      setFileName(file.name)
      setParseResult(null)
      setFileError(getReadableError(readError))
    }
  }

  async function handleImport() {
    if (!parseResult?.products.length || !selectedVenueId) {
      return
    }

    setImportResult(null)
    await runAction(async () => {
      const nextResult = await importRevoCatalogProducts(tenantContext, parseResult.products, selectedVenueId)
      setImportResult(nextResult)
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Copia completa del catalogo</h2>
            <p>
              Exporta productos, categorias, formatos, precios, modificadores e imagenes a un ZIP, o importa uno en el local seleccionado.
            </p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <button
              className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !selectedVenueId}
              onClick={() => void handleExportCatalog()}
              type="button"
            >
              <Download className="h-4 w-4" />
              Exportar ZIP
            </button>
            <label
              className={
                disabled
                  ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                  : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
              }
            >
              <Upload className="h-4 w-4" />
              Seleccionar ZIP
              <input accept=".zip,application/zip" disabled={disabled} onChange={handleBackupFileChange} type="file" />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !catalogTransfer || !selectedVenueId}
              onClick={() => void handleBackupImport()}
              type="button"
            >
              <Upload className="h-4 w-4" />
              Importar ZIP
            </button>
          </div>
        </div>

        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Productos del local" value={catalogProducts.length} />
          <KpiCard color="blue" label="Categorias" value={categories.length} />
          <KpiCard color="neutral" label="Formatos de venta" value={saleFormats.length} />
          <KpiCard color="neutral" label="Imagenes" value={catalogProducts.filter((product) => product.imageUrl).length} />
        </div>
      </section>

      {backupFileError ? <div className="crm-import-alert crm-import-alert-warning">{backupFileError}</div> : null}

      {catalogTransfer ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>ZIP preparado: {backupFileName}</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Origen" value={catalogTransfer.manifest.source.venueName} />
            <MiniMetric label="Productos" value={String(catalogTransfer.manifest.products.length)} />
            <MiniMetric label="Categorias" value={String(catalogTransfer.manifest.categories.length)} />
            <MiniMetric label="Formatos de venta" value={String(catalogTransfer.manifest.saleFormats.length)} />
            <MiniMetric label="Variantes" value={String(catalogTransfer.manifest.products.reduce((sum, product) => sum + product.variants.length, 0))} />
            <MiniMetric label="Imagenes" value={String(catalogTransfer.images.size)} />
          </div>
        </section>
      ) : null}

      {backupImportResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Resultado de la importacion ZIP</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Categorias creadas / actualizadas" value={`${backupImportResult.categoriesCreated} / ${backupImportResult.categoriesUpdated}`} />
            <MiniMetric label="Formatos creados / actualizados" value={`${backupImportResult.saleFormatsCreated} / ${backupImportResult.saleFormatsUpdated}`} />
            <MiniMetric label="Productos creados / actualizados" value={`${backupImportResult.productsCreated} / ${backupImportResult.productsUpdated}`} />
            <MiniMetric label="Variantes creadas / actualizadas" value={`${backupImportResult.variantsCreated} / ${backupImportResult.variantsUpdated}`} />
            <MiniMetric label="Modificadores creados / actualizados" value={`${backupImportResult.modifiersCreated} / ${backupImportResult.modifiersUpdated}`} />
            <MiniMetric label="Imagenes cargadas" value={String(backupImportResult.imagesUploaded)} />
          </div>
        </section>
      ) : null}

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Importar articulos REVO</h2>
            <p>
              {fileName
                ? `${fileName} - ${products.length} productos y ${variantCount} formatos detectados`
                : 'Selecciona el CSV de articulos exportado desde REVO.'}
            </p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label
              className={
                disabled
                  ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                  : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
              }
            >
              <Upload className="h-4 w-4" />
              Seleccionar CSV
              <input accept=".csv,text/csv" disabled={disabled} onChange={handleFileChange} type="file" />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !parseResult?.products.length || !selectedVenueId}
              onClick={() => void handleImport()}
              type="button"
            >
              <Upload className="h-4 w-4" />
              Importar
            </button>
          </div>
        </div>

        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="blue" label="Productos" value={products.length} />
          <KpiCard color="green" label="Formatos" value={variantCount} />
          <KpiCard color="neutral" label="Avisos" value={allWarnings.length} />
          <KpiCard color="neutral" label="Filas omitidas" value={parseResult?.skippedRows ?? 0} />
        </div>
      </section>

      {fileError ? <div className="crm-import-alert crm-import-alert-warning">{fileError}</div> : null}

      {allWarnings.length ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Avisos de interpretacion</span>
          </div>
          <ul className="crm-import-warning-list">
            {allWarnings.slice(0, 8).map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
            {allWarnings.length > 8 ? <li>{allWarnings.length - 8} avisos mas en el CSV.</li> : null}
          </ul>
        </section>
      ) : null}

      {importResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Resultado de importacion</span>
          </div>
          <div className="crm-import-result-grid !grid !grid-cols-1 !gap-3 !px-[22px] !pt-3.5 !pb-[22px] md:!grid-cols-3">
            <MiniMetric label="Categorias creadas" value={String(importResult.categoriesCreated)} />
            <MiniMetric label="Categorias actualizadas" value={String(importResult.categoriesUpdated)} />
            <MiniMetric label="Productos creados" value={String(importResult.productsCreated)} />
            <MiniMetric label="Productos actualizados" value={String(importResult.productsUpdated)} />
            <MiniMetric label="Formatos creados" value={String(importResult.variantsCreated)} />
            <MiniMetric label="Formatos actualizados" value={String(importResult.variantsUpdated)} />
          </div>
        </section>
      ) : null}

      {parseResult ? (
        <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
          <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
            <span>Previsualizacion</span>
          </div>
          <div className="crm-data-table !grid !overflow-auto crm-import-table">
            <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
              <span>Producto</span>
              <span>Categoria destino</span>
              <span>Formatos</span>
              <span>Precio</span>
              <span>Estado</span>
              <span>Avisos</span>
            </div>
            {products.map((product) => (
              <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]" key={`${product.categoryName}:${product.name}`}>
                <div className="crm-cell-main">
                  <strong>{product.name}</strong>
                  <span>{product.sourceCategories.join(', ') || 'REVO'}</span>
                </div>
                <span>{product.categoryName}</span>
                <div className="crm-format-list">
                  {product.saleFormats.map((format) => (
                    <span key={format}>{getSaleFormatLabel(format)}</span>
                  ))}
                </div>
                <div className="crm-price-list">
                  {product.variants.map((variant) => (
                    <span key={variant.name}>
                      {variant.name}: {formatMoney(variant.priceCents)}
                    </span>
                  ))}
                </div>
                <span className={product.active ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
                  {product.active ? 'Activo' : 'Oculto'}
                </span>
                <span className="crm-import-warning-cell">
                  {product.warnings.length ? product.warnings.join(' ') : 'Sin avisos'}
                </span>
              </div>
            ))}
            {!products.length ? <EmptyList message="Carga un CSV de REVO para ver la previsualizacion." /> : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}

type ProductsCrmProps = {
  defaultTaxRate: number
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
}

type ProductEditorState =
  | {
      mode: 'create'
    }
  | {
      mode: 'edit'
      productId: string
    }

function ProductsCrm({
  defaultTaxRate,
  categories,
  disabled,
  onCatalogChanged,
  products,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
}: ProductsCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [editor, setEditor] = useState<ProductEditorState | null>(null)
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return products
    }

    return products.filter((product) => {
      const categoryName = categoryById.get(product.categoryId)?.name ?? ''
      const variantNames = product.variants.map((variant) => variant.name).join(' ')
      const saleFormatNames = getProductSaleFormats(product).map((format) => getSaleFormatLabel(format, saleFormats)).join(' ')
      return [product.name, product.description ?? '', categoryName, getKindLabel(product.kind), saleFormatNames, variantNames]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [categoryById, products, query, saleFormats])
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedProducts = filteredProducts.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const selectedProduct = editor?.mode === 'edit' ? products.find((product) => product.id === editor.productId) : null

  useEffect(() => {
    setCurrentPage(1)
  }, [selectedVenueId])

  async function handleDeleteProduct(product: Product) {
    if (!window.confirm(`Eliminar el producto "${product.name}" de este local de forma permanente?`)) {
      return
    }

    await runAction(async () => {
      await deleteProduct(tenantContext, product.id)
      await deleteProductImage(tenantContext, product.imagePath).catch(() => undefined)
      if (editor?.mode === 'edit' && editor.productId === product.id) {
        setEditor(null)
      }
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Productos</h2>
            <p>{filteredProducts.length} de {products.length} productos</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar producto"
                value={query}
              />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !categories.length || !selectedVenueId}
              onClick={() => setEditor({ mode: 'create' })}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Anadir producto
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-products-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Producto</span>
            <span>Formatos</span>
            <span>Categoria / Tipo</span>
            <span>Precio final</span>
            <span>Uso</span>
            <span>Acciones</span>
          </div>
          {paginatedProducts.map((product) => (
            <ProductListRow
              category={categoryById.get(product.categoryId)}
              disabled={disabled}
              key={product.id}
              onDelete={() => void handleDeleteProduct(product)}
              onEdit={() => setEditor({ mode: 'edit', productId: product.id })}
              product={product}
              saleFormats={saleFormats}
            />
          ))}
          {!filteredProducts.length ? <EmptyList message="No hay productos que coincidan con la busqueda." /> : null}
        </div>
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredProducts.length}
        />
      </section>

      {editor && (editor.mode === 'create' || selectedProduct) ? (
        <ProductFormPanel
          categories={categories}
          defaultTaxRate={defaultTaxRate}
          disabled={disabled}
          key={editor.mode === 'edit' ? editor.productId : 'create'}
          mode={editor.mode}
          onCatalogChanged={onCatalogChanged}
          onClose={() => setEditor(null)}
          product={selectedProduct ?? undefined}
          runAction={runAction}
          saleFormats={saleFormats}
          selectedVenueId={selectedVenueId}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

type ProductListRowProps = {
  category: Category | undefined
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  product: Product
  saleFormats: SaleFormatDefinition[]
}

function ProductListRow({
  category,
  disabled,
  onDelete,
  onEdit,
  product,
  saleFormats,
}: ProductListRowProps) {
  const primaryVariant = product.variants.find((variant) => variant.isDefault) ?? product.variants[0]
  const usageLabel = canUseProductAsMixer(product)
    ? product.mixerSupplementCents
      ? `Mixer +${formatMoney(product.mixerSupplementCents)}`
      : 'Mixer'
    : canSellProductStandalone(product)
      ? 'Venta directa'
      : 'Interno'

  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <div className="crm-product-cell">
        {product.imageUrl ? (
          <img alt="" className="crm-product-thumb" src={product.imageUrl} />
        ) : (
          <div className="crm-product-thumb crm-product-thumb-empty">
            <Boxes className="h-4 w-4" />
          </div>
        )}
        <div className="crm-cell-main">
          <strong>{product.name}</strong>
          <span>
            {product.description || 'Sin descripcion'} · {product.isActive ? 'Activo' : 'Oculto'} ·{' '}
            {product.isFeatured ? 'Destacado' : 'Normal'}
          </span>
        </div>
      </div>
      <div className="crm-format-list">
        {getProductSaleFormats(product).map((format) => (
          <span key={format}>{getSaleFormatLabel(format, saleFormats)}</span>
        ))}
      </div>
      <span>{category?.name ?? 'Sin categoria'} · {getKindLabel(product.kind)}</span>
      <strong>{formatMoney(primaryVariant?.priceCents ?? 0)}</strong>
      <span className={product.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {usageLabel}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onDelete} type="button">
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}

type PriceInputMode = 'gross' | 'net'

type ProductFormPanelProps = {
  categories: Category[]
  defaultTaxRate: number
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  product?: Product
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
}

function assignProductVariantsToSaleFormats(product: Product, formats: SaleFormat[]) {
  const assignedVariants = new Map<SaleFormat, ProductVariant>()
  const usedVariantIds = new Set<string>()

  formats.forEach((format) => {
    const matchingVariant = findProductVariantForSaleFormat(product, format)
    if (matchingVariant && !usedVariantIds.has(matchingVariant.id)) {
      assignedVariants.set(format, matchingVariant)
      usedVariantIds.add(matchingVariant.id)
    }
  })

  const remainingVariants = product.variants.filter((variant) => !usedVariantIds.has(variant.id))
  formats.forEach((format) => {
    if (assignedVariants.has(format)) return
    const fallbackVariant = remainingVariants.shift()
    if (fallbackVariant) {
      assignedVariants.set(format, fallbackVariant)
      usedVariantIds.add(fallbackVariant.id)
    }
  })

  return assignedVariants
}

function ProductFormPanel({
  categories,
  defaultTaxRate,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  product,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
}: ProductFormPanelProps) {
  const firstCategory = categories[0]
  const isEditing = mode === 'edit'
  const primaryVariant = product?.variants.find((variant) => variant.isDefault) ?? product?.variants[0]
  const initialKind = product?.kind ?? firstCategory?.kind ?? 'other'
  const initialMixerSupplementCents = product?.mixerSupplementCents ?? 0
  const initialSaleFormats = product ? getProductSaleFormats(product) : getDefaultSaleFormatsForKind(initialKind)
  const initialVariantByFormat = product
    ? assignProductVariantsToSaleFormats(product, initialSaleFormats)
    : new Map<SaleFormat, ProductVariant>()
  const initialProductTaxRate = product?.taxRate ?? null
  const initialEffectiveTaxRate = resolveEffectiveTaxRate(initialProductTaxRate, defaultTaxRate)
  const initialGrossPrices = Object.fromEntries(
    saleFormats.map((format) => [
      format.key,
      centsToInput(initialVariantByFormat.get(format.key)?.priceCents ?? primaryVariant?.priceCents ?? 0),
    ]),
  ) as Record<SaleFormat, string>
  const [name, setName] = useState(product?.name ?? '')
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? firstCategory?.id ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [kind, setKind] = useState<CatalogKind>(initialKind)
  const [selectedSaleFormats, setSelectedSaleFormats] = useState<SaleFormat[]>(initialSaleFormats)
  const [taxRateInput, setTaxRateInput] = useState(initialProductTaxRate === null ? 'inherit' : String(initialProductTaxRate))
  const [priceInputMode, setPriceInputMode] = useState<PriceInputMode>('gross')
  const [saleFormatPrices, setSaleFormatPrices] = useState<Record<SaleFormat, string>>(initialGrossPrices)
  const [saleFormatNetPrices, setSaleFormatNetPrices] = useState<Record<SaleFormat, string>>(() => Object.fromEntries(
    saleFormats.map((format) => {
      const grossCents = parseMoneyToCents(initialGrossPrices[format.key] ?? '')
      return [format.key, centsToInput(calculateTaxFromGross(grossCents, initialEffectiveTaxRate).taxableBaseCents)]
    }),
  ))
  const [isFeatured, setIsFeatured] = useState(product?.isFeatured ?? false)
  const [canSellStandalone, setCanSellStandalone] = useState(product ? canSellProductStandalone(product) : true)
  const [canUseAsMixer, setCanUseAsMixer] = useState(product ? canUseProductAsMixer(product) : initialKind === 'mixer')
  const [hasMixerSupplement, setHasMixerSupplement] = useState(initialMixerSupplementCents > 0)
  const [mixerSupplement, setMixerSupplement] = useState(centsToInput(initialMixerSupplementCents || 100))
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState(product?.imageUrl ?? '')
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null)
  const [imageFillColor, setImageFillColor] = useState(getDefaultProductImageFillColor)
  const [imageError, setImageError] = useState<string | null>(null)
  const [shouldRemoveImage, setShouldRemoveImage] = useState(false)
  const selectedCategory = categories.find((category) => category.id === categoryId)
  const selectedTaxRate = taxRateInput === 'inherit' ? null : Number(taxRateInput)
  const effectiveTaxRate = resolveEffectiveTaxRate(selectedTaxRate, defaultTaxRate)

  useEffect(() => {
    if (!categoryId && firstCategory) {
      setCategoryId(firstCategory.id)
    }
  }, [categoryId, firstCategory])

  useEffect(() => {
    return () => {
      if (imageObjectUrl) {
        URL.revokeObjectURL(imageObjectUrl)
      }
    }
  }, [imageObjectUrl])

  function handleCategoryChange(nextCategoryId: string) {
    const nextCategory = categories.find((category) => category.id === nextCategoryId)
    setCategoryId(nextCategoryId)

    if (!isEditing && nextCategory) {
      setKind(nextCategory.kind)
      setSelectedSaleFormats(getDefaultSaleFormatsForKind(nextCategory.kind))
      setCanSellStandalone(true)
      setCanUseAsMixer(nextCategory.kind === 'mixer')
      setHasMixerSupplement(false)
    }
  }

  function toggleSaleFormat(format: SaleFormat) {
    setSelectedSaleFormats((current) =>
      current.includes(format) ? current.filter((currentFormat) => currentFormat !== format) : [...current, format],
    )
  }

  function handleTaxRateChange(nextTaxRateInput: string) {
    const nextProductTaxRate = nextTaxRateInput === 'inherit' ? null : Number(nextTaxRateInput)
    const nextEffectiveTaxRate = resolveEffectiveTaxRate(nextProductTaxRate, defaultTaxRate)
    setTaxRateInput(nextTaxRateInput)

    if (priceInputMode === 'gross') {
      setSaleFormatNetPrices(Object.fromEntries(saleFormats.map((format) => {
        const grossCents = parseMoneyToCents(saleFormatPrices[format.key] ?? '')
        return [format.key, centsToInput(calculateTaxFromGross(grossCents, nextEffectiveTaxRate).taxableBaseCents)]
      })))
      return
    }

    setSaleFormatPrices(Object.fromEntries(saleFormats.map((format) => {
      const netCents = parseMoneyToCents(saleFormatNetPrices[format.key] ?? '')
      return [format.key, centsToInput(calculateGrossFromNet(netCents, nextEffectiveTaxRate).grossTotalCents)]
    })))
  }

  function updateSaleFormatPrice(format: SaleFormat, nextPrice: string) {
    if (priceInputMode === 'gross') {
      setSaleFormatPrices((current) => ({ ...current, [format]: nextPrice }))
      setSaleFormatNetPrices((current) => ({
        ...current,
        [format]: centsToInput(calculateTaxFromGross(parseMoneyToCents(nextPrice), effectiveTaxRate).taxableBaseCents),
      }))
      return
    }

    setSaleFormatNetPrices((current) => ({ ...current, [format]: nextPrice }))
    setSaleFormatPrices((current) => ({
      ...current,
      [format]: centsToInput(calculateGrossFromNet(parseMoneyToCents(nextPrice), effectiveTaxRate).grossTotalCents),
    }))
  }

  function getSaleFormatTaxBreakdown(format: SaleFormat) {
    return calculateTaxFromGross(parseMoneyToCents(saleFormatPrices[format] ?? ''), effectiveTaxRate)
  }

  function handleCanUseAsMixerChange(nextCanUseAsMixer: boolean) {
    setCanUseAsMixer(nextCanUseAsMixer)

    if (!nextCanUseAsMixer) {
      setHasMixerSupplement(false)
    }
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setImageError(null)

    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      setImageError('Selecciona un archivo de imagen valido.')
      return
    }

    const nextObjectUrl = URL.createObjectURL(file)
    setImageFile(file)
    setImageObjectUrl(nextObjectUrl)
    setImagePreviewUrl(nextObjectUrl)
    setShouldRemoveImage(false)
  }

  function removeSelectedImage() {
    setImageFile(null)
    setImageObjectUrl(null)
    setImagePreviewUrl('')
    setImageError(null)
    setShouldRemoveImage(Boolean(product?.imagePath))
  }

  async function saveProduct() {
    if (!selectedCategory || !name.trim() || !selectedVenueId) {
      sileo.error({
        description: 'Revisa el nombre, la categoria y el local antes de guardar.',
        title: 'No se ha podido guardar el producto',
      })
      return
    }

    const activePriceInputs = priceInputMode === 'gross' ? saleFormatPrices : saleFormatNetPrices
    if (!selectedSaleFormats.length || selectedSaleFormats.some((format) => !activePriceInputs[format]?.trim())) {
      sileo.error({
        description: 'Selecciona al menos un formato e introduce su precio.',
        title: 'Faltan precios de venta',
      })
      return
    }

    const formatVariants = selectedSaleFormats.map((format) => ({
      format,
      name: getSaleFormatLabel(format, saleFormats),
      priceCents: parseMoneyToCents(saleFormatPrices[format]),
    }))

    const mixerSupplementCents =
      canUseAsMixer && hasMixerSupplement ? parseMoneyToCents(mixerSupplement) : 0

    await runAction(async () => {
      let uploadedImagePath: string | null = null
      const previousImagePath = product?.imagePath ?? null

      try {
        const nextImagePath = imageFile
          ? await uploadProductImage(tenantContext, imageFile, imageFillColor)
          : shouldRemoveImage
            ? null
            : previousImagePath

        uploadedImagePath = imageFile ? nextImagePath : null

        if (isEditing && product) {
          await updateProduct(tenantContext, product.id, {
            canSellStandalone,
            canUseAsMixer,
            categoryId,
            description: description.trim(),
            imagePath: nextImagePath,
            isFeatured,
            kind,
            mixerSupplementCents,
            name: name.trim(),
            saleFormats: selectedSaleFormats,
            taxRate: selectedTaxRate,
          })

          const assignedVariants = assignProductVariantsToSaleFormats(product, selectedSaleFormats)
          const assignedVariantIds = new Set<string>()
          for (const [index, formatVariant] of formatVariants.entries()) {
            const existingVariant = assignedVariants.get(formatVariant.format)
            if (existingVariant) {
              assignedVariantIds.add(existingVariant.id)
              await updateVariant(tenantContext, existingVariant.id, {
                isDefault: index === 0,
                name: formatVariant.name,
                priceCents: formatVariant.priceCents,
              })
            } else {
              await createVariant(tenantContext, product.id, {
                isDefault: index === 0,
                name: formatVariant.name,
                priceCents: formatVariant.priceCents,
              })
            }
          }

          for (const obsoleteVariant of product.variants.filter((variant) => !assignedVariantIds.has(variant.id))) {
            await deleteVariant(tenantContext, obsoleteVariant.id)
          }
        } else {
          await createProductWithVariant(tenantContext, {
            venueId: selectedVenueId,
            canSellStandalone,
            canUseAsMixer,
            categoryId: selectedCategory.id,
            description: description.trim(),
            imagePath: nextImagePath,
            isFeatured,
            kind,
            mixerSupplementCents,
            name: name.trim(),
            saleFormats: selectedSaleFormats,
            taxRate: selectedTaxRate,
            variants: formatVariants.map(({ name: variantLabel, priceCents }) => ({
              name: variantLabel,
              priceCents,
            })),
          })
        }

        if ((uploadedImagePath || shouldRemoveImage) && previousImagePath && previousImagePath !== nextImagePath) {
          await deleteProductImage(tenantContext, previousImagePath).catch(() => undefined)
        }

        await onCatalogChanged()
        sileo.success({
          description: `${name.trim()} se ha guardado correctamente.`,
          title: isEditing ? 'Producto actualizado' : 'Producto creado',
        })
        onClose()
      } catch (saveError) {
        await deleteProductImage(tenantContext, uploadedImagePath).catch(() => undefined)
        sileo.error({
          description: getReadableError(saveError),
          title: 'No se ha podido guardar el producto',
        })
        throw saveError
      }
    })
  }

  async function toggleProduct() {
    if (!product) {
      return
    }

    await runAction(async () => {
      await updateProduct(tenantContext, product.id, {
        isActive: !product.isActive,
      })
      await onCatalogChanged()
    })
  }

  const editorContent = (
    <>
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>{isEditing ? 'Editar producto' : 'Nuevo producto'}</span>
          <small>{isEditing ? product?.name : 'Alta rapida de catalogo'}</small>
        </div>
        <button aria-label="Cerrar editor de producto" className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="!min-h-0 !flex-1 !overflow-y-auto">
      <form
        className="crm-form-stack !grid !min-h-0 !gap-3.5 !px-[22px] !pt-5 !pb-[22px]"
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
      >
        <Field label="Producto">
          <input autoFocus={!isEditing} className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setName(event.target.value)} value={name} />
        </Field>
        <Field label="Categoria">
          <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => handleCategoryChange(event.target.value)} value={categoryId}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo de producto">
          <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setKind(event.target.value as CatalogKind)} value={kind}>
            {productKindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descripcion">
          <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setDescription(event.target.value)} value={description} />
        </Field>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Imagen</span>
          <div className="crm-image-field !grid !grid-cols-1 !gap-3 md:!grid-cols-[96px_minmax(0,1fr)]">
            <div className="crm-image-preview" style={{ backgroundColor: imageFillColor }}>
              {imagePreviewUrl ? (
                <img alt="" src={imagePreviewUrl} />
              ) : (
                <Boxes className="h-7 w-7" />
              )}
            </div>
            <div className="crm-image-controls">
              <label
                className={
                  disabled
                    ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                    : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
                }
              >
                <Upload className="h-4 w-4" />
                Cargar imagen
                <input accept="image/*" disabled={disabled} onChange={handleImageChange} type="file" />
              </label>
              <label className="crm-color-field">
                <span>Relleno</span>
                <input
                  disabled={disabled || !imageFile}
                  onChange={(event) => setImageFillColor(event.target.value)}
                  type="color"
                  value={imageFillColor}
                />
              </label>
              {imagePreviewUrl ? (
                <button className="crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]" disabled={disabled} onClick={removeSelectedImage} type="button">
                  <X className="h-4 w-4" />
                  Quitar
                </button>
              ) : null}
            </div>
          </div>
          {imageError ? <div className="crm-field-error">{imageError}</div> : null}
        </div>
        <div>
          <Field label="IVA aplicado">
            <select
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none"
              onChange={(event) => handleTaxRateChange(event.target.value)}
              value={taxRateInput}
            >
              <option value="inherit">Usar IVA por defecto del local</option>
              {COMMON_TAX_RATES.map((rate) => <option key={rate} value={rate}>{rate} %</option>)}
            </select>
          </Field>
          {selectedTaxRate === null ? (
            <p className="crm-form-help">Se aplicara el IVA por defecto del local: {defaultTaxRate} %.</p>
          ) : null}
        </div>
        <div>
          <div className="!mb-1.5 !flex !items-center !justify-between !gap-3">
            <span className="crm-field-label !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">
              {priceInputMode === 'gross' ? 'Formatos y precio final' : 'Formatos y base imponible'}
            </span>
            <button
              className="!border-0 !bg-transparent !p-0 !text-xs !font-semibold !text-[var(--crm-blue)]"
              onClick={() => setPriceInputMode((current) => current === 'gross' ? 'net' : 'gross')}
              type="button"
            >
              {priceInputMode === 'gross' ? 'Editar base imponible' : 'Volver a precio final'}
            </button>
          </div>
          {priceInputMode === 'net' ? (
            <p className="crm-form-help !mb-2">Estas editando la base; el precio final se recalcula con el IVA efectivo.</p>
          ) : null}
          <div className="!grid !gap-2">
            {saleFormats.map((option) => {
              const isSelected = selectedSaleFormats.includes(option.key)
              const breakdown = getSaleFormatTaxBreakdown(option.key)
              return (
                <div className="!grid !min-h-[58px] !grid-cols-[minmax(0,1fr)_120px] !items-center !gap-x-3 !gap-y-1 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-3.5 !py-2" key={option.key}>
                  <label className="!flex !min-w-0 !cursor-pointer !items-center !gap-2.5 !text-[13px] !font-semibold !text-[var(--crm-text)]">
                    <input
                      checked={isSelected}
                      className="!size-4 !shrink-0 !accent-[var(--crm-blue)]"
                      onChange={() => toggleSaleFormat(option.key)}
                      type="checkbox"
                    />
                    <span className="!truncate">{option.label}</span>
                  </label>
                  {isSelected ? (
                    <label className="!relative !block">
                      <span className="sr-only">{priceInputMode === 'gross' ? 'Precio final' : 'Base imponible'} de {option.label}</span>
                      <input
                        className="crm-input !h-10 !w-full !rounded-[9px] !border !border-transparent !bg-[var(--crm-input-bg)] !pr-10 !pl-3 !text-right !font-mono !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
                        inputMode="decimal"
                        onChange={(event) => updateSaleFormatPrice(option.key, event.target.value)}
                        placeholder="0,00"
                        value={(priceInputMode === 'gross' ? saleFormatPrices : saleFormatNetPrices)[option.key] ?? ''}
                      />
                      <span className="!pointer-events-none !absolute !top-1/2 !right-3 !-translate-y-1/2 !text-[10px] !font-semibold !text-[var(--crm-text-muted)]">EUR</span>
                    </label>
                  ) : (
                    <span className="!pr-3 !text-right !text-xs !font-medium !text-[var(--crm-text-muted)]">Sin precio</span>
                  )}
                  {isSelected ? (
                    <small className="!col-span-2 !text-[11px] !font-medium !text-[var(--crm-text-muted)]">
                      {priceInputMode === 'net' ? `Precio final: ${formatMoney(breakdown.grossTotalCents)} · ` : ''}
                      Base imponible: {formatMoney(breakdown.taxableBaseCents)} · IVA {effectiveTaxRate} %: {formatMoney(breakdown.taxAmountCents)}
                    </small>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Catalogo</span>
          <div className="crm-checkbox-list">
            <label>
              <input
                checked={isFeatured}
                onChange={(event) => setIsFeatured(event.target.checked)}
                type="checkbox"
              />
              <span>Producto Destacado</span>
            </label>
          </div>
        </div>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Usos</span>
          <div className="crm-checkbox-list">
            <label>
              <input
                checked={canSellStandalone}
                onChange={(event) => setCanSellStandalone(event.target.checked)}
                type="checkbox"
              />
              <span>Venta directa</span>
            </label>
            <label>
              <input
                checked={canUseAsMixer}
                onChange={(event) => handleCanUseAsMixerChange(event.target.checked)}
                type="checkbox"
              />
              <span>Mixer para cubatas</span>
            </label>
          </div>
        </div>
        {canUseAsMixer ? (
          <div>
            <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Suplemento en cubatas</span>
            <div className="crm-checkbox-list">
              <label>
                <input
                  checked={hasMixerSupplement}
                  onChange={(event) => setHasMixerSupplement(event.target.checked)}
                  type="checkbox"
                />
                <span>Aplicar suplemento</span>
              </label>
            </div>
          </div>
        ) : null}
        {canUseAsMixer && hasMixerSupplement ? (
          <Field label="Importe suplemento">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 !font-mono"
              inputMode="decimal"
              onChange={(event) => setMixerSupplement(event.target.value)}
              value={mixerSupplement}
            />
          </Field>
        ) : null}
        <div className="crm-editor-actions">
          <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !categories.length} type="submit">
            <Save className="h-4 w-4" />
            Guardar
          </button>
          {isEditing && product ? (
            <button
              className={product.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
              disabled={disabled}
              onClick={toggleProduct}
              type="button"
            >
              {product.isActive ? 'Marcar oculto' : 'Activar'}
            </button>
          ) : null}
        </div>
      </form>
      </div>
    </>
  )

  return (
    <CrmModal label={isEditing ? 'Editar producto' : 'Anadir producto'} onClose={onClose} size="large">
      {editorContent}
    </CrmModal>
  )
}

type SaleFormatsCrmProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  tenantContext: TenantContext
}

function SaleFormatsCrm({
  disabled,
  onCatalogChanged,
  products,
  runAction,
  saleFormats,
  tenantContext,
}: SaleFormatsCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const productsByFormat = useMemo(() => {
    const nextMap = new Map<SaleFormat, number>()
    products.forEach((product) => {
      getProductSaleFormats(product).forEach((format) => {
        nextMap.set(format, (nextMap.get(format) ?? 0) + 1)
      })
    })
    return nextMap
  }, [products])
  const filteredSaleFormats = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return saleFormats
    }

    return saleFormats.filter((format) =>
      [format.label, format.key].join(' ').toLowerCase().includes(normalizedQuery),
    )
  }, [query, saleFormats])
  const totalPages = Math.max(1, Math.ceil(filteredSaleFormats.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedSaleFormats = filteredSaleFormats.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const nextSortOrder = Math.max(0, ...saleFormats.map((format) => format.sortOrder)) + 1

  function closeCreateDialog() {
    setIsCreateOpen(false)
    setNewLabel('')
  }

  async function addSaleFormat() {
    if (!newLabel.trim()) {
      return
    }

    await runAction(async () => {
      await createSaleFormat(tenantContext, {
        label: newLabel,
        sortOrder: nextSortOrder,
      })
      await onCatalogChanged()
      setNewLabel('')
      setIsCreateOpen(false)
    })
  }

  async function handleDeleteSaleFormat(saleFormat: SaleFormatDefinition) {
    const productCount = productsByFormat.get(saleFormat.key) ?? 0
    const message = productCount
      ? `Eliminar "${saleFormat.label}" y quitarlo de ${productCount} productos?`
      : `Eliminar "${saleFormat.label}"?`

    if (!window.confirm(message)) {
      return
    }

    await runAction(async () => {
      await deleteSaleFormat(tenantContext, saleFormat)
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Formatos de venta</h2>
            <p>{filteredSaleFormats.length} de {saleFormats.length} formatos</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar formato"
                value={query}
              />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled}
              onClick={() => setIsCreateOpen(true)}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Anadir formato
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-sale-formats-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Formato</span>
            <span>Clave</span>
            <span>Productos</span>
            <span>Orden</span>
            <span>Estado</span>
            <span>Acciones</span>
          </div>
          {paginatedSaleFormats.map((saleFormat) => (
            <SaleFormatListRow
              disabled={disabled}
              key={saleFormat.key}
              onCatalogChanged={onCatalogChanged}
              onDelete={() => void handleDeleteSaleFormat(saleFormat)}
              productCount={productsByFormat.get(saleFormat.key) ?? 0}
              runAction={runAction}
              saleFormat={saleFormat}
              tenantContext={tenantContext}
            />
          ))}
          {!filteredSaleFormats.length ? <EmptyList message="No hay formatos que coincidan con la busqueda." /> : null}
        </div>
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredSaleFormats.length}
        />
      </section>

      {isCreateOpen ? (
        <CrmModal label="Anadir formato de venta" onClose={closeCreateDialog}>
          <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div>
              <span>Nuevo formato de venta</span>
              <small>Define el nombre que aparecera en el catalogo.</small>
            </div>
            <button
              aria-label="Cerrar dialogo de formato"
              className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              onClick={closeCreateDialog}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <form
            className="crm-form-stack !grid !min-h-0 !gap-3.5 !overflow-y-auto !px-[22px] !pt-5 !pb-[22px]"
            onSubmit={(event) => {
              event.preventDefault()
              void addSaleFormat()
            }}
          >
            <Field label="Nombre">
              <input
                autoFocus
                className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
                onChange={(event) => setNewLabel(event.target.value)}
                placeholder="Por ejemplo, Copa"
                value={newLabel}
              />
            </Field>
            <div className="crm-editor-actions">
              <button
                className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
                onClick={closeCreateDialog}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
                disabled={disabled || !newLabel.trim()}
                type="submit"
              >
                <Plus className="h-4 w-4" />
                Crear formato
              </button>
            </div>
          </form>
        </CrmModal>
      ) : null}
    </div>
  )
}

type SaleFormatListRowProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  onDelete: () => void
  productCount: number
  runAction: RunAction
  saleFormat: SaleFormatDefinition
  tenantContext: TenantContext
}

function SaleFormatListRow({
  disabled,
  onCatalogChanged,
  onDelete,
  productCount,
  runAction,
  saleFormat,
  tenantContext,
}: SaleFormatListRowProps) {
  const [label, setLabel] = useState(saleFormat.label)
  const [sortOrder, setSortOrder] = useState(String(saleFormat.sortOrder))

  async function saveSaleFormat() {
    await runAction(async () => {
      await updateSaleFormat(tenantContext, saleFormat, {
        label,
        sortOrder: Number.parseInt(sortOrder, 10) || saleFormat.sortOrder,
      })
      await onCatalogChanged()
    })
  }

  async function toggleSaleFormat() {
    await runAction(async () => {
      await updateSaleFormat(tenantContext, saleFormat, {
        isActive: !saleFormat.isActive,
      })
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setLabel(event.target.value)} value={label} />
      <code className="crm-code-cell">{saleFormat.key}</code>
      <strong>{productCount}</strong>
      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 !font-mono" inputMode="numeric" onChange={(event) => setSortOrder(event.target.value)} value={sortOrder} />
      <span className={saleFormat.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {saleFormat.isActive ? 'Activo' : 'Oculto'}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void saveSaleFormat()} type="button">
          <Save className="h-4 w-4" />
          Guardar
        </button>
        <button
          className={saleFormat.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
          disabled={disabled}
          onClick={() => void toggleSaleFormat()}
          type="button"
        >
          {saleFormat.isActive ? 'Ocultar' : 'Activar'}
        </button>
        <button className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onDelete} type="button">
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}

type CategoriesCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  tenantContext: TenantContext
}

type CategoryEditorState =
  | {
      mode: 'create'
    }
  | {
      categoryId: string
      mode: 'edit'
    }

function CategoriesCrm({ categories, disabled, onCatalogChanged, products, runAction, tenantContext }: CategoriesCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [editor, setEditor] = useState<CategoryEditorState | null>(null)
  const productsByCategory = useMemo(() => {
    const nextMap = new Map<string, number>()
    products.forEach((product) => {
      nextMap.set(product.categoryId, (nextMap.get(product.categoryId) ?? 0) + 1)
    })
    return nextMap
  }, [products])
  const filteredCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return categories
    }

    return categories.filter((category) =>
      [category.name, category.kind, getKindLabel(category.kind)].join(' ').toLowerCase().includes(normalizedQuery),
    )
  }, [categories, query])
  const totalPages = Math.max(1, Math.ceil(filteredCategories.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedCategories = filteredCategories.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const selectedCategory =
    editor?.mode === 'edit' ? categories.find((category) => category.id === editor.categoryId) : null

  async function handleDeleteCategory(category: Category) {
    const productCount = productsByCategory.get(category.id) ?? 0

    if (productCount > 0 || !window.confirm(`Eliminar la categoria "${category.name}" de forma permanente?`)) {
      return
    }

    await runAction(async () => {
      await deleteCategory(tenantContext, category.id)
      if (editor?.mode === 'edit' && editor.categoryId === category.id) {
        setEditor(null)
      }
      await onCatalogChanged()
    })
  }

  return (
    <div className={editor?.mode === 'edit' ? 'crm-entity-layout !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1fr)_410px] xl:!gap-6' : 'crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4'}>
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Categorias</h2>
            <p>{filteredCategories.length} de {categories.length} categorias</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar categoria"
                value={query}
              />
            </label>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => setEditor({ mode: 'create' })} type="button">
              <Plus className="h-4 w-4" />
              Anadir categoria
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-categories-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Categoria</span>
            <span>Tipo</span>
            <span>Productos</span>
            <span>Estado</span>
            <span>Acciones</span>
          </div>
          {paginatedCategories.map((category) => {
            const productCount = productsByCategory.get(category.id) ?? 0
            return (
              <CategoryListRow
                category={category}
                disabled={disabled}
                key={category.id}
                onDelete={() => void handleDeleteCategory(category)}
                onEdit={() => setEditor({ categoryId: category.id, mode: 'edit' })}
                productCount={productCount}
              />
            )
          })}
          {!filteredCategories.length ? <EmptyList message="No hay categorias que coincidan con la busqueda." /> : null}
        </div>
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredCategories.length}
        />
      </section>

      {editor && (editor.mode === 'create' || selectedCategory) ? (
        <CategoryFormPanel
          categories={categories}
          category={selectedCategory ?? undefined}
          disabled={disabled}
          key={editor.mode === 'edit' ? editor.categoryId : 'create'}
          mode={editor.mode}
          onCatalogChanged={onCatalogChanged}
          onClose={() => setEditor(null)}
          runAction={runAction}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

type CategoryListRowProps = {
  category: Category
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  productCount: number
}

function CategoryListRow({ category, disabled, onDelete, onEdit, productCount }: CategoryListRowProps) {
  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <div className="crm-cell-main">
        <strong>{category.name}</strong>
        <span>Orden {category.sortOrder}</span>
      </div>
      <span>{getKindLabel(category.kind)}</span>
      <strong>{productCount}</strong>
      <span className={category.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {category.isActive ? 'Activa' : 'Oculta'}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button
          className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
          disabled={disabled || productCount > 0}
          onClick={onDelete}
          title={productCount > 0 ? 'No se puede eliminar una categoria con productos asociados.' : undefined}
          type="button"
        >
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}

type CategoryFormPanelProps = {
  categories: Category[]
  category?: Category
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  runAction: RunAction
  tenantContext: TenantContext
}

function CategoryFormPanel({
  categories,
  category,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  runAction,
  tenantContext,
}: CategoryFormPanelProps) {
  const isEditing = mode === 'edit'
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<CatalogKind>(category?.kind ?? 'alcohol')
  const nextSortOrder = useMemo(() => categories.length + 1, [categories.length])

  async function saveCategory() {
    if (!name.trim()) {
      return
    }

    await runAction(async () => {
      if (isEditing && category) {
        await updateCategory(tenantContext, category.id, {
          kind,
          name: name.trim(),
          sortOrder: category.sortOrder,
        })
      } else {
        await createCategory(tenantContext, {
          kind,
          name: name.trim(),
          sortOrder: nextSortOrder,
        })
      }
      await onCatalogChanged()
      onClose()
    })
  }

  async function toggleCategory() {
    if (!category) {
      return
    }

    await runAction(async () => {
      await updateCategory(tenantContext, category.id, {
        isActive: !category.isActive,
      })
      await onCatalogChanged()
    })
  }

  const editorContent = (
    <>
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>{isEditing ? 'Editar categoria' : 'Nueva categoria'}</span>
          <small>{isEditing ? category?.name : 'Agrupa productos del TPV'}</small>
        </div>
        <button aria-label="Cerrar editor de categoria" className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="crm-form-stack !grid !min-h-0 !gap-3.5 !overflow-y-auto !px-[22px] !pt-5 !pb-[22px]"
        onSubmit={(event) => {
          event.preventDefault()
          void saveCategory()
        }}
      >
      <Field label="Nombre">
        <input autoFocus={!isEditing} className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
      <Field label="Tipo">
        <select className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setKind(event.target.value as CatalogKind)} value={kind}>
          {categoryKindOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="crm-editor-actions">
        <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} type="submit">
          <Save className="h-4 w-4" />
          Guardar
        </button>
        {isEditing && category ? (
          <button
            className={category.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
            disabled={disabled}
            onClick={toggleCategory}
            type="button"
          >
            {category.isActive ? 'Marcar oculta' : 'Activar'}
          </button>
        ) : null}
      </div>
      </form>
    </>
  )

  if (!isEditing) {
    return (
      <CrmModal label="Anadir categoria" onClose={onClose}>
        {editorContent}
      </CrmModal>
    )
  }

  return (
    <aside className="crm-panel !flex !min-w-0 !flex-col !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-editor-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
      {editorContent}
    </aside>
  )
}

function EmptyList({ message }: { message: string }) {
  return <div className="crm-empty-row">{message}</div>
}

type SalesReportView = 'tickets' | 'products' | 'categories' | 'formats'
type SalesReportAggregateView = Exclude<SalesReportView, 'tickets'>
type SalesReportSortDirection = 'asc' | 'desc'
type SalesReportSortKey =
  | 'average'
  | 'createdAt'
  | 'label'
  | 'paymentMethod'
  | 'quantity'
  | 'status'
  | 'ticketCount'
  | 'ticketId'
  | 'totalCents'

type SalesReportLine = CrmSalesReports['tickets'][number]['lines'][number]

function salesReportLineMatches(line: SalesReportLine, productQuery: string, categoryQuery: string) {
  return (!productQuery || normalizeText(line.productName).includes(productQuery))
    && (!categoryQuery || normalizeText(line.categoryName).includes(categoryQuery))
}

function buildSalesReportAggregates(
  tickets: CrmSalesReports['tickets'],
  view: SalesReportAggregateView,
  productQuery: string,
  categoryQuery: string,
) {
  const report = new Map<string, CrmSalesReportAggregate & { ticketIds: Set<string> }>()

  tickets.forEach((ticket) => {
    if (ticket.status !== 'paid') return

    ticket.lines.forEach((line) => {
      if (!salesReportLineMatches(line, productQuery, categoryQuery)) return

      const id = view === 'products'
        ? line.productId ?? `deleted:${normalizeText(line.productName)}`
        : view === 'categories'
          ? line.categoryId ?? 'uncategorized'
          : normalizeText(line.variantName) || 'sin-formato'
      const label = view === 'products'
        ? line.productName
        : view === 'categories'
          ? line.categoryName
          : line.variantName || 'Sin formato'
      const current = report.get(id) ?? {
        id,
        label,
        quantity: 0,
        ticketCount: 0,
        ticketIds: new Set<string>(),
        totalCents: 0,
      }

      current.quantity += line.quantity
      current.totalCents += line.lineTotalCents
      current.ticketIds.add(ticket.id)
      current.ticketCount = current.ticketIds.size
      report.set(id, current)
    })
  })

  return [...report.values()].map((item) => ({
    id: item.id,
    label: item.label,
    quantity: item.quantity,
    ticketCount: item.ticketCount,
    totalCents: item.totalCents,
  }))
}

function compareSalesReportValues(
  left: number | string,
  right: number | string,
  direction: SalesReportSortDirection,
) {
  const comparison = typeof left === 'number' && typeof right === 'number'
    ? left - right
    : String(left).localeCompare(String(right), 'es', { sensitivity: 'base' })

  return direction === 'asc' ? comparison : -comparison
}

const salesReportTabs: Array<{ id: SalesReportView; label: string }> = [
  { id: 'tickets', label: 'Todos los tickets' },
  { id: 'products', label: 'Por producto' },
  { id: 'categories', label: 'Por categoría' },
  { id: 'formats', label: 'Por formato' },
]

type SalesReportsCrmProps = {
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

function SalesReportsCrm({ disabled, runAction, selectedVenueId, tenantContext }: SalesReportsCrmProps) {
  const [activeView, setActiveView] = useState<SalesReportView>('tickets')
  const [categoryQuery, setCategoryQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [isFiltersOpen, setIsFiltersOpen] = useState(false)
  const [productQuery, setProductQuery] = useState('')
  const [reports, setReports] = useState<CrmSalesReports | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SalesReportSortDirection>('desc')
  const [sortKey, setSortKey] = useState<SalesReportSortKey>('createdAt')
  const refresh = useCallback(async () => {
    setReports(await loadCrmSalesReports(tenantContext, selectedVenueId))
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    setReports(null)
    setCurrentPage(1)
    setSelectedTicketId(null)
    void runAction(refresh)
  }, [refresh, runAction])

  const normalizedProductQuery = normalizeText(productQuery.trim())
  const normalizedCategoryQuery = normalizeText(categoryQuery.trim())
  const ticketsInDateRange = useMemo(() => {
    const startAt = dateFrom ? new Date(`${dateFrom}T00:00:00`).getTime() : Number.NEGATIVE_INFINITY
    const endAt = dateTo ? new Date(`${dateTo}T23:59:59.999`).getTime() : Number.POSITIVE_INFINITY

    return (reports?.tickets ?? []).filter((ticket) => {
      const createdAt = new Date(ticket.createdAt).getTime()
      return createdAt >= startAt && createdAt <= endAt
    })
  }, [dateFrom, dateTo, reports])
  const filteredTickets = useMemo(() => ticketsInDateRange.filter((ticket) => {
    if (!normalizedProductQuery && !normalizedCategoryQuery) return true
    return ticket.lines.some((line) => salesReportLineMatches(line, normalizedProductQuery, normalizedCategoryQuery))
  }), [normalizedCategoryQuery, normalizedProductQuery, ticketsInDateRange])
  const activeAggregateView: SalesReportAggregateView = activeView === 'tickets' ? 'products' : activeView
  const activeAggregates = useMemo(() => buildSalesReportAggregates(
    ticketsInDateRange,
    activeAggregateView,
    normalizedProductQuery,
    normalizedCategoryQuery,
  ), [activeAggregateView, normalizedCategoryQuery, normalizedProductQuery, ticketsInDateRange])
  const sortedTickets = useMemo(() => [...filteredTickets].sort((left, right) => {
    const leftValue = sortKey === 'ticketId'
      ? left.id
      : sortKey === 'createdAt'
        ? new Date(left.createdAt).getTime()
        : sortKey === 'quantity'
          ? left.quantity
          : sortKey === 'paymentMethod'
            ? left.paymentMethod ?? ''
            : sortKey === 'status'
              ? left.status
              : left.totalCents
    const rightValue = sortKey === 'ticketId'
      ? right.id
      : sortKey === 'createdAt'
        ? new Date(right.createdAt).getTime()
        : sortKey === 'quantity'
          ? right.quantity
          : sortKey === 'paymentMethod'
            ? right.paymentMethod ?? ''
            : sortKey === 'status'
              ? right.status
              : right.totalCents

    return compareSalesReportValues(leftValue, rightValue, sortDirection)
  }), [filteredTickets, sortDirection, sortKey])
  const sortedAggregates = useMemo(() => [...activeAggregates].sort((left, right) => {
    const leftValue = sortKey === 'label'
      ? left.label
      : sortKey === 'ticketCount'
        ? left.ticketCount
        : sortKey === 'quantity'
          ? left.quantity
          : sortKey === 'average'
            ? left.quantity ? left.totalCents / left.quantity : 0
            : left.totalCents
    const rightValue = sortKey === 'label'
      ? right.label
      : sortKey === 'ticketCount'
        ? right.ticketCount
        : sortKey === 'quantity'
          ? right.quantity
          : sortKey === 'average'
            ? right.quantity ? right.totalCents / right.quantity : 0
            : right.totalCents

    return compareSalesReportValues(leftValue, rightValue, sortDirection)
  }), [activeAggregates, sortDirection, sortKey])
  const matchingPaidTickets = filteredTickets.filter((ticket) => ticket.status === 'paid')
  const salesCents = ticketsInDateRange
    .filter((ticket) => ticket.status === 'paid')
    .flatMap((ticket) => ticket.lines)
    .filter((line) => salesReportLineMatches(line, normalizedProductQuery, normalizedCategoryQuery))
    .reduce((total, line) => total + line.lineTotalCents, 0)
  const totalResults = activeView === 'tickets' ? sortedTickets.length : sortedAggregates.length
  const totalPages = Math.max(1, Math.ceil(totalResults / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const pageStart = (visiblePage - 1) * CRM_PAGE_SIZE
  const visibleTickets = sortedTickets.slice(pageStart, pageStart + CRM_PAGE_SIZE)
  const visibleAggregates = sortedAggregates.slice(pageStart, pageStart + CRM_PAGE_SIZE)
  const activeTab = salesReportTabs.find((tab) => tab.id === activeView) ?? salesReportTabs[0]
  const selectedTicket = reports?.tickets.find((ticket) => ticket.id === selectedTicketId) ?? null
  const productOptions = useMemo(() => [...new Set(
    (reports?.tickets ?? []).flatMap((ticket) => ticket.lines.map((line) => line.productName)),
  )].sort((a, b) => a.localeCompare(b, 'es')), [reports])
  const categoryOptions = useMemo(() => [...new Set(
    (reports?.tickets ?? []).flatMap((ticket) => ticket.lines.map((line) => line.categoryName)),
  )].sort((a, b) => a.localeCompare(b, 'es')), [reports])
  const hasActiveFilters = Boolean(dateFrom || dateTo || productQuery || categoryQuery)
  const activeFilterCount = [dateFrom || dateTo, productQuery, categoryQuery].filter(Boolean).length

  function handleSort(nextSortKey: SalesReportSortKey) {
    setCurrentPage(1)
    if (sortKey === nextSortKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
      return
    }

    setSortKey(nextSortKey)
    setSortDirection(nextSortKey === 'label' || nextSortKey === 'ticketId' || nextSortKey === 'paymentMethod' || nextSortKey === 'status' ? 'asc' : 'desc')
  }

  function clearFilters() {
    setCategoryQuery('')
    setDateFrom('')
    setDateTo('')
    setProductQuery('')
    setCurrentPage(1)
  }

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <div>
            <h2>Resumen histórico</h2>
            <p>Datos del local seleccionado</p>
          </div>
          <button
            aria-label="Actualizar informes de ventas"
            className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
            disabled={disabled}
            onClick={() => void runAction(refresh)}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] sm:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Ventas filtradas" value={formatMoney(salesCents)} />
          <KpiCard color="blue" label="Tickets cobrados" value={matchingPaidTickets.length} />
          <KpiCard color="neutral" label="Ticket medio" value={formatMoney(matchingPaidTickets.length ? Math.round(salesCents / matchingPaidTickets.length) : 0)} />
          <KpiCard color="neutral" label="Tickets anulados" value={filteredTickets.filter((ticket) => ticket.status === 'void').length} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>{activeTab.label}</h2>
            <p>{reports ? `${totalResults} resultados` : 'Cargando información de ventas...'}</p>
          </div>
          <button
            aria-controls="crm-sales-report-filters"
            aria-expanded={isFiltersOpen}
            className={isFiltersOpen
              ? '!inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-blue)] !shadow-none !transition-[background-color,color,transform] !duration-150'
              : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
            onClick={() => setIsFiltersOpen((current) => !current)}
            type="button"
          >
            <SlidersHorizontal className="!size-4" />
            Filtros
            {activeFilterCount ? (
              <span className="!inline-grid !size-5 !place-items-center !rounded-full !bg-[var(--crm-blue)] !text-[10px] !font-bold !text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </button>
        </div>

        <div aria-label="Subsecciones de informes" className="!flex !gap-2 !overflow-x-auto !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-3 md:!px-[22px]" role="tablist">
          {salesReportTabs.map((tab) => (
            <button
              aria-selected={activeView === tab.id}
              className={activeView === tab.id
                ? '!inline-flex !min-h-10 !shrink-0 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-blue-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-blue)] !shadow-none !transition-[background-color,color,transform] !duration-150'
                : 'crm-secondary-button !inline-flex !min-h-10 !shrink-0 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
              key={tab.id}
              onClick={() => {
                setActiveView(tab.id)
                setCurrentPage(1)
                setSortDirection('desc')
                setSortKey(tab.id === 'tickets' ? 'createdAt' : 'totalCents')
              }}
              role="tab"
              type="button"
            >
              {tab.label}
            </button>
          ))}
        </div>

        {isFiltersOpen ? (
        <div className="!grid !grid-cols-1 !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[18px] !py-4 sm:!grid-cols-2 lg:!grid-cols-4 xl:!grid-cols-[minmax(150px,0.65fr)_minmax(150px,0.65fr)_minmax(210px,1fr)_minmax(210px,1fr)_auto] md:!px-[22px]" id="crm-sales-report-filters">
          <Field label="Desde">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              max={dateTo || undefined}
              onChange={(event) => {
                setDateFrom(event.target.value)
                setCurrentPage(1)
              }}
              type="date"
              value={dateFrom}
            />
          </Field>
          <Field label="Hasta">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              min={dateFrom || undefined}
              onChange={(event) => {
                setDateTo(event.target.value)
                setCurrentPage(1)
              }}
              type="date"
              value={dateTo}
            />
          </Field>
          <Field label="Producto">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              list="crm-report-products"
              onChange={(event) => {
                setProductQuery(event.target.value)
                setCurrentPage(1)
              }}
              placeholder="Buscar producto"
              type="search"
              value={productQuery}
            />
            <datalist id="crm-report-products">
              {productOptions.map((product) => <option key={product} value={product} />)}
            </datalist>
          </Field>
          <Field label="Categoría">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              list="crm-report-categories"
              onChange={(event) => {
                setCategoryQuery(event.target.value)
                setCurrentPage(1)
              }}
              placeholder="Buscar categoría"
              type="search"
              value={categoryQuery}
            />
            <datalist id="crm-report-categories">
              {categoryOptions.map((category) => <option key={category} value={category} />)}
            </datalist>
          </Field>
          <div className="!flex !items-end sm:!col-span-2 lg:!col-span-4 xl:!col-span-1">
            <button
              className="crm-secondary-button !inline-flex !h-11 !w-full !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150 xl:!w-auto"
              disabled={!hasActiveFilters}
              onClick={clearFilters}
              type="button"
            >
              <X className="!size-4" />
              Limpiar
            </button>
          </div>
        </div>
        ) : null}

        {activeView === 'tickets' ? (
          <SalesReportTicketsTable
            isLoading={!reports}
            onSelect={setSelectedTicketId}
            onSort={handleSort}
            sortDirection={sortDirection}
            sortKey={sortKey}
            tickets={visibleTickets}
          />
        ) : (
          <SalesReportAggregateTable
            items={visibleAggregates}
            labelHeading={activeView === 'products' ? 'Producto' : activeView === 'categories' ? 'Categoría' : 'Formato'}
            loading={!reports}
            onSort={handleSort}
            sortDirection={sortDirection}
            sortKey={sortKey}
          />
        )}
        <CrmPagination currentPage={visiblePage} onPageChange={setCurrentPage} totalResults={totalResults} />
      </section>

      {selectedTicket ? (
        <SalesReportTicketModal onClose={() => setSelectedTicketId(null)} ticket={selectedTicket} />
      ) : null}
    </div>
  )
}

function SalesReportTicketsTable({
  isLoading,
  onSelect,
  onSort,
  sortDirection,
  sortKey,
  tickets,
}: {
  isLoading: boolean
  onSelect: (ticketId: string) => void
  onSort: (sortKey: SalesReportSortKey) => void
  sortDirection: SalesReportSortDirection
  sortKey: SalesReportSortKey
  tickets: CrmSalesReports['tickets']
}) {
  return (
    <div className="crm-data-table !grid !overflow-auto">
      <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[900px] !grid-cols-[minmax(180px,0.85fr)_minmax(190px,1fr)_110px_130px_110px_130px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Ticket" onSort={onSort} sortKey="ticketId" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Fecha" onSort={onSort} sortKey="createdAt" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Artículos" onSort={onSort} sortKey="quantity" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Método" onSort={onSort} sortKey="paymentMethod" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Estado" onSort={onSort} sortKey="status" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Total" onSort={onSort} sortKey="totalCents" />
      </div>
      {tickets.map((ticket) => (
        <button
          aria-label={`Ver detalles del ticket ${ticket.id.slice(0, 8)}`}
          className="crm-data-row !grid !min-h-[72px] !w-full !min-w-[900px] !cursor-pointer !grid-cols-[minmax(180px,0.85fr)_minmax(190px,1fr)_110px_130px_110px_130px] !items-center !gap-3.5 !border-0 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-left !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !shadow-none !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]"
          key={ticket.id}
          onClick={() => onSelect(ticket.id)}
          type="button"
        >
          <div className="crm-cell-main">
            <strong>#{ticket.id.slice(0, 8).toUpperCase()}</strong>
            <span>{ticket.lineCount} líneas</span>
          </div>
          <span>{crmReportDateTimeFormatter.format(new Date(ticket.createdAt))}</span>
          <span>{ticket.quantity} uds.</span>
          <span>{ticket.paymentMethod ? paymentLabels[ticket.paymentMethod] : 'Sin cobro'}</span>
          <span className={ticket.status === 'paid'
            ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]'
            : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-red-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-red)]'}>
            {ticket.status === 'paid' ? 'Cobrado' : 'Anulado'}
          </span>
          <strong className="!font-mono !text-[var(--crm-text)]">{formatMoney(ticket.totalCents)}</strong>
        </button>
      ))}
      {!tickets.length ? <EmptyList message={isLoading ? 'Cargando tickets...' : 'No hay tickets para este local.'} /> : null}
    </div>
  )
}

function SalesReportSortHeader({
  currentDirection,
  currentKey,
  label,
  onSort,
  sortKey,
}: {
  currentDirection: SalesReportSortDirection
  currentKey: SalesReportSortKey
  label: string
  onSort: (sortKey: SalesReportSortKey) => void
  sortKey: SalesReportSortKey
}) {
  const isActive = currentKey === sortKey
  const SortIcon = isActive ? currentDirection === 'asc' ? ArrowUp : ArrowDown : ArrowUpDown

  return (
    <button
      aria-label={`Ordenar por ${label}`}
      className={isActive
        ? '!inline-flex !w-fit !items-center !gap-1.5 !border-0 !bg-transparent !p-0 !text-left !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-secondary)] !shadow-none'
        : '!inline-flex !w-fit !items-center !gap-1.5 !border-0 !bg-transparent !p-0 !text-left !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)] !shadow-none'}
      onClick={() => onSort(sortKey)}
      type="button"
    >
      <span>{label}</span>
      <SortIcon className="!size-3.5" />
    </button>
  )
}

function SalesReportTicketModal({
  onClose,
  ticket,
}: {
  onClose: () => void
  ticket: CrmSalesReports['tickets'][number]
}) {
  return (
    <CrmModal label={`Detalle del ticket ${ticket.id.slice(0, 8)}`} onClose={onClose} size="large">
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>Ticket #{ticket.id.slice(0, 8).toUpperCase()}</span>
          <small>{crmReportDateTimeFormatter.format(new Date(ticket.createdAt))}</small>
        </div>
        <button
          aria-label="Cerrar detalle del ticket"
          className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="!min-h-0 !overflow-y-auto !px-[18px] !py-5 md:!px-[22px]">
        <div className="!mb-5 !grid !grid-cols-1 !gap-2.5 sm:!grid-cols-2 lg:!grid-cols-4">
          <TicketDetailSummary label="Estado">
            <span className={ticket.status === 'paid'
              ? '!inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]'
              : '!inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-red-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-red)]'}>
              {ticket.status === 'paid' ? 'Cobrado' : 'Anulado'}
            </span>
          </TicketDetailSummary>
          <TicketDetailSummary label="Método de pago">
            <strong>{ticket.paymentMethod ? paymentLabels[ticket.paymentMethod] : 'Sin cobro'}</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Productos">
            <strong>{ticket.lineCount} líneas · {ticket.quantity} uds.</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Total">
            <strong className="!font-mono !text-base">{formatMoney(ticket.totalCents)}</strong>
          </TicketDetailSummary>
        </div>

        {ticket.status === 'void' ? (
          <div className="!mb-4 !rounded-[10px] !bg-[var(--crm-red-soft)] !px-3.5 !py-3 !text-xs !font-semibold !text-[var(--crm-red)]">
            Este ticket fue anulado y no se contabiliza en los informes de ventas.
          </div>
        ) : null}

        <div className="!overflow-x-auto !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)]">
          <div className="!grid !min-h-11 !min-w-[660px] !grid-cols-[minmax(240px,1fr)_minmax(150px,0.65fr)_80px_120px_120px] !items-center !gap-3 !border-b !border-[var(--crm-border)] !px-4 !text-[10px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Producto</span>
            <span>Formato</span>
            <span>Cantidad</span>
            <span>Precio / ud.</span>
            <span>Total</span>
          </div>
          {ticket.lines.map((line) => (
            <div className="!grid !min-h-[68px] !min-w-[660px] !grid-cols-[minmax(240px,1fr)_minmax(150px,0.65fr)_80px_120px_120px] !items-center !gap-3 !border-b !border-[var(--crm-border)] !px-4 !py-3 !text-[13px] !font-medium !text-[var(--crm-text-secondary)] last:!border-b-0" key={line.id}>
              <div className="crm-cell-main">
                <strong>{line.productName}</strong>
                {line.modifiers.length ? (
                  <span>{line.modifiers.map((modifier) => `+ ${modifier.name}${modifier.priceCents ? ` (${formatMoney(modifier.priceCents)})` : ''}`).join(' · ')}</span>
                ) : (
                  <span>Sin modificadores</span>
                )}
              </div>
              <span>{line.variantName || 'Sin formato'}</span>
              <span>{line.quantity}</span>
              <span className="!font-mono">{formatMoney(line.quantity ? Math.round(line.lineTotalCents / line.quantity) : line.unitPriceCents)}</span>
              <strong className="!font-mono !text-[var(--crm-text)]">{formatMoney(line.lineTotalCents)}</strong>
            </div>
          ))}
          {!ticket.lines.length ? <EmptyList message="Este ticket no contiene líneas de producto." /> : null}
        </div>
      </div>

      <div className="!flex !items-center !justify-between !gap-4 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-4 md:!px-[22px]">
        <span className="!text-sm !font-semibold !text-[var(--crm-text-secondary)]">Total del ticket</span>
        <strong className="!font-mono !text-xl !text-[var(--crm-text)]">{formatMoney(ticket.totalCents)}</strong>
      </div>
    </CrmModal>
  )
}

function TicketDetailSummary({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="!grid !min-h-[76px] !content-center !gap-1.5 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-3.5 !py-3">
      <span className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">{label}</span>
      <div className="!text-[13px] !font-semibold !text-[var(--crm-text)]">{children}</div>
    </div>
  )
}

function SalesReportAggregateTable({
  items,
  labelHeading,
  loading,
  onSort,
  sortDirection,
  sortKey,
}: {
  items: CrmSalesReportAggregate[]
  labelHeading: string
  loading: boolean
  onSort: (sortKey: SalesReportSortKey) => void
  sortDirection: SalesReportSortDirection
  sortKey: SalesReportSortKey
}) {
  return (
    <div className="crm-data-table !grid !overflow-auto">
      <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[760px] !grid-cols-[minmax(250px,1fr)_120px_120px_150px_150px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label={labelHeading} onSort={onSort} sortKey="label" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Tickets" onSort={onSort} sortKey="ticketCount" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Unidades" onSort={onSort} sortKey="quantity" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Media / unidad" onSort={onSort} sortKey="average" />
        <SalesReportSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Ventas" onSort={onSort} sortKey="totalCents" />
      </div>
      {items.map((item) => (
        <div className="crm-data-row !grid !min-h-[72px] !min-w-[760px] !grid-cols-[minmax(250px,1fr)_120px_120px_150px_150px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]" key={item.id}>
          <div className="crm-cell-main">
            <strong>{item.label}</strong>
            <span>{item.ticketCount === 1 ? '1 operación' : `${item.ticketCount} operaciones`}</span>
          </div>
          <span>{item.ticketCount}</span>
          <span>{item.quantity}</span>
          <span className="!font-mono">{formatMoney(item.quantity ? Math.round(item.totalCents / item.quantity) : 0)}</span>
          <strong className="!font-mono !text-[var(--crm-text)]">{formatMoney(item.totalCents)}</strong>
        </div>
      ))}
      {!items.length ? <EmptyList message={loading ? 'Calculando informe...' : `No hay ventas agrupadas por ${labelHeading.toLowerCase()}.`} /> : null}
    </div>
  )
}

type StatsCrmProps = {
  disabled: boolean
  onRefresh: () => Promise<void>
  stats: CrmStats | null
}

function StatsCrm({ disabled, onRefresh, stats }: StatsCrmProps) {
  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Ventas del mes</span>
          <button aria-label="Actualizar estadisticas" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Ventas" value={formatMoney(stats?.monthSalesCents ?? 0)} />
          <KpiCard color="blue" label="Tickets" value={stats?.monthTicketCount ?? 0} />
          <KpiCard color="neutral" label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <KpiCard color="neutral" label="Top productos" value={stats?.topProducts.length ?? 0} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Por metodo de pago</span>
        </div>
        <PaymentBreakdown stats={stats} />
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  )
}

function PaymentBreakdown({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-payment-list">
      {(stats?.byPayment ?? []).map((payment) => (
        <div className="crm-payment-row" key={payment.method}>
          <div>
            <strong>{payment.method}</strong>
            <span>{payment.count} operaciones</span>
          </div>
          <b>{formatMoney(payment.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

function TopProductsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-top-list">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="crm-top-row" key={product.productName}>
          <span>{index + 1}</span>
          <div>
            <strong>{product.productName}</strong>
            <small>{product.quantity} uds</small>
          </div>
          <b>{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

type FieldProps = {
  children: ReactNode
  className?: string
  label: string
}

function Field({ children, className, label }: FieldProps) {
  return (
    <label className={className ? `block ${className}` : 'block'}>
      <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">{label}</span>
      {children}
    </label>
  )
}
