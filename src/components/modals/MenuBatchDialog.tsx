import { Pencil } from 'lucide-react'
import { useMemo, useRef, useState, type ReactNode } from 'react'
import type { CatalogData, ResolvedCatalogItem, ResolvedSellableProduct } from '../../features/catalog/domain/types'
import { buildSaleLine } from '../../features/catalog/services/saleLineBuilder'
import { getMenuBatchGroupCount, MAX_MENU_BATCH_SIZE, resizeMenuBatch, type MenuBatchDraft } from '../../features/restaurant/services/menuBatch'
import { formatMoney } from '../../lib/format'
import type { ProductLineSelection } from '../../types'
import { MenuCountControl } from '../pos/MenuCountControl'
import { MenuBatchOptionCard } from './MenuBatchOptionCard'
import { Button, MenuDialogLayout, MenuOptionList } from '../ui'

type Props = {
  catalog: CatalogData
  item: ResolvedCatalogItem
  sellable: ResolvedSellableProduct
  draft: MenuBatchDraft
  disabled: boolean
  onChange: (draft: MenuBatchDraft) => void
  onCancel: () => void
  onAdd: (selections: ProductLineSelection[], sourceElement: HTMLElement | null) => boolean
  renderEditor: (selection: ProductLineSelection, onSave: (selection: ProductLineSelection) => void, onCancel: () => void) => ReactNode
}

export function MenuBatchDialog({ catalog, item, sellable, draft, disabled, onChange, onCancel, onAdd, renderEditor }: Props) {
  const [configuringOption, setConfiguringOption] = useState<string | null>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const [pendingSize, setPendingSize] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const submitted = useRef(false)
  const groups = sellable.selectionGroups.filter((group) => group.group.type === 'menu_component')
  const count = draft.selections.length
  const blocked = disabled || pendingSize !== null
  const navigationBlocked = blocked || configuringOption !== null
  const preview = useMemo(() => draft.selections.map((selection) => {
    try { return { line: buildSaleLine('preview', catalog, sellable, selection, item, true), error: null } }
    catch (failure) { return { line: null, error: failure instanceof Error ? failure.message : 'Revisa las opciones de este menú.' } }
  }), [catalog, draft.selections, item, sellable])
  const invalid = preview.findIndex((menu) => menu.error)
  const total = preview.reduce((sum, menu) => sum + (menu.line?.unitPriceCents ?? sellable.variant.priceCents), 0)

  function requestSize(size: number) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MENU_BATCH_SIZE) {
      return
    }
    if (size < count && draft.selections.slice(size).some((selection) => selection.components.some((component) => component.type === 'menu_component'))) {
      setPendingSize(size)
      return
    }
    onChange(resizeMenuBatch(draft, size))
  }

  function save(sourceElement: HTMLElement) {
    if (navigationBlocked || invalid >= 0 || submitted.current) return
    submitted.current = true
    if (onAdd(draft.selections, sourceElement)) onCancel()
    else { submitted.current = false; setError('No se han añadido los menús. Revisa la comanda e inténtalo de nuevo.') }
  }

  if (editing !== null) return renderEditor(draft.selections[editing], (selection) => {
    onChange({ ...draft, selections: draft.selections.map((current, index) => index === editing ? selection : current) })
    setEditing(null)
  }, () => setEditing(null))

  return <MenuDialogLayout
    controls={<MenuCountControl count={count} disabled={navigationBlocked} onChange={requestSize} />}
    disabled={disabled}
    footer={<>

        <div className="flex items-center justify-between gap-3"><span className="text-sm font-semibold">{count} {count === 1 ? 'menú' : 'menús'}</span><strong className="font-mono text-xl tabular-nums">{invalid >= 0 ? 'Desde ' : ''}{formatMoney(total)}</strong></div>
        {configuringOption === null ? <Button className="!min-h-12 !px-3 !font-bold" disabled={navigationBlocked || invalid >= 0} fullWidth onClick={(event) => save(event.currentTarget)} type="button" variant="primary">Añadir {count} {count === 1 ? 'menú' : 'menús'}</Button>
          : <p className="text-xs text-[var(--muted)]">Confirma o cancela la preparación para continuar.</p>}
    </>}
    onClose={onCancel}
    priceCents={sellable.variant.priceCents}
    skipEnterAnimation
    title={item.product.name}
    variantName={sellable.variant.name}
  >
        {pendingSize !== null ? <div className="space-y-3 rounded-[12px] border border-[var(--warning)] p-4" role="alert">
          <p className="text-sm font-semibold">Los últimos {count - pendingSize} menús ya tienen platos. Si reduces a {pendingSize}, se quitarán sus elecciones.</p>
          <div className="flex flex-wrap gap-2"><Button className="!min-h-11" onClick={() => setPendingSize(null)} type="button" variant="tertiary">Mantener {count}</Button>
            <Button className="!min-h-11" onClick={() => { onChange(resizeMenuBatch(draft, pendingSize)); setPendingSize(null) }} type="button" variant="secondary">Reducir a {pendingSize}</Button></div>
        </div> : null}
        {groups.map((group) => <section aria-label={`Elegir ${group.assignment.displayName ?? group.group.name}`} key={group.group.id}>
          <div className="mb-3">
            <div className="flex items-center justify-between gap-3"><h3 className="text-lg font-bold">{group.assignment.displayName ?? group.group.name}</h3><span className="text-sm font-semibold tabular-nums text-[var(--muted)]">{getMenuBatchGroupCount(draft.selections, group.group.id)} / {count * group.assignment.maxSelection}</span></div>
            <p className="text-sm text-[var(--muted)]">Elige platos y sus preparaciones. Puedes dejar elecciones para después.</p>
          </div>
          <MenuOptionList disabled={navigationBlocked} groupLabel={group.assignment.displayName ?? group.group.name} options={group.options} renderOption={(option) => <MenuBatchOptionCard key={option.id} catalog={catalog} draft={draft} group={group} option={option}
            disabled={blocked || (configuringOption !== null && configuringOption !== option.id)} configuring={configuringOption === option.id}
            onConfigure={() => setConfiguringOption(option.id)} onCloseConfiguration={() => setConfiguringOption(null)} onChange={onChange} />} />
        </section>)}

        {invalid >= 0 ? <div className="flex flex-wrap items-center justify-between gap-2 rounded-[12px] border border-[var(--warning)] p-3"><p className="text-sm font-semibold">Hay opciones que requieren revisión.</p>
          <Button className="!min-h-11" disabled={navigationBlocked} onClick={() => setEditing(invalid)} type="button" variant="secondary">Revisar menú {invalid + 1}</Button></div> : null}
        <details className="border-t border-[var(--separator)] pt-2">
          <summary className="min-h-12 cursor-pointer py-3 text-sm font-semibold">Ver los {count} menús y personalizar</summary>
          <p className="mb-2 text-xs text-[var(--muted)]">Las elecciones se reparten en este orden. Aquí puedes ajustar cada menú.</p>
          <div className="divide-y divide-[var(--separator)]">{draft.selections.map((selection, index) => <div className="flex items-center gap-3 py-3" key={index}>
            <div className="min-w-0 flex-1"><p className="text-sm font-bold">Menú {index + 1}{preview[index].line ? ` · ${formatMoney(preview[index].line.unitPriceCents)}` : ''}</p>
              <p className="break-words text-xs text-[var(--muted)]">{groups.map((current) => `${current.assignment.displayName ?? current.group.name}: ${selection.components.filter((component) => component.selectionGroupId === current.group.id).map((component) => `${component.quantity > 1 ? `${component.quantity}× ` : ''}${component.productName}${component.modifiers?.length ? ` (${component.modifiers.map((modifier) => modifier.name).join(', ')})` : ''}`).join(', ') || 'por elegir'}`).join(' · ')}</p>
              {preview[index].error ? <p className="text-xs text-[var(--warning)]">{preview[index].error}</p> : null}</div>
            <Button aria-label={`Personalizar menú ${index + 1}`} className="!size-11 !min-h-11 !min-w-11 !p-0" disabled={navigationBlocked} onClick={() => setEditing(index)} type="button" variant="tertiary"><Pencil aria-hidden="true" className="h-4 w-4" /></Button>
          </div>)}</div>
        </details>
        {error ? <p className="text-sm font-semibold text-[var(--danger)]" role="alert">{error}</p> : null}
  </MenuDialogLayout>
}
