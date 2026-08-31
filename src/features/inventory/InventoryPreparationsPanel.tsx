import { Beaker, Check, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import { Button, Input } from '../../components/ui'
import type { TenantContext } from '../../types'
import { getReadableError } from '../../utils/errors'
import { loadInventoryPreparations, previewInventoryPreparation, recordInventoryPreparation, type InventoryPreparation, type InventoryPreparationPreview } from './preparationsService'

export function InventoryPreparationsPanel({ context, isOnline, onClose }: { context: TenantContext; isOnline: boolean; onClose?: () => void }) {
  const [items, setItems] = useState<InventoryPreparation[]>([])
  const [selected, setSelected] = useState<InventoryPreparation | null>(null)
  const [quantity, setQuantity] = useState('')
  const [preview, setPreview] = useState<InventoryPreparationPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [success, setSuccess] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    if (!isOnline) return
    try { const next = await loadInventoryPreparations(context.venueId); setItems(next); setSelected((current) => next.find((item) => item.inventoryItemId === current?.inventoryItemId) ?? null); setError(null) }
    catch (cause) { setError(getReadableError(cause)) }
  }, [context.venueId, isOnline])
  useEffect(() => { void refresh() }, [refresh])

  async function showPreview() {
    if (!selected) return
    const parsed = Number(quantity.replace(',', '.'))
    if (!(parsed > 0)) return setError('Indica una cantidad positiva.')
    setBusy(true); setError(null); setSuccess(null)
    try { setPreview(await previewInventoryPreparation(selected.inventoryItemId, parsed, selected.referenceUnitId)) }
    catch (cause) { setError(getReadableError(cause)) }
    finally { setBusy(false) }
  }

  async function confirm() {
    if (!selected || !preview) return
    setBusy(true); setError(null)
    try {
      await recordInventoryPreparation({ inventoryItemId: selected.inventoryItemId, quantity: preview.quantity, unitId: preview.unitId, deviceId: context.deviceId, requestId: crypto.randomUUID() })
      setSuccess(`${selected.name}: preparación registrada correctamente.`); setPreview(null); setQuantity(''); await refresh()
    } catch (cause) { setError(getReadableError(cause)) }
    finally { setBusy(false) }
  }

  return <section className="grid min-h-0 gap-4 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-4 text-[var(--foreground)] shadow-[var(--shadow)]">
    <header className="flex items-center justify-between gap-3"><div><p className="text-xs font-black uppercase tracking-widest text-[var(--muted)]">Inventario</p><h2 className="text-2xl font-black">Preparaciones</h2></div><div className="flex gap-2"><Button disabled={!isOnline || busy} onClick={() => void refresh()} size="md" type="button" variant="secondary"><RefreshCw className="size-4" /> Actualizar</Button>{onClose ? <Button onClick={onClose} size="md" type="button" variant="tertiary"><X className="size-4" /> Cerrar</Button> : null}</div></header>
    {!isOnline ? <p className="rounded-xl border border-[var(--danger)] p-3 font-semibold text-[var(--danger)]">Las preparaciones requieren conexión.</p> : null}
    {error ? <p className="rounded-xl border border-[var(--danger)] p-3 font-semibold text-[var(--danger)]">{error}</p> : null}
    {success ? <p className="rounded-xl border border-[var(--success)] p-3 font-semibold text-[var(--success)]">{success}</p> : null}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">{items.map((item) => <button className={`rounded-xl border p-4 text-left ${selected?.inventoryItemId === item.inventoryItemId ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)] bg-[var(--background)]'}`} key={item.inventoryItemId} onClick={() => { setSelected(item); setQuantity(''); setPreview(null); setSuccess(null) }} type="button"><span className="mb-3 grid size-10 place-items-center rounded-xl bg-[var(--accent-soft)] text-[var(--accent)]"><Beaker className="size-5" /></span><strong className="block text-lg">{item.name}</strong><span className="text-sm text-[var(--muted)]">Disponible: {item.availableStock} {item.unitSymbol}</span><small className="mt-1 block">Producción: {item.warehouseName}</small></button>)}</div>
    {!items.length && isOnline ? <div className="flex min-h-40 items-center justify-center rounded-xl border border-dashed border-[var(--separator)] text-center font-semibold text-[var(--muted)]">No hay elaboraciones activas configuradas en CRM.</div> : null}
    {selected ? <div className="grid gap-4 rounded-xl bg-[var(--background)] p-4"><div><h3 className="font-black">Registrar {selected.name}</h3><p className="text-sm text-[var(--muted)]">Indica la cantidad real preparada; no existe un batch obligatorio.</p></div><label className="grid max-w-sm grid-cols-[1fr_auto] gap-2"><Input aria-label="Cantidad preparada" inputMode="decimal" onChange={(event) => { setQuantity(event.target.value); setPreview(null) }} placeholder="3,7" value={quantity} /><span className="grid min-w-16 place-items-center rounded-xl bg-[var(--surface)] px-3 font-bold">{selected.referenceUnitSymbol}</span></label><Button disabled={busy || !quantity} onClick={() => void showPreview()} type="button" variant="secondary">Calcular consumo</Button>{preview ? <div className="grid gap-3 rounded-xl border border-[var(--accent)] p-4"><h4 className="font-black">Se consumirán</h4>{preview.ingredients.map((ingredient) => <div className={`flex justify-between gap-3 rounded-lg p-2 text-sm ${ingredient.sufficient ? '' : 'bg-amber-500/15 text-amber-800 dark:text-amber-200'}`} key={ingredient.inventoryItemId}><span>{ingredient.name}<small className="block opacity-75">Disponible: {ingredient.availableStock} {ingredient.unitSymbol}</small></span><strong>{ingredient.quantity} {ingredient.unitSymbol}</strong></div>)}{preview.ingredients.some((ingredient) => !ingredient.sufficient) ? <p className="rounded-xl border border-amber-500 p-3 text-sm font-semibold text-amber-800 dark:text-amber-200">Stock insuficiente: se permitirá continuar y el artículo quedará en negativo.</p> : null}<div className="mt-2 flex justify-between border-t border-[var(--separator)] pt-3"><span>Se producirá en {preview.warehouseName}</span><strong>{preview.name} +{preview.quantity} {selected.referenceUnitSymbol}</strong></div><Button disabled={busy} onClick={() => void confirm()} type="button"><Check className="size-4" /> Confirmar preparación</Button></div> : null}</div> : null}
  </section>
}
