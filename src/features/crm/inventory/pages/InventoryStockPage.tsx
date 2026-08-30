import { ChevronRight, Package, Save, Search, X } from 'lucide-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import { DataTable } from '../../../../components/ui/DataTable'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { EmptyList } from '../../shared/components/EmptyList'
import type { RunAction } from '../../shared/types'
import { formatInventoryQuantity, parseInventoryQuantity } from '../inventoryModel'
import { loadInventorySnapshot, saveInventoryItemStock, setVenueInventoryEnabled } from '../services/inventoryService'
import type { InventorySnapshot } from '../types'

type Props = {
  disabled: boolean
  inventoryEnabled: boolean
  onInventoryEnabledChange: () => Promise<void>
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
}

const emptySnapshot: InventorySnapshot = {
  items: [], itemRoutes: [], levels: [], modifierEffects: [], productionRecipeLines: [],
  productionRecipes: [], recipeLines: [], recipes: [], units: [], warehouses: [],
}

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLocaleLowerCase('es')
}

export function InventoryStockCrm({ disabled, inventoryEnabled, onInventoryEnabledChange, runAction, selectedVenueId, tenantContext }: Props) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot>(emptySnapshot)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [quantities, setQuantities] = useState<Record<string, string>>({})
  const [error, setError] = useState<string | null>(null)
  const deferredQuery = useDeferredValue(query)

  const refresh = useCallback(async () => {
    if (!selectedVenueId || !inventoryEnabled) return setSnapshot(emptySnapshot)
    setSnapshot(await loadInventorySnapshot(tenantContext, selectedVenueId))
  }, [inventoryEnabled, selectedVenueId, tenantContext])

  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  const rows = useMemo(() => snapshot.items
    .filter((item) => !deferredQuery || normalize(item.name).includes(normalize(deferredQuery)))
    .map((item) => {
      const unit = snapshot.units.find((candidate) => candidate.id === item.baseUnitId)
      const levels = snapshot.levels.filter((level) => level.inventoryItemId === item.id && level.enabled)
      const primaryRoute = snapshot.itemRoutes
        .filter((route) => route.inventoryItemId === item.id && route.enabled)
        .toSorted((a, b) => a.priority - b.priority)[0]
      return {
        item, unit,
        total: levels.reduce((sum, level) => sum + level.quantity, 0),
        warehouse: snapshot.warehouses.find((warehouse) => warehouse.id === primaryRoute?.warehouseId),
        isPreparation: snapshot.productionRecipes.some((recipe) => recipe.inventoryItemId === item.id && recipe.active),
      }
    }).toSorted((a, b) => a.item.name.localeCompare(b.item.name, 'es')),
  [deferredQuery, snapshot])

  const selected = snapshot.items.find((item) => item.id === selectedId)
  const selectedUnit = snapshot.units.find((unit) => unit.id === selected?.baseUnitId)
  const selectedRoutes = snapshot.itemRoutes.filter((route) => route.inventoryItemId === selectedId && route.enabled)
    .toSorted((a, b) => a.priority - b.priority)

  function open(itemId: string) {
    setSelectedId(itemId)
    setQuantities(Object.fromEntries(snapshot.warehouses.map((warehouse) => [
      warehouse.id,
      String(snapshot.levels.find((level) => level.inventoryItemId === itemId && level.warehouseId === warehouse.id)?.quantity ?? 0),
    ])))
    setError(null)
  }

  async function save() {
    if (!selected) return
    try {
      const levels = snapshot.warehouses.map((warehouse) => ({
        warehouseId: warehouse.id,
        enabled: selectedRoutes.some((route) => route.warehouseId === warehouse.id),
        quantity: parseInventoryQuantity(quantities[warehouse.id] ?? '0', selectedUnit?.decimalPlaces ?? 6),
      }))
      await runAction(async () => {
        await saveInventoryItemStock(tenantContext, selectedVenueId, selected.id, levels)
        await refresh()
        setSelectedId(null)
      })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Cantidad no válida.')
    }
  }

  return <section className="overflow-hidden rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] p-5">
      <div><h2 className="text-lg font-bold">Stock físico</h2><p className="text-sm text-[var(--crm-text-muted)]">Existencias por artículo y almacén. El stock negativo está permitido.</p></div>
      <label className="flex items-center gap-3 rounded-xl bg-[var(--crm-surface-soft)] px-4 py-3 text-sm font-semibold">
        <input checked={inventoryEnabled} disabled={disabled} onChange={(event) => void runAction(async () => {
          await setVenueInventoryEnabled(selectedVenueId, event.target.checked)
          await onInventoryEnabledChange()
        })} type="checkbox" /> Control de inventario activo
      </label>
    </header>

    {inventoryEnabled ? <>
      <div className="border-b border-[var(--crm-border-subtle)] p-4">
        <label className="flex h-11 items-center gap-2 rounded-xl bg-[var(--crm-input-bg)] px-3"><Search className="size-4 text-[var(--crm-text-muted)]" /><Input aria-label="Buscar artículo" className="border-0 bg-transparent p-0 focus:shadow-none" onChange={(event) => setQuery(event.target.value)} placeholder="Buscar artículo físico" value={query} /></label>
      </div>
      {rows.length ? <DataTable aria-label="Stock por artículo" className="!w-full !min-w-[720px] !border-collapse">
        <thead>
          <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-xs !font-bold !uppercase !text-[var(--crm-text-muted)]">
            <th className="!min-w-[220px] !px-5 !py-3">Artículo</th>
            <th className="!w-[140px] !px-3 !py-3">Disponible</th>
            <th className="!min-w-[170px] !px-3 !py-3">Ruta principal</th>
            <th className="!w-[130px] !px-3 !py-3">Tipo</th>
            <th aria-label="Acciones" className="!w-[42px] !px-3 !py-3" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => <tr aria-label={`Editar stock de ${row.item.name}`} className="!cursor-pointer !border-b !border-[var(--crm-border-subtle)] !outline-none hover:!bg-[var(--crm-surface-hover)] focus-visible:!bg-[var(--crm-surface-hover)] last:!border-0" key={row.item.id} onClick={() => open(row.item.id)} role="button" tabIndex={0}>
            <td className="!px-5 !py-3"><span className="flex items-center gap-3"><span className="grid size-9 place-items-center rounded-xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]"><Package className="size-4" /></span><span><strong className="block">{row.item.name}</strong><small className="text-[var(--crm-text-muted)]">{row.item.active ? 'Activo' : 'Inactivo'}</small></span></span></td>
            <td className="!whitespace-nowrap !px-3 !py-3"><strong className="font-mono">{formatInventoryQuantity(row.total, row.unit?.decimalPlaces ?? 6)} {row.unit?.symbol}</strong></td>
            <td className="!px-3 !py-3">{row.warehouse?.name ?? 'Sin ruta'}</td>
            <td className="!px-3 !py-3">{row.isPreparation ? 'Elaboración' : 'Artículo'}</td>
            <td className="!px-3 !py-3"><ChevronRight className="size-4" /></td>
          </tr>)}
        </tbody>
      </DataTable> : <div className="p-5"><EmptyList message="No hay artículos de inventario. Créelos desde Inventario → Artículos." /></div>}
    </> : <div className="p-6"><EmptyList message="Activa el control de inventario para gestionar existencias." /></div>}

    {selected ? <CrmModal label={`Stock de ${selected.name}`} onClose={() => setSelectedId(null)}>
      <div className="flex items-center justify-between border-b border-[var(--crm-border-subtle)] p-5"><div><h2 className="text-lg font-bold">{selected.name}</h2><p className="text-xs text-[var(--crm-text-muted)]">Unidad física: {selectedUnit?.name ?? 'Sin unidad'}</p></div><Button aria-label="Cerrar" onClick={() => setSelectedId(null)} type="button" variant="tertiary"><X className="size-4" /></Button></div>
      <div className="grid gap-3 p-5">{selectedRoutes.map((route) => {
        const warehouse = snapshot.warehouses.find((candidate) => candidate.id === route.warehouseId)
        return <label className="grid gap-2 rounded-xl bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-[1fr_180px] sm:items-center" key={route.warehouseId}><span><strong className="block">{route.priority}. {warehouse?.name}</strong><small className="text-[var(--crm-text-muted)]">Se consume por este orden, independientemente del TPV.</small></span><Input inputMode="decimal" onChange={(event) => setQuantities((current) => ({ ...current, [route.warehouseId]: event.target.value }))} value={quantities[route.warehouseId] ?? '0'} /></label>
      })}{!selectedRoutes.length ? <EmptyList message="Configura una ruta de almacenes en la ficha del artículo." /> : null}{error ? <p className="rounded-xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}</div>
      <div className="flex justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4"><Button onClick={() => setSelectedId(null)} type="button" variant="tertiary">Cancelar</Button><Button disabled={disabled || !selectedRoutes.length} onClick={() => void save()} type="button"><Save className="size-4" /> Guardar stock</Button></div>
    </CrmModal> : null}
  </section>
}
