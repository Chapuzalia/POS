import { AccessManagementCrm } from '../access/pages/AccessPage'
import { StatsCrm } from '../analytics/pages/StatsPage'
import { CatalogGroupsCrm } from '../catalog/pages/CatalogGroupsPage.tsx'
import { CatalogProductsCrm } from '../catalog/pages/CatalogProductsPage.tsx'
import { CatalogStructureCrm } from '../catalog/pages/CatalogStructurePage.tsx'
import { CatalogTransferCrm } from '../catalog/pages/CatalogTransferPage.tsx'
import { DashboardCrm } from '../dashboard/pages/DashboardPage'
import { DiscountsCrm } from '../discounts/pages/DiscountsPage'
import { PlanCrm } from '../plan/pages/PlanPage'
import { SalesReportsCrm } from '../sales/pages/SalesReportsPage'
import type { RunAction } from '../shared/types'
import { VenueSettingsCrm } from '../venues/pages/VenueSettingsPage'
import { TableManagementPage } from '../../table-management/TableManagementPage'
import type { CatalogData } from '../../catalog/domain/types.ts'
import type { CrmStats, CrmVenue, TenantContext } from '../../../types'
import type { CrmSection } from './crmNavigation'

type Props = {
  activeSection: CrmSection
  catalog: CatalogData | null
  context: TenantContext
  disabled: boolean
  isCatalogLoading: boolean
  mutateCatalog: (action: () => Promise<unknown>) => Promise<boolean>
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onStatsRefresh: (options?: { silent?: boolean }) => Promise<void>
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  stats: CrmStats | null
  venues: CrmVenue[]
}

const catalogSections = new Set<CrmSection>(['dashboard', 'products', 'categories', 'selection-groups', 'modifiers', 'import'])

export function CrmSectionContent({
  activeSection,
  catalog,
  context,
  disabled,
  isCatalogLoading,
  mutateCatalog,
  onCatalogChanged,
  onError,
  onStatsRefresh,
  onVenuesChanged,
  runAction,
  selectedVenueId,
  stats,
  venues,
}: Props) {
  if (catalogSections.has(activeSection) && !catalog) {
    return <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-6 !shadow-[var(--crm-shadow-card)]"><h2 className="!font-bold">{isCatalogLoading ? 'Cargando catálogo…' : 'Selecciona un local'}</h2><p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">La gestión del catálogo está aislada por local.</p></section>
  }

  switch (activeSection) {
    case 'dashboard':
      return catalog ? <DashboardCrm activeCategories={catalog.categories.filter((category) => category.active).length} activeProducts={catalog.products.filter((product) => product.active).length} categories={catalog.categories} disabled={disabled} onRefresh={onStatsRefresh} placements={catalog.placements} products={catalog.products} stats={stats} /> : null
    case 'products':
      return catalog ? <CatalogProductsCrm catalog={catalog} defaultTaxRate={venues.find((venue) => venue.id === selectedVenueId)?.defaultTaxRate ?? 21} disabled={disabled} mutate={mutateCatalog} /> : null
    case 'categories':
      return catalog ? <CatalogStructureCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} /> : null
    case 'selection-groups':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="selection" mutate={mutateCatalog} /> : null
    case 'modifiers':
      return catalog ? <CatalogGroupsCrm catalog={catalog} disabled={disabled} domain="modifier" mutate={mutateCatalog} /> : null
    case 'access':
      return <AccessManagementCrm disabled={disabled} onVenuesChanged={onVenuesChanged} runAction={runAction} tenantContext={context} />
    case 'discounts':
      return <DiscountsCrm disabled={disabled} onCatalogChanged={onCatalogChanged} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'import':
      return catalog ? <CatalogTransferCrm catalog={catalog} disabled={disabled} mutate={mutateCatalog} venueName={venues.find((venue) => venue.id === selectedVenueId)?.name ?? 'local'} /> : null
    case 'tables':
      return <TableManagementPage context={context} disabled={disabled} onError={onError} venueId={selectedVenueId} />
    case 'reports':
      return <SalesReportsCrm disabled={disabled} runAction={runAction} selectedVenueId={selectedVenueId} tenantContext={context} />
    case 'stats':
      return <StatsCrm disabled={disabled} onRefresh={onStatsRefresh} stats={stats} />
    case 'settings':
      return <VenueSettingsCrm disabled={disabled} onVenuesChanged={onVenuesChanged} runAction={runAction} tenantContext={context} venues={venues} />
    case 'plan':
      return <PlanCrm disabled={disabled} runAction={runAction} tenantContext={context} />
  }
}