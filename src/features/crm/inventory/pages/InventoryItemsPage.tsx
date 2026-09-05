import { PackagePlus, Pencil, Plus, Save, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input, TextArea } from '../../../../components/ui'
import { DataTable } from '../../../../components/ui/DataTable'
import type { TenantContext } from '../../../../types'
import { CrmModal } from '../../shared/components/CrmModal'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import type { RunAction } from '../../shared/types'
import { formatInventoryQuantity, getEffectiveInventoryItemCost } from '../inventoryModel'
import { loadInventorySnapshot, saveInventoryItem } from '../services/inventoryService'
import type { InventoryItem, InventorySnapshot } from '../types'

type Props = { disabled: boolean; runAction: RunAction; selectedVenueId: string; tenantContext: TenantContext }
type Draft = {
  id: string | null
  name: string
  description: string
  baseUnitId: string
  active: boolean
  routes: Record<string, { enabled: boolean; priority: string }>
}

const emptySnapshot: InventorySnapshot = { items: [], itemRoutes: [], levels: [], modifierEffects: [], productionRecipeLines: [], productionRecipes: [], recipeLines: [], recipes: [], units: [], warehouses: [] }

export function InventoryItemsCrm({ disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [query, setQuery] = useState('')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => setSnapshot(await loadInventorySnapshot(tenantContext, selectedVenueId)), [selectedVenueId, tenantContext])
  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  const items = useMemo(() => snapshot.items.toSorted((a, b) => a.name.localeCompare(b.name, 'es')), [snapshot.items])
  const stock = (itemId: string) => snapshot.levels.filter((level) => level.inventoryItemId === itemId && level.enabled).reduce((sum, level) => sum + level.quantity, 0)

  function open(item?: InventoryItem) {
    const routes = Object.fromEntries(snapshot.warehouses.map((warehouse, index) => {
      const route = item ? snapshot.itemRoutes.find((candidate) => candidate.inventoryItemId === item.id && candidate.warehouseId === warehouse.id) : null
      return [warehouse.id, { enabled: route?.enabled ?? (!item && index === 0), priority: String(route?.priority ?? index + 1) }]
    }))
    setDraft({ id: item?.id ?? null, name: item?.name ?? '', description: item?.description ?? '', baseUnitId: item?.baseUnitId ?? snapshot.units.find((unit) => unit.active)?.id ?? '', active: item?.active ?? true, routes })
    setError(null)
  }

  async function save() {
    if (!draft) return
    const routes = snapshot.warehouses.filter((warehouse) => draft.routes[warehouse.id]?.enabled).map((warehouse) => ({
      warehouseId: warehouse.id, enabled: true, priority: Number(draft.routes[warehouse.id]?.priority),
    }))
    if (!draft.name.trim() || !draft.baseUnitId || !routes.length) return setError('Indica nombre, unidad y al menos un almacén.')
    if (routes.some((route) => !Number.isInteger(route.priority) || route.priority < 1) || new Set(routes.map((route) => route.priority)).size !== routes.length) return setError('Las prioridades activas deben ser enteros positivos diferentes.')
    await runAction(async () => {
      await saveInventoryItem(selectedVenueId, { ...draft, routes })
      await refresh()
      setDraft(null)
    })
  }

  return <section className="overflow-hidden rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
    <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] p-5"><div><h2 className="text-lg font-bold">Artículos de inventario</h2><p className="text-sm text-[var(--crm-text-muted)]">Todo lo que existe físicamente: ingredientes, bebidas y elaboraciones.</p></div><Button disabled={disabled || !snapshot.units.length || !snapshot.warehouses.length} onClick={() => open()} type="button"><Plus className="size-4" /> Nuevo artículo</Button></header>
    {items.length ? <DataTable aria-label="Artículos de inventario" className="!w-full !min-w-[900px] !border-collapse" filterPlaceholder="Carne, harina, salsa…" filterValue={query} onFilterChange={setQuery}>
      <thead>
        <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-xs !font-bold !uppercase !text-[var(--crm-text-muted)]">
          <th className="!min-w-[240px] !px-5 !py-3">Artículo</th>
          <th className="!min-w-[130px] !px-3 !py-3">Unidad</th>
          <th className="!min-w-[140px] !px-3 !py-3">Stock</th>
          <th className="!min-w-[150px] !px-3 !py-3">Coste efectivo</th>
          <th className="!min-w-[170px] !px-3 !py-3">Ruta principal</th>
          <th className="!min-w-[120px] !px-3 !py-3">Vínculos</th>
          <th className="!min-w-[120px] !px-3 !py-3">Tipo</th>
          <th aria-label="Acciones" className="!w-[64px] !px-3 !py-3" data-sortable="false" />
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const unit = snapshot.units.find((candidate) => candidate.id === item.baseUnitId)
          const routes = snapshot.itemRoutes.filter((route) => route.inventoryItemId === item.id && route.enabled).toSorted((a, b) => a.priority - b.priority)
          const primary = snapshot.warehouses.find((warehouse) => warehouse.id === routes[0]?.warehouseId)
          const linkedVariants = snapshot.recipes.filter((recipe) => snapshot.recipeLines.some((line) => line.recipeId === recipe.id && line.inventoryItemId === item.id)).length
          const preparation = snapshot.productionRecipes.some((recipe) => recipe.inventoryItemId === item.id && recipe.active)
          const effectiveCost = getEffectiveInventoryItemCost(item)
          const costSource = effectiveCost?.source === 'average' ? 'Coste medio' : effectiveCost?.source === 'last_purchase' ? 'Última compra' : 'Referencia'
          return <tr className="!border-b !border-[var(--crm-border-subtle)] last:!border-0" key={item.id}>
            <td className="!px-5 !py-3"><span className="flex items-center gap-3"><span className="grid size-9 shrink-0 place-items-center rounded-xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]"><PackagePlus className="size-4" /></span><span className="min-w-0"><strong className="block">{item.name}</strong><small className="block max-w-[320px] truncate text-[var(--crm-text-muted)]">{item.description || 'Sin descripción'} · {item.active ? 'Activo' : 'Inactivo'}</small></span></span></td>
            <td className="!px-3 !py-3"><strong className="block">{unit?.name ?? 'Sin unidad'}</strong><small className="text-[var(--crm-text-muted)]">{unit?.symbol}</small></td>
            <td className="!whitespace-nowrap !px-3 !py-3" data-sort-value={stock(item.id)}><strong className="font-mono">{formatInventoryQuantity(stock(item.id), unit?.decimalPlaces ?? 6)} {unit?.symbol}</strong></td>
            <td className="!whitespace-nowrap !px-3 !py-3" data-sort-value={effectiveCost?.cost ?? -1}>{effectiveCost ? <><strong className="block font-mono">{effectiveCost.cost.toLocaleString('es-ES', { style: 'currency', currency: 'EUR', maximumFractionDigits: 4 })}/{unit?.symbol}</strong><small className="text-[var(--crm-text-muted)]">{costSource}</small></> : <span className="text-[var(--crm-text-muted)]">Sin coste</span>}</td>
            <td className="!px-3 !py-3">{primary?.name ?? 'Sin ruta'}</td>
            <td className="!px-3 !py-3" data-sort-value={linkedVariants}>{linkedVariants} {linkedVariants === 1 ? 'variante' : 'variantes'}</td>
            <td className="!px-3 !py-3">{preparation ? 'Elaboración' : 'Artículo'}</td>
            <td className="!px-3 !py-3"><Button aria-label={`Editar ${item.name}`} disabled={disabled} onClick={() => open(item)} type="button" variant="tertiary"><Pencil className="size-4" /></Button></td>
          </tr>
        })}
      </tbody>
    </DataTable> : <div className="p-5"><EmptyList message="Crea el primer artículo físico de inventario." /></div>}

    {draft ? <CrmModal label={draft.id ? 'Editar artículo' : 'Nuevo artículo'} onClose={() => setDraft(null)}><div className="flex items-center justify-between border-b border-[var(--crm-border-subtle)] p-5"><div><h2 className="text-lg font-bold">{draft.id ? 'Editar artículo' : 'Nuevo artículo'}</h2><p className="text-xs text-[var(--crm-text-muted)]">La ruta define de dónde se consume, no el TPV.</p></div><Button onClick={() => setDraft(null)} type="button" variant="tertiary"><X className="size-4" /></Button></div><div className="grid gap-4 p-5"><label className="grid gap-1 text-xs font-semibold">Nombre<Input autoFocus maxLength={120} onChange={(event) => setDraft({ ...draft, name: event.target.value })} value={draft.name} /></label><label className="grid gap-1 text-xs font-semibold">Descripción<TextArea maxLength={500} onChange={(event) => setDraft({ ...draft, description: event.target.value })} value={draft.description} /></label><label className="grid gap-1 text-xs font-semibold">Unidad física<CrmSelect onChange={(baseUnitId) => setDraft({ ...draft, baseUnitId })} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: `${unit.name} (${unit.symbol})`, value: unit.id }))} value={draft.baseUnitId} /></label><Checkbox checked={draft.active} onChange={(active) => setDraft({ ...draft, active })}>Artículo activo</Checkbox><div className="grid gap-2"><h3 className="text-sm font-bold">Ruta de almacenes</h3>{snapshot.warehouses.filter((warehouse) => warehouse.active).map((warehouse) => <div className="grid grid-cols-[1fr_110px] items-center gap-3 rounded-xl bg-[var(--crm-surface-soft)] p-3" key={warehouse.id}><Checkbox checked={draft.routes[warehouse.id]?.enabled ?? false} onChange={(enabled) => setDraft({ ...draft, routes: { ...draft.routes, [warehouse.id]: { ...draft.routes[warehouse.id], enabled } } })}>{warehouse.name}</Checkbox><Input aria-label={`Prioridad ${warehouse.name}`} disabled={!draft.routes[warehouse.id]?.enabled} min="1" onChange={(event) => setDraft({ ...draft, routes: { ...draft.routes, [warehouse.id]: { ...draft.routes[warehouse.id], priority: event.target.value } } })} type="number" value={draft.routes[warehouse.id]?.priority ?? ''} /></div>)}</div>{error ? <p className="rounded-xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}</div><div className="flex justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4"><Button onClick={() => setDraft(null)} type="button" variant="tertiary">Cancelar</Button><Button disabled={disabled} onClick={() => void save()} type="button"><Save className="size-4" /> Guardar</Button></div></CrmModal> : null}
  </section>
}
