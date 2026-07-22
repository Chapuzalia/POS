import { useMemo, useState } from 'react'
import type { Product, SelectionGroup, TenantContext } from '../../../../types'
import type { RunAction } from '../../shared/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { parseMoneyToCents, formatMoney } from '../../../../lib/format'
import {
  addModifier,
  addSelectionGroupItem,
  assignModifierGroup,
  assignSelectionGroupToVariant,
  createModifierGroup,
  createSelectionGroup,
} from '../services/catalogService'

type Props = { context: TenantContext; venueId: string; groups: SelectionGroup[]; products: Product[]; disabled: boolean; runAction: RunAction; onCatalogChanged: () => Promise<void> }

export function ComplementsCrm({ context, venueId, groups, products, disabled, runAction, onCatalogChanged }: Props) {
  const [kind, setKind] = useState<'mixer' | 'menu_component'>('mixer')
  const [name, setName] = useState('')
  const [groupId, setGroupId] = useState(groups[0]?.id ?? '')
  const [productId, setProductId] = useState(products[0]?.id ?? '')
  const [variantId, setVariantId] = useState('')
  const [delta, setDelta] = useState('0,00')
  const [modifierOwnerProductId, setModifierOwnerProductId] = useState(products[0]?.id ?? '')
  const [modifierGroupName, setModifierGroupName] = useState('')
  const [modifierMin, setModifierMin] = useState(0)
  const [modifierMax, setModifierMax] = useState(1)
  const [modifierGroupId, setModifierGroupId] = useState('')
  const [modifierName, setModifierName] = useState('')
  const [modifierDelta, setModifierDelta] = useState('0,00')
  const [modifierDefault, setModifierDefault] = useState(false)
  const [modifierTargetProductId, setModifierTargetProductId] = useState(products[0]?.id ?? '')
  const [modifierTargetVariantId, setModifierTargetVariantId] = useState('')
  const variants = products.flatMap((product) => product.variants.map((variant) => ({ ...variant, productName: product.name })))
  const reusableModifierGroups = useMemo(() => [...new Map(products.flatMap((product) => [
    ...product.modifierGroups,
    ...(product.modifierGroupAssignments ?? []).map((assignment) => assignment.group),
  ]).map((group) => [group.id, group])).values()].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'es')), [products])
  const selectedModifierGroupId = modifierGroupId || reusableModifierGroups[0]?.id || ''
  const targetProduct = products.find((product) => product.id === modifierTargetProductId)
  async function refresh(action: () => Promise<void>) { await runAction(async () => { await action(); await onCatalogChanged() }) }

  return <div className="grid gap-4 xl:grid-cols-3">
    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <h2 className="text-lg font-bold">Mixers y componentes de menu</h2>
      <div className="mt-4 grid gap-3">
        <CrmSelect options={[{ label: 'Mixers', value: 'mixer' }, { label: 'Componentes de menu', value: 'menu_component' }]} value={kind} onChange={(value) => setKind(value as typeof kind)} />
        <input className="crm-input" placeholder="Nombre del grupo" value={name} onChange={(event) => setName(event.target.value)} />
        <button className="crm-primary-button" disabled={disabled || !name.trim()} onClick={() => void refresh(async () => { await createSelectionGroup(context, { venueId, kind, name, minSelect: 1, maxSelect: 1 }); setName('') })} type="button">Crear grupo 1 de 1</button>
      </div>
      <div className="mt-4 grid gap-2">{groups.map((group) => <div className="rounded-xl bg-[var(--crm-surface-soft)] p-3" key={group.id}><strong>{group.name}</strong><small className="ml-2 text-[var(--crm-text-muted)]">{group.kind} · {group.minSelect}-{group.maxSelect}</small>{group.items.map((item) => <div className="mt-1 text-sm" key={item.id}>{products.find((product) => product.id === item.productId)?.name ?? 'Producto'} · {item.priceDeltaCents ? `+${formatMoney(item.priceDeltaCents)}` : 'incluido'}</div>)}</div>)}</div>
    </section>
    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <h2 className="text-lg font-bold">Opciones y asignacion por variante</h2>
      <div className="mt-4 grid gap-3">
        <CrmSelect options={groups.map((group) => ({ label: group.name, value: group.id }))} value={groupId} onChange={setGroupId} />
        <CrmSelect options={products.filter((product) => product.isActive && product.productType === 'standard').map((product) => ({ label: product.name, value: product.id }))} value={productId} onChange={setProductId} />
        <input className="crm-input" aria-label="Suplemento" value={delta} onChange={(event) => setDelta(event.target.value)} />
        <button className="crm-primary-button" disabled={disabled || !groupId || !productId} onClick={() => void refresh(() => addSelectionGroupItem(context, { groupId, productId, variantId: null, priceDeltaCents: parseMoneyToCents(delta) }))} type="button">Anadir opcion</button>
        <CrmSelect options={[{ label: 'Selecciona variante para asignar', value: '' }, ...variants.filter((variant) => variant.isActive).map((variant) => ({ label: `${variant.productName} · ${variant.name}`, value: variant.id }))]} value={variantId} onChange={setVariantId} />
        <button className="crm-secondary-button" disabled={disabled || !groupId || !variantId} onClick={() => void refresh(() => assignSelectionGroupToVariant(context, variantId, groupId))} type="button">Asignar grupo a variante</button>
      </div>
    </section>
    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <h2 className="text-lg font-bold">Modificadores reutilizables</h2>
      <div className="mt-4 grid gap-3">
        <CrmSelect
          options={products.filter((product) => product.isActive).map((product) => ({ label: `Producto inicial · ${product.name}`, value: product.id }))}
          value={modifierOwnerProductId}
          onChange={setModifierOwnerProductId}
        />
        <input className="crm-input" placeholder="Nombre del grupo" value={modifierGroupName} onChange={(event) => setModifierGroupName(event.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <input aria-label="Seleccion minima" className="crm-input" min={0} type="number" value={modifierMin} onChange={(event) => setModifierMin(Number(event.target.value))} />
          <input aria-label="Seleccion maxima" className="crm-input" min={1} type="number" value={modifierMax} onChange={(event) => setModifierMax(Number(event.target.value))} />
        </div>
        <button
          className="crm-primary-button"
          disabled={disabled || !modifierOwnerProductId || !modifierGroupName.trim() || modifierMin < 0 || modifierMax < Math.max(1, modifierMin)}
          onClick={() => void refresh(async () => {
            await createModifierGroup(context, { productId: modifierOwnerProductId, name: modifierGroupName, minSelect: modifierMin, maxSelect: modifierMax })
            setModifierGroupName('')
          })}
          type="button"
        >Crear grupo</button>

        <CrmSelect options={reusableModifierGroups.map((group) => ({ label: group.name, value: group.id }))} value={selectedModifierGroupId} onChange={setModifierGroupId} />
        <input className="crm-input" placeholder="Nombre del modificador" value={modifierName} onChange={(event) => setModifierName(event.target.value)} />
        <input aria-label="Suplemento del modificador" className="crm-input" value={modifierDelta} onChange={(event) => setModifierDelta(event.target.value)} />
        <label className="flex items-center gap-2 text-sm font-semibold">
          <input checked={modifierDefault} onChange={(event) => setModifierDefault(event.target.checked)} type="checkbox" />
          Seleccionado por defecto
        </label>
        <button
          className="crm-secondary-button"
          disabled={disabled || !selectedModifierGroupId || !modifierName.trim()}
          onClick={() => void refresh(async () => {
            await addModifier(context, { groupId: selectedModifierGroupId, name: modifierName, priceCents: parseMoneyToCents(modifierDelta), isDefault: modifierDefault })
            setModifierName('')
            setModifierDelta('0,00')
            setModifierDefault(false)
          })}
          type="button"
        >Anadir modificador</button>

        <CrmSelect options={products.filter((product) => product.isActive).map((product) => ({ label: `Asignar a · ${product.name}`, value: product.id }))} value={modifierTargetProductId} onChange={(value) => { setModifierTargetProductId(value); setModifierTargetVariantId('') }} />
        <CrmSelect
          options={[{ label: 'Todas las variantes', value: '' }, ...(targetProduct?.variants ?? []).filter((variant) => variant.isActive).map((variant) => ({ label: variant.name, value: variant.id }))]}
          value={modifierTargetVariantId}
          onChange={setModifierTargetVariantId}
        />
        <button
          className="crm-secondary-button"
          disabled={disabled || !selectedModifierGroupId || !modifierTargetProductId}
          onClick={() => void refresh(() => assignModifierGroup(context, {
            productId: modifierTargetProductId,
            variantId: modifierTargetVariantId || null,
            modifierGroupId: selectedModifierGroupId,
          }))}
          type="button"
        >Asignar grupo</button>
      </div>
      <div className="mt-4 grid gap-2">
        {reusableModifierGroups.map((group) => <div className="rounded-xl bg-[var(--crm-surface-soft)] p-3" key={group.id}>
          <strong>{group.name}</strong>
          <small className="ml-2 text-[var(--crm-text-muted)]">{group.minSelect}-{group.maxSelect}</small>
          {group.modifiers.filter((modifier) => modifier.isActive).map((modifier) => <div className="mt-1 text-sm" key={modifier.id}>
            {modifier.name} · {modifier.priceCents ? `+${formatMoney(modifier.priceCents)}` : 'incluido'}{modifier.isDefault ? ' · por defecto' : ''}
          </div>)}
        </div>)}
      </div>
    </section>
  </div>
}
