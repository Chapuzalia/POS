import { Minus, Pencil, Plus, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { resolveSellableProduct } from '../../features/catalog/domain/resolver'
import type { CatalogData, ResolvedCatalogSelectionGroup, ResolvedCatalogSelectionOption } from '../../features/catalog/domain/types'
import { canonicalizeProductModifiers } from '../../features/catalog/services/saleLineBuilder'
import { addMenuBatchChoice, addMenuBatchPreparation, getMenuBatchChoiceCapacity, getMenuBatchPreparations, removeMenuBatchChoice, replaceMenuBatchPreparation, type MenuBatchDraft } from '../../features/restaurant/services/menuBatch'
import { formatMoney } from '../../lib/format'
import type { TicketLineModifier } from '../../types'
import { Button } from '../ui/Button'

type Props = {
  catalog: CatalogData
  draft: MenuBatchDraft
  group: ResolvedCatalogSelectionGroup
  option: ResolvedCatalogSelectionOption
  disabled: boolean
  configuring: boolean
  onConfigure: () => void
  onCloseConfiguration: () => void
  onChange: (draft: MenuBatchDraft) => void
}
type Preparation = { key: string; quantity: number; modifiers: TicketLineModifier[] }
type Editor = { selectedIds: string[]; quantity: number; previous?: Preparation }

export function MenuBatchOptionCard({ catalog, draft, group, option, disabled, configuring, onConfigure, onCloseConfiguration, onChange }: Props) {
  const sellable = useMemo(() => resolveSellableProduct(catalog, option.product.id, option.variant.id), [catalog, option.product.id, option.variant.id])
  const preparations = getMenuBatchPreparations(draft, group.group.id, option.id)
  const quantity = preparations.reduce((sum, preparation) => sum + preparation.quantity, 0)
  const hasModifiers = sellable.modifierGroups.length > 0
  const full = getMenuBatchChoiceCapacity(draft.selections, group, option) === 0
  const [editor, setEditor] = useState<Editor | null>(null)
  const [error, setError] = useState<string | null>(null)
  const formRef = useRef<HTMLDivElement>(null)
  useEffect(() => { if (configuring) formRef.current?.scrollIntoView({ block: 'nearest' }) }, [configuring])
  const selectedModifiers = sellable.modifierGroups.flatMap((resolved) => resolved.modifiers
    .filter((modifier) => editor?.selectedIds.includes(modifier.id)).map((modifier) => ({ id: modifier.id, groupId: resolved.group.id, name: modifier.name, priceCents: modifier.supplementCents })))
  let valid = true
  try { canonicalizeProductModifiers(sellable.modifierGroups, selectedModifiers) } catch { valid = false }
  const capacity = getMenuBatchChoiceCapacity(draft.selections, group, option, selectedModifiers)
  const amount = editor?.previous ? editor.previous.quantity : Math.min(editor?.quantity ?? 1, capacity)
  const supplement = option.supplementCents + selectedModifiers.reduce((sum, modifier) => sum + modifier.priceCents, 0)
  const cardDisabled = disabled || configuring

  function start(previous?: Preparation) {
    setError(null)
    setEditor({ previous, quantity: 1, selectedIds: previous ? previous.modifiers.map((modifier) => modifier.id)
      : sellable.modifierGroups.flatMap((resolved) => resolved.modifiers.filter((modifier) => modifier.isDefault).map((modifier) => modifier.id)) })
    onConfigure()
  }
  function close() { setEditor(null); setError(null); onCloseConfiguration() }
  function request() {
    if (hasModifiers) start()
    else onChange(addMenuBatchChoice(catalog, draft, group, option))
  }
  function toggle(groupId: string, modifierId: string, maximum: number) {
    setError(null)
    setEditor((current) => {
      if (!current) return current
      if (current.selectedIds.includes(modifierId)) return { ...current, selectedIds: current.selectedIds.filter((id) => id !== modifierId) }
      const ids = new Set(sellable.modifierGroups.find((resolved) => resolved.group.id === groupId)?.modifiers.map((modifier) => modifier.id))
      const selectedInGroup = current.selectedIds.filter((id) => ids.has(id))
      if (maximum !== 1 && selectedInGroup.length >= maximum) return current
      return { ...current, selectedIds: [...(maximum === 1 ? current.selectedIds.filter((id) => !ids.has(id)) : current.selectedIds), modifierId] }
    })
  }
  function confirm() {
    if (disabled || !editor || !valid || amount < 1) return
    try {
      onChange(editor.previous ? replaceMenuBatchPreparation(catalog, draft, group, option, editor.previous.key, selectedModifiers)
        : addMenuBatchPreparation(catalog, draft, group, option, selectedModifiers, amount))
      close()
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'No se ha guardado la preparación.') }
  }

  return <article aria-label={`Plato ${option.product.name}`} className={`min-w-0 self-start overflow-hidden rounded-[12px] border ${quantity || configuring ? 'border-[var(--accent)]' : 'border-[var(--separator)]'} bg-[var(--background)]`}>
    <div className={`flex items-center gap-1 p-2 ${quantity ? 'bg-[var(--accent-soft)]/40' : ''}`}>
      <button aria-label={`Pedir ${option.product.name}`} className="min-h-14 min-w-0 flex-1 cursor-pointer rounded-[8px] px-2 py-1 text-left disabled:cursor-default" disabled={cardDisabled || full} onClick={request} type="button">
        <strong className="block text-sm">{option.product.name}</strong><span className="text-xs text-[var(--muted)]">{option.variant.name}{option.supplementCents ? ` · +${formatMoney(option.supplementCents)}` : ''}</span>
        {hasModifiers ? <span className="block text-xs font-semibold text-[var(--accent)]">Elegir preparación</span> : null}
      </button>
      <div className="flex shrink-0 items-center">
        {!hasModifiers ? <Button aria-label={`Quitar una ración de ${option.product.name}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={cardDisabled || quantity === 0}
          onClick={() => onChange(removeMenuBatchChoice(draft, group.group.id, option.id))} type="button" variant="tertiary"><Minus aria-hidden="true" className="h-4 w-4" /></Button> : null}
        <output aria-label={`Raciones de ${option.product.name}`} className="min-w-6 text-center font-mono text-lg font-bold tabular-nums">{quantity}</output>
        <Button aria-label={hasModifiers ? `Añadir preparación de ${option.product.name}` : `Añadir una ración de ${option.product.name}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={cardDisabled || full} onClick={request} type="button" variant="tertiary"><Plus aria-hidden="true" className="h-4 w-4" /></Button>
      </div>
    </div>

    {hasModifiers && preparations.length ? <div className="divide-y divide-[var(--separator)] border-t border-[var(--separator)] bg-[var(--surface)] px-3">
      {preparations.map((preparation) => {
        const label = preparation.modifiers.map((modifier) => modifier.name).join(' · ') || 'Sin extras'
        return <div aria-label={`Preparación de ${option.product.name}: ${label}`} className="flex items-center gap-1 py-2" key={preparation.key}>
          <p className="min-w-0 flex-1 break-words text-xs font-semibold"><span className="font-mono text-sm font-bold">{preparation.quantity}× </span>{label}</p>
          <Button aria-label={`Quitar ${option.product.name}: ${label}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={cardDisabled} onClick={() => onChange(removeMenuBatchChoice(draft, group.group.id, option.id, preparation.key))} type="button" variant="tertiary"><Minus aria-hidden="true" className="h-4 w-4" /></Button>
          <Button aria-label={`Repetir ${option.product.name}: ${label}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={cardDisabled || getMenuBatchChoiceCapacity(draft.selections, group, option, preparation.modifiers) === 0}
            onClick={() => onChange(addMenuBatchChoice(catalog, draft, group, option, preparation.modifiers))} type="button" variant="tertiary"><Plus aria-hidden="true" className="h-4 w-4" /></Button>
          <Button aria-label={`Editar ${option.product.name}: ${label}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={cardDisabled} onClick={() => start(preparation)} type="button" variant="tertiary"><Pencil aria-hidden="true" className="h-4 w-4" /></Button>
        </div>
      })}
    </div> : null}

    {configuring && editor ? <div aria-label={`Preparar ${option.product.name}`} className="space-y-4 border-t border-[var(--separator)] bg-[var(--surface)] p-3" ref={formRef}>
      <div className="flex items-center justify-between gap-2"><h4 className="text-sm font-bold">{option.product.name} · {editor.previous ? 'Editar preparación' : 'Preparación'}</h4>
        <Button aria-label={`Cancelar preparación de ${option.product.name}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={disabled} onClick={close} type="button" variant="tertiary"><X aria-hidden="true" className="h-4 w-4" /></Button></div>
      {sellable.modifierGroups.map((resolved) => {
        const { minSelection, maxSelection } = resolved.assignment
        const selected = resolved.modifiers.filter((modifier) => editor.selectedIds.includes(modifier.id)).length
        return <fieldset className="space-y-2" key={resolved.group.id}>
          <legend className="text-sm font-semibold">{resolved.assignment.displayName ?? resolved.group.name}<span className={`ml-2 text-xs ${selected < minSelection ? 'text-[var(--warning)]' : 'text-[var(--muted)]'}`}>{minSelection === maxSelection ? `Elige ${minSelection}` : minSelection === 0 ? `Opcional · hasta ${maxSelection}` : `Elige ${minSelection}–${maxSelection}`}</span></legend>
          <div className="flex flex-wrap gap-2">{resolved.modifiers.map((modifier) => <Button active={editor.selectedIds.includes(modifier.id)} aria-label={`Elegir ${modifier.name} para ${option.product.name}`} className="!min-h-11 !px-3 text-sm"
            disabled={disabled || (!editor.selectedIds.includes(modifier.id) && maxSelection !== 1 && selected >= maxSelection)} key={modifier.id}
            onClick={() => toggle(resolved.group.id, modifier.id, maxSelection)} type="button" variant="secondary">{modifier.name}{modifier.supplementCents ? ` ${modifier.supplementCents > 0 ? '+' : ''}${formatMoney(modifier.supplementCents)}` : ''}</Button>)}</div>
        </fieldset>
      })}
      {editor.previous ? <p className="text-xs text-[var(--muted)]">Se aplicará a las {amount} {amount === 1 ? 'ración de esta preparación' : 'raciones de esta preparación'}.</p>
        : <div className="flex flex-wrap items-center justify-between gap-2"><span className="text-sm font-semibold">Raciones</span><div className="flex items-center gap-1">
          <Button aria-label="Una ración menos" className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={disabled || amount <= 1} onClick={() => setEditor({ ...editor, quantity: amount - 1 })} type="button" variant="tertiary"><Minus aria-hidden="true" className="h-4 w-4" /></Button>
          <output aria-label="Raciones de esta preparación" className="min-w-6 text-center font-mono font-bold">{amount}</output>
          <Button aria-label="Una ración más" className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={disabled || amount >= capacity} onClick={() => setEditor({ ...editor, quantity: amount + 1 })} type="button" variant="tertiary"><Plus aria-hidden="true" className="h-4 w-4" /></Button>
          {capacity > 1 ? <Button className="!min-h-11 !px-2 text-xs" disabled={disabled} onClick={() => setEditor({ ...editor, quantity: capacity })} type="button" variant="tertiary">Todas ({capacity})</Button> : null}
        </div></div>}
      <p className="text-xs text-[var(--muted)]">{supplement ? `${supplement > 0 ? '+' : ''}${formatMoney(supplement)} por ración` : 'Preparación incluida en el menú'}</p>
      {!valid ? <p className="text-xs font-semibold text-[var(--warning)]">Completa las opciones obligatorias.</p> : null}
      {!editor.previous && capacity === 0 ? <p className="text-xs font-semibold text-[var(--warning)]">No quedan raciones disponibles para esta preparación.</p> : null}
      {error ? <p className="text-xs font-semibold text-[var(--danger)]" role="alert">{error}</p> : null}
      <div className="flex gap-2"><Button className="!min-h-11 !px-3" disabled={disabled} onClick={close} type="button" variant="tertiary">Cancelar</Button>
        <Button className="!min-h-11 flex-1 !px-3 !font-bold" disabled={disabled || !valid || amount < 1} onClick={confirm} type="button" variant="primary">{editor.previous ? 'Guardar preparación' : `Añadir ${amount} ${amount === 1 ? 'ración' : 'raciones'}`}</Button></div>
    </div> : null}
  </article>
}
