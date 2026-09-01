import { lazy } from 'react'
import type { RunAction } from '../shared/types'
import type { CatalogData } from '../../catalog/domain/types.ts'
import type { CrmStats, CrmStatsPeriod, CrmVenue, TenantContext } from '../../../types'
import type { CrmSection } from './crmNavigation'
import { hasTenantFeature } from '../../platform/tenantFeatureAccess'

const AccessManagementCrm = lazy(() => import('../access/pages/AccessPage').then((module) => ({ default: module.AccessManagementCrm })))
const StatsCrm = lazy(() => import('../analytics/pages/StatsPage').then((module) => ({ default: module.StatsCrm })))
const CatalogGroupsCrm = lazy(() => import('../catalog/pages/CatalogGroupsPage.tsx').then((module) => ({ default: module.CatalogGroupsCrm })))
const CatalogFormatsCrm = lazy(() => import('../catalog/pages/CatalogFormatsPage.tsx').then((module) => ({ default: module.CatalogFormatsCrm })))
const CatalogProductsCrm = lazy(() => import('../catalog/pages/CatalogProductsPage.tsx').then((module) => ({ default: module.CatalogProductsCrm })))
const CatalogStructureCrm = lazy(() => import('../catalog/pages/CatalogStructurePage.tsx').then((module) => ({ default: module.CatalogStructureCrm })))
const CatalogTransferCrm = lazy(() => import('../catalog/pages/CatalogTransferPage.tsx').then((module) => ({ default: module.CatalogTransferCrm })))
const DashboardCrm = lazy(() => import('../dashboard/pages/DashboardPage').then((module) => ({ default: module.DashboardCrm })))
const DiscountsCrm = lazy(() => import('../discounts/pages/DiscountsPage').then((module) => ({ default: module.DiscountsCrm })))
const PlanCrm = lazy(() => import('../plan/pages/PlanPage').then((module) => ({ default: module.PlanCrm })))
const InventoryStockCrm = lazy(() => import('../inventory/pages/InventoryStockPage').then((module) => ({ default: module.InventoryStockCrm })))
const SupplierReceiptsCrm = lazy(() => import('../supplier-documents/pages/SupplierReceiptsPage').then((module) => ({ default: module.SupplierReceiptsCrm })))
const InventoryWarehousesCrm = lazy(() => import('../inventory/pages/InventoryWarehousesPage').then((module) => ({ default: module.InventoryWarehousesCrm })))
const InventorySettingsCrm = lazy(() => import('../inventory/pages/InventorySettingsPage').then((module) => ({ default: module.InventorySettingsCrm })))
const InventoryItemsCrm = lazy(() => import('../inventory/pages/InventoryItemsPage').then((module) => ({ default: module.InventoryItemsCrm })))
const InventoryPreparationsCrm = lazy(() => import('../inventory/pages/InventoryPreparationsPage').then((module) => ({ default: module.InventoryPreparationsCrm })))
const InventoryConfigurationCrm = lazy(() => import('../inventory/pages/InventoryConfigurationPage').then((module) => ({ default: module.InventoryConfigurationCrm })))
const IntegrationsCrm = lazy(() => import('../integrations/pages/IntegrationsPage').then((module) => ({ default: module.IntegrationsCrm })))
const SalesReportsCrm = lazy(() => import('../sales/pages/SalesReportsPage').then((module) => ({ default: module.SalesReportsCrm })))
const CashClosingReportsCrm = lazy(() => import('../sales/pages/CashClosingReportsPage').then((module) => ({ default: module.CashClosingReportsCrm })))
const VenueSettingsCrm = lazy(() => import('../venues/pages/VenueSettingsPage').then((module) => ({ default: module.VenueSettingsCrm })))
const TableManagementPage = lazy(() => import('../../table-management/TableManagementPage').then((module) => ({ default: module.TableManagementPage })))
const ProductionCrm = lazy(() => import('../production/pages/ProductionPage').then((module) => ({ default: module.ProductionCrm })))

type Props = {
  activeSection: CrmSection
  catalog: CatalogData | null
  comparisonStats: CrmStats | null
  context: TenantContext
  disabled: boolean
  duplicateCatalogProduct: (sourceProductId: string, targetVenueId: string) => Promise<boolean>
  inventoryEnabled: boolean
  isCatalogLoading: boolean
  mutateCatalog: (action: () => Promise<unknown>) => Promise<boolean>
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onInventoryEnabledChange: () => Promise<void>
  onStatsRefresh: (options?: { comparisonPeriod?: CrmStatsPeriod; period?: CrmStatsPeriod; silent?: boolean }) => Promise<void>
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  stats: CrmStats | null
  venues: CrmVenue[]
}

const catalogSections = new Set<CrmSection>(['dashboard', 'products', 'formats', 'categories', 'selection-groups', 'modifiers', 'import'])

export function CrmSectionContent({
  activeSection,
  catalog,
  comparisonStats,
  context,
  disabled,
  duplicateCatalogProduct,
  inventoryEnabled,
  isCatalogLoading,
  mutateCatalog,
  onCatalogChanged,
  onError,
  onInventoryEnabledChange,
  onStatsRefresh,
  onVenuesChanged,
  runAction,
  selectedVenueId,
  stats,
  venues,
}: Props) {
  if (catalogSections.has(activeSection) && !catalog) {
    return <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !rounded-2xl !bg-[var(--crm-surface)] !p-6 !shadow-[var(--crm-shadow-card)]"><h2 className="!font-bold">{isCatalogLoading ? 'Cargando catálogo…' : 'Selecciona un local'}</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">La gestión del catálogo está aislada por local.</p></section>
  }

  if (!inventoryEnabled && activeSection.startsWith('inventory-') && activeSection !== 'inventory-stock') {
    return <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !rounded-2xl !bg-[var(--crm-surface)] !p-6 !shadow-[var(--crm-shadow-card)]"><h2 className="!font-bold">Control de stock desactivado</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Actívalo desde la página Stock para acceder a esta configuración.</p></section>
  }

  switch (activeSection) {
    case 'dashboard':
      return catalog ? <DashboardCrm disabled={disabled} onRefresh={onStatsRefresh} selectedVenueId={selectedVenueId} stats={stats} /> : null
    case 'products':
      return catalog ? <CatalogProductsCrm catalog={catalog} defaultTaxRate={venues.find((venue) => venue.id === selectedVenueId)?.defaultTaxRate ?? 21} disabled={disabled} duplicateProduct={duplicateCatalogProduct} inventoryRecipesEnabled={hasTenantFeature(context, 'inventory') && hasTenantFeature(context, 'inventory_recipes')} mutate={mutateCatalog} venues={venues} /> : null
    case 'formats':
      return catalog ? <CatalogFormatsCrm catalog={catalog} disabled={disabled} inventoryFeatureEnabled={hasTenantFeature(context, 'inventory')} mutate={mutateCatalog} /> : null
    case 'categories':
      return catalog ? <CatalogStructureCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} /> : null
    case 'selection-groups':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="selection" inventoryRecipesEnabled={hasTenantFeature(context, 'inventory') && hasTenantFeature(context, 'inventory_recipes')} mutate={mutateCatalog} /> : null
    case 'modifiers':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="modifier" inventoryRecipesEnabled={hasTenantFeature(context, 'inventory') && hasTenantFeature(context, 'inventory_recipes')} mutate={mutateCatalog} /> : null
    case 'access':
      return <AccessManagementCrm disabled={disabled} runAction={runAction} tenantContext={context} />
    case 'discounts':
      return <DiscountsCrm disabled={disabled} onCatalogChanged={onCatalogChanged} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'import':
      return catalog ? <CatalogTransferCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} venueName={venues.find((venue) => venue.id === selectedVenueId)?.name ?? 'local'} /> : null
    case 'tables':
      return <TableManagementPage context={context} disabled={disabled} onError={onError} venueId={selectedVenueId} />
    case 'production':
      return <ProductionCrm catalog={catalog} context={context} disabled={disabled} runAction={runAction} venueId={selectedVenueId} />
    case 'inventory-stock':
      return <InventoryStockCrm disabled={disabled} inventoryEnabled={inventoryEnabled} onInventoryEnabledChange={onInventoryEnabledChange} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-receipts':
      return <SupplierReceiptsCrm disabled={disabled} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-items':
      return <InventoryItemsCrm disabled={disabled} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-preparations':
      return <InventoryPreparationsCrm disabled={disabled} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-warehouses':
      return <InventoryWarehousesCrm disabled={disabled} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-units':
      return <InventorySettingsCrm disabled={disabled} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'inventory-settings':
      return <InventoryConfigurationCrm />
    case 'reports':
      return <SalesReportsCrm
        dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null}
        disabled={disabled}
        runAction={runAction}
        selectedVenueId={selectedVenueId}
        tenantContext={context}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'x-reports':
      return <CashClosingReportsCrm
        dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null}
        disabled={disabled}
        runAction={runAction}
        selectedVenueId={selectedVenueId}
        tenantContext={context}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'stats':
      return <StatsCrm
        comparisonStats={comparisonStats}
        dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null}
        disabled={disabled}
        key={selectedVenueId}
        onRefresh={(period, comparisonPeriod) => onStatsRefresh({ comparisonPeriod, period })}
        stats={stats}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'integrations':
      return <IntegrationsCrm disabled={disabled} runAction={runAction} tenantContext={context} />
    case 'settings':
      return <VenueSettingsCrm disabled={disabled} onVenuesChanged={onVenuesChanged} runAction={runAction} tenantContext={context} venues={venues} />
    case 'plan':
      return <PlanCrm disabled={disabled} runAction={runAction} tenantContext={context} />
  }
}
