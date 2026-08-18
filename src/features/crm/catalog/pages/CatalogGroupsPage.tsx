import { Input as UiInput } from '../../../../components/ui/Input'
import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Button as UiButton } from '../../../../components/ui/Button'
import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CatalogData } from '../../../catalog/domain/types.ts'
import { formatMoney, normalizeText, parseMoneyToCents } from '../../../../lib/format.ts'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { getCatalogProductSummaries, moveCatalogItem, toReorderItems } from '../services/catalogAdminModel.ts'

type Props = {
  catalog: CatalogData
  disabled: boolean
  domain: 'selection' | 'modifier'
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
}

function money(value: string) {
  try { return parseMoneyToCents(value) } catch { return Number.NaN }
}

export function CatalogGroupsCrm({ catalog, disabled, domain, mutate }: Props) {
  const groups = domain === 'selection' ? catalog.selectionGroups.filter((group) => group.type === 'mixer') : catalog.modifierGroups
  const assignments = domain === 'selection' ? catalog.selectionAssignments : catalog.modifierAssignments
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? '')
  const [groupName, setGroupName] = useState('')
  const [optionProductId, setOptionProductId] = useState(catalog.products[0]?.id ?? '')
  const [optionVariantId, setOptionVariantId] = useState('')
  const [optionProductQuery, setOptionProductQuery] = useState('')
  const [optionCategoryId, setOptionCategoryId] = useState('')
  const [optionSupplement, setOptionSupplement] = useState('0,00')
  const [optionDefaultQuantity, setOptionDefaultQuantity] = useState(0)
  const [optionMaxQuantity, setOptionMaxQuantity] = useState(1)
  const [modifierName, setModifierName] = useState('')
  const [modifierSupplement, setModifierSupplement] = useState('0,00')
  const [modifierDefault, setModifierDefault] = useState(false)
  const selectedGroup = groups.find((group) => group.id === selectedGroupId) ?? null
  const options = useMemo(() => domain === 'selection'
    ? catalog.selectionOptions.filter((option) => option.groupId === selectedGroupId)
    : catalog.modifiers.filter((modifier) => modifier.groupId === selectedGroupId), [catalog.modifiers, catalog.selectionOptions, domain, selectedGroupId])
  const productSummaries = useMemo(() => getCatalogProductSummaries(catalog), [catalog])
  const optionCategoryOptions = useMemo(() => {
    const availableCategoryIds = new Set(productSummaries
      .filter((summary) => summary.product.active)
      .flatMap((summary) => summary.categories.map((category) => category.id)))
    const hasUncategorizedProducts = productSummaries.some((summary) => summary.product.active && summary.categories.length === 0)
    return [
      { label: 'Todas las categorías', value: '' },
      ...catalog.categories
        .filter((category) => availableCategoryIds.has(category.id))
        .map((category) => ({ label: category.name, value: category.id })),
      ...(hasUncategorizedProducts ? [{ label: 'Sin categoría', value: '__uncategorized__' }] : []),
    ]
  }, [catalog.categories, productSummaries])
  const filteredProductOptions = useMemo(() => {
    const query = normalizeText(optionProductQuery.trim())
    return productSummaries
      .filter((summary) => summary.product.active)
      .filter((summary) => domain !== 'selection' || summary.product.type === 'standard')
      .filter((summary) => !query || normalizeText(summary.product.name).includes(query))
      .filter((summary) => optionCategoryId === ''
        || (optionCategoryId === '__uncategorized__'
          ? summary.categories.length === 0
          : summary.categories.some((category) => category.id === optionCategoryId)))
      .map((summary) => ({
        description: summary.categories.map((category) => category.name).join(', ') || 'Sin categoría',
        label: summary.product.name,
        value: summary.product.id,
      }))
  }, [domain, optionCategoryId, optionProductQuery, productSummaries])
  const selectedProductVariants = useMemo(
    () => catalog.variants.filter((variant) => variant.productId === optionProductId),
    [catalog.variants, optionProductId],
  )
  const hasSelectableProduct = filteredProductOptions.some((option) => option.value === optionProductId)

  async function createGroup() {
    if (!groupName.trim()) return
    const saved = domain === 'selection'
      ? await mutate(() => catalogAdminService.saveSelectionGroup(catalog.venueId, { name: groupName.trim(), type: 'mixer', active: true, sortOrder: catalog.selectionGroups.length * 10 }))
      : await mutate(() => catalogAdminService.saveModifierGroup(catalog.venueId, { name: groupName.trim(), active: true, sortOrder: groups.length * 10 }))
    if (saved) setGroupName('')
  }

  async function updateGroup(patch: { name?: string; active?: boolean }) {
    if (!selectedGroup) return
    if (domain === 'selection') {
      await mutate(() => catalogAdminService.saveSelectionGroup(catalog.venueId, { ...selectedGroup, ...patch, type: 'mixer' }))
    } else {
      await mutate(() => catalogAdminService.saveModifierGroup(catalog.venueId, { ...selectedGroup, ...patch }))
    }
  }

  async function deleteGroup() {
    if (!selectedGroup) return
    const assignmentCount = assignments.filter((assignment) => assignment.groupId === selectedGroup.id).length
    if (assignmentCount > 0) {
      window.alert(`Este grupo tiene ${assignmentCount} asignaciones. Elimínalas desde los productos antes de borrar el grupo.`)
      return
    }
    if (!window.confirm(`¿Eliminar definitivamente “${selectedGroup.name}” y sus ${options.length} opciones?`)) return
    const saved = domain === 'selection'
      ? await mutate(() => catalogAdminService.deleteSelectionGroup(catalog.venueId, selectedGroup.id))
      : await mutate(() => catalogAdminService.deleteModifierGroup(catalog.venueId, selectedGroup.id))
    if (saved) setSelectedGroupId('')
  }

  async function moveGroup(id: string, direction: -1 | 1) {
    const reordered = moveCatalogItem(groups, id, direction)
    const availableSortOrders = groups.map((group) => group.sortOrder).toSorted((left, right) => left - right)
    await mutate(() => catalogAdminService.reorder(catalog.venueId, {
      entity: domain === 'selection' ? 'selection_groups' : 'modifier_groups',
      items: reordered.map((group, index) => ({ id: group.id, sortOrder: availableSortOrders[index] })),
    }))
  }

  async function addOption() {
    if (!selectedGroup || !optionProductId || !Number.isSafeInteger(money(optionSupplement))) return
    await mutate(() => catalogAdminService.saveSelectionOption(catalog.venueId, {
      groupId: selectedGroup.id,
      productId: optionProductId,
      variantId: optionVariantId || null,
      supplementCents: money(optionSupplement),
      defaultQuantity: optionDefaultQuantity,
      maxQuantity: optionMaxQuantity,
      active: true,
      sortOrder: options.length * 10,
    }))
  }

  async function addModifier() {
    if (!selectedGroup || !modifierName.trim() || !Number.isSafeInteger(money(modifierSupplement))) return
    const saved = await mutate(() => catalogAdminService.saveModifier(catalog.venueId, {
      groupId: selectedGroup.id,
      name: modifierName.trim(),
      supplementCents: money(modifierSupplement),
      isDefault: modifierDefault,
      active: true,
      sortOrder: options.length * 10,
    }))
    if (saved) { setModifierName(''); setModifierSupplement('0,00'); setModifierDefault(false) }
  }

  async function moveOption(id: string, direction: -1 | 1) {
    await mutate(() => catalogAdminService.reorder(catalog.venueId, {
      entity: domain === 'selection' ? 'selection_options' : 'modifiers',
      items: toReorderItems(moveCatalogItem(options as readonly { id: string }[], id, direction)),
    }))
  }

  return (
    <div className="!grid !gap-4 xl:!grid-cols-[minmax(280px,.72fr)_minmax(0,1.28fr)]">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)]">
        <header className="!border-b !border-[var(--crm-border-subtle)] !p-5">
          <h2 className="!text-lg !font-bold">{domain === 'selection' ? 'Mixers y acompañamientos' : 'Grupos de modificadores'}</h2>
          <p className="!text-sm !text-[var(--crm-text-muted)]">{domain === 'selection' ? 'Reutilizables entre productos estándar y variantes.' : 'Reutilizables entre productos y variantes.'}</p>
          <div className="!mt-4 !grid !gap-2">
            <UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" onChange={(event) => setGroupName(event.target.value)} placeholder={domain === 'selection' ? 'Nombre del grupo de mixers' : 'Nombre del grupo'} value={groupName} />
            <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !w-fit" disabled={disabled || !groupName.trim()} onClick={() => void createGroup()} type="button"><Plus className="!size-4" /> Crear grupo</UiButton>
          </div>
        </header>
        <div className="!grid">
          {groups.map((group, index) => {
            const groupAssignments = assignments.filter((assignment) => assignment.groupId === group.id)
            const minimum = groupAssignments.length ? Math.min(...groupAssignments.map((assignment) => assignment.minSelection)) : 0
            const maximum = groupAssignments.length ? Math.max(...groupAssignments.map((assignment) => assignment.maxSelection)) : 0
            const optionCount = domain === 'selection' ? catalog.selectionOptions.filter((option) => option.groupId === group.id).length : catalog.modifiers.filter((modifier) => modifier.groupId === group.id).length
            return <div className={`!grid !grid-cols-[1fr_auto] !items-center !gap-2 !border-0 !border-b !border-[var(--crm-border-subtle)] !p-4 !text-left ${selectedGroupId === group.id ? '!bg-[var(--crm-blue-soft)]' : '!bg-transparent hover:!bg-[var(--crm-surface-hover)]'}`} key={group.id}><UiButton className="!border-0 !bg-transparent !p-0 !text-left" onClick={() => setSelectedGroupId(group.id)} type="button"><strong>{group.name}</strong><small className="!block !text-[var(--crm-text-muted)]">{domain === 'selection' ? 'Mixer' : 'Modificadores'} · {minimum}–{maximum || '—'} · {optionCount} opciones · {groupAssignments.length} asignaciones</small></UiButton><span className="!flex !gap-1"><UiButton aria-label="Subir grupo" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === 0} onClick={(event) => { event.stopPropagation(); void moveGroup(group.id, -1) }} type="button"><ArrowUp className="!size-4" /></UiButton><UiButton aria-label="Bajar grupo" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === groups.length - 1} onClick={(event) => { event.stopPropagation(); void moveGroup(group.id, 1) }} type="button"><ArrowDown className="!size-4" /></UiButton></span></div>
          })}
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]">
        {selectedGroup ? <div className="!grid !gap-5">
          <header className="!flex !flex-col !justify-between !gap-3 sm:!flex-row sm:!items-center"><div><h2 className="!text-lg !font-bold">{selectedGroup.name}</h2><p className="!text-sm !text-[var(--crm-text-muted)]">{selectedGroup.active ? 'Activo' : 'Inactivo'} · {options.length} opciones · {assignments.filter((assignment) => assignment.groupId === selectedGroup.id).length} asignaciones</p></div><div className="flex min-w-0 items-center justify-end gap-[7px]"><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => { const name = window.prompt('Nombre del grupo', selectedGroup.name)?.trim(); if (name) void updateGroup({ name }) }} type="button"><Pencil className="!size-4" /> Editar</UiButton><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void updateGroup({ active: !selectedGroup.active })} type="button">{selectedGroup.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />} {selectedGroup.active ? 'Desactivar' : 'Activar'}</UiButton><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => void deleteGroup()} type="button"><Trash2 className="!size-4" /> Eliminar</UiButton></div></header>

          {domain === 'selection' ? <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><h3 className="!font-bold">Añadir opción reutilizable</h3><div className="!grid !gap-2 sm:!grid-cols-[minmax(180px,1fr)_minmax(160px,.7fr)]"><label className="!flex !h-9 !items-center !gap-2 !rounded-[9px] !border !border-[var(--crm-input-border)] !bg-[var(--crm-input-bg)] !px-2.5 focus-within:!border-[var(--crm-blue)] focus-within:!shadow-[0_0_0_3px_var(--crm-blue-soft)]"><Search aria-hidden="true" className="!size-3.5 !shrink-0 !text-[var(--crm-text-muted)]" /><UiInput aria-label="Buscar producto" className="!min-h-0 !border-0 !bg-transparent !p-0 !text-[12px] focus:!shadow-none" onChange={(event) => setOptionProductQuery(event.target.value)} placeholder="Buscar producto" type="search" value={optionProductQuery} /></label><CrmSelect ariaLabel="Filtrar productos por categoría" compact onChange={setOptionCategoryId} options={optionCategoryOptions} value={optionCategoryId} /></div><div className="!grid !gap-2 sm:!grid-cols-2"><CrmSelect ariaLabel="Producto" onChange={(value) => { setOptionProductId(value); setOptionVariantId('') }} options={filteredProductOptions} placeholder={filteredProductOptions.length ? 'Selecciona un producto' : 'Sin productos coincidentes'} value={optionProductId} /><CrmSelect onChange={setOptionVariantId} options={[{ label: 'Variante predeterminada', value: '' }, ...selectedProductVariants.filter((variant) => variant.active).map((variant) => ({ label: variant.name, value: variant.id }))]} value={optionVariantId} /><UiInput aria-label="Suplemento" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" onChange={(event) => setOptionSupplement(event.target.value)} value={optionSupplement} /><div className="!grid !grid-cols-2 !gap-2"><UiInput aria-label="Cantidad predeterminada" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" min={0} onChange={(event) => setOptionDefaultQuantity(Number(event.target.value))} type="number" value={optionDefaultQuantity} /><UiInput aria-label="Cantidad máxima" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" min={optionDefaultQuantity} onChange={(event) => setOptionMaxQuantity(Number(event.target.value))} type="number" value={optionMaxQuantity} /></div></div><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !w-fit" disabled={disabled || !hasSelectableProduct || !Number.isSafeInteger(money(optionSupplement)) || optionMaxQuantity < optionDefaultQuantity} onClick={() => void addOption()} type="button"><Plus className="!size-4" /> Añadir opción</UiButton></div> : <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><h3 className="!font-bold">Añadir modificador</h3><div className="!grid !gap-2 sm:!grid-cols-2"><UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" onChange={(event) => setModifierName(event.target.value)} placeholder="Nombre" value={modifierName} /><UiInput aria-label="Suplemento" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" onChange={(event) => setModifierSupplement(event.target.value)} value={modifierSupplement} /></div><UiCheckbox checked={modifierDefault} className="!text-sm !font-semibold" onChange={setModifierDefault}>Seleccionado por defecto</UiCheckbox><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !w-fit" disabled={disabled || !modifierName.trim() || !Number.isSafeInteger(money(modifierSupplement))} onClick={() => void addModifier()} type="button"><Plus className="!size-4" /> Añadir modificador</UiButton></div>}

          <div className="!grid !gap-2">
            {options.map((option, index) => {
              const selectionOption = domain === 'selection' ? option as CatalogData['selectionOptions'][number] : null
              const modifier = domain === 'modifier' ? option as CatalogData['modifiers'][number] : null
              const label = selectionOption ? catalog.products.find((product) => product.id === selectionOption.productId)?.name ?? 'Producto' : modifier?.name ?? 'Modificador'
              const supplement = selectionOption?.supplementCents ?? modifier?.supplementCents ?? 0
              const active = selectionOption?.active ?? modifier?.active ?? false
              return <div className="!grid !grid-cols-[1fr_auto] !items-center !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3" key={option.id}><span><strong>{label}</strong> · {supplement === 0 ? 'Incluido' : `${supplement > 0 ? '+' : ''}${formatMoney(supplement)}`} · {active ? 'Activo' : 'Inactivo'}{modifier?.isDefault ? ' · Predeterminado' : ''}</span><div className="flex min-w-0 items-center justify-end gap-[7px]"><UiButton aria-label="Subir opción" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === 0} onClick={() => void moveOption(option.id, -1)} type="button"><ArrowUp className="!size-4" /></UiButton><UiButton aria-label="Bajar opción" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || index === options.length - 1} onClick={() => void moveOption(option.id, 1)} type="button"><ArrowDown className="!size-4" /></UiButton><UiButton aria-label="Editar suplemento" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => { const value = window.prompt('Suplemento', (supplement / 100).toFixed(2).replace('.', ',')); if (value === null || !Number.isSafeInteger(money(value))) return; if (selectionOption) void mutate(() => catalogAdminService.saveSelectionOption(catalog.venueId, { ...selectionOption, supplementCents: money(value) })); else if (modifier) void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, supplementCents: money(value) })) }} type="button"><Pencil className="!size-4" /></UiButton><UiButton aria-label="Activar o desactivar opción" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => { if (selectionOption) void mutate(() => catalogAdminService.saveSelectionOption(catalog.venueId, { ...selectionOption, active: !selectionOption.active })); else if (modifier) void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, active: !modifier.active })) }} type="button">{active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</UiButton>{modifier ? <UiButton aria-label="Cambiar modificador predeterminado" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, isDefault: !modifier.isDefault }))} type="button">★</UiButton> : null}<UiButton aria-label="Eliminar opción" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => { if (!window.confirm(`¿Eliminar “${label}”?`)) return; void mutate(() => selectionOption ? catalogAdminService.deleteSelectionOption(catalog.venueId, option.id) : catalogAdminService.deleteModifier(catalog.venueId, option.id)) }} type="button"><Trash2 className="!size-4" /></UiButton></div></div>
            })}
          </div>
        </div> : <p className="!text-[var(--crm-text-muted)]">Crea o selecciona un grupo para editar sus opciones.</p>}
      </section>
    </div>
  )
}
