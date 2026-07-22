import { ArrowDown, ArrowUp, Boxes, Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { formatMoney } from '../../../../lib/format.ts'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination.tsx'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { EmptyList } from '../../shared/components/EmptyList.tsx'
import {
  filterCatalogProducts,
  getCatalogProductSummaries,
  type CatalogProductFilters,
  type CatalogProductSummary,
  moveCatalogItem,
  toReorderItems,
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

function priceLabel(summary: CatalogProductSummary) {
  if (summary.minPriceCents === null) return 'Sin precio vendible'
  if (summary.minPriceCents === summary.maxPriceCents) return formatMoney(summary.minPriceCents)
  return `${formatMoney(summary.minPriceCents)} – ${formatMoney(summary.maxPriceCents ?? summary.minPriceCents)}`
}

export function CatalogProductsCrm({ catalog, defaultTaxRate, disabled, mutate }: Props) {
  const [filters, setFilters] = useState(defaultFilters)
  const [sort, setSort] = useState<'order' | 'name' | 'price'>('order')
  const [page, setPage] = useState(1)
  const [editorProductId, setEditorProductId] = useState<string | 'create' | null>(null)
  const deferredQuery = useDeferredValue(filters.query)
  const summaries = useMemo(() => getCatalogProductSummaries(catalog), [catalog])
  const filtered = useMemo(() => {
    const result = filterCatalogProducts(summaries, { ...filters, query: deferredQuery })
    return [...result].sort((left, right) => {
      if (sort === 'name') return left.product.name.localeCompare(right.product.name, 'es')
      if (sort === 'price') return (left.minPriceCents ?? Number.MAX_SAFE_INTEGER) - (right.minPriceCents ?? Number.MAX_SAFE_INTEGER)
      return left.product.sortOrder - right.product.sortOrder || left.product.id.localeCompare(right.product.id)
    })
  }, [deferredQuery, filters, sort, summaries])
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

  async function moveProduct(productId: string, direction: -1 | 1) {
    const reordered = moveCatalogItem(catalog.products, productId, direction)
    await mutate(() => catalogAdminService.reorder(catalog.venueId, {
      entity: 'products',
      items: toReorderItems(reordered),
    }))
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
    <div className="crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-list-toolbar !grid !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
          <div className="!flex !flex-col !justify-between !gap-3 md:!flex-row md:!items-center">
            <div className="crm-list-title">
              <h2>Productos</h2>
              <p>{filtered.length} de {catalog.products.length} productos · una única carga para todo el local</p>
            </div>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-2" disabled={disabled} onClick={() => setEditorProductId('create')} type="button">
              <Plus className="!size-4" /> Añadir producto
            </button>
          </div>
          <div className="!grid !gap-2 sm:!grid-cols-2 lg:!grid-cols-[minmax(220px,1fr)_repeat(5,minmax(130px,auto))]">
            <label className="crm-search !flex !h-11 !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
              <Search className="!size-4 !text-[var(--crm-text-muted)]" />
              <input onChange={(event) => updateFilters({ query: event.target.value })} placeholder="Buscar producto, variante o ubicación" value={filters.query} />
            </label>
            <CrmSelect ariaLabel="Filtrar por estado" onChange={(value) => updateFilters({ status: value as CatalogProductFilters['status'] })} options={[{ label: 'Todos los estados', value: 'all' }, { label: 'Activos', value: 'active' }, { label: 'Inactivos', value: 'inactive' }]} value={filters.status} />
            <CrmSelect ariaLabel="Filtrar por tipo" onChange={(value) => updateFilters({ type: value as CatalogProductFilters['type'] })} options={[{ label: 'Todos los tipos', value: 'all' }, { label: 'Estándar', value: 'standard' }, { label: 'Menú', value: 'menu' }]} value={filters.type} />
            <CrmSelect ariaLabel="Filtrar por categoría" onChange={(categoryId) => updateFilters({ categoryId })} options={[{ label: 'Todas las categorías', value: '' }, ...catalog.categories.map((category) => ({ label: category.name, value: category.id }))]} value={filters.categoryId} />
            <CrmSelect ariaLabel="Filtrar por pestaña" onChange={(tabId) => updateFilters({ tabId })} options={[{ label: 'Todas las pestañas', value: '' }, ...catalog.tabs.map((tab) => ({ label: tab.label, value: tab.id }))]} value={filters.tabId} />
            <CrmSelect ariaLabel="Ordenar productos" onChange={(value) => setSort(value as typeof sort)} options={[{ label: 'Orden del TPV', value: 'order' }, { label: 'Nombre', value: 'name' }, { label: 'Precio', value: 'price' }]} value={sort} />
          </div>
          <label className="!flex !w-fit !items-center !gap-2 !text-sm !font-medium !text-[var(--crm-text-secondary)]">
            <input checked={filters.showInternal} onChange={(event) => updateFilters({ showInternal: event.target.checked })} type="checkbox" />
            Mostrar productos internos sin apariciones activas
          </label>
        </div>

        <div className="crm-data-table !grid !overflow-auto">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[1120px] !grid-cols-[2fr_.8fr_.8fr_.75fr_.8fr_1.4fr_1fr] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[.045em] !text-[var(--crm-text-muted)]">
            <span>Producto</span><span>Tipo / estado</span><span>IVA</span><span>Variantes</span><span>Precio</span><span>Ubicaciones</span><span>Acciones</span>
          </div>
          {visibleProducts.map((summary) => (
            <div className="crm-data-row !grid !min-h-[78px] !min-w-[1120px] !grid-cols-[2fr_.8fr_.8fr_.75fr_.8fr_1.4fr_1fr] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !text-[13px]" key={summary.product.id}>
              <div className="crm-product-cell">
                {summary.product.image?.publicUrl ? <img alt="" className="crm-product-thumb" src={summary.product.image.publicUrl} /> : <div className="crm-product-thumb crm-product-thumb-empty"><Boxes className="!size-4" /></div>}
                <div className="crm-cell-main"><strong>{summary.product.name}</strong><span>{summary.product.description || 'Sin descripción'}{summary.internal ? ' · Interno' : ''}</span></div>
              </div>
              <span>{summary.product.type === 'menu' ? 'Menú' : 'Estándar'}<br /><small>{summary.product.active ? 'Activo' : 'Inactivo'}</small></span>
              <span>{summary.product.vatRate === null ? 'Heredado' : `${summary.product.vatRate} %`}</span>
              <strong>{summary.variants.length}</strong>
              <strong>{priceLabel(summary)}</strong>
              <span>{summary.tabs.map((tab) => tab.label).join(', ') || 'Sin apariciones'}<br /><small>{summary.categories.map((category) => category.name).join(', ')}</small></span>
              <div className="crm-action-group">
                <button aria-label="Subir producto" className="crm-action-button" disabled={disabled || catalog.products[0]?.id === summary.product.id} onClick={() => void moveProduct(summary.product.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
                <button aria-label="Bajar producto" className="crm-action-button" disabled={disabled || catalog.products.at(-1)?.id === summary.product.id} onClick={() => void moveProduct(summary.product.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
                <button aria-label={`Editar ${summary.product.name}`} className="crm-action-button" disabled={disabled} onClick={() => setEditorProductId(summary.product.id)} type="button"><Pencil className="!size-4" /></button>
                <button aria-label={summary.product.active ? 'Desactivar' : 'Activar'} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.setProductActive(catalog.venueId, summary.product.id, !summary.product.active))} type="button">{summary.product.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
                <button aria-label={`Eliminar ${summary.product.name}`} className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void removeProduct(summary)} type="button"><Trash2 className="!size-4" /></button>
              </div>
            </div>
          ))}
          {!filtered.length ? <EmptyList message="No hay productos que coincidan con los filtros." /> : null}
        </div>
        <CrmPagination currentPage={visiblePage} onPageChange={setPage} totalResults={filtered.length} />
      </section>

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
