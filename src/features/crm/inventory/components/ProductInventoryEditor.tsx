import { Plus, Save, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Checkbox, Input } from '../../../../components/ui'
import type { CatalogData, CatalogProduct } from '../../../catalog/domain/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { loadInventorySnapshot, saveInventoryItem, saveVariantInventoryRecipe } from '../services/inventoryService'
import type { InventorySnapshot } from '../types'

type Props = { catalog: CatalogData; disabled: boolean; inventoryRecipesEnabled: boolean; product: CatalogProduct }
type VariantDirectDraft = { inherited: boolean; quantity: string; unitId: string }
type RecipeLineDraft = { inventoryItemId: string; quantity: string; unitId: string }
const emptySnapshot: InventorySnapshot = { items: [], itemRoutes: [], levels: [], modifierEffects: [], productionRecipeLines: [], productionRecipes: [], recipeLines: [], recipes: [], units: [], warehouses: [] }

export function ProductInventoryEditor({ catalog, disabled, inventoryRecipesEnabled, product }: Props) {
  const variants = useMemo(() => catalog.variants.filter((variant) => variant.productId === product.id).toSorted((a, b) => a.sortOrder - b.sortOrder), [catalog.variants, product.id])
  const [snapshot, setSnapshot] = useState(emptySnapshot)
  const [mode, setMode] = useState<'none' | 'direct' | 'recipe'>('none')
  const [directItemId, setDirectItemId] = useState('')
  const [autoUnitId, setAutoUnitId] = useState('')
  const [directDrafts, setDirectDrafts] = useState<Record<string, VariantDirectDraft>>({})
  const [selectedVariantId, setSelectedVariantId] = useState(variants[0]?.id ?? '')
  const [recipeLines, setRecipeLines] = useState<RecipeLineDraft[]>([])
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const refresh = useCallback(async () => setSnapshot(await loadInventorySnapshot({ tenantId: catalog.tenantId }, catalog.venueId)), [catalog.tenantId, catalog.venueId])
  useEffect(() => { void refresh() }, [refresh])

  useEffect(() => {
    if (!snapshot.units.length) return
    setAutoUnitId((value) => value || snapshot.units.find((unit) => unit.active)?.id || '')
    const recipes = variants.map((variant) => snapshot.recipes.find((recipe) => recipe.variantId === variant.id)).filter(Boolean)
    const nextMode = !recipes.length ? 'none' : recipes.every((recipe) => recipe?.mode === 'direct') ? 'direct' : inventoryRecipesEnabled ? 'recipe' : 'none'
    setMode(nextMode)
    const directRecipe = recipes.find((recipe) => recipe?.mode === 'direct')
    const firstLine = snapshot.recipeLines.find((line) => line.recipeId === directRecipe?.id)
    setDirectItemId((value) => value || firstLine?.inventoryItemId || '')
    setDirectDrafts(Object.fromEntries(variants.map((variant) => {
      const recipe = snapshot.recipes.find((candidate) => candidate.variantId === variant.id)
      const line = snapshot.recipeLines.find((candidate) => candidate.recipeId === recipe?.id)
      const format = catalog.saleFormats.find((candidate) => candidate.id === variant.formatId)
      return [variant.id, {
        inherited: line?.usesFormatDefault ?? true,
        quantity: String(line?.quantity ?? format?.inventoryConsumptionQuantity ?? ''),
        unitId: line?.unitId ?? format?.inventoryConsumptionUnitId ?? snapshot.units[0]?.id ?? '',
      }]
    })))
  }, [catalog.saleFormats, inventoryRecipesEnabled, snapshot, variants])

  useEffect(() => {
    const recipe = snapshot.recipes.find((candidate) => candidate.variantId === selectedVariantId)
    setRecipeLines(snapshot.recipeLines.filter((line) => line.recipeId === recipe?.id).map((line) => ({
      inventoryItemId: line.inventoryItemId, quantity: String(line.quantity ?? ''), unitId: line.unitId ?? '',
    })))
  }, [selectedVariantId, snapshot.recipeLines, snapshot.recipes])

  async function run(action: () => Promise<void>) {
    setBusy(true); setMessage(null)
    try { await action(); await refresh(); setMessage('Configuración de inventario guardada.') }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : 'No se pudo guardar.') }
    finally { setBusy(false) }
  }

  async function saveNone() {
    await run(async () => { for (const variant of variants) await saveVariantInventoryRecipe(variant.id, 'none', []) })
  }

  async function ensureDirectItem() {
    if (directItemId) return directItemId
    const warehouse = snapshot.warehouses.find((candidate) => candidate.active)
    if (!warehouse || !autoUnitId) throw new Error('Selecciona una unidad y asegúrate de tener un almacén activo.')
    return saveInventoryItem(catalog.venueId, {
      name: product.name, description: product.description ?? '', baseUnitId: autoUnitId, active: true,
      routes: [{ warehouseId: warehouse.id, priority: 1, enabled: true }],
    })
  }

  async function saveDirect() {
    await run(async () => {
      const itemId = await ensureDirectItem()
      setDirectItemId(itemId)
      for (const variant of variants) {
        const draft = directDrafts[variant.id]
        if (!draft) continue
        const quantity = Number(draft.quantity.replace(',', '.'))
        if (!draft.inherited && (!(quantity > 0) || !draft.unitId)) throw new Error(`Completa el consumo de ${variant.name}.`)
        await saveVariantInventoryRecipe(variant.id, 'direct', [{
          inventoryItemId: itemId, quantity: draft.inherited ? null : quantity,
          unitId: draft.inherited ? null : draft.unitId, usesFormatDefault: draft.inherited, sortOrder: 0,
        }])
      }
    })
  }

  function addRecipeLine() {
    const item = snapshot.items.find((candidate) => !recipeLines.some((line) => line.inventoryItemId === candidate.id))
    if (item) setRecipeLines([...recipeLines, { inventoryItemId: item.id, quantity: '1', unitId: item.baseUnitId }])
  }

  async function saveRecipe() {
    await run(async () => {
      if (!inventoryRecipesEnabled) throw new Error('La feature Escandallos está desactivada para este negocio.')
      const lines = recipeLines.map((line, sortOrder) => ({
        inventoryItemId: line.inventoryItemId, quantity: Number(line.quantity.replace(',', '.')),
        unitId: line.unitId, usesFormatDefault: false, sortOrder,
      }))
      if (!lines.length || lines.some((line) => !line.inventoryItemId || !line.unitId || !(line.quantity > 0))) throw new Error('Añade ingredientes con cantidades positivas.')
      await saveVariantInventoryRecipe(selectedVariantId, 'recipe', lines)
    })
  }

  return <section className="grid gap-4 border-t border-[var(--crm-border-subtle)] pt-5">
    <div><h3 className="font-bold">Inventario</h3><p className="text-sm text-[var(--crm-text-muted)]">¿Cómo afecta este producto al stock?</p></div>
    <div className="grid gap-2 sm:grid-cols-3">{([
      ['none', 'No controlar inventario'], ['direct', 'Consumo directo'], ['recipe', 'Escandallo'],
    ] as const).filter(([value]) => inventoryRecipesEnabled || value !== 'recipe').map(([value, label]) => <button className={`rounded-xl border p-4 text-left font-semibold ${mode === value ? 'border-[var(--crm-blue)] bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]' : 'border-[var(--crm-border-subtle)] bg-[var(--crm-surface-soft)]'}`} key={value} onClick={() => setMode(value)} type="button">{label}</button>)}</div>

    {mode === 'none' ? <div className="flex justify-end"><Button disabled={disabled || busy} onClick={() => void saveNone()} type="button"><Save className="size-4" /> Guardar sin consumo</Button></div> : null}
    {mode === 'direct' ? <div className="grid gap-4 rounded-xl bg-[var(--crm-surface-soft)] p-4"><div className="grid gap-3 sm:grid-cols-2"><label className="grid gap-1 text-xs font-semibold">Artículo físico<CrmSelect onChange={setDirectItemId} options={[{ label: `Crear automáticamente “${product.name}”`, value: '' }, ...snapshot.items.filter((item) => item.active).map((item) => ({ label: item.name, value: item.id }))]} value={directItemId} /></label>{!directItemId ? <label className="grid gap-1 text-xs font-semibold">Unidad del nuevo artículo<CrmSelect onChange={setAutoUnitId} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: `${unit.name} (${unit.symbol})`, value: unit.id }))} value={autoUnitId} /></label> : null}</div><div className="grid gap-2">{variants.map((variant) => {
      const draft = directDrafts[variant.id] ?? { inherited: true, quantity: '', unitId: '' }
      const format = catalog.saleFormats.find((candidate) => candidate.id === variant.formatId)
      return <div className="grid gap-2 rounded-xl bg-[var(--crm-surface)] p-3 sm:grid-cols-[1fr_190px_120px] sm:items-center" key={variant.id}><div><strong className="block">{variant.name}</strong><small className="text-[var(--crm-text-muted)]">Predeterminado de {format?.name}: {format?.inventoryConsumptionQuantity ?? 'sin configurar'} {snapshot.units.find((unit) => unit.id === format?.inventoryConsumptionUnitId)?.symbol ?? ''}</small></div><Checkbox checked={draft.inherited} onChange={(inherited) => setDirectDrafts((current) => ({ ...current, [variant.id]: { ...draft, inherited } }))}>Usar predeterminado</Checkbox><div className="grid grid-cols-2 gap-1"><Input aria-label={`Cantidad ${variant.name}`} disabled={draft.inherited} inputMode="decimal" onChange={(event) => setDirectDrafts((current) => ({ ...current, [variant.id]: { ...draft, quantity: event.target.value } }))} value={draft.quantity} /><CrmSelect ariaLabel={`Unidad ${variant.name}`} disabled={draft.inherited} onChange={(unitId) => setDirectDrafts((current) => ({ ...current, [variant.id]: { ...draft, unitId } }))} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: unit.symbol, value: unit.id }))} value={draft.unitId} /></div></div>
    })}</div><div className="flex justify-end"><Button disabled={disabled || busy || !variants.length} onClick={() => void saveDirect()} type="button"><Save className="size-4" /> Guardar consumo directo</Button></div></div> : null}

    {inventoryRecipesEnabled && mode === 'recipe' ? <div className="grid gap-4 rounded-xl bg-[var(--crm-surface-soft)] p-4"><label className="grid gap-1 text-xs font-semibold">Variante<CrmSelect onChange={setSelectedVariantId} options={variants.map((variant) => ({ label: variant.name, value: variant.id }))} value={selectedVariantId} /></label><div className="flex items-center justify-between"><h4 className="font-bold">Ingredientes</h4><Button disabled={recipeLines.length >= snapshot.items.length} onClick={addRecipeLine} type="button" variant="secondary"><Plus className="size-4" /> Añadir ingrediente</Button></div>{recipeLines.map((line, index) => <div className="grid gap-2 rounded-xl bg-[var(--crm-surface)] p-3 sm:grid-cols-[1fr_130px_120px_42px]" key={`${index}-${line.inventoryItemId}`}><CrmSelect onChange={(inventoryItemId) => setRecipeLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, inventoryItemId, unitId: snapshot.items.find((item) => item.id === inventoryItemId)?.baseUnitId ?? entry.unitId } : entry))} options={snapshot.items.filter((item) => !recipeLines.some((entry, lineIndex) => lineIndex !== index && entry.inventoryItemId === item.id)).map((item) => ({ label: item.name, value: item.id }))} value={line.inventoryItemId} /><Input inputMode="decimal" onChange={(event) => setRecipeLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, quantity: event.target.value } : entry))} value={line.quantity} /><CrmSelect onChange={(unitId) => setRecipeLines((current) => current.map((entry, lineIndex) => lineIndex === index ? { ...entry, unitId } : entry))} options={snapshot.units.filter((unit) => unit.active).map((unit) => ({ label: unit.symbol, value: unit.id }))} value={line.unitId} /><Button aria-label="Eliminar ingrediente" onClick={() => setRecipeLines((current) => current.filter((_, lineIndex) => lineIndex !== index))} type="button" variant="tertiary"><Trash2 className="size-4" /></Button></div>)}<div className="flex justify-end"><Button disabled={disabled || busy || !selectedVariantId} onClick={() => void saveRecipe()} type="button"><Save className="size-4" /> Guardar escandallo de variante</Button></div></div> : null}
    {message ? <p className="rounded-xl bg-[var(--crm-blue-soft)] p-3 text-sm font-semibold text-[var(--crm-blue)]">{message}</p> : null}
  </section>
}
