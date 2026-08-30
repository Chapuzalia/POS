import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { DataTable } from '../../../../components/ui/DataTable'
import { Dropdown, Label } from '@heroui/react'
import { Boxes, ChevronDown, Copy, Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useDeferredValue, useMemo, useState } from 'react'
import { sileo } from 'sileo'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import type { CrmVenue } from '../../../../types'
import { formatMoney } from '../../../../lib/format.ts'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination.tsx'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { CatalogCheckbox, CatalogPanel, CatalogPanelHeader, CatalogStatus } from '../components/CatalogUi.tsx'
import {
  filterCatalogProducts,
  getCatalogProductSummaries,
  type CatalogProductFilters,
  type CatalogProductSummary,
} from '../services/catalogAdminModel.ts'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { CatalogProductEditor } from '../forms/CatalogProductEditor.tsx'
import { CatalogMenuEditor } from '../forms/CatalogMenuEditor.tsx'

type Props = {
  catalog: CatalogData
  defaultTaxRate: number
  disabled: boolean
  duplicateProduct: (sourceProductId: string, targetVenueId: string) => Promise<boolean>
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
  venues: CrmVenue[]
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

export function CatalogProductsCrm({ catalog, defaultTaxRate, disabled, duplicateProduct, mutate, venues }: Props) {
  const [filters, setFilters] = useState(defaultFilters)
  const [sortKey, setSortKey] = useState<CatalogProductSortKey>('product')
  const [sortDirection, setSortDirection] = useState<CatalogProductSortDirection>('asc')
  const [page, setPage] = useState(1)
  const [editorProductId, setEditorProductId] = useState<string | 'create' | 'create-menu' | null>(null)
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
  const selectedProduct = editorProductId && editorProductId !== 'create' && editorProductId !== 'create-menu'
    ? catalog.products.find((product) => product.id === editorProductId) ?? null
    : null

  function updateFilters(patch: Partial<CatalogProductFilters>) {
    setFilters((current) => ({ ...current, ...patch }))
    setPage(1)
  }

  function handleSort(nextSortKey: CatalogProductSortKey, nextDirection?: CatalogProductSortDirection) {
    setPage(1)
    if (nextDirection) {
      setSortKey(nextSortKey)
      setSortDirection(nextDirection)
      return
    }
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
    if (!window.confirm(`¿Eliminar definitivamente “${summary.product.name}”? Se eliminarán ${impact}. El histórico de ventas se conserva.`)) return
    const saved = await mutate(() => catalogAdminService.deleteProduct(catalog.venueId, summary.product.id))
    if (saved && editorProductId === summary.product.id) setEditorProductId(null)
  }

  async function duplicate(summary: CatalogProductSummary, targetVenueId: string) {
    const saved = await duplicateProduct(summary.product.id, targetVenueId)
    if (!saved) return
    const targetVenue = venues.find((venue) => venue.id === targetVenueId)
    sileo.success({ title: targetVenueId === catalog.venueId ? 'Producto duplicado' : `Producto copiado en ${targetVenue?.name ?? 'el local'}` })
  }

  return (
    <div className="grid min-w-0 items-start gap-4">
      <CatalogPanel>
        <CatalogPanelHeader
          actions={
            <div className="flex flex-wrap gap-2"><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold text-[var(--crm-text-secondary)]" disabled={disabled} onClick={() => setEditorProductId('create')} type="button"><Plus className="!size-4" /> Añadir producto</UiButton><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)]" disabled={disabled} onClick={() => setEditorProductId('create-menu')} type="button"><Plus className="!size-4" /> Añadir menú</UiButton></div>
          }
          description={`${filtered.length} de ${catalog.products.length} productos · una única carga para todo el local`}
          title="Productos"
        >
          <div className="!grid !gap-2 sm:!grid-cols-2 lg:!grid-cols-[minmax(220px,1fr)_repeat(4,minmax(180px,auto))]">
            <label className="!flex !h-11 !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
              <Search className="!size-4 !text-[var(--crm-text-muted)]" />
              <UiInput className="bg-transparent" onChange={(event) => updateFilters({ query: event.target.value })} placeholder="Buscar producto, variante o ubicación" value={filters.query} />
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

        <DataTable
          aria-label="Productos del catálogo"
          className="!w-full !min-w-[940px] !border-collapse"
          emptyContent="No hay productos que coincidan con los filtros."
          filterable={false}
          onSortChange={({ column, direction }) => handleSort(column as CatalogProductSortKey, direction === 'ascending' ? 'asc' : 'desc')}
          sortDescriptor={{ column: sortKey, direction: sortDirection === 'asc' ? 'ascending' : 'descending' }}
        >
          <thead><tr className="!border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !text-[11px] !font-semibold !uppercase !tracking-[.045em] !text-[var(--crm-text-muted)]">
            <th className="!min-w-[160px] !px-[22px] !py-3" data-column-key="product">Producto</th>
            <th className="!w-[105px] !px-3 !py-3" data-column-key="type">Tipo / estado</th>
            <th className="!w-[64px] !px-3 !py-3" data-column-key="vat">IVA</th>
            <th className="!w-[68px] !px-3 !py-3" data-column-key="variants">Variantes</th>
            <th className="!w-[104px] !px-3 !py-3" data-column-key="price">Precio</th>
            <th className="!min-w-[120px] !px-3 !py-3" data-column-key="locations">Ubicaciones</th>
            <th aria-label="Acciones" className="!w-[168px] !px-[22px] !py-3" data-sortable="false" />
          </tr></thead>
          <tbody>
          {visibleProducts.map((summary) => (
            <tr className="!min-h-[78px] !border-b !border-[var(--crm-border-subtle)] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] hover:!bg-[var(--crm-surface-hover)]" key={summary.product.id}>
              <td className="!min-w-[160px] !px-[22px] !py-3"><div className="flex min-w-0 items-center gap-[11px]">
                {summary.product.image?.publicUrl ? <img alt="" className="grid size-[42px] shrink-0 place-items-center overflow-hidden rounded-xl border-0 bg-[var(--crm-surface-soft)] object-cover text-[var(--crm-text-muted)]" src={summary.product.image.publicUrl} /> : <div className="grid size-[42px] shrink-0 place-items-center overflow-hidden rounded-xl border-0 bg-[var(--crm-surface-soft)] object-cover text-[var(--crm-text-muted)]"><Boxes className="!size-4" /></div>}
                <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]"><strong>{summary.product.name}</strong><span>{summary.product.description || 'Sin descripción'}{summary.internal ? ' · Interno' : ''}</span></div>
              </div></td>
              <td className="!w-[105px] !px-3 !py-3"><div className="!grid !gap-1.5"><span>{summary.product.type === 'menu' ? 'Menú' : 'Estándar'}</span><CatalogStatus active={summary.product.active} /></div></td>
              <td className="!w-[64px] !px-3 !py-3" data-sort-value={summary.product.vatRate ?? defaultTaxRate}>{summary.product.vatRate === null ? 'Heredado' : `${summary.product.vatRate} %`}</td>
              <td className="!w-[68px] !px-3 !py-3" data-sort-value={summary.variants.length}><strong>{summary.variants.length}</strong></td>
              <td className="!w-[104px] !px-3 !py-3" data-sort-value={summary.minPriceCents ?? Number.MAX_SAFE_INTEGER}><strong>{priceLabel(summary)}</strong></td>
              <td className="!min-w-[120px] !px-3 !py-3">{summary.tabs.map((tab) => tab.label).join(', ') || 'Sin apariciones'}<br /><small>{summary.categories.map((category) => category.name).join(', ')}</small></td>
              <td className="!w-[168px] !px-[22px] !py-3"><div className="flex min-w-0 items-center justify-end gap-[7px]">
                <UiButton aria-label={`Editar ${summary.product.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => setEditorProductId(summary.product.id)} type="button"><Pencil className="!size-4" /></UiButton>
                <Dropdown>
                  <Dropdown.Trigger aria-label={`Duplicar ${summary.product.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-0 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] disabled:opacity-50" isDisabled={disabled}>
                    <Copy className="!size-4" /><ChevronDown className="!-mr-1 !size-3" />
                  </Dropdown.Trigger>
                  <Dropdown.Popover className="!w-64" placement="bottom end">
                    <Dropdown.Menu onAction={(key) => void duplicate(summary, String(key))}>
                      <Dropdown.Item id={catalog.venueId} textValue="Duplicar aquí"><Copy className="!size-4" /><Label>Duplicar aquí</Label></Dropdown.Item>
                      {venues.filter((venue) => venue.isActive && venue.id !== catalog.venueId).map((venue) => (
                        <Dropdown.Item id={venue.id} key={venue.id} textValue={`Duplicar en ${venue.name}`}><Copy className="!size-4" /><Label>Duplicar en {venue.name}</Label></Dropdown.Item>
                      ))}
                    </Dropdown.Menu>
                  </Dropdown.Popover>
                </Dropdown>
                <UiButton aria-label={summary.product.active ? 'Desactivar' : 'Activar'} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.setProductActive(catalog.venueId, summary.product.id, !summary.product.active))} type="button">{summary.product.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</UiButton>
                <UiButton aria-label={`Eliminar ${summary.product.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => void removeProduct(summary)} type="button"><Trash2 className="!size-4" /></UiButton>
              </div></td>
            </tr>
          ))}
          </tbody>
        </DataTable>
        <CrmPagination currentPage={visiblePage} onPageChange={setPage} totalResults={filtered.length} />
      </CatalogPanel>

      {editorProductId ? (editorProductId === 'create-menu' || selectedProduct?.type === 'menu' ? (
        <CatalogMenuEditor
          catalog={catalog}
          defaultTaxRate={defaultTaxRate}
          disabled={disabled}
          key={editorProductId}
          mutate={mutate}
          onClose={() => setEditorProductId(null)}
          product={selectedProduct}
        />
      ) : <CatalogProductEditor
          catalog={catalog}
          defaultTaxRate={defaultTaxRate}
          disabled={disabled}
          key={editorProductId}
          mutate={mutate}
          onClose={() => setEditorProductId(null)}
          product={selectedProduct}
        />) : null}
    </div>
  )
}
