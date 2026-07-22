import { AccessManagementCrm } from '../access/pages/AccessPage'
import { StatsCrm } from '../analytics/pages/StatsPage'
import { CatalogImportCrm } from '../catalog/pages/CatalogImportPage'
import { CategoriesCrm } from '../catalog/pages/CategoriesPage'
import { ProductsCrm } from '../catalog/pages/ProductsPage'
import { SaleFormatsCrm } from '../catalog/pages/SaleFormatsPage'
import { CatalogOrganizationCrm } from '../catalog/pages/CatalogOrganizationPage'
import { ComplementsCrm } from '../catalog/pages/ComplementsPage'
import { DashboardCrm } from '../dashboard/pages/DashboardPage'
import { DiscountsCrm } from '../discounts/pages/DiscountsPage'
import { PlanCrm } from '../plan/pages/PlanPage'
import { SalesReportsCrm } from '../sales/pages/SalesReportsPage'
import type { RunAction } from '../shared/types'
import { VenueSettingsCrm } from '../venues/pages/VenueSettingsPage'
import { TableManagementPage } from '../../table-management/TableManagementPage'
import { getAvailableSaleFormats } from '../../../lib/catalog'
import type { Catalog, CrmStats, CrmVenue, TenantContext } from '../../../types'
import type { CrmSection } from './crmNavigation'

type Props = {
  activeSection: CrmSection
  catalog: Catalog | null
  context: TenantContext
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onStatsRefresh: (options?: { silent?: boolean }) => Promise<void>
  onVenuesChanged: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  stats: CrmStats | null
  venues: CrmVenue[]
}

export function CrmSectionContent({
  activeSection,
  catalog,
  context,
  disabled,
  onCatalogChanged,
  onError,
  onStatsRefresh,
  onVenuesChanged,
  runAction,
  selectedVenueId,
  stats,
  venues,
}: Props) {
  const categories = catalog?.categories ?? []
  const products = catalog?.products ?? []
  const saleFormats = getAvailableSaleFormats(catalog?.saleFormats)
  const venueProducts = products.filter((product) => product.venueId === selectedVenueId)
  const venueCategoryIds = new Set(venueProducts.map((product) => product.categoryId))
  const venueCategories = categories.filter((category) => venueCategoryIds.has(category.id))

  switch (activeSection) {
    case 'dashboard':
      return (
        <DashboardCrm
          activeCategories={venueCategories.filter((category) => category.isActive).length}
          activeProducts={venueProducts.filter((product) => product.isActive).length}
          categories={venueCategories}
          disabled={disabled}
          onRefresh={onStatsRefresh}
          products={venueProducts}
          stats={stats}
        />
      )
    case 'products':
      return (
        <ProductsCrm
          categories={categories}
          defaultTaxRate={venues.find((venue) => venue.id === selectedVenueId)?.defaultTaxRate ?? 21}
          disabled={disabled}
          onCatalogChanged={onCatalogChanged}
          products={venueProducts}
          runAction={runAction}
          saleFormats={saleFormats}
          selectedVenueId={selectedVenueId}
          tenantContext={context}
        />
      )
    case 'access':
      return <AccessManagementCrm disabled={disabled} onVenuesChanged={onVenuesChanged} runAction={runAction} tenantContext={context} />
    case 'categories':
      return (
        <CategoriesCrm
          categories={categories}
          disabled={disabled}
          onCatalogChanged={onCatalogChanged}
          products={products}
          runAction={runAction}
          tenantContext={context}
        />
      )
    case 'sale-formats':
      return (
        <SaleFormatsCrm
          disabled={disabled}
          onCatalogChanged={onCatalogChanged}
          products={products}
          runAction={runAction}
          saleFormats={saleFormats}
          tenantContext={context}
        />
      )
    case 'organization':
      return <CatalogOrganizationCrm context={context} venueId={selectedVenueId} tabs={(catalog?.tabs ?? []).filter((tab) => tab.venueId === selectedVenueId)} placements={(catalog?.placements ?? []).filter((placement) => placement.venueId === selectedVenueId)} categories={categories} products={venueProducts} disabled={disabled} runAction={runAction} onCatalogChanged={onCatalogChanged} />
    case 'complements':
      return <ComplementsCrm context={context} venueId={selectedVenueId} groups={(catalog?.selectionGroups ?? []).filter((group) => group.venueId === selectedVenueId)} products={venueProducts} disabled={disabled} runAction={runAction} onCatalogChanged={onCatalogChanged} />
    case 'discounts':
      return (
        <DiscountsCrm
          disabled={disabled}
          onCatalogChanged={onCatalogChanged}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          tenantContext={context}
        />
      )
    case 'import':
      return (
        <CatalogImportCrm
          categories={categories}
          disabled={disabled}
          onCatalogChanged={onCatalogChanged}
          products={venueProducts}
          runAction={runAction}
          saleFormats={saleFormats}
          selectedVenueId={selectedVenueId}
          tenantContext={context}
          venueName={venues.find((venue) => venue.id === selectedVenueId)?.name ?? ''}
        />
      )
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
