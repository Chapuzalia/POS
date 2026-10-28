import { Save } from 'lucide-react'
import { useState } from 'react'
import { Button, Checkbox, Input, TextArea } from '../../../../components/ui'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { useCrmModalBusy } from '../../shared/components/CrmModalBusyContext'
import type { RunAction } from '../../shared/types'
import { createInventoryItemDraft, parseInventoryItemDraft } from '../inventoryItemEditorModel'
import { saveInventoryItem, type InventoryStockPageData } from '../services/inventoryService'
import type { InventoryItem } from '../types'

type Props = {
  disabled: boolean
  item: InventoryItem | null
  snapshot: InventoryStockPageData
  venueId: string
  runAction: RunAction
  onCancel: () => void
  onSaved: (itemId: string) => Promise<void>
}

export function InventoryItemEditor({ disabled, item, snapshot, venueId, runAction, onCancel, onSaved }: Props) {
  const modalBusy = useCrmModalBusy(disabled)
  const [draft, setDraft] = useState(() => createInventoryItemDraft(snapshot, item))
  const [error, setError] = useState<string | null>(null)
  const hasStock = !!item && snapshot.levels.some((level) => level.inventoryItemId === item.id && level.quantity !== 0)
  const warehouses = snapshot.warehouses.filter((warehouse) => warehouse.active || snapshot.itemRoutes.some((route) => route.inventoryItemId === item?.id && route.warehouseId === warehouse.id))
  const units = snapshot.units.filter((unit) => unit.active || unit.id === item?.baseUnitId)

  async function save() {
    try {
      const input = parseInventoryItemDraft(draft, snapshot)
      setError(null)
      await runAction(async () => {
        const itemId = await saveInventoryItem(venueId, input)
        await onSaved(itemId)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo guardar el artículo.')
    }
  }

  function updateRoute(warehouseId: string, patch: Partial<(typeof draft.routes)[string]>) {
    setDraft((current) => ({ ...current, routes: { ...current.routes, [warehouseId]: { ...current.routes[warehouseId], ...patch } } }))
    setError(null)
  }

  return <form onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="grid gap-4 p-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="grid gap-1 text-xs font-semibold">Nombre
          <Input autoFocus disabled={disabled} maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} />
        </label>
        <label className="grid gap-1 text-xs font-semibold">Unidad física
          <CrmSelect ariaLabel="Unidad física del artículo" disabled={disabled || hasStock} onChange={(baseUnitId) => setDraft({ ...draft, baseUnitId })} options={units.map((unit) => ({ label: `${unit.name} (${unit.symbol})${unit.active ? '' : ' · Inactiva'}`, value: unit.id, disabled: !unit.active && unit.id !== item?.baseUnitId }))} value={draft.baseUnitId} />
        </label>
      </div>
      {hasStock ? <p className="m-0 text-xs text-[var(--crm-text-muted)]">La unidad física no se puede cambiar mientras haya existencias en algún almacén.</p> : null}
      <label className="grid gap-1 text-xs font-semibold">Descripción
        <TextArea disabled={disabled} maxLength={500} onChange={(event) => setDraft({ ...draft, description: event.target.value })} value={draft.description} />
      </label>
      <Checkbox checked={draft.active} disabled={disabled} onChange={(active) => setDraft({ ...draft, active })}>Artículo activo</Checkbox>
      <div className="grid gap-3">
        <div><h3 className="m-0 text-sm font-bold">Almacenes, objetivos y orden de consumo</h3><p className="mt-1 mb-0 text-xs text-[var(--crm-text-muted)]">Una prioridad menor se consume primero. Deja el objetivo vacío si no necesitas un nivel de reposición. Guardar la configuración conserva las cantidades actuales.</p></div>
        {warehouses.map((warehouse) => {
          const route = draft.routes[warehouse.id]
          return <div className="grid gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-[minmax(0,1fr)_110px_150px] sm:items-center" key={warehouse.id}>
            <Checkbox checked={route?.enabled ?? false} disabled={disabled} onChange={(enabled) => updateRoute(warehouse.id, { enabled })}>{warehouse.name}{warehouse.active ? '' : ' · Inactivo'}</Checkbox>
            <label className="grid gap-1 text-xs font-semibold">Prioridad
              <Input aria-label={`Prioridad ${warehouse.name}`} disabled={disabled || !route?.enabled} max="9999" min="1" onChange={(event) => updateRoute(warehouse.id, { priority: event.target.value })} type="number" value={route?.priority ?? ''} />
            </label>
            <label className="grid gap-1 text-xs font-semibold">Stock objetivo
              <Input aria-label={`Stock objetivo ${warehouse.name}`} disabled={disabled || !route?.enabled} inputMode="decimal" onChange={(event) => updateRoute(warehouse.id, { targetQuantity: event.target.value })} placeholder="Sin objetivo" value={route?.targetQuantity ?? ''} />
            </label>
          </div>
        })}
      </div>
      {error ? <p className="m-0 rounded-[var(--crm-radius-md)] bg-[var(--crm-red-soft)] p-3 text-sm text-[var(--crm-red)]" role="alert">{error}</p> : null}
    </div>
    <div className="flex flex-wrap justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4">
      <Button disabled={modalBusy} onClick={onCancel} type="button" variant="tertiary">Cancelar</Button>
      <Button disabled={disabled} type="submit"><Save className="size-4" /> {item ? 'Guardar artículo' : 'Crear artículo'}</Button>
    </div>
  </form>
}
