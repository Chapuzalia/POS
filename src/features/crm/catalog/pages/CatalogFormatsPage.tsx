import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
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
          <UiInput
            aria-label="Nombre del nuevo formato"
            className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !min-w-0 !flex-1"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => { if (event.key === 'Enter') void createFormat() }}
            placeholder="Ej. Copa, Botella, Chupito…"
            value={name}
          />
          <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)]" disabled={disabled || !name.trim()} onClick={() => void createFormat()} type="button">
            <Plus className="!size-4" /> Añadir formato
          </UiButton>
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
              <UiInput
                aria-label={`Cantidad consumida por ${format.name}`}
                className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !font-mono"
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
              <UiButton aria-label={`Guardar consumo de ${format.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !text-[var(--crm-blue)]" disabled={disabled || (!draft.quantity.trim() && !draft.unitId)} onClick={() => void saveConsumption(format.id)} type="button"><Save className="!size-4" /></UiButton>
            </div>
            <CatalogStatus active={format.active} />
            <div className="flex min-w-0 items-center justify-end gap-[7px]">
              <UiButton aria-label="Subir formato" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === 0} onClick={() => void moveFormat(format.id, -1)} type="button"><ArrowUp className="!size-4" /></UiButton>
              <UiButton aria-label="Bajar formato" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === catalog.saleFormats.length - 1} onClick={() => void moveFormat(format.id, 1)} type="button"><ArrowDown className="!size-4" /></UiButton>
              <UiButton aria-label={`Editar ${format.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void renameFormat(format.id, format.name)} type="button"><Pencil className="!size-4" /></UiButton>
              <UiButton aria-label={format.active ? `Desactivar ${format.name}` : `Activar ${format.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, active: !format.active }))} type="button">{format.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</UiButton>
              <UiButton aria-label={`Quitar consumo de ${format.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || (!format.inventoryConsumptionUnitId && format.inventoryConsumptionQuantity === null)} onClick={() => { setConsumptionDrafts((current) => ({ ...current, [format.id]: { quantity: '', unitId: '' } })); void mutate(() => catalogAdminService.saveSaleFormat(catalog.venueId, { ...format, inventoryConsumptionQuantity: null, inventoryConsumptionUnitId: null })) }} type="button"><X className="!size-4" /></UiButton>
              <UiButton aria-label={`Eliminar ${format.name}`} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => void deleteFormat(format.id, format.name)} type="button"><Trash2 className="!size-4" /></UiButton>
            </div>
          </div>
          )
        })}
        {!catalog.saleFormats.length ? <EmptyList message="Todavía no hay formatos. Añade el primero para poder crear variantes de producto." /> : null}
      </div>
    </CatalogPanel>
  )
}
