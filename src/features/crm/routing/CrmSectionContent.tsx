import { lazy, useMemo } from 'react'
import { buildCrmVenueContext } from '../venues/services/venueSelection'
import type { RunAction } from '../shared/types'
import type { CatalogData } from '../../catalog/domain/types.ts'
import type { CrmStats, CrmStatsPeriod, CrmVenue, TenantContext } from '../../../types'
import { canAccessCrmSection } from './crmPermissions'
import { catalogSections, type CrmSection } from './crmNavigation'
import { hasTenantVenueCapability } from '../../platform/tenantFeatureAccess'
import { getOnboardingTopics } from '../onboarding/onboardingModel'

const AccessManagementCrm = lazy(() => import('../access/pages/AccessPage').then((module) => ({ default: module.AccessManagementCrm })))
const StatsCrm = lazy(() => import('../analytics/pages/StatsPage').then((module) => ({ default: module.StatsCrm })))
const ProfitabilityCrm = lazy(() => import('../analytics/pages/ProfitabilityPage').then((module) => ({ default: module.ProfitabilityCrm })))
const CatalogGroupsCrm = lazy(() => import('../catalog/pages/CatalogGroupsPage.tsx').then((module) => ({ default: module.CatalogGroupsCrm })))
const CatalogFormatsCrm = lazy(() => import('../catalog/pages/CatalogFormatsPage.tsx').then((module) => ({ default: module.CatalogFormatsCrm })))
const CatalogProductsCrm = lazy(() => import('../catalog/pages/CatalogProductsPage.tsx').then((module) => ({ default: module.CatalogProductsCrm })))
const CatalogStructureCrm = lazy(() => import('../catalog/pages/CatalogStructurePage.tsx').then((module) => ({ default: module.CatalogStructureCrm })))
const CatalogTransferCrm = lazy(() => import('../catalog/pages/CatalogTransferPage.tsx').then((module) => ({ default: module.CatalogTransferCrm })))
import type { DashboardMonthStatus } from '../dashboard/pages/DashboardPage'
const DashboardCrm = lazy(() => import('../dashboard/pages/DashboardPage').then((module) => ({ default: module.DashboardCrm })))
const DiscountsCrm = lazy(() => import('../discounts/pages/DiscountsPage').then((module) => ({ default: module.DiscountsCrm })))
const DocumentationCrm = lazy(() => import('../documentation/pages/DocumentationPage').then((module) => ({ default: module.DocumentationCrm })))
const PlanCrm = lazy(() => import('../plan/pages/PlanPage').then((module) => ({ default: module.PlanCrm })))
const InventoryStockCrm = lazy(() => import('../inventory/pages/InventoryStockPage').then((module) => ({ default: module.InventoryStockCrm })))
const PurchasesOverviewCrm = lazy(() => import('../purchases/pages/PurchasesOverviewPage').then((module) => ({ default: module.PurchasesOverviewCrm })))
const PurchasesReplenishmentCrm = lazy(() => import('../purchases/pages/PurchasesReplenishmentPage').then((module) => ({ default: module.PurchasesReplenishmentCrm })))
const PurchasesInvoicesCrm = lazy(() => import('../purchases/pages/PurchasesInvoicesPage').then((module) => ({ default: module.PurchasesInvoicesCrm })))
const PurchasesSuppliersCrm = lazy(() => import('../purchases/pages/PurchasesSuppliersPage').then((module) => ({ default: module.PurchasesSuppliersCrm })))
const InventoryWarehousesCrm = lazy(() => import('../inventory/pages/InventoryWarehousesPage').then((module) => ({ default: module.InventoryWarehousesCrm })))
const InventorySettingsCrm = lazy(() => import('../inventory/pages/InventorySettingsPage').then((module) => ({ default: module.InventorySettingsCrm })))
const InventoryPreparationsCrm = lazy(() => import('../inventory/pages/InventoryPreparationsPage').then((module) => ({ default: module.InventoryPreparationsCrm })))
const InventoryConfigurationCrm = lazy(() => import('../inventory/pages/InventoryConfigurationPage').then((module) => ({ default: module.InventoryConfigurationCrm })))
const IntegrationsCrm = lazy(() => import('../integrations/pages/IntegrationsPage').then((module) => ({ default: module.IntegrationsCrm })))
const SalesReportsCrm = lazy(() => import('../sales/pages/SalesReportsPage').then((module) => ({ default: module.SalesReportsCrm })))
const CashClosingReportsCrm = lazy(() => import('../sales/pages/CashClosingReportsPage').then((module) => ({ default: module.CashClosingReportsCrm })))
const VenueSettingsCrm = lazy(() => import('../venues/pages/VenueSettingsPage').then((module) => ({ default: module.VenueSettingsCrm })))
const TableManagementPage = lazy(() => import('../../table-management/TableManagementPage').then((module) => ({ default: module.TableManagementPage })))
const ProductionCrm = lazy(() => import('../production/pages/ProductionPage').then((module) => ({ default: module.ProductionCrm })))
const PrintTemplatesCrm = lazy(() => import('../printing/pages/PrintTemplatesPage').then((module) => ({ default: module.PrintTemplatesCrm })))

type Props = {
  activeSection: CrmSection
  catalog: CatalogData | null
  comparisonStats: CrmStats | null
  context: TenantContext
  dashboardMonthStatus: DashboardMonthStatus
  disabled: boolean
  duplicateCatalogProduct: (sourceProductId: string, targetVenueId: string) => Promise<boolean>
  /** Record picked in the global search; `key` remounts the page so it opens that record. */
  focus?: { key: string; targetId: string } | null
  inventoryEnabled: boolean
  isCatalogLoading: boolean
  mutateCatalog: (action: () => Promise<unknown>) => Promise<boolean>
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onInventoryEnabledChange: () => Promise<void>
  onStartOnboarding: () => void
  onStatsRefresh: (options?: { comparisonPeriod?: CrmStatsPeriod; period?: CrmStatsPeriod; silent?: boolean }) => Promise<void>
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  stats: CrmStats | null
  venues: CrmVenue[]
}

export function CrmSectionContent({
  activeSection,
  catalog,
  comparisonStats,
  context,
  dashboardMonthStatus,
  disabled,
  duplicateCatalogProduct,
  focus,
  inventoryEnabled,
  isCatalogLoading,
  mutateCatalog,
  onCatalogChanged,
  onError,
  onInventoryEnabledChange,
  onStartOnboarding,
  onStatsRefresh,
  onVenuesChanged,
  runAction,
  selectedVenueId,
  stats,
  venues,
}: Props) {
  const selectedVenue = venues.find((venue) => venue.id === selectedVenueId)
  const reportContext = useMemo(() => buildCrmVenueContext(context, selectedVenue), [context, selectedVenue])
  if (!canAccessCrmSection(context.role, activeSection, context.features, selectedVenue)) return null
  const venueContext = selectedVenue ? { features: context.features, venue: selectedVenue } : context

  if (catalogSections.has(activeSection) && !catalog) {
    return <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !rounded-2xl !bg-[var(--crm-surface)] !p-6 !shadow-[var(--crm-shadow-card)]"><h2 className="!font-bold">{isCatalogLoading ? 'Cargando catálogo…' : 'Selecciona un local'}</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">La gestión del catálogo está aislada por local.</p></section>
  }

  if (!inventoryEnabled && activeSection.startsWith('inventory-') && activeSection !== 'inventory-stock' && activeSection !== 'inventory-items') {
    return <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !rounded-2xl !bg-[var(--crm-surface)] !p-6 !shadow-[var(--crm-shadow-card)]"><h2 className="!font-bold">Control de stock desactivado</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Actívalo desde la página Stock para acceder a esta configuración.</p></section>
  }

  switch (activeSection) {
    case 'dashboard':
      return <DashboardCrm disabled={disabled} monthStatus={dashboardMonthStatus} onRefresh={onStatsRefresh} selectedVenueId={selectedVenueId} stats={stats} />
    case 'products':
      return catalog ? <CatalogProductsCrm catalog={catalog} initialProductId={focus?.targetId} key={focus?.key} defaultTaxRate={venues.find((venue) => venue.id === selectedVenueId)?.defaultTaxRate ?? 21} disabled={disabled} duplicateProduct={duplicateCatalogProduct} inventoryRecipesEnabled={hasTenantVenueCapability(venueContext, 'costing')} mutate={mutateCatalog} venues={venues} /> : null
    case 'formats':
      return catalog ? <CatalogFormatsCrm catalog={catalog} disabled={disabled} inventoryFeatureEnabled={hasTenantVenueCapability(venueContext, 'inventory')} mutate={mutateCatalog} /> : null
    case 'categories':
      return catalog ? <CatalogStructureCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} /> : null
    case 'selection-groups':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="selection" initialGroupId={focus?.targetId} key={focus?.key} inventoryRecipesEnabled={hasTenantVenueCapability(venueContext, 'costing')} mutate={mutateCatalog} /> : null
    case 'modifiers':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="modifier" initialGroupId={focus?.targetId} key={focus?.key} inventoryRecipesEnabled={hasTenantVenueCapability(venueContext, 'costing')} mutate={mutateCatalog} /> : null
    case 'access':
      return <AccessManagementCrm disabled={disabled} key={`${context.tenantId}:${selectedVenueId}`} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} venues={venues} />
    case 'discounts':
      return <DiscountsCrm disabled={disabled} onCatalogChanged={onCatalogChanged} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'import':
      return catalog ? <CatalogTransferCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} venueName={venues.find((venue) => venue.id === selectedVenueId)?.name ?? 'local'} venues={venues} /> : null
    case 'tables':
      return <TableManagementPage context={context} disabled={disabled} onError={onError} venueId={selectedVenueId} />
    case 'production':
      return catalog ? <ProductionCrm catalog={catalog} context={context} disabled={disabled} runAction={runAction} venueId={selectedVenueId} /> : null
    case 'inventory-stock':
    case 'inventory-items':
      return <InventoryStockCrm dayChangeTime={selectedVenue?.dayChangeTime ?? null} disabled={disabled} inventoryEnabled={inventoryEnabled} key={`${context.tenantId}:${selectedVenueId}`} onInventoryEnabledChange={onInventoryEnabledChange} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} timeZone={selectedVenue?.timeZone ?? 'Europe/Madrid'} />
    case 'purchases-summary':
      return <PurchasesOverviewCrm selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'purchases-replenishment':
      return <PurchasesReplenishmentCrm key={`${context.tenantId}:${selectedVenueId}`} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'purchases-invoices':
      return <PurchasesInvoicesCrm disabled={disabled} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'purchases-suppliers':
      return <PurchasesSuppliersCrm disabled={disabled} selectedVenueId={selectedVenueId} tenantContext={context} />
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
        tenantContext={reportContext}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'x-reports':
      return <CashClosingReportsCrm
        initialClosingId={focus?.targetId}
        key={focus?.key}
        dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null}
        disabled={disabled}
        runAction={runAction}
        selectedVenueId={selectedVenueId}
        tenantContext={context}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'stats':
       return <StatsCrm
         advancedEnabled={hasTenantVenueCapability(venueContext, 'analytics_advanced')}
         comparisonStats={comparisonStats}
        dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null}
        disabled={disabled}
        key={selectedVenueId}
        onRefresh={(period, comparisonPeriod) => onStatsRefresh({ comparisonPeriod, period })}
        stats={stats}
        timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'}
      />
    case 'profitability':
      return catalog ? <ProfitabilityCrm catalog={catalog} context={context} dayChangeTime={venues.find((venue) => venue.id === selectedVenueId)?.dayChangeTime ?? null} disabled={disabled} key={selectedVenueId} timeZone={venues.find((venue) => venue.id === selectedVenueId)?.timeZone ?? 'Europe/Madrid'} venueId={selectedVenueId} /> : null
    case 'integrations':
      return <IntegrationsCrm disabled={disabled} runAction={runAction} tenantContext={context} />
    case 'print-templates':
      return <PrintTemplatesCrm context={context} disabled={disabled} runAction={runAction} venueId={selectedVenueId} />
    case 'settings':
      return <VenueSettingsCrm disabled={disabled} onVenuesChanged={onVenuesChanged} runAction={runAction} tenantContext={context} venues={venues} />
    case 'plan':
      return <PlanCrm disabled={disabled} tenantContext={context} />
    case 'documentation':
      return <DocumentationCrm canStartOnboarding={!disabled && Boolean(selectedVenue && getOnboardingTopics(context, selectedVenue).length)} onStartOnboarding={onStartOnboarding} tenantContext={context} />
  }
}
