import { ArrowDown, ArrowUp, ImagePlus, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { CatalogData, CatalogProduct } from '../../../catalog/domain/types.ts'
import { formatMoney, parseMoneyToCents } from '../../../../lib/format.ts'
import { CrmModal } from '../../shared/components/CrmModal.tsx'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { Field } from '../../shared/components/Field.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import {
  buildProductCreationBatch,
  moveCatalogItem,
  toReorderItems,
  validateSelectionCapacity,
  validateVariantDrafts,
} from '../services/catalogAdminModel.ts'

type Props = {
  catalog: CatalogData
  defaultTaxRate: number
  disabled: boolean
  mutate: (action: () => Promise<unknown>) => Promise<boolean>
  onClose: () => void
  product: CatalogProduct | null
}

type VariantDraft = {
  id: string
  name: string
  price: string
  active: boolean
  isDefault: boolean
}

function cents(value: string) {
  try {
    return parseMoneyToCents(value)
  } catch {
    return Number.NaN
  }
}

export function CatalogProductEditor({ catalog, defaultTaxRate, disabled, mutate, onClose, product }: Props) {
  const productVariants = useMemo(() => catalog.variants.filter((variant) => variant.productId === product?.id), [catalog.variants, product?.id])
  const productPlacements = useMemo(() => catalog.placements.filter((placement) => placement.productId === product?.id), [catalog.placements, product?.id])
  const productAssignments = useMemo(() => [
    ...catalog.selectionAssignments.filter((assignment) => assignment.productId === product?.id).map((assignment) => ({ ...assignment, domain: 'selection' as const })),
    ...catalog.modifierAssignments.filter((assignment) => assignment.productId === product?.id).map((assignment) => ({ ...assignment, domain: 'modifier' as const })),
  ], [catalog.modifierAssignments, catalog.selectionAssignments, product?.id])
  const [name, setName] = useState(product?.name ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [type, setType] = useState<'standard' | 'menu'>(product?.type ?? 'standard')
  const [vatRate, setVatRate] = useState(String(product?.vatRate ?? defaultTaxRate))
  const [active, setActive] = useState(product?.active ?? true)
  const [advanced, setAdvanced] = useState(product?.type === 'menu')
  const [variantDrafts, setVariantDrafts] = useState<VariantDraft[]>(() => productVariants.length
    ? productVariants.map((variant) => ({ id: variant.id, name: variant.name, price: (variant.priceCents / 100).toFixed(2).replace('.', ','), active: variant.active, isDefault: variant.isDefault }))
    : [{ id: catalogAdminService.uuid(), name: 'Normal', price: '0,00', active: true, isDefault: true }])
  const [tabId, setTabId] = useState(catalog.tabs.find((tab) => tab.active)?.id ?? '')
  const [categoryId, setCategoryId] = useState(catalog.categories.find((category) => category.active)?.id ?? '')
  const [internal, setInternal] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [dirty, setDirty] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [newVariantName, setNewVariantName] = useState('')
  const [newVariantPrice, setNewVariantPrice] = useState('0,00')
  const [placementTabId, setPlacementTabId] = useState(catalog.tabs.find((tab) => tab.active)?.id ?? '')
  const [placementCategoryId, setPlacementCategoryId] = useState(catalog.categories.find((category) => category.active)?.id ?? '')
  const [placementVariantId, setPlacementVariantId] = useState('')
  const [placementEditId, setPlacementEditId] = useState('')
  const [assignmentDomain, setAssignmentDomain] = useState<'selection' | 'modifier'>('selection')
  const [assignmentGroupId, setAssignmentGroupId] = useState('')
  const [assignmentMin, setAssignmentMin] = useState(0)
  const [assignmentMax, setAssignmentMax] = useState(1)
  const [assignmentVariantId, setAssignmentVariantId] = useState('')
  const previewUrl = useMemo(() => imageFile ? URL.createObjectURL(imageFile) : product?.image?.publicUrl ?? null, [imageFile, product?.image?.publicUrl])

  useEffect(() => () => {
    if (imageFile && previewUrl) URL.revokeObjectURL(previewUrl)
  }, [imageFile, previewUrl])

  function markDirty() {
    setDirty(true)
    setFormError(null)
  }

  function closeSafely() {
    if (!dirty || window.confirm('Hay cambios sin guardar. ¿Cerrar de todos modos?')) onClose()
  }

  function updateDraft(id: string, patch: Partial<VariantDraft>) {
    setVariantDrafts((current) => current.map((variant) => {
      if (variant.id === id) return { ...variant, ...patch }
      return patch.isDefault ? { ...variant, isDefault: false } : variant
    }))
    markDirty()
  }

  async function submitGeneral(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return setFormError('El nombre es obligatorio.')
    const parsedVat = Number(vatRate.replace(',', '.'))
    if (!Number.isFinite(parsedVat) || parsedVat < 0 || parsedVat > 100) return setFormError('El IVA debe estar entre 0 y 100.')

    if (product) {
      const saved = await mutate(() => catalogAdminService.updateProduct(catalog.venueId, {
        id: product.id,
        type,
        name: name.trim(),
        description: description.trim() || null,
        vatRate: parsedVat,
        active,
        sortOrder: product.sortOrder,
      }))
      if (saved && imageFile) await mutate(() => catalogAdminService.uploadProductImage({ tenantId: catalog.tenantId, venueId: catalog.venueId, productId: product.id, file: imageFile }))
      if (saved) setDirty(false)
      return
    }

    const variants = (advanced ? variantDrafts : variantDrafts.slice(0, 1)).map((variant, index) => ({
      id: variant.id,
      name: variant.name.trim(),
      priceCents: cents(variant.price),
      active: variant.active,
      isDefault: variant.isDefault,
      sortOrder: index * 10,
    }))
    const variantError = validateVariantDrafts(variants, active)
    if (variantError) return setFormError(variantError)
    if (!internal && (!tabId || !categoryId)) return setFormError('Elige una pestaña y categoría, o marca el producto como interno.')
    const productId = catalogAdminService.uuid()
    const batch = buildProductCreationBatch({
      productId,
      venueId: catalog.venueId,
      type,
      name,
      description: description.trim() || null,
      vatRate: parsedVat,
      active,
      sortOrder: catalog.products.length * 10,
      variants,
      placement: internal ? undefined : {
        id: catalogAdminService.uuid(),
        tabId,
        categoryId,
        pinnedVariantId: null,
        sortOrder: catalog.placements.filter((placement) => placement.tabId === tabId && placement.categoryId === categoryId).length * 10,
      },
    })
    const saved = await mutate(() => catalogAdminService.batch(catalog.venueId, batch))
    if (saved && imageFile) await mutate(() => catalogAdminService.uploadProductImage({ tenantId: catalog.tenantId, venueId: catalog.venueId, productId, file: imageFile }))
    if (saved) onClose()
  }

  async function addVariant() {
    if (!product || !newVariantName.trim() || cents(newVariantPrice) < 0) return
    await mutate(() => catalogAdminService.createVariant(catalog.venueId, product.id, {
      name: newVariantName.trim(), priceCents: cents(newVariantPrice), active: true,
      isDefault: productVariants.length === 0, sortOrder: productVariants.length * 10,
    }))
    setNewVariantName('')
    setNewVariantPrice('0,00')
  }

  async function moveVariant(id: string, direction: -1 | 1) {
    const items = moveCatalogItem(productVariants, id, direction)
    await mutate(() => catalogAdminService.reorder(catalog.venueId, { entity: 'variants', items: toReorderItems(items) }))
  }

  async function savePlacement() {
    if (!product || !placementTabId || !placementCategoryId) return
    const existing = productPlacements.find((placement) => placement.id === placementEditId)
    const saved = existing
      ? await mutate(() => catalogAdminService.updatePlacement(catalog.venueId, {
          ...existing,
          tabId: placementTabId,
          categoryId: placementCategoryId,
          pinnedVariantId: placementVariantId || null,
        }))
      : await mutate(() => catalogAdminService.createPlacement(catalog.venueId, {
          productId: product.id, tabId: placementTabId, categoryId: placementCategoryId,
          pinnedVariantId: placementVariantId || null, featured: false, active: true,
          sortOrder: productPlacements.length * 10,
        }))
    if (saved) setPlacementEditId('')
  }

  function editPlacement(id: string) {
    const placement = productPlacements.find((item) => item.id === id)
    if (!placement) return
    setPlacementEditId(id)
    setPlacementTabId(placement.tabId)
    setPlacementCategoryId(placement.categoryId ?? '')
    setPlacementVariantId(placement.pinnedVariantId ?? '')
  }

  async function movePlacement(id: string, direction: -1 | 1) {
    await mutate(() => catalogAdminService.reorder(catalog.venueId, {
      entity: 'placements',
      items: toReorderItems(moveCatalogItem(productPlacements, id, direction)),
    }))
  }

  async function addAssignment() {
    if (!product || !assignmentGroupId) return
    const optionsCount = assignmentDomain === 'selection'
      ? catalog.selectionOptions.filter((option) => option.groupId === assignmentGroupId && option.active).length
      : catalog.modifiers.filter((modifier) => modifier.groupId === assignmentGroupId && modifier.active).length
    const validation = validateSelectionCapacity({ minSelection: assignmentMin, maxSelection: assignmentMax, required: assignmentMin > 0, availableOptions: optionsCount })
    if (validation) return setFormError(validation)
    await mutate(() => catalogAdminService.saveAssignment(catalog.venueId, {
      domain: assignmentDomain,
      productId: product.id,
      groupId: assignmentGroupId,
      minSelection: assignmentMin,
      maxSelection: assignmentMax,
      appliesToAllVariants: !assignmentVariantId,
      variantIds: assignmentVariantId ? [assignmentVariantId] : [],
      active: true,
      sortOrder: productAssignments.filter((assignment) => assignment.domain === assignmentDomain).length * 10,
    }))
  }

  const assignmentGroups = assignmentDomain === 'selection' ? catalog.selectionGroups : catalog.modifierGroups

  return (
    <CrmModal label={product ? `Editar ${product.name}` : 'Crear producto'} onClose={closeSafely} size="large">
      <header className="!flex !items-center !justify-between !border-b !border-[var(--crm-border-subtle)] !px-5 !py-4">
        <div><h2 className="!text-lg !font-bold">{product ? product.name : 'Nuevo producto'}</h2><p className="!text-sm !text-[var(--crm-text-muted)]">{product ? 'Configuración completa del catálogo definitivo' : 'Alta rápida con acceso a opciones avanzadas'}</p></div>
        <button aria-label="Cerrar" className="crm-action-button" onClick={closeSafely} type="button"><X className="!size-5" /></button>
      </header>
      <div className="!grid !gap-5 !overflow-y-auto !p-5">
        <form className="!grid !gap-4" onSubmit={(event) => void submitGeneral(event)}>
          <h3 className="!font-bold">Información general</h3>
          <div className="!grid !gap-3 sm:!grid-cols-2">
            <Field label="Nombre"><input className="crm-input" onChange={(event) => { setName(event.target.value); markDirty() }} value={name} /></Field>
            <Field label="Tipo"><CrmSelect onChange={(value) => { setType(value as typeof type); if (value === 'menu') setAdvanced(true); markDirty() }} options={[{ label: 'Producto estándar', value: 'standard' }, { label: 'Menú', value: 'menu' }]} value={type} /></Field>
            <Field label="IVA (%)"><input className="crm-input" inputMode="decimal" onChange={(event) => { setVatRate(event.target.value); markDirty() }} value={vatRate} /></Field>
            <label className="!flex !items-end !gap-2 !pb-3 !text-sm !font-semibold"><input checked={active} onChange={(event) => { setActive(event.target.checked); markDirty() }} type="checkbox" /> Producto activo</label>
          </div>
          <Field label="Descripción"><textarea className="crm-input !min-h-20" onChange={(event) => { setDescription(event.target.value); markDirty() }} value={description} /></Field>
          <div className="!grid !gap-3 sm:!grid-cols-[110px_1fr] sm:!items-center">
            <div className="crm-product-thumb !size-24 !overflow-hidden">{previewUrl ? <img alt="Previsualización" className="!size-full !object-cover" src={previewUrl} /> : <ImagePlus className="!size-5" />}</div>
            <div className="!grid !gap-2">
              <label className="crm-secondary-button !inline-flex !w-fit !cursor-pointer !items-center !gap-2"><ImagePlus className="!size-4" /> Seleccionar imagen<input accept="image/jpeg,image/png,image/webp,image/avif" className="!sr-only" disabled={disabled} onChange={(event) => { setImageFile(event.target.files?.[0] ?? null); markDirty() }} type="file" /></label>
              <small className="!text-[var(--crm-text-muted)]">JPEG, PNG, WebP o AVIF, máximo 10 MB. Se optimiza a WebP.</small>
              {product?.image ? <button className="crm-danger-button !w-fit" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deleteProductImage(catalog.venueId, product.id))} type="button">Eliminar imagen actual</button> : null}
            </div>
          </div>

          {!product ? (
            <>
              <label className="!flex !items-center !gap-2 !text-sm !font-semibold"><input checked={advanced} onChange={(event) => { setAdvanced(event.target.checked); markDirty() }} type="checkbox" /> Configuración avanzada de variantes</label>
              <div className="!grid !gap-2">
                {(advanced ? variantDrafts : variantDrafts.slice(0, 1)).map((variant) => (
                  <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto_auto] sm:!items-center" key={variant.id}>
                    <input aria-label="Nombre de variante" className="crm-input" onChange={(event) => updateDraft(variant.id, { name: event.target.value })} value={variant.name} />
                    <input aria-label="Precio de variante" className="crm-input" inputMode="decimal" onChange={(event) => updateDraft(variant.id, { price: event.target.value })} value={variant.price} />
                    <label className="!text-xs"><input checked={variant.active} onChange={(event) => updateDraft(variant.id, { active: event.target.checked })} type="checkbox" /> Activa</label>
                    <label className="!text-xs"><input checked={variant.isDefault} onChange={() => updateDraft(variant.id, { isDefault: true })} type="radio" /> Predeterminada</label>
                  </div>
                ))}
                {advanced ? <button className="crm-secondary-button !w-fit" onClick={() => { setVariantDrafts((current) => [...current, { id: catalogAdminService.uuid(), name: '', price: '0,00', active: true, isDefault: false }]); markDirty() }} type="button"><Plus className="!size-4" /> Añadir variante</button> : null}
              </div>
              <label className="!flex !items-center !gap-2 !text-sm !font-semibold"><input checked={internal} onChange={(event) => { setInternal(event.target.checked); markDirty() }} type="checkbox" /> Producto interno, sin aparición inicial en TPV</label>
              {!internal ? <div className="!grid !gap-3 sm:!grid-cols-2"><Field label="Pestaña inicial"><CrmSelect onChange={(value) => { setTabId(value); markDirty() }} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={tabId} /></Field><Field label="Categoría inicial"><CrmSelect onChange={(value) => { setCategoryId(value); markDirty() }} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={categoryId} /></Field></div> : null}
            </>
          ) : null}
          {formError ? <p className="!rounded-lg !bg-red-500/10 !p-3 !text-sm !font-semibold !text-red-500" role="alert">{formError}</p> : null}
          <button className="crm-primary-button !inline-flex !w-fit !items-center !gap-2" disabled={disabled} type="submit"><Save className="!size-4" /> {product ? 'Guardar información' : 'Crear producto'}</button>
        </form>

        {product ? (
          <>
            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Variantes</h3><p className="!text-sm !text-[var(--crm-text-muted)]">Una sola variante mantiene una experiencia sencilla; añade más cuando el producto lo necesite.</p></div>
              {productVariants.map((variant, index) => (
                <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[1fr_auto] sm:!items-center" key={variant.id}>
                  <div><strong>{variant.name}</strong> · {formatMoney(variant.priceCents)} · {variant.active ? 'Activa' : 'Inactiva'}{variant.isDefault ? ' · Predeterminada' : ''}</div>
                  <div className="crm-action-group">
                    <button aria-label="Subir" className="crm-action-button" disabled={disabled || index === 0} onClick={() => void moveVariant(variant.id, -1)} type="button"><ArrowUp className="!size-4" /></button>
                    <button aria-label="Bajar" className="crm-action-button" disabled={disabled || index === productVariants.length - 1} onClick={() => void moveVariant(variant.id, 1)} type="button"><ArrowDown className="!size-4" /></button>
                    <button aria-label="Editar variante" className="crm-secondary-button" disabled={disabled} onClick={() => { const nextName = window.prompt('Nombre de la variante', variant.name)?.trim(); const nextPrice = window.prompt('Precio', (variant.priceCents / 100).toFixed(2).replace('.', ',')); if (!nextName || nextPrice === null || cents(nextPrice) < 0) return; void mutate(() => catalogAdminService.updateVariant(catalog.venueId, { id: variant.id, productId: product.id, name: nextName, priceCents: cents(nextPrice), active: variant.active, isDefault: variant.isDefault, sortOrder: variant.sortOrder })) }} type="button">Editar</button>
                    <button className="crm-secondary-button" disabled={disabled || variant.isDefault} onClick={() => void mutate(() => catalogAdminService.updateVariant(catalog.venueId, { id: variant.id, productId: product.id, name: variant.name, priceCents: variant.priceCents, active: !variant.active, isDefault: variant.isDefault, sortOrder: variant.sortOrder }))} type="button">{variant.active ? 'Desactivar' : 'Activar'}</button>
                    {!variant.isDefault ? <button className="crm-secondary-button" disabled={disabled || !variant.active} onClick={() => void mutate(() => catalogAdminService.setDefaultVariant(catalog.venueId, product.id, variant.id))} type="button">Predeterminada</button> : null}
                    <button aria-label="Eliminar variante" className="crm-action-button crm-danger-button" disabled={disabled || variant.isDefault} onClick={() => void mutate(() => catalogAdminService.deleteVariant(catalog.venueId, product.id, variant.id))} type="button"><Trash2 className="!size-4" /></button>
                  </div>
                </div>
              ))}
              <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto]"><input className="crm-input" onChange={(event) => setNewVariantName(event.target.value)} placeholder="Nueva variante" value={newVariantName} /><input className="crm-input" inputMode="decimal" onChange={(event) => setNewVariantPrice(event.target.value)} value={newVariantPrice} /><button className="crm-secondary-button" disabled={disabled || !newVariantName.trim()} onClick={() => void addVariant()} type="button"><Plus className="!size-4" /> Añadir</button></div>
            </section>

            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Apariciones en TPV</h3><p className="!text-sm !text-[var(--crm-text-muted)]">El producto puede mostrarse varias veces y fijar una variante distinta en cada ubicación.</p></div>
              <div className="!grid !gap-2 sm:!grid-cols-4"><CrmSelect onChange={setPlacementTabId} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={placementTabId} /><CrmSelect onChange={setPlacementCategoryId} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={placementCategoryId} /><CrmSelect onChange={setPlacementVariantId} options={[{ label: 'Variante predeterminada', value: '' }, ...productVariants.filter((variant) => variant.active).map((variant) => ({ label: variant.name, value: variant.id }))]} value={placementVariantId} /><button className="crm-secondary-button" disabled={disabled || !placementTabId || !placementCategoryId} onClick={() => void savePlacement()} type="button"><Plus className="!size-4" /> {placementEditId ? 'Guardar cambios' : 'Añadir'}</button></div>
              {productPlacements.map((placement) => (
                <div className="!flex !items-center !justify-between !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3" key={placement.id}><span>{catalog.tabs.find((tab) => tab.id === placement.tabId)?.label} / {catalog.categories.find((category) => category.id === placement.categoryId)?.name ?? 'Sin categoría'}{placement.pinnedVariantId ? ` · ${productVariants.find((variant) => variant.id === placement.pinnedVariantId)?.name}` : ''} · {placement.active ? 'Visible' : 'Oculta'}</span><div className="crm-action-group"><button className="crm-secondary-button" disabled={disabled} onClick={() => editPlacement(placement.id)} type="button">Editar</button><button aria-label="Subir aparición" className="crm-action-button" disabled={disabled || productPlacements[0]?.id === placement.id} onClick={() => void movePlacement(placement.id, -1)} type="button"><ArrowUp className="!size-4" /></button><button aria-label="Bajar aparición" className="crm-action-button" disabled={disabled || productPlacements.at(-1)?.id === placement.id} onClick={() => void movePlacement(placement.id, 1)} type="button"><ArrowDown className="!size-4" /></button><button className="crm-secondary-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.updatePlacement(catalog.venueId, { ...placement, active: !placement.active }))} type="button">{placement.active ? 'Ocultar' : 'Mostrar'}</button><button aria-label="Eliminar aparición" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deletePlacement(catalog.venueId, placement.id))} type="button"><Trash2 className="!size-4" /></button></div></div>
              ))}
            </section>

            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Grupos asignados</h3><p className="!text-sm !text-[var(--crm-text-muted)]">Aplica el grupo a todo el producto o limita su alcance a una variante concreta.</p></div>
              <div className="!grid !gap-2 sm:!grid-cols-5"><CrmSelect onChange={(value) => { setAssignmentDomain(value as typeof assignmentDomain); setAssignmentGroupId('') }} options={[{ label: 'Grupo de selección', value: 'selection' }, { label: 'Modificadores', value: 'modifier' }]} value={assignmentDomain} /><CrmSelect onChange={setAssignmentGroupId} options={assignmentGroups.filter((group) => group.active).map((group) => ({ label: group.name, value: group.id }))} value={assignmentGroupId} /><input aria-label="Mínimo" className="crm-input" min={0} onChange={(event) => setAssignmentMin(Number(event.target.value))} type="number" value={assignmentMin} /><input aria-label="Máximo" className="crm-input" min={1} onChange={(event) => setAssignmentMax(Number(event.target.value))} type="number" value={assignmentMax} /><CrmSelect onChange={setAssignmentVariantId} options={[{ label: 'Todas las variantes', value: '' }, ...productVariants.map((variant) => ({ label: variant.name, value: variant.id }))]} value={assignmentVariantId} /></div>
              <button className="crm-secondary-button !w-fit" disabled={disabled || !assignmentGroupId} onClick={() => void addAssignment()} type="button"><Plus className="!size-4" /> Asignar grupo</button>
              {productAssignments.map((assignment) => <div className="!flex !items-center !justify-between !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3" key={`${assignment.domain}-${assignment.id}`}><span><strong>{assignment.domain === 'selection' ? catalog.selectionGroups.find((group) => group.id === assignment.groupId)?.name : catalog.modifierGroups.find((group) => group.id === assignment.groupId)?.name}</strong> · {assignment.minSelection}–{assignment.maxSelection} · {assignment.appliesToAllVariants ? 'Todas las variantes' : assignment.variantIds.map((id) => productVariants.find((variant) => variant.id === id)?.name).join(', ')}</span><button aria-label="Eliminar asignación" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deleteAssignment(catalog.venueId, assignment.domain, assignment.id))} type="button"><Trash2 className="!size-4" /></button></div>)}
            </section>
          </>
        ) : null}
      </div>
    </CrmModal>
  )
}
