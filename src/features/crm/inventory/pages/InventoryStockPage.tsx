import { Save } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { TenantContext } from '../../../../types'
import type { CatalogData } from '../../../catalog/domain/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import type { RunAction } from '../../shared/types'
import {
  formatInventoryQuantity,
  inventoryQuantityStep,
  parseInventoryQuantity,
} from '../inventoryModel'
import { loadInventorySnapshot, saveInventoryProductStock } from '../services/inventoryService'
import type { InventorySnapshot } from '../types'

type Props = {
  catalog: CatalogData
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

type ProductStockDraft = {
  quantities: Record<string, string>
  unitId: string
}

export function InventoryStockCrm({ catalog, disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const products = useMemo(
    () => catalog.products.filter((product) => product.active)
      .toSorted((left, right) => left.name.localeCompare(right.name, 'es')),
    [catalog.products],
  )
  const [snapshot, setSnapshot] = useState<InventorySnapshot>({ levels: [], settings: [], units: [], warehouses: [] })
  const [drafts, setDrafts] = useState<Record<string, ProductStockDraft>>({})
  const [validationErrors, setValidationErrors] = useState<Record<string, string>>({})

  const refresh = useCallback(async () => {
    if (!selectedVenueId) return
    const next = await loadInventorySnapshot(tenantContext, selectedVenueId)
    const settingsByProduct = new Map(next.settings.map((setting) => [setting.productId, setting]))
    const levelsByProductWarehouse = new Map(next.levels.map((level) => [`${level.productId}:${level.warehouseId}`, level.quantity]))
    setSnapshot(next)
    setDrafts(Object.fromEntries(products.map((product) => [
      product.id,
      {
        unitId: settingsByProduct.get(product.id)?.unitId ?? '',
        quantities: Object.fromEntries(next.warehouses.map((warehouse) => [
          warehouse.id,
          String(levelsByProductWarehouse.get(`${product.id}:${warehouse.id}`) ?? 0),
        ])),
      },
    ])))
    setValidationErrors({})
  }, [products, selectedVenueId, tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  const updateDraft = (productId: string, update: (draft: ProductStockDraft) => ProductStockDraft) => {
    setDrafts((current) => ({
      ...current,
      [productId]: update(current[productId] ?? {
        quantities: {},
        unitId: '',
      }),
    }))
    setValidationErrors((current) => {
      const next = { ...current }
      delete next[productId]
      return next
    })
  }

  const saveProduct = async (productId: string) => {
    const draft = drafts[productId]
    const unit = snapshot.units.find((candidate) => candidate.id === draft?.unitId)
    if (!draft || !unit) {
      setValidationErrors((current) => ({ ...current, [productId]: 'Selecciona la unidad de stock.' }))
      return
    }

    let levels: Array<{ warehouseId: string; quantity: number }>
    try {
      const stockDecimalPlaces = unit.contentUnitId === unit.id && unit.contentQuantity === 1
        ? unit.decimalPlaces
        : 6
      levels = snapshot.warehouses.map((warehouse) => ({
        warehouseId: warehouse.id,
        quantity: parseInventoryQuantity(draft.quantities[warehouse.id] ?? '0', stockDecimalPlaces),
      }))
    } catch (error) {
      setValidationErrors((current) => ({
        ...current,
        [productId]: error instanceof Error ? error.message : 'La cantidad no es válida.',
      }))
      return
    }

    await runAction(async () => {
      await saveInventoryProductStock(
        tenantContext,
        selectedVenueId,
        productId,
        unit.id,
        levels,
      )
      await refresh()
    })
  }

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

  return (
    <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
      <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!flex-row md:!items-center md:!px-[22px]">
        <div className="crm-list-title">
          <h2>Stock por producto y almacén</h2>
          <p>{products.length} productos activos · las cantidades admiten hasta 6 decimales según su unidad</p>
        </div>
      </div>

      {!snapshot.units.length ? <div className="!mx-[18px] !mt-[18px] !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)] md:!mx-[22px]">Crea al menos una unidad desde Inventario → Configuración antes de asignar stock.</div> : null}
      {!snapshot.warehouses.length ? <div className="!mx-[18px] !mt-[18px] !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)] md:!mx-[22px]">Crea un almacén para poder indicar dónde se encuentran las existencias.</div> : null}

      <div className="!overflow-x-auto !pt-[18px]">
        <table className="!w-full !min-w-max !border-collapse !text-left">
          <thead>
            <tr className="!bg-[var(--crm-surface-soft)] !text-[11px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
              <th className="!min-w-[240px] !px-[22px] !py-3">Producto</th>
              <th className="!min-w-[210px] !px-3 !py-3">Unidad de stock</th>
              {snapshot.warehouses.map((warehouse) => <th className="!min-w-[170px] !px-3 !py-3" key={warehouse.id}>{warehouse.name}</th>)}
              <th className="!min-w-[130px] !px-3 !py-3">Total</th>
              <th className="!w-[110px] !px-[22px] !py-3"><span className="!sr-only">Acciones</span></th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => {
              const draft = drafts[product.id] ?? {
                quantities: {},
                unitId: '',
              }
              const unit = snapshot.units.find((candidate) => candidate.id === draft.unitId)
              const contentUnit = snapshot.units.find((candidate) => candidate.id === unit?.contentUnitId)
              const parsedQuantities = snapshot.warehouses.map((warehouse) => Number((draft.quantities[warehouse.id] ?? '0').replace(',', '.')))
              const total = parsedQuantities.every(Number.isFinite) ? parsedQuantities.reduce((sum, quantity) => sum + quantity, 0) : null
              const stockDecimalPlaces = unit?.contentUnitId === unit?.id && unit?.contentQuantity === 1
                ? unit?.decimalPlaces ?? 0
                : 6
              const totalContent = total !== null && unit
                ? total * unit.contentQuantity
                : null
              return (
                <tr className="!border-b !border-[var(--crm-border-subtle)] !align-top" key={product.id}>
                  <td className="!px-[22px] !py-3.5">
                    <div className="crm-cell-main"><strong>{product.name}</strong><span>{product.type === 'menu' ? 'Menú' : 'Producto estándar'}</span></div>
                    {validationErrors[product.id] ? <small className="!mt-1 !block !max-w-[230px] !font-semibold !text-[var(--crm-red)]">{validationErrors[product.id]}</small> : null}
                  </td>
                  <td className="!px-3 !py-3">
                    <CrmSelect
                      ariaLabel={`Unidad de inventario de ${product.name}`}
                      disabled={disabled || !unitOptions.length}
                      onChange={(unitId) => updateDraft(product.id, (current) => ({ ...current, unitId }))}
                      options={unitOptions}
                      placeholder="Sin configurar"
                      value={draft.unitId}
                    />
                  </td>
                  {snapshot.warehouses.map((warehouse) => (
                    <td className="!px-3 !py-3" key={warehouse.id}>
                      <div className="!flex !min-h-10 !items-center !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3">
                        <input
                          aria-label={`Stock de ${product.name} en ${warehouse.name}`}
                          className="!min-w-20 !flex-1 !border-0 !bg-transparent !font-mono !text-[13px] !outline-none"
                          disabled={disabled || !unit}
                          inputMode="decimal"
                          min="0"
                          onChange={(event) => updateDraft(product.id, (current) => ({
                            ...current,
                            quantities: { ...current.quantities, [warehouse.id]: event.target.value },
                          }))}
                          step={unit ? inventoryQuantityStep(stockDecimalPlaces) : '1'}
                          type="number"
                          value={draft.quantities[warehouse.id] ?? '0'}
                        />
                        {unit ? <span className="!ml-2 !text-xs !font-semibold !text-[var(--crm-text-muted)]">{unit.symbol}</span> : null}
                      </div>
                    </td>
                  ))}
                  <td className="!px-3 !py-4 !font-mono !text-[13px] !font-semibold">
                    {total === null ? '—' : (
                      <div className="!grid !gap-0.5">
                        <span>{formatInventoryQuantity(total, stockDecimalPlaces)}{unit ? ` ${unit.symbol}` : ''}</span>
                        {totalContent !== null && contentUnit ? <small className="!text-[var(--crm-text-muted)]">{formatInventoryQuantity(totalContent, contentUnit.decimalPlaces)} {contentUnit.symbol}</small> : null}
                      </div>
                    )}
                  </td>
                  <td className="!px-[22px] !py-3">
                    <button aria-label={`Guardar stock de ${product.name}`} className="crm-action-button !inline-flex !min-h-10 !items-center !gap-1.5 !rounded-[9px] !border-0 !bg-[var(--crm-blue-soft)] !px-3 !text-xs !font-semibold !text-[var(--crm-blue)]" disabled={disabled || !draft.unitId} onClick={() => void saveProduct(product.id)} type="button">
                      <Save className="!size-3.5" /> Guardar
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      {!products.length ? <div className="!p-[18px] md:!p-[22px]"><EmptyList message="No hay productos activos en el local seleccionado." /></div> : null}
    </section>
  )
}
