import { ArrowDown, ArrowUp, ArrowUpDown, Boxes, Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { formatMoney } from '../../../../lib/format.ts'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination.tsx'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { EmptyList } from '../../shared/components/EmptyList.tsx'
import { CatalogCheckbox, CatalogPanel, CatalogPanelHeader, CatalogStatus } from '../components/CatalogUi.tsx'
import {
  filterCatalogProducts,
  getCatalogProductSummaries,
  type CatalogProductFilters,
  type CatalogProductSummary,
} from '../services/catalogAdminModel.ts'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { CatalogProductEditor } from '../forms/CatalogProductEditor.tsx'

type Props = {
  catalog: CatalogData
  defaultTaxRate: number
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
}

const defaultFilters: CatalogProductFilters = {
  query: '',
  status: 'all',
  type: 'all',
  categoryId: '',
  tabId: '',
  showInternal: false,
}

type CatalogProductSortKey = 'product' | 'type' | 'vat' | 'variants' | 'price' | 'locations'
type CatalogProductSortDirection = 'asc' | 'desc'

function priceLabel(summary: CatalogProductSummary) {
  if (summary.minPriceCents === null) return 'Sin precio vendible'
  if (summary.minPriceCents === summary.maxPriceCents) return formatMoney(summary.minPriceCents)
  return `${formatMoney(summary.minPriceCents)} – ${formatMoney(summary.maxPriceCents ?? summary.minPriceCents)}`
}

export function CatalogProductsCrm({ catalog, defaultTaxRate, disabled, mutate }: Props) {
  const [filters, setFilters] = useState(defaultFilters)
  const [sortKey, setSortKey] = useState<CatalogProductSortKey>('product')
  const [sortDirection, setSortDirection] = useState<CatalogProductSortDirection>('asc')
  const [page, setPage] = useState(1)
  const [editorProductId, setEditorProductId] = useState<string | 'create' | null>(null)
  const deferredQuery = useDeferredValue(filters.query)
  const summaries = useMemo(() => getCatalogProductSummaries(catalog), [catalog])
  const filtered = useMemo(() => {
    const result = filterCatalogProducts(summaries, { ...filters, query: deferredQuery })
    return [...result].sort((left, right) => {
      if (sortKey === 'price' && (left.minPriceCents === null || right.minPriceCents === null)) {
        if (left.minPriceCents === right.minPriceCents) return left.product.name.localeCompare(right.product.name, 'es')
        return left.minPriceCents === null ? 1 : -1
      }
      const leftValue = sortKey === 'product'
        ? left.product.name
        : sortKey === 'type'
          ? `${left.product.type}:${left.product.active ? '0' : '1'}`
          : sortKey === 'vat'
            ? left.product.vatRate ?? defaultTaxRate
            : sortKey === 'variants'
              ? left.variants.length
              : sortKey === 'price'
                ? left.minPriceCents ?? 0
                : `${left.tabs.map((tab) => tab.label).join(', ')} ${left.categories.map((category) => category.name).join(', ')}`
      const rightValue = sortKey === 'product'
        ? right.product.name
        : sortKey === 'type'
          ? `${right.product.type}:${right.product.active ? '0' : '1'}`
          : sortKey === 'vat'
            ? right.product.vatRate ?? defaultTaxRate
            : sortKey === 'variants'
              ? right.variants.length
              : sortKey === 'price'
                ? right.minPriceCents ?? 0
                : `${right.tabs.map((tab) => tab.label).join(', ')} ${right.categories.map((category) => category.name).join(', ')}`
      const comparison = typeof leftValue === 'number' && typeof rightValue === 'number'
        ? leftValue - rightValue
        : String(leftValue).localeCompare(String(rightValue), 'es')
      return comparison * (sortDirection === 'asc' ? 1 : -1)
        || left.product.name.localeCompare(right.product.name, 'es')
    })
  }, [defaultTaxRate, deferredQuery, filters, sortDirection, sortKey, summaries])
  const pages = Math.max(1, Math.ceil(filtered.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(page, pages)
  const visibleProducts = filtered.slice((visiblePage - 1) * CRM_PAGE_SIZE, visiblePage * CRM_PAGE_SIZE)
  const selectedProduct = editorProductId && editorProductId !== 'create'
    ? catalog.products.find((product) => product.id === editorProductId) ?? null
    : null

  function updateFilters(patch: Partial<CatalogProductFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  function handleSort(nextSortKey: CatalogProductSortKey) {
    setPage(1)
    if (sortKey === nextSortKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
      return
    }
    setSortKey(nextSortKey)
    setSortDirection('asc')
  }
  async function removeProduct(summary: CatalogProductSummary) {
    const assignmentCount = catalog.selectionAssignments.filter((item) => item.productId === summary.product.id).length
      + catalog.modifierAssignments.filter((item) => item.productId === summary.product.id).length
    const impact = `${summary.variants.length} variantes, ${summary.placementCount} apariciones y ${assignmentCount} asignaciones`
    if (!window.confirm(`Eliminar definitivamente “${summary.product.name}”? Se eliminarán ${impact}. El histórico de ventas se conserva.`)) return
    const saved = await mutate(() => catalogAdminService.deleteProduct(catalog.venueId, summary.product.id))
    if (saved && editorProductId === summary.product.id) setEditorProductId(null)
  }

  return (
    <div className="crm-catalog-page-grid">
      <CatalogPanel>
        <CatalogPanelHeader
          actions={
            <button className="crm-primary-button" disabled={disabled} onClick={() => setEditorProductId('create')} type="button">
              <Plus className="!size-4" /> Añadir producto
            </button>
          }
          description={`${filtered.length} de ${catalog.products.length} productos · una única carga para todo el local`}
          title="Productos"
        >
          <div className="!grid !gap-2 sm:!grid-cols-2 lg:!grid-cols-[minmax(220px,1fr)_repeat(4,minmax(130px,auto))]">
            <label className="crm-search !flex !h-11 !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
              <Search className="!size-4 !text-[var(--crm-text-muted)]" />
              <input onChange={(event) => updateFilters({ query: event.target.value })} placeholder="Buscar producto, variante o ubicación" value={filters.query} />
            </label>
            <CrmSelect ariaLabel="Filtrar por estado" onChange={(value) => updateFilters({ status: value as CatalogProductFilters['status'] })} options={[{ label: 'Todos los estados', value: 'all' }, { label: 'Activos', value: 'active' }, { label: 'Inactivos', value: 'inactive' }]} value={filters.status} />
            <CrmSelect ariaLabel="Filtrar por tipo" onChange={(value) => updateFilters({ type: value as CatalogProductFilters['type'] })} options={[{ label: 'Todos los tipos', value: 'all' }, { label: 'Estándar', value: 'standard' }, { label: 'Menú', value: 'menu' }]} value={filters.type} />
            <CrmSelect ariaLabel="Filtrar por categoría" onChange={(categoryId) => updateFilters({ categoryId })} options={[{ label: 'Todas las categorías', value: '' }, ...catalog.categories.map((category) => ({ label: category.name, value: category.id }))]} value={filters.categoryId} />
            <CrmSelect ariaLabel="Filtrar por pestaña" onChange={(tabId) => updateFilters({ tabId })} options={[{ label: 'Todas las pestañas', value: '' }, ...catalog.tabs.map((tab) => ({ label: tab.label, value: tab.id }))]} value={filters.tabId} />
          </div>
          <CatalogCheckbox checked={filters.showInternal} onChange={(showInternal) => updateFilters({ showInternal })}>
            Mostrar productos internos sin apariciones activas
          </CatalogCheckbox>
        </CatalogPanelHeader>

        <div className="crm-data-table crm-catalog-products-table !grid !overflow-auto">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[.045em] !text-[var(--crm-text-muted)]">
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Producto" onSort={handleSort} sortKey="product" />
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Tipo / estado" onSort={handleSort} sortKey="type" />
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="IVA" onSort={handleSort} sortKey="vat" />
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Variantes" onSort={handleSort} sortKey="variants" />
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Precio" onSort={handleSort} sortKey="price" />
            <CatalogProductSortHeader currentDirection={sortDirection} currentKey={sortKey} label="Ubicaciones" onSort={handleSort} sortKey="locations" />
            <span>Acciones</span>
          </div>
          {visibleProducts.map((summary) => (
            <div className="crm-data-row !grid !min-h-[78px] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !text-[13px]" key={summary.product.id}>
              <div className="crm-product-cell">
                {summary.product.image?.publicUrl ? <img alt="" className="crm-product-thumb" src={summary.product.image.publicUrl} /> : <div className="crm-product-thumb crm-product-thumb-empty"><Boxes className="!size-4" /></div>}
                <div className="crm-cell-main"><strong>{summary.product.name}</strong><span>{summary.product.description || 'Sin descripción'}{summary.internal ? ' · Interno' : ''}</span></div>
              </div>
              <div className="!grid !gap-1.5"><span>{summary.product.type === 'menu' ? 'Menú' : 'Estándar'}</span><CatalogStatus active={summary.product.active} /></div>
              <span>{summary.product.vatRate === null ? 'Heredado' : `${summary.product.vatRate} %`}</span>
              <strong>{summary.variants.length}</strong>
              <strong>{priceLabel(summary)}</strong>
              <span>{summary.tabs.map((tab) => tab.label).join(', ') || 'Sin apariciones'}<br /><small>{summary.categories.map((category) => category.name).join(', ')}</small></span>
              <div className="crm-action-group">
                <button aria-label={`Editar ${summary.product.name}`} className="crm-action-button" disabled={disabled} onClick={() => setEditorProductId(summary.product.id)} type="button"><Pencil className="!size-4" /></button>
                <button aria-label={summary.product.active ? 'Desactivar' : 'Activar'} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.setProductActive(catalog.venueId, summary.product.id, !summary.product.active))} type="button">{summary.product.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
                <button aria-label={`Eliminar ${summary.product.name}`} className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void removeProduct(summary)} type="button"><Trash2 className="!size-4" /></button>
              </div>
            </div>
          ))}
          {!filtered.length ? <EmptyList message="No hay productos que coincidan con los filtros." /> : null}
        </div>
        <CrmPagination currentPage={visiblePage} onPageChange={setPage} totalResults={filtered.length} />
      </CatalogPanel>

      {editorProductId ? (
        <CatalogProductEditor
          catalog={catalog}
          defaultTaxRate={defaultTaxRate}
          disabled={disabled}
          key={editorProductId}
          mutate={mutate}
          onClose={() => setEditorProductId(null)}
          product={selectedProduct}
        />
      ) : null}
    </div>
  )
}

function CatalogProductSortHeader({
  currentDirection,
  currentKey,
  label,
  onSort,
  sortKey,
}: {
  currentDirection: CatalogProductSortDirection
  currentKey: CatalogProductSortKey
  label: string
  onSort: (sortKey: CatalogProductSortKey) => void
  sortKey: CatalogProductSortKey
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
