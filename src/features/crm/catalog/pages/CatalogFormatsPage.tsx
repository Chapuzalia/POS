import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { EmptyList } from '../../shared/components/EmptyList.tsx'
import { inventoryQuantityStep, parsePositiveInventoryQuantity } from '../../inventory/inventoryModel.ts'
import { loadInventoryUnits } from '../../inventory/services/inventoryService.ts'
import type { InventoryUnit } from '../../inventory/types.ts'
import { CatalogPanel, CatalogPanelHeader, CatalogStatus } from '../components/CatalogUi.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { moveCatalogItem, toReorderItems } from '../services/catalogAdminModel.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
}

export function CatalogFormatsCrm({ catalog, disabled, mutate }: Props) {
  const [name, setName] = useState('')
  const [inventoryUnits, setInventoryUnits] = useState<InventoryUnit[]>([])
  const [consumptionDrafts, setConsumptionDrafts] = useState<Record<string, { quantity: string; unitId: string }>>({})
  const usageByFormat = useMemo(() => {
    const counts = new Map<string, number>()
    for (const variant of catalog.variants) {
      if (variant.formatId) counts.set(variant.formatId, (counts.get(variant.formatId) ?? 0) + 1)
    }
    return counts
  }, [catalog.variants])

  useEffect(() => {
    setConsumptionDrafts(Object.fromEntries(catalog.saleFormats.map((format) => [
      format.id,
      {
        quantity: format.inventoryConsumptionQuantity === null ? '' : String(format.inventoryConsumptionQuantity),
        unitId: format.inventoryConsumptionUnitId ?? '',
      },
    ])))
  }, [catalog.saleFormats])

  useEffect(() => {
    let active = true
    void loadInventoryUnits({ tenantId: catalog.tenantId }, catalog.venueId)
      .then((units) => {
        if (active) {
          setInventoryUnits(units.filter((unit) => (
            unit.active
            && unit.contentUnitId === unit.id
            && unit.contentQuantity === 1
          )))
        }
      })
      .catch(() => { if (active) setInventoryUnits([]) })
    return () => { active = false }
  }, [catalog.tenantId, catalog.venueId])

  async function createFormat() {
    const nextName = name.trim()
    if (!nextName) return
    const saved = await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, {
      name: nextName,
      active: true,
      sortOrder: catalog.saleFormats.length * 10,
    }))
    if (saved) setName('')
  }

  async function moveFormat(id: string, direction: -1 | 1) {
    const reordered = moveCatalogItem(catalog.saleFormats, id, direction)
    await mutate(() => catalogAdminService.reorderSaleFormats(catalog.venueId, toReorderItems(reordered)))
  }

  async function saveConsumption(formatId: string) {
    const format = catalog.saleFormats.find((item) => item.id === formatId)
    const draft = consumptionDrafts[formatId] ?? { quantity: '', unitId: '' }
    if (!format) return
    if (!draft.quantity.trim() && !draft.unitId) {
      await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, {
        ...format,
        inventoryConsumptionQuantity: null,
        inventoryConsumptionUnitId: null,
      }))
      return
    }
    const unit = inventoryUnits.find((candidate) => candidate.id === draft.unitId)
    if (!unit) {
      window.alert('Selecciona la unidad consumida por este formato.')
      return
    }
    try {
      const quantity = parsePositiveInventoryQuantity(draft.quantity, unit.decimalPlaces, 'El consumo')
      await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, {
        ...format,
        inventoryConsumptionQuantity: quantity,
        inventoryConsumptionUnitId: unit.id,
      }))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : 'El consumo no es válido.')
    }
  }

  async function renameFormat(id: string, currentName: string) {
    const format = catalog.saleFormats.find((item) => item.id === id)
    const nextName = window.prompt('Nombre del formato', currentName)?.trim()
    if (!format || !nextName || nextName === currentName) return
    await mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, name: nextName }))
  }

  async function deleteFormat(id: string, formatName: string) {
    const usage = usageByFormat.get(id) ?? 0
    if (usage > 0) {
      window.alert(`“${formatName}” se utiliza en ${usage} variantes. Cambia esas variantes antes de eliminar el formato.`)
      return
    }
    if (window.confirm(`¿Eliminar definitivamente el formato “${formatName}”?`)) {
      await mutate(() => catalogAdminService.deleteSaleFormat(catalog.venueId, id))
    }
  }

  return (
    <CatalogPanel>
      <CatalogPanelHeader
        description="Define los formatos reutilizables y cuánto inventario consume cada venta."
        title="Formatos de venta"
      >
        <div className="!flex !max-w-xl !gap-2">
          <input
            aria-label="Nombre del nuevo formato"
            className="crm-input !min-w-0 !flex-1"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createFormat() }}
            placeholder="Ej. Copa, Botella, Chupito…"
            value={name}
          />
          <button className="crm-primary-button" disabled={disabled || !name.trim()} onClick={() => void createFormat()} type="button">
            <Plus className="!size-4" /> Añadir formato
          </button>
        </div>
      </CatalogPanelHeader>

      {!inventoryUnits.length ? (
        <div className="!mx-[18px] !mt-[18px] !rounded-xl !bg-[var(--crm-yellow-soft)] !p-4 !text-sm !font-semibold !text-[var(--crm-yellow)] md:!mx-[22px]">
          Crea primero las unidades de consumo en Inventario → Configuración para poder definir las recetas.
        </div>
      ) : null}

      <div className="!grid !overflow-auto">
        {catalog.saleFormats.map((format, index) => {
          const draft = consumptionDrafts[format.id] ?? { quantity: '', unitId: '' }
          const selectedUnit = inventoryUnits.find((unit) => unit.id === draft.unitId)
          return (
          <div className="!grid !min-h-[72px] !min-w-[980px] !grid-cols-[minmax(160px,1fr)_110px_minmax(330px,1.4fr)_110px_auto] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !px-[22px] !py-3 !text-sm" key={format.id}>
            <strong className="!text-[var(--crm-text)]">{format.name}</strong>
            <span className="!text-[var(--crm-text-secondary)]">{usageByFormat.get(format.id) ?? 0} variantes</span>
            <div className="!grid !grid-cols-[110px_minmax(150px,1fr)_40px] !items-center !gap-2">
              <input
                aria-label={`Cantidad consumida por ${format.name}`}
                className="crm-input !font-mono"
                disabled={disabled || !inventoryUnits.length}
                inputMode="decimal"
                min="0"
                onChange={(event) => setConsumptionDrafts((current) => ({
                  ...current,
                  [format.id]: { ...draft, quantity: event.target.value },
                }))}
                placeholder="Sin consumo"
                step={selectedUnit ? inventoryQuantityStep(selectedUnit.decimalPlaces) : '1'}
                type="number"
                value={draft.quantity}
              />
              <CrmSelect
                ariaLabel={`Unidad consumida por ${format.name}`}
                disabled={disabled || !inventoryUnits.length}
                onChange={(unitId) => setConsumptionDrafts((current) => ({
                  ...current,
                  [format.id]: { ...draft, unitId },
                }))}
                options={inventoryUnits.map((unit) => ({ label: `${unit.name} (${unit.symbol})`, value: unit.id }))}
                placeholder="Unidad consumida"
                value={draft.unitId}
              />
              <button aria-label={`Guardar consumo de ${format.name}`} className="crm-action-button !text-[var(--crm-blue)]" disabled={disabled || (!draft.quantity.trim() && !draft.unitId)} onClick={() => void saveConsumption(format.id)} type="button"><Save className="!size-4" /></button>
            </div>
            <CatalogStatus active={format.active} />
            <div className="crm-action-group">
              <button aria-label="Subir formato" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void moveFormat(format.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
              <button aria-label="Bajar formato" className="crm-action-button" disabled={disabled || index === catalog.saleFormats.length - 1} onClick={() => void moveFormat(format.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
              <button aria-label={`Editar ${format.name}`} className="crm-action-button" disabled={disabled} onClick={() => void renameFormat(format.id, format.name)} type="button"><Pencil className="!size-4" /></button>
              <button aria-label={format.active ? `Desactivar ${format.name}` : `Activar ${format.name}`} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, active: !format.active }))} type="button">{format.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
              <button aria-label={`Quitar consumo de ${format.name}`} className="crm-action-button" disabled={disabled || (!format.inventoryConsumptionUnitId && format.inventoryConsumptionQuantity === null)} onClick={() => { setConsumptionDrafts((current) => ({ ...current, [format.id]: { quantity: '', unitId: '' } })); void mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null })) }} type="button"><X className="!size-4" /></button>
              <button aria-label={`Eliminar ${format.name}`} className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void deleteFormat(format.id, format.name)} type="button"><Trash2 className="!size-4" /></button>
            </div>
          </div>
          )
        })}
        {!catalog.saleFormats.length ? <EmptyList message="Todavía no hay formatos. Añade el primero para poder crear variantes de producto." /> : null}
      </div>
    </CatalogPanel>
  )
}
