import { Plus, Save, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import type { CatalogData } from '../../../catalog/domain/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { loadInventorySnapshot, saveModifierInventoryEffects } from '../services/inventoryService'
import type { InventorySnapshot } from '../types'

type Draft = { operation: 'ADD' | 'REMOVE'; inventoryItemId: string; quantity: string; unitId: string }
const emptySnapshot: InventorySnapshot = { items: [], itemRoutes: [], levels: [], modifierEffects: [], productionRecipeLines: [], productionRecipes: [], recipeLines: [], recipes: [], units: [], warehouses: [] }

export function ModifierInventoryEffectsEditor({ catalog, disabled, modifierId, onClose }: { catalog: CatalogData; disabled: boolean; modifierId: string; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [drafts, setDrafts] = useState<Draft[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    const next = await loadInventorySnapshot({ tenantId: catalog.tenantId }, catalog.venueId)
    setSnapshot(next)
    setDrafts(next.modifierEffects.filter((effect) => effect.modifierId === modifierId).toSorted((a, b) => a.sortOrder - b.sortOrder).map((effect) => ({ operation: effect.operation, inventoryItemId: effect.inventoryItemId, quantity: String(effect.quantity ?? ''), unitId: effect.unitId ?? '' })))
  }, [catalog.tenantId, catalog.venueId, modifierId])
  useEffect(() => { void refresh() }, [refresh])
  const modifier = catalog.modifiers.find((candidate) => candidate.id === modifierId)

  async function save() {
    const effects = drafts.map((draft, sortOrder) => ({ operation: draft.operation, inventoryItemId: draft.inventoryItemId, quantity: draft.operation === 'ADD' ? Number(draft.quantity.replace(',', '.')) : null, unitId: draft.operation === 'ADD' ? draft.unitId : null, sortOrder }))
    if (effects.some((effect) => !effect.inventoryItemId || (effect.operation === 'ADD' && (!(Number(effect.quantity) > 0) || !effect.unitId)))) return setMessage('Completa los efectos ADD con cantidad y unidad.')
    try { await saveModifierInventoryEffects(modifierId, effects); setMessage('Efectos de inventario guardados.') } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'No se pudo guardar.') }
  }

  return <div className="grid gap-3 rounded-xl border border-[var(--crm-blue)] bg-[var(--crm-blue-soft)] p-4"><div className="flex items-center justify-between"><div><h3 className="font-bold">Inventario · {modifier?.name}</h3><p className="text-xs text-[var(--crm-text-muted)]">REMOVE elimina primero el ingrediente completo; después se aplican todos los ADD.</p></div><Button onClick={onClose} type="button" variant="tertiary"><X className="size-4" /></Button></div>{drafts.map((draft, index) => <div className="grid gap-2 rounded-xl bg-[var(--crm-surface)] p-3 sm:grid-cols-[120px_1fr_120px_110px_42px]" key={index}><CrmSelect onChange={(operation) => setDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, operation: operation as Draft['operation'] } : entry))} options={[{ label: 'ADD', value: 'ADD' }, { label: 'REMOVE', value: 'REMOVE' }]} value={draft.operation} /><CrmSelect onChange={(inventoryItemId) => setDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, inventoryItemId, unitId: snapshot.items.find((item) => item.id === inventoryItemId)?.baseUnitId ?? entry.unitId } : entry))} options={snapshot.items.filter((item) => item.active).map((item) => ({ label: item.name, value: item.id }))} value={draft.inventoryItemId} /><Input aria-label="Cantidad" disabled={draft.operation === 'REMOVE'} inputMode="decimal" onChange={(event) => setDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, quantity: event.target.value } : entry))} value={draft.quantity} /><CrmSelect disabled={draft.operation === 'REMOVE'} onChange={(unitId) => setDrafts((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, unitId } : entry))} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: unit.symbol, value: unit.id }))} value={draft.unitId} /><Button aria-label="Eliminar efecto" onClick={() => setDrafts((current) => current.filter((_, entryIndex) => entryIndex !== index))} type="button" variant="tertiary"><Trash2 className="size-4" /></Button></div>)}<div className="flex flex-wrap justify-between gap-2"><Button disabled={!snapshot.items.length} onClick={() => { const item = snapshot.items[0]; setDrafts([...drafts, { operation: 'ADD', inventoryItemId: item?.id ?? '', quantity: '1', unitId: item?.baseUnitId ?? '' }]) }} type="button" variant="secondary"><Plus className="size-4" /> Añadir efecto</Button><Button disabled={disabled} onClick={() => void save()} type="button"><Save className="size-4" /> Guardar efectos</Button></div>{message ? <p className="text-sm font-semibold">{message}</p> : null}</div>
}
