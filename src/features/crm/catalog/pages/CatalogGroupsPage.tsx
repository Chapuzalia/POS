import { ArrowDown, ArrowUp, Eye, EyeOff, Pencil, Plus, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { CatalogData, CatalogSelectionGroup } from '../../../catalog/domain/types.ts'
import { formatMoney, parseMoneyToCents } from '../../../../lib/format.ts'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import { moveCatalogItem, toReorderItems } from '../services/catalogAdminModel.ts'

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
  const groups = domain === 'selection' ? catalog.selectionGroups : catalog.modifierGroups
  const assignments = domain === 'selection' ? catalog.selectionAssignments : catalog.modifierAssignments
  const [selectedGroupId, setSelectedGroupId] = useState(groups[0]?.id ?? '')
  const [groupName, setGroupName] = useState('')
  const [groupType, setGroupType] = useState<'mixer' | 'menu_component'>('menu_component')
  const [optionProductId, setOptionProductId] = useState(catalog.products[0]?.id ?? '')
  const [optionVariantId, setOptionVariantId] = useState('')
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
  const selectedProductVariants = catalog.variants.filter((variant) => variant.productId === optionProductId)

  async function createGroup() {
    if (!groupName.trim()) return
    const saved = domain === 'selection'
      ? await mutate(() => catalogAdminService.saveSelectionGroup(catalog.venueId, { name: groupName.trim(), type: groupType, active: true, sortOrder: groups.length * 10 }))
      : await mutate(() => catalogAdminService.saveModifierGroup(catalog.venueId, { name: groupName.trim(), active: true, sortOrder: groups.length * 10 }))
    if (saved) setGroupName('')
  }

  async function updateGroup(patch: { name?: string; active?: boolean }) {
    if (!selectedGroup) return
    if (domain === 'selection') {
      await mutate(() => catalogAdminService.saveSelectionGroup(catalog.venueId, { ...selectedGroup, ...patch, type: (selectedGroup as CatalogSelectionGroup).type }))
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
    if (!window.confirm(`Eliminar definitivamente “${selectedGroup.name}” y sus ${options.length} opciones?`)) return
    const saved = domain === 'selection'
      ? await mutate(() => catalogAdminService.deleteSelectionGroup(catalog.venueId, selectedGroup.id))
      : await mutate(() => catalogAdminService.deleteModifierGroup(catalog.venueId, selectedGroup.id))
    if (saved) setSelectedGroupId('')
  }

  async function moveGroup(id: string, direction: -1 | 1) {
    await mutate(() => catalogAdminService.reorder(catalog.venueId, {
      entity: domain === 'selection' ? 'selection_groups' : 'modifier_groups',
      items: toReorderItems(moveCatalogItem(groups, id, direction)),
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
      <section className="crm-panel !overflow-hidden !rounded-2xl !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)]">
        <header className="!border-b !border-[var(--crm-border-subtle)] !p-5"><h2 className="!text-lg !font-bold">{domain === 'selection' ? 'Grupos de selección' : 'Grupos de modificadores'}</h2><p className="!text-sm !text-[var(--crm-text-muted)]">Reutilizables entre productos y variantes.</p><div className="!mt-4 !grid !gap-2"><input className="crm-input" onChange={(event) => setGroupName(event.target.value)} placeholder="Nombre del grupo" value={groupName} />{domain === 'selection' ? <CrmSelect onChange={(value) => setGroupType(value as typeof groupType)} options={[{ label: 'Componentes de menú', value: 'menu_component' }, { label: 'Mixer / acompañamiento', value: 'mixer' }]} value={groupType} /> : null}<button className="crm-primary-button !w-fit" disabled={disabled || !groupName.trim()} onClick={() => void createGroup()} type="button"><Plus className="!size-4" /> Crear grupo</button></div></header>
        <div className="!grid">
          {groups.map((group, index) => {
            const groupAssignments = assignments.filter((assignment) => assignment.groupId === group.id)
            const minimum = groupAssignments.length ? Math.min(...groupAssignments.map((assignment) => assignment.minSelection)) : 0
            const maximum = groupAssignments.length ? Math.max(...groupAssignments.map((assignment) => assignment.maxSelection)) : 0
            const optionCount = domain === 'selection' ? catalog.selectionOptions.filter((option) => option.groupId === group.id).length : catalog.modifiers.filter((modifier) => modifier.groupId === group.id).length
            return <div className={`!grid !grid-cols-[1fr_auto] !items-center !gap-2 !border-0 !border-b !border-[var(--crm-border-subtle)] !p-4 !text-left ${selectedGroupId === group.id ? '!bg-[var(--crm-blue-soft)]' : '!bg-transparent hover:!bg-[var(--crm-surface-hover)]'}`} key={group.id}><button className="!border-0 !bg-transparent !p-0 !text-left" onClick={() => setSelectedGroupId(group.id)} type="button"><strong>{group.name}</strong><small className="!block !text-[var(--crm-text-muted)]">{domain === 'selection' ? (group as CatalogSelectionGroup).type === 'menu_component' ? 'Menú' : 'Mixer' : 'Modificadores'} · {minimum}–{maximum || '—'} · {optionCount} opciones · {groupAssignments.length} asignaciones</small></button><span className="!flex !gap-1"><button aria-label="Subir grupo" className="crm-action-button" disabled={disabled || index === 0} onClick={(event) => { event.stopPropagation(); void moveGroup(group.id, -1) }} type="button"><ArrowUp className="!size-4" /></button><button aria-label="Bajar grupo" className="crm-action-button" disabled={disabled || index === groups.length - 1} onClick={(event) => { event.stopPropagation(); void moveGroup(group.id, 1) }} type="button"><ArrowDown className="!size-4" /></button></span></div>
          })}
        </div>
      </section>

      <section className="crm-panel !rounded-2xl !bg-[var(--crm-surface)] !p-5 !shadow-[var(--crm-shadow-card)]">
        {selectedGroup ? <div className="!grid !gap-5">
          <header className="!flex !flex-col !justify-between !gap-3 sm:!flex-row sm:!items-center"><div><h2 className="!text-lg !font-bold">{selectedGroup.name}</h2><p className="!text-sm !text-[var(--crm-text-muted)]">{selectedGroup.active ? 'Activo' : 'Inactivo'} · {options.length} opciones · {assignments.filter((assignment) => assignment.groupId === selectedGroup.id).length} asignaciones</p></div><div className="crm-action-group"><button className="crm-secondary-button" disabled={disabled} onClick={() => { const name = window.prompt('Nombre del grupo', selectedGroup.name)?.trim(); if (name) void updateGroup({ name }) }} type="button"><Pencil className="!size-4" /> Editar</button><button className="crm-secondary-button" disabled={disabled} onClick={() => void updateGroup({ active: !selectedGroup.active })} type="button">{selectedGroup.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />} {selectedGroup.active ? 'Desactivar' : 'Activar'}</button><button className="crm-danger-button" disabled={disabled} onClick={() => void deleteGroup()} type="button"><Trash2 className="!size-4" /> Eliminar</button></div></header>

          {domain === 'selection' ? <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><h3 className="!font-bold">Añadir opción reutilizable</h3><div className="!grid !gap-2 sm:!grid-cols-2"><CrmSelect onChange={(value) => { setOptionProductId(value); setOptionVariantId('') }} options={catalog.products.filter((product) => product.active).map((product) => ({ label: product.name, value: product.id }))} value={optionProductId} /><CrmSelect onChange={setOptionVariantId} options={[{ label: 'Variante predeterminada', value: '' }, ...selectedProductVariants.filter((variant) => variant.active).map((variant) => ({ label: variant.name, value: variant.id }))]} value={optionVariantId} /><input aria-label="Suplemento" className="crm-input" onChange={(event) => setOptionSupplement(event.target.value)} value={optionSupplement} /><div className="!grid !grid-cols-2 !gap-2"><input aria-label="Cantidad predeterminada" className="crm-input" min={0} onChange={(event) => setOptionDefaultQuantity(Number(event.target.value))} type="number" value={optionDefaultQuantity} /><input aria-label="Cantidad máxima" className="crm-input" min={optionDefaultQuantity} onChange={(event) => setOptionMaxQuantity(Number(event.target.value))} type="number" value={optionMaxQuantity} /></div></div><button className="crm-primary-button !w-fit" disabled={disabled || !optionProductId || !Number.isSafeInteger(money(optionSupplement)) || optionMaxQuantity < optionDefaultQuantity} onClick={() => void addOption()} type="button"><Plus className="!size-4" /> Añadir opción</button></div> : <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-4"><h3 className="!font-bold">Añadir modificador</h3><div className="!grid !gap-2 sm:!grid-cols-2"><input className="crm-input" onChange={(event) => setModifierName(event.target.value)} placeholder="Nombre" value={modifierName} /><input aria-label="Suplemento" className="crm-input" onChange={(event) => setModifierSupplement(event.target.value)} value={modifierSupplement} /></div><label className="!flex !items-center !gap-2 !text-sm !font-semibold"><input checked={modifierDefault} onChange={(event) => setModifierDefault(event.target.checked)} type="checkbox" /> Seleccionado por defecto</label><button className="crm-primary-button !w-fit" disabled={disabled || !modifierName.trim() || !Number.isSafeInteger(money(modifierSupplement))} onClick={() => void addModifier()} type="button"><Plus className="!size-4" /> Añadir modificador</button></div>}

          <div className="!grid !gap-2">
            {options.map((option, index) => {
              const selectionOption = domain === 'selection' ? option as CatalogData['selectionOptions'][number] : null
              const modifier = domain === 'modifier' ? option as CatalogData['modifiers'][number] : null
              const label = selectionOption ? catalog.products.find((product) => product.id === selectionOption.productId)?.name ?? 'Producto' : modifier?.name ?? 'Modificador'
              const supplement = selectionOption?.supplementCents ?? modifier?.supplementCents ?? 0
              const active = selectionOption?.active ?? modifier?.active ?? false
              return <div className="!grid !grid-cols-[1fr_auto] !items-center !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3" key={option.id}><span><strong>{label}</strong> · {supplement === 0 ? 'Incluido' : `${supplement > 0 ? '+' : ''}${formatMoney(supplement)}`} · {active ? 'Activo' : 'Inactivo'}{modifier?.isDefault ? ' · Predeterminado' : ''}</span><div className="crm-action-group"><button aria-label="Subir opción" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void moveOption(option.id, -1)} type="button"><ArrowUp className="!size-4" /></button><button aria-label="Bajar opción" className="crm-action-button" disabled={disabled || index === options.length - 1} onClick={() => void moveOption(option.id, 1)} type="button"><ArrowDown className="!size-4" /></button><button aria-label="Editar suplemento" className="crm-action-button" disabled={disabled} onClick={() => { const value = window.prompt('Suplemento', (supplement / 100).toFixed(2).replace('.', ',')); if (value === null || !Number.isSafeInteger(money(value))) return; if (selectionOption) void mutate(() => catalogAdminService.saveSelectionOption(catalog.venueId, { ...selectionOption, supplementCents: money(value) })); else if (modifier) void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, supplementCents: money(value) })) }} type="button"><Pencil className="!size-4" /></button><button aria-label="Activar o desactivar opción" className="crm-action-button" disabled={disabled} onClick={() => { if (selectionOption) void mutate(() => catalogAdminService.saveSelectionOption(catalog.venueId, { ...selectionOption, active: !selectionOption.active })); else if (modifier) void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, active: !modifier.active })) }} type="button">{active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>{modifier ? <button aria-label="Cambiar modificador predeterminado" className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.saveModifier(catalog.venueId, { ...modifier, isDefault: !modifier.isDefault }))} type="button">★</button> : null}<button aria-label="Eliminar opción" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => { if (!window.confirm(`Eliminar “${label}”?`)) return; void mutate(() => selectionOption ? catalogAdminService.deleteSelectionOption(catalog.venueId, option.id) : catalogAdminService.deleteModifier(catalog.venueId, option.id)) }} type="button"><Trash2 className="!size-4" /></button></div></div>
            })}
          </div>
        </div> : <p className="!text-[var(--crm-text-muted)]">Crea o selecciona un grupo para editar sus opciones.</p>}
      </section>
    </div>
  )
}
