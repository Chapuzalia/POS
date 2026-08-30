import { Beaker, Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Checkbox, Input } from '../../../../components/ui'
import type { TenantContext } from '../../../../types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { EmptyList } from '../../shared/components/EmptyList'
import type { RunAction } from '../../shared/types'
import { loadInventorySnapshot, saveInventoryProductionRecipe } from '../services/inventoryService'
import type { InventorySnapshot } from '../types'

type Props = { disabled: boolean; runAction: RunAction; selectedVenueId: string; tenantContext: TenantContext }
type LineDraft = { inventoryItemId: string; quantity: string; unitId: string }
const emptySnapshot: InventorySnapshot = { items: [], itemRoutes: [], levels: [], modifierEffects: [], productionRecipeLines: [], productionRecipes: [], recipeLines: [], recipes: [], units: [], warehouses: [] }

export function InventoryPreparationsCrm({ disabled, runAction, selectedVenueId, tenantContext }: Props) {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [itemId, setItemId] = useState('')
  const [warehouseId, setWarehouseId] = useState('')
  const [referenceQuantity, setReferenceQuantity] = useState('1')
  const [referenceUnitId, setReferenceUnitId] = useState('')
  const [active, setActive] = useState(true)
  const [lines, setLines] = useState<LineDraft[]>([])
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => setSnapshot(await loadInventorySnapshot(tenantContext, selectedVenueId)), [selectedVenueId, tenantContext])
  useEffect(() => { void runAction(refresh) }, [refresh, runAction])

  function selectItem(nextId: string) {
    setItemId(nextId)
    const item = snapshot.items.find((candidate) => candidate.id === nextId)
    const recipe = snapshot.productionRecipes.find((candidate) => candidate.inventoryItemId === nextId)
    setWarehouseId(recipe?.productionWarehouseId ?? snapshot.itemRoutes.filter((route) => route.inventoryItemId === nextId && route.enabled).toSorted((a, b) => a.priority - b.priority)[0]?.warehouseId ?? '')
    setReferenceQuantity(String(recipe?.referenceQuantity ?? 1))
    setReferenceUnitId(recipe?.referenceUnitId ?? item?.baseUnitId ?? '')
    setActive(recipe?.active ?? true)
    setLines(recipe ? snapshot.productionRecipeLines.filter((line) => line.recipeId === recipe.id).toSorted((a, b) => a.sortOrder - b.sortOrder).map((line) => ({ inventoryItemId: line.inventoryItemId, quantity: String(line.quantity), unitId: line.unitId })) : [])
    setError(null)
  }

  function addLine() {
    const ingredient = snapshot.items.find((item) => item.id !== itemId && !lines.some((line) => line.inventoryItemId === item.id))
    if (!ingredient) return
    setLines([...lines, { inventoryItemId: ingredient.id, quantity: '1', unitId: ingredient.baseUnitId }])
  }

  async function save() {
    const quantity = Number(referenceQuantity.replace(',', '.'))
    const parsed = lines.map((line, sortOrder) => ({ ...line, quantity: Number(line.quantity.replace(',', '.')), sortOrder }))
    if (!itemId || !warehouseId || !referenceUnitId || !(quantity > 0) || !parsed.length || parsed.some((line) => !line.inventoryItemId || !line.unitId || !(line.quantity > 0))) return setError('Completa la salida, el almacén y todos los ingredientes con cantidades positivas.')
    await runAction(async () => {
      await saveInventoryProductionRecipe({ inventoryItemId: itemId, productionWarehouseId: warehouseId, referenceQuantity: quantity, referenceUnitId, active, lines: parsed })
      await refresh()
    })
  }

  const selected = snapshot.items.find((item) => item.id === itemId)
  return <section className="overflow-hidden rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
    <header className="border-b border-[var(--crm-border-subtle)] p-5"><h2 className="text-lg font-bold">Elaboraciones</h2><p className="text-sm text-[var(--crm-text-muted)]">Configura cómo se fabrica un artículo. La salida solo define proporciones; la preparación se registra desde KDS o POS.</p></header>
    <div className="grid gap-5 p-5 xl:grid-cols-[320px_1fr]">
      <div className="grid content-start gap-2"><h3 className="text-sm font-bold">Artículos elaborables</h3>{snapshot.items.map((item) => {
        const recipe = snapshot.productionRecipes.find((candidate) => candidate.inventoryItemId === item.id)
        return <button className={`rounded-xl p-3 text-left ${itemId === item.id ? 'bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]' : 'bg-[var(--crm-surface-soft)]'}`} key={item.id} onClick={() => selectItem(item.id)} type="button"><strong className="block">{item.name}</strong><small>{recipe ? (recipe.active ? 'Receta activa' : 'Receta inactiva') : 'Sin receta de producción'}</small></button>
      })}{!snapshot.items.length ? <EmptyList message="Crea primero artículos de inventario." /> : null}</div>
      {selected ? <div className="grid gap-5"><div className="flex items-center gap-3"><span className="grid size-11 place-items-center rounded-xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]"><Beaker className="size-5" /></span><div><h3 className="text-lg font-bold">{selected.name}</h3><p className="text-xs text-[var(--crm-text-muted)]">Receta proporcional, no batch operativo.</p></div></div><div className="grid gap-3 rounded-xl bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-3"><label className="grid gap-1 text-xs font-semibold">Salida de referencia<Input inputMode="decimal" onChange={(event) => setReferenceQuantity(event.target.value)} value={referenceQuantity} /></label><label className="grid gap-1 text-xs font-semibold">Unidad<CrmSelect onChange={setReferenceUnitId} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: unit.symbol, value: unit.id }))} value={referenceUnitId} /></label><label className="grid gap-1 text-xs font-semibold">Almacén de producción<CrmSelect onChange={setWarehouseId} options={snapshot.warehouses.filter((warehouse) => warehouse.active).map((warehouse) => ({ label: warehouse.name, value: warehouse.id }))} value={warehouseId} /></label><Checkbox checked={active} onChange={setActive}>Elaboración disponible en KDS/POS</Checkbox></div><div className="grid gap-3"><div className="flex items-center justify-between"><h3 className="font-bold">Ingredientes</h3><Button disabled={disabled || lines.length >= snapshot.items.length - 1} onClick={addLine} type="button" variant="secondary"><Plus className="size-4" /> Añadir</Button></div>{lines.map((line, index) => <div className="grid gap-2 rounded-xl bg-[var(--crm-surface-soft)] p-3 sm:grid-cols-[1fr_140px_130px_42px]" key={`${index}-${line.inventoryItemId}`}><CrmSelect onChange={(inventoryItemId) => setLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, inventoryItemId, unitId: snapshot.items.find((item) => item.id === inventoryItemId)?.baseUnitId ?? entry.unitId } : entry))} options={snapshot.items.filter((item) => item.id !== itemId && (!lines.some((entry, lineIndex) => lineIndex !== index && entry.inventoryItemId === item.id))).map((item) => ({ label: item.name, value: item.id }))} value={line.inventoryItemId} /><Input aria-label="Cantidad" inputMode="decimal" onChange={(event) => setLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, quantity: event.target.value } : entry))} value={line.quantity} /><CrmSelect onChange={(unitId) => setLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, unitId } : entry))} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: unit.symbol, value: unit.id }))} value={line.unitId} /><Button aria-label="Eliminar ingrediente" onClick={() => setLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} type="button" variant="tertiary"><Trash2 className="size-4" /></Button></div>)}{!lines.length ? <EmptyList message="Añade los ingredientes de la elaboración." /> : null}</div>{error ? <p className="rounded-xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">{error}</p> : null}<div className="flex justify-end"><Button disabled={disabled} onClick={() => void save()} type="button"><Save className="size-4" /> Guardar receta</Button></div></div> : <EmptyList message="Selecciona un artículo para configurar cómo se fabrica." />}
    </div>
  </section>
}
