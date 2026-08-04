import { Button as UiButton } from '../../../../components/ui/Button'
import { DataTable as UiDataTable } from '../../../../components/ui/DataTable'
import { Input as UiInput } from '../../../../components/ui/Input'
import { ChevronRight, Package, Save, Search, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import type { TenantContext } from '../../../../types'
import type { CatalogData } from '../../../catalog/domain/types'
import { CrmModal } from '../../shared/components/CrmModal'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import type { RunAction } from '../../shared/types'
import {
  formatInventoryQuantity,
  inventoryQuantityStep,
  parseInventoryQuantity,
} from '../inventoryModel'
import { loadInventorySnapshot, saveInventoryProductStock, setVenueInventoryEnabled } from '../services/inventoryService'
import type { InventorySnapshot, InventoryUnit } from '../types'

type Props = {
  catalog: CatalogData
  disabled: boolean
  inventoryEnabled: boolean
  onInventoryEnabledChange: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

type ProductStockDraft = {
  enabledByWarehouse: Record<string, boolean>
  quantities: Record<string, string>
  unitId: string
}

function normalizeSearch(value: string) {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('es')
}

function stockDecimalPlaces(unit: InventoryUnit | undefined) {
  if (!unit) return 0
  return unit.contentUnitId === unit.id && unit.contentQuantity === 1
    ? unit.decimalPlaces
    : 6
}

export function InventoryStockCrm({ catalog, disabled, inventoryEnabled, onInventoryEnabledChange, runAction, selectedVenueId, tenantContext }: Props) {
  const products = useMemo(
    () => catalog.products.filter((product) => product.active)
      .toSorted((left, right) => left.name.localeCompare(right.name, 'es')),
    [catalog.products],
  )
  const [snapshot, setSnapshot] = useState<InventorySnapshot>({ levels: [], settings: [], units: [], warehouses: [] })
  const [query, setQuery] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [page, setPage] = useState(1)
  const [selectedProductId, setSelectedProductId] = useState<string | null>(null)
  const [modalDraft, setModalDraft] = useState<ProductStockDraft | null>(null)
  const [validationError, setValidationError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)

  const refresh = useCallback(async () => {
    if (!selectedVenueId || !inventoryEnabled) {
      setSnapshot({ levels: [], settings: [], units: [], warehouses: [] })
      return
    }
    setSnapshot(await loadInventorySnapshot(tenantContext, selectedVenueId))
  }, [inventoryEnabled, selectedVenueId, tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  const categories = useMemo(
    () => catalog.categories.filter((category) => category.active)
      .toSorted((left, right) => left.name.localeCompare(right.name, 'es')),
    [catalog.categories],
  )
  const categoriesById = useMemo(
    () => new Map(categories.map((category) => [category.id, category])),
    [categories],
  )
  const categoryIdsByProduct = useMemo(() => {
    const result = new Map<string, Set<string>>()
    for (const placement of catalog.placements) {
      if (!placement.active || !placement.categoryId || !categoriesById.has(placement.categoryId)) continue
      const productCategories = result.get(placement.productId) ?? new Set<string>()
      productCategories.add(placement.categoryId)
      result.set(placement.productId, productCategories)
    }
    return result
  }, [catalog.placements, categoriesById])

  const stockRows = useMemo(() => {
    const settingsByProduct = new Map(snapshot.settings.map((setting) => [setting.productId, setting]))
    const unitsById = new Map(snapshot.units.map((unit) => [unit.id, unit]))
    const totalsByProduct = new Map<string, number>()
    for (const level of snapshot.levels) {
      if (!level.enabled) continue
      totalsByProduct.set(level.productId, (totalsByProduct.get(level.productId) ?? 0) + level.quantity)
    }

    return products.map((product) => {
      const productCategoryIds = [...(categoryIdsByProduct.get(product.id) ?? [])]
      return {
        product,
        categoryIds: productCategoryIds,
        categoryNames: productCategoryIds
          .map((id) => categoriesById.get(id)?.name)
          .filter((name): name is string => Boolean(name))
          .toSorted((left, right) => left.localeCompare(right, 'es')),
        total: totalsByProduct.get(product.id) ?? 0,
        unit: unitsById.get(settingsByProduct.get(product.id)?.unitId ?? ''),
      }
    })
  }, [categoriesById, categoryIdsByProduct, products, snapshot.levels, snapshot.settings, snapshot.units])

  const filteredRows = useMemo(() => {
    const normalizedQuery = normalizeSearch(deferredQuery)
    return stockRows.filter((row) => (
      (!normalizedQuery || normalizeSearch(row.product.name).includes(normalizedQuery))
      && (!categoryId || row.categoryIds.includes(categoryId))
    ))
  }, [categoryId, deferredQuery, stockRows])
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(page, totalPages)
  const visibleRows = filteredRows.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const selectedProduct = selectedProductId
    ? products.find((product) => product.id === selectedProductId) ?? null
    : null
  const selectedProductCategories = selectedProduct
    ? stockRows.find((row) => row.product.id === selectedProduct.id)?.categoryNames ?? []
    : []
  const modalUnit = snapshot.units.find((unit) => unit.id === modalDraft?.unitId)
  const modalDecimalPlaces = stockDecimalPlaces(modalUnit)
  const modalTotal = modalDraft
    ? snapshot.warehouses.reduce((total, warehouse) => {
      if (!modalDraft.enabledByWarehouse[warehouse.id]) return total
      const quantity = Number((modalDraft.quantities[warehouse.id] ?? '0').replace(',', '.'))
      return Number.isFinite(quantity) ? total + quantity : total
    }, 0)
    : 0

  const unitOptions = snapshot.units.filter((unit) => unit.active).map((unit) => {
    const contentUnit = snapshot.units.find((candidate) => candidate.id === unit.contentUnitId)
    const equivalence = unit.contentUnitId === unit.id && unit.contentQuantity === 1
      ? ''
      : ` · ${unit.contentQuantity} ${contentUnit?.symbol ?? ''}`
    return {
      label: `${unit.name} (${unit.symbol})${equivalence}`,
      value: unit.id,
    }
  })

  function updateQuery(value: string) {
    setQuery(value)
    setPage(1)
  }

  function updateCategory(value: string) {
    setCategoryId(value)
    setPage(1)
  }

  function openProduct(productId: string) {
    const setting = snapshot.settings.find((candidate) => candidate.productId === productId)
    const levelsByWarehouse = new Map(snapshot.levels
      .filter((level) => level.productId === productId)
      .map((level) => [level.warehouseId, level]))
    const quantities = Object.fromEntries(snapshot.warehouses.map((warehouse) => [
      warehouse.id,
      String(levelsByWarehouse.get(warehouse.id)?.quantity ?? 0),
    ]))
    const enabledByWarehouse = Object.fromEntries(snapshot.warehouses.map((warehouse) => [
      warehouse.id,
      levelsByWarehouse.get(warehouse.id)?.enabled ?? false,
    ]))
    setSelectedProductId(productId)
    setModalDraft({ enabledByWarehouse, quantities, unitId: setting?.unitId ?? '' })
    setValidationError(null)
  }

  function closeModal() {
    setSelectedProductId(null)
    setModalDraft(null)
    setValidationError(null)
  }

  function updateModalDraft(update: (draft: ProductStockDraft) => ProductStockDraft) {
    setModalDraft((current) => current ? update(current) : current)
    setValidationError(null)
  }

  async function saveProduct() {
    if (!selectedProduct || !modalDraft || !modalUnit) {
      setValidationError('Selecciona la unidad de stock.')
      return
    }

    let levels: Array<{ enabled: boolean; warehouseId: string; quantity: number }>
    try {
      levels = snapshot.warehouses.map((warehouse) => ({
        enabled: modalDraft.enabledByWarehouse[warehouse.id] ?? false,
        warehouseId: warehouse.id,
        quantity: parseInventoryQuantity(
          modalDraft.quantities[warehouse.id] ?? '0',
          modalDecimalPlaces,
        ),
      }))
    } catch (error) {
      setValidationError(error instanceof Error ? error.message : 'La cantidad no es válida.')
      return
    }

    await runAction(async () => {
      await saveInventoryProductStock(
        tenantContext,
        selectedVenueId,
        selectedProduct.id,
        modalUnit.id,
        levels,
      )
      await refresh()
      closeModal()
    })
  }

  async function changeInventoryEnabled(enabled: boolean) {
    await runAction(async () => {
      await setVenueInventoryEnabled(selectedVenueId, enabled)
      await onInventoryEnabledChange()
    })
  }

  return (
    <>
      <section className="!mb-4 !flex !items-center !justify-between !gap-4 !rounded-2xl !bg-[var(--crm-surface)] !px-[18px] !py-5 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)] md:!mb-5 md:!px-[22px]">
        <div className="!min-w-0">
          <h2 className="!m-0 !text-[17px] !font-bold !tracking-[-0.02em]">Control de stock</h2>
          <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">{inventoryEnabled ? 'Activo: las ventas descuentan existencias según almacén y TPV.' : 'Desactivado: las ventas ignoran completamente el inventario.'}</p>
        </div>
        <label className="!flex !shrink-0 !cursor-pointer !items-center !gap-3 !text-[13px] !font-semibold">
          <span>{inventoryEnabled ? 'Activado' : 'Desactivado'}</span>
          <input
            aria-label="Activar control de stock"
            checked={inventoryEnabled}
            className="!size-5 !accent-[var(--crm-blue)]"
            disabled={disabled || !selectedVenueId}
            onChange={(event) => { void changeInventoryEnabled(event.target.checked) }}
            type="checkbox"
          />
        </label>
      </section>

      {inventoryEnabled ? (
      <>
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="!flex !flex-col !items-stretch !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px] lg:!flex-row lg:!items-end">
          <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]">
            <h2>Stock por producto</h2>
            <p>{filteredRows.length} de {products.length} productos activos · pulsa una fila para consultar el stock por almacén</p>
          </div>
          <div className="!grid !gap-2 sm:!grid-cols-2 lg:!w-auto lg:!grid-cols-[minmax(260px,360px)_220px]">
            <label className="!flex !h-11 !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
              <Search className="!size-4 !shrink-0 !text-[var(--crm-text-muted)]" />
              <UiInput
                aria-label="Buscar producto"
                className="!border-0 !bg-transparent !p-0"
                onChange={(event) => updateQuery(event.target.value)}
                placeholder="Buscar producto"
                value={query}
              />
            </label>
            <CrmSelect
              ariaLabel="Filtrar por categoría"
              onChange={updateCategory}
              options={[
                { label: 'Todas las categorías', value: '' },
                ...categories.map((category) => ({ label: category.name, value: category.id })),
              ]}
              value={categoryId}
            />
          </div>
        </div>

        {!snapshot.units.length ? <div className="!mx-[18px] !mt-[18px] !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)] md:!mx-[22px]">Crea al menos una unidad desde Inventario → Configuración antes de asignar stock.</div> : null}
        {!snapshot.warehouses.length ? <div className="!mx-[18px] !mt-[18px] !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)] md:!mx-[22px]">Crea un almacén para poder indicar dónde se encuentran las existencias.</div> : null}

        <div className="!overflow-x-auto !pt-[18px]">
          <UiDataTable aria-label="Stock de productos" className="!w-full !min-w-[760px] !border-collapse !text-left">
            <thead>
              <tr className="!bg-[var(--crm-surface-soft)] !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
                <th className="!min-w-[260px] !px-[22px] !py-3">Producto</th>
                <th className="!min-w-[210px] !px-3 !py-3">Categoría</th>
                <th className="!min-w-[190px] !px-3 !py-3">Unidad</th>
                <th className="!min-w-[150px] !px-3 !py-3">Stock total</th>
                <th className="!w-14 !px-[22px] !py-3"><span className="!sr-only">Abrir detalle</span></th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => {
                const decimalPlaces = stockDecimalPlaces(row.unit)
                const contentUnit = snapshot.units.find((unit) => unit.id === row.unit?.contentUnitId)
                const totalContent = row.unit ? row.total * row.unit.contentQuantity : null
                return (
                  <tr
                    aria-label={`Abrir stock de ${row.product.name}`}
                    className="!cursor-pointer !border-b !border-[var(--crm-border-subtle)] !align-middle !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]"
                    key={row.product.id}
                    onClick={() => openProduct(row.product.id)}
                  >
                    <td className="!px-[22px] !py-3.5">
                      <div className="!flex !min-w-0 !items-center !gap-3">
                        {row.product.image?.publicUrl ? (
                          <img alt="" className="!size-10 !shrink-0 !rounded-xl !bg-[var(--crm-surface-soft)] !object-cover" src={row.product.image.publicUrl} />
                        ) : (
                          <span className="!grid !size-10 !shrink-0 !place-items-center !rounded-xl !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]"><Package className="!size-4" /></span>
                        )}
                        <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]">
                          <strong>{row.product.name}</strong>
                          <span>{row.product.type === 'menu' ? 'Menú' : 'Producto estándar'}</span>
                        </div>
                      </div>
                    </td>
                    <td className="!px-3 !py-3.5 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">{row.categoryNames.join(', ') || 'Sin categoría'}</td>
                    <td className="!px-3 !py-3.5 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">{row.unit ? `${row.unit.name} (${row.unit.symbol})` : 'Sin configurar'}</td>
                    <td className="!px-3 !py-3.5 !font-mono !text-[13px] !font-semibold">
                      {row.unit ? (
                        <div className="!grid !gap-0.5">
                          <span className={row.total < 0 ? '!text-[var(--crm-red)]' : ''}>{formatInventoryQuantity(row.total, decimalPlaces)} {row.unit.symbol}</span>
                          {totalContent !== null && contentUnit ? <small className="!text-[var(--crm-text-muted)]">{formatInventoryQuantity(totalContent, contentUnit.decimalPlaces)} {contentUnit.symbol}</small> : null}
                        </div>
                      ) : '—'}
                    </td>
                    <td className="!px-[22px] !py-3.5 !text-right !text-[var(--crm-text-muted)]"><ChevronRight className="!ml-auto !size-4" /></td>
                  </tr>
                )
              })}
            </tbody>
          </UiDataTable>
        </div>
        {!filteredRows.length ? <div className="!p-[18px] md:!p-[22px]"><EmptyList message={products.length ? 'No hay productos que coincidan con los filtros.' : 'No hay productos activos en el local seleccionado.'} /></div> : null}
        <CrmPagination currentPage={visiblePage} onPageChange={setPage} totalResults={filteredRows.length} />
      </section>

      {selectedProduct && modalDraft ? (
        <CrmModal label={`Stock de ${selectedProduct.name}`} onClose={closeModal}>
          <form className="!flex !min-h-0 !flex-1 !flex-col" onSubmit={(event) => { event.preventDefault(); void saveProduct() }}>
            <div className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-5 md:!px-[22px]">
              <div className="!min-w-0">
                <h2 className="!m-0 !truncate !text-lg !font-bold">{selectedProduct.name}</h2>
                <p className="!mt-1 !mb-0 !truncate !text-xs !font-medium !text-[var(--crm-text-muted)]">{selectedProductCategories.join(', ') || 'Sin categoría'}</p>
              </div>
              <UiButton aria-label="Cerrar" className="!inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-[var(--crm-text-muted)]" disabled={disabled} onClick={closeModal} type="button"><X className="!size-4" /></UiButton>
            </div>

            <div className="!grid !min-h-0 !gap-5 !overflow-y-auto !px-[18px] !py-5 md:!px-[22px]">
              <label className="!grid !gap-1.5">
                <span className="!text-xs !font-semibold !text-[var(--crm-text-secondary)]">Unidad de stock</span>
                <CrmSelect
                  ariaLabel={`Unidad de inventario de ${selectedProduct.name}`}
                  disabled={disabled || !unitOptions.length}
                  onChange={(unitId) => updateModalDraft((current) => ({ ...current, unitId }))}
                  options={unitOptions}
                  placeholder="Selecciona una unidad"
                  value={modalDraft.unitId}
                />
              </label>

              <fieldset className="!grid !gap-3" disabled={disabled || !modalUnit}>
                <legend className="!mb-0 !text-sm !font-bold">Stock según almacén</legend>
                {snapshot.warehouses.map((warehouse) => {
                  const warehouseEnabled = modalDraft.enabledByWarehouse[warehouse.id] ?? false
                  return (
                  <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[minmax(0,1fr)_180px] sm:!items-center" key={warehouse.id}>
                    <label className="!flex !min-w-0 !cursor-pointer !items-start !gap-3">
                      <input
                        aria-label={`Incluir ${selectedProduct.name} en ${warehouse.name}`}
                        checked={warehouseEnabled}
                        className="!mt-0.5 !size-4 !shrink-0 !accent-[var(--crm-blue)]"
                        onChange={(event) => updateModalDraft((current) => ({
                          ...current,
                          enabledByWarehouse: {
                            ...current.enabledByWarehouse,
                            [warehouse.id]: event.target.checked,
                          },
                        }))}
                        type="checkbox"
                      />
                      <span className="!grid !min-w-0 !gap-0.5">
                        <strong className="!truncate !text-[13px] !font-semibold">{warehouse.name}</strong>
                        <small className="!truncate !text-xs !font-medium !text-[var(--crm-text-muted)]">{warehouseEnabled ? 'Producto disponible en este almacén' : 'Producto excluido de este almacén'}</small>
                      </span>
                    </label>
                    <span className="!flex !min-h-10 !items-center !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
                      <UiInput
                        aria-label={`Stock de ${selectedProduct.name} en ${warehouse.name}`}
                        className="!min-w-20 !flex-1 !border-0 !bg-transparent !p-0 !font-mono !text-[13px] !outline-none"
                        disabled={!warehouseEnabled}
                        inputMode="decimal"
                        min="0"
                        onChange={(event) => updateModalDraft((current) => ({
                          ...current,
                          quantities: { ...current.quantities, [warehouse.id]: event.target.value },
                        }))}
                        step={modalUnit ? inventoryQuantityStep(modalDecimalPlaces) : '1'}
                        type="number"
                        value={modalDraft.quantities[warehouse.id] ?? '0'}
                      />
                      {modalUnit ? <span className="!ml-2 !text-xs !font-semibold !text-[var(--crm-text-muted)]">{modalUnit.symbol}</span> : null}
                    </span>
                  </div>
                  )
                })}
                {!snapshot.warehouses.length ? <p className="!m-0 !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)]">No hay almacenes configurados.</p> : null}
              </fieldset>

              <div className="!flex !items-center !justify-between !gap-4 !rounded-xl !border !border-[var(--crm-border-subtle)] !px-4 !py-3">
                <span className="!text-xs !font-semibold !text-[var(--crm-text-muted)]">Stock total</span>
                <strong className={modalTotal < 0 ? '!font-mono !text-sm !text-[var(--crm-red)]' : '!font-mono !text-sm'}>{modalUnit ? `${formatInventoryQuantity(modalTotal, modalDecimalPlaces)} ${modalUnit.symbol}` : '—'}</strong>
              </div>
              {validationError ? <p className="!m-0 !rounded-xl !bg-[var(--crm-red-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-red)]" role="alert">{validationError}</p> : null}
            </div>

            <div className="!flex !justify-end !gap-2 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-4 md:!px-[22px]">
              <UiButton className="!inline-flex !min-h-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)]" disabled={disabled} onClick={closeModal} type="button">Cancelar</UiButton>
              <UiButton className="!inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white" disabled={disabled || !modalDraft.unitId || !snapshot.warehouses.length} type="submit"><Save className="!size-4" /> Guardar</UiButton>
            </div>
          </form>
        </CrmModal>
      ) : null}
      </>
      ) : (
        <section className="!rounded-2xl !bg-[var(--crm-surface)] !p-6 !text-[var(--crm-text)] !shadow-[var(--crm-shadow-card)]">
          <h2 className="!m-0 !text-base !font-bold">Inventario desactivado para este local</h2>
          <p className="!mt-2 !mb-0 !text-sm !font-medium !text-[var(--crm-text-muted)]">No se descontará stock, no se crearán movimientos y las páginas de almacenes y configuración permanecerán ocultas.</p>
        </section>
      )}
    </>
  )
}
