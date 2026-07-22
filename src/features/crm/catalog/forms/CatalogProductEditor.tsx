import { Eye, EyeOff, ImagePlus, Pencil, Plus, Save, Trash2, X } from 'lucide-react'
import { useEffect, useMemo, useState, type FormEvent } from 'react'
import type { CatalogData, CatalogProduct } from '../../../catalog/domain/types.ts'
import { formatMoney, parseMoneyToCents } from '../../../../lib/format.ts'
import { CrmModal } from '../../shared/components/CrmModal.tsx'
import { CrmSelect } from '../../shared/components/CrmSelect.tsx'
import { Field } from '../../shared/components/Field.tsx'
import { catalogAdminService } from '../services/catalogAdminService.ts'
import {
  buildProductCreationBatch,
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
  formatId: string
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
  const activeFormats = useMemo(() => catalog.saleFormats.filter((format) => format.active), [catalog.saleFormats])
  const formatById = useMemo(() => new Map(catalog.saleFormats.map((format) => [format.id, format])), [catalog.saleFormats])
  const productVariants = useMemo(() => catalog.variants.filter((variant) => variant.productId === product?.id), [catalog.variants, product?.id])
  const productPlacements = useMemo(() => catalog.placements.filter((placement) => placement.productId === product?.id), [catalog.placements, product?.id])
  const productAssignments = useMemo(() => [
    ...catalog.selectionAssignments.filter((assignment) => assignment.productId === product?.id).map((assignment) => ({ ...assignment, domain: 'selection' as const })),
    ...catalog.modifierAssignments.filter((assignment) => assignment.productId === product?.id).map((assignment) => ({ ...assignment, domain: 'modifier' as const })),
  ], [catalog.modifierAssignments, catalog.selectionAssignments, product?.id])
  const [name, setName] = useState(product?.name ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [type, setType] = useState<'standard' | 'menu'>(product?.type ?? 'standard')
  const [vatMode, setVatMode] = useState<'default' | 'custom'>(product?.vatRate === null || product?.vatRate === undefined ? 'default' : 'custom')
  const [vatRate, setVatRate] = useState(String(product?.vatRate ?? defaultTaxRate))
  const [advanced, setAdvanced] = useState(product?.type === 'menu')
  const [variantDrafts, setVariantDrafts] = useState<VariantDraft[]>(() => productVariants.length
    ? productVariants.map((variant) => ({ id: variant.id, formatId: variant.formatId ?? '', price: (variant.priceCents / 100).toFixed(2).replace('.', ','), active: variant.active, isDefault: variant.isDefault }))
    : [{ id: catalogAdminService.uuid(), formatId: activeFormats[0]?.id ?? '', price: '0,00', active: true, isDefault: true }])
  const [tabId, setTabId] = useState(catalog.tabs.find((tab) => tab.active)?.id ?? '')
  const [categoryId, setCategoryId] = useState(catalog.categories.find((category) => category.active)?.id ?? '')
  const [internal, setInternal] = useState(false)
  const [initialPlacementFeatured, setInitialPlacementFeatured] = useState(false)
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [dirty, setDirty] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [newVariantFormatId, setNewVariantFormatId] = useState('')
  const [newVariantPrice, setNewVariantPrice] = useState('0,00')
  const [editingVariantId, setEditingVariantId] = useState('')
  const [editingVariantFormatId, setEditingVariantFormatId] = useState('')
  const [editingVariantPrice, setEditingVariantPrice] = useState('0,00')
  const [placementTabId, setPlacementTabId] = useState(catalog.tabs.find((tab) => tab.active)?.id ?? '')
  const [placementCategoryId, setPlacementCategoryId] = useState(catalog.categories.find((category) => category.active)?.id ?? '')
  const [placementVariantId, setPlacementVariantId] = useState('')
  const [placementFeatured, setPlacementFeatured] = useState(false)
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
    const parsedVat = vatMode === 'default' ? null : Number(vatRate.replace(',', '.'))
    if (parsedVat !== null && (!Number.isFinite(parsedVat) || parsedVat < 0 || parsedVat > 100)) return setFormError('El IVA debe estar entre 0 y 100.')

    if (product) {
      const saved = await mutate(() => catalogAdminService.updateProduct(catalog.venueId, {
        id: product.id,
        type,
        name: name.trim(),
        description: description.trim() || null,
        vatRate: parsedVat,
        active: product.active,
        sortOrder: product.sortOrder,
      }))
      if (saved && imageFile) await mutate(() => catalogAdminService.uploadProductImage({ tenantId: catalog.tenantId, venueId: catalog.venueId, productId: product.id, file: imageFile }))
      if (saved) setDirty(false)
      return
    }

    const variants = (advanced ? variantDrafts : variantDrafts.slice(0, 1)).map((variant, index) => ({
      id: variant.id,
      formatId: variant.formatId,
      name: formatById.get(variant.formatId)?.name ?? '',
      priceCents: cents(variant.price),
      active: variant.active,
      isDefault: variant.isDefault,
      sortOrder: index * 10,
    }))
    const variantError = validateVariantDrafts(variants, true)
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
      active: true,
      sortOrder: catalog.products.length * 10,
      variants,
      placement: internal ? undefined : {
        id: catalogAdminService.uuid(),
        tabId,
        categoryId,
        pinnedVariantId: null,
        featured: initialPlacementFeatured,
        sortOrder: catalog.placements.filter((placement) => placement.tabId === tabId && placement.categoryId === categoryId).length * 10,
      },
    })
    const saved = await mutate(() => catalogAdminService.batchWithVariantFormats(
      catalog.venueId,
      batch,
      variants.map((variant) => ({ variantId: variant.id, formatId: variant.formatId })),
    ))
    if (saved && imageFile) await mutate(() => catalogAdminService.uploadProductImage({ tenantId: catalog.tenantId, venueId: catalog.venueId, productId, file: imageFile }))
    if (saved) onClose()
  }

  async function addVariant() {
    const format = formatById.get(newVariantFormatId)
    if (!product || !format || cents(newVariantPrice) < 0) return
    await mutate(() => catalogAdminService.createVariant(catalog.venueId, product.id, {
      formatId: format.id, name: format.name, priceCents: cents(newVariantPrice), active: true,
      isDefault: productVariants.length === 0, sortOrder: productVariants.length * 10,
    }))
    setNewVariantFormatId('')
    setNewVariantPrice('0,00')
  }

  function beginVariantEdit(variantId: string) {
    const variant = productVariants.find((item) => item.id === variantId)
    if (!variant) return
    setEditingVariantId(variant.id)
    setEditingVariantFormatId(variant.formatId ?? '')
    setEditingVariantPrice((variant.priceCents / 100).toFixed(2).replace('.', ','))
  }

  async function saveVariantEdit() {
    if (!product) return
    const variant = productVariants.find((item) => item.id === editingVariantId)
    const format = formatById.get(editingVariantFormatId)
    if (!variant || !format || cents(editingVariantPrice) < 0) return
    const saved = await mutate(() => catalogAdminService.updateVariant(catalog.venueId, {
      id: variant.id,
      productId: product.id,
      formatId: format.id,
      name: format.name,
      priceCents: cents(editingVariantPrice),
      active: variant.active,
      isDefault: variant.isDefault,
      sortOrder: variant.sortOrder,
    }))
    if (saved) setEditingVariantId('')
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
          featured: placementFeatured,
        }))
      : await mutate(() => catalogAdminService.createPlacement(catalog.venueId, {
          productId: product.id, tabId: placementTabId, categoryId: placementCategoryId,
          pinnedVariantId: placementVariantId || null, featured: placementFeatured, active: true,
          sortOrder: productPlacements.length * 10,
        }))
    if (saved) {
      setPlacementEditId('')
      setPlacementFeatured(false)
    }
  }

  function editPlacement(id: string) {
    const placement = productPlacements.find((item) => item.id === id)
    if (!placement) return
    setPlacementEditId(id)
    setPlacementTabId(placement.tabId)
    setPlacementCategoryId(placement.categoryId ?? '')
    setPlacementVariantId(placement.pinnedVariantId ?? '')
    setPlacementFeatured(placement.featured)
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
            <Field className="sm:!col-span-2" label="IVA">
              <div className="!grid !gap-2 sm:!grid-cols-2">
                <CrmSelect
                  ariaLabel="Tipo de IVA"
                  onChange={(value) => { setVatMode(value as typeof vatMode); markDirty() }}
                  options={[
                    { label: `IVA predeterminado del local (${defaultTaxRate} %)`, value: 'default' },
                    { label: 'IVA personalizado', value: 'custom' },
                  ]}
                  value={vatMode}
                />
                {vatMode === 'custom' ? <input aria-label="IVA personalizado (%)" className="crm-input" inputMode="decimal" onChange={(event) => { setVatRate(event.target.value); markDirty() }} value={vatRate} /> : null}
              </div>
            </Field>
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
              {!activeFormats.length ? <p className="!rounded-xl !bg-[var(--crm-yellow-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-yellow)]">Crea al menos un formato en Productos → Formatos antes de crear el producto.</p> : null}
              <div className="!grid !gap-2">
                {(advanced ? variantDrafts : variantDrafts.slice(0, 1)).map((variant) => (
                  <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto_auto] sm:!items-center" key={variant.id}>
                    <CrmSelect ariaLabel="Formato de venta" onChange={(formatId) => updateDraft(variant.id, { formatId })} options={activeFormats.map((format) => ({ label: format.name, value: format.id, disabled: variantDrafts.some((draft) => draft.id !== variant.id && draft.formatId === format.id) }))} placeholder="Selecciona un formato" value={variant.formatId} />
                    <input aria-label="Precio de variante" className="crm-input" inputMode="decimal" onChange={(event) => updateDraft(variant.id, { price: event.target.value })} value={variant.price} />
                    <label className="!text-xs"><input checked={variant.active} onChange={(event) => updateDraft(variant.id, { active: event.target.checked })} type="checkbox" /> Activa</label>
                    <label className="!text-xs"><input checked={variant.isDefault} onChange={() => updateDraft(variant.id, { isDefault: true })} type="radio" /> Predeterminada</label>
                  </div>
                ))}
                {advanced ? <button className="crm-secondary-button !w-fit" disabled={variantDrafts.length >= activeFormats.length} onClick={() => { const used = new Set(variantDrafts.map((variant) => variant.formatId)); const formatId = activeFormats.find((format) => !used.has(format.id))?.id ?? ''; setVariantDrafts((current) => [...current, { id: catalogAdminService.uuid(), formatId, price: '0,00', active: true, isDefault: false }]); markDirty() }} type="button"><Plus className="!size-4" /> Añadir variante</button> : null}
              </div>
              <label className="!flex !items-center !gap-2 !text-sm !font-semibold"><input checked={internal} onChange={(event) => { setInternal(event.target.checked); markDirty() }} type="checkbox" /> Producto interno, sin aparición inicial en TPV</label>
              {!internal ? <div className="!grid !gap-3 sm:!grid-cols-[1fr_1fr_auto] sm:!items-end"><Field label="Pestaña inicial"><CrmSelect onChange={(value) => { setTabId(value); markDirty() }} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={tabId} /></Field><Field label="Categoría inicial"><CrmSelect onChange={(value) => { setCategoryId(value); markDirty() }} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={categoryId} /></Field><label className="!flex !min-h-11 !items-center !gap-2 !text-xs !font-semibold"><input checked={initialPlacementFeatured} onChange={(event) => { setInitialPlacementFeatured(event.target.checked); markDirty() }} type="checkbox" /> Destacado</label></div> : null}
            </>
          ) : null}
          {formError ? <p className="!rounded-lg !bg-red-500/10 !p-3 !text-sm !font-semibold !text-red-500" role="alert">{formError}</p> : null}
          <button className="crm-primary-button !inline-flex !w-fit !items-center !gap-2" disabled={disabled || (!product && !activeFormats.length)} type="submit"><Save className="!size-4" /> {product ? 'Guardar información' : 'Crear producto'}</button>
        </form>

        {product ? (
          <>
            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Variantes</h3><p className="!text-sm !text-[var(--crm-text-muted)]">Cada variante utiliza uno de los formatos configurados para el local.</p></div>
              {productVariants.map((variant) => (
                <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[1fr_auto] sm:!items-center" key={variant.id}>
                  {editingVariantId === variant.id ? (
                    <div className="!grid !gap-2 sm:!grid-cols-[minmax(180px,1fr)_140px_auto]">
                      <CrmSelect ariaLabel="Formato de la variante" onChange={setEditingVariantFormatId} options={catalog.saleFormats.map((format) => ({ label: format.name, value: format.id, disabled: !format.active || productVariants.some((item) => item.id !== variant.id && item.formatId === format.id) }))} value={editingVariantFormatId} />
                      <input aria-label="Precio de variante" className="crm-input" inputMode="decimal" onChange={(event) => setEditingVariantPrice(event.target.value)} value={editingVariantPrice} />
                      <button aria-label="Guardar variante" className="crm-action-button !bg-[var(--crm-blue)] !text-white" disabled={disabled || !editingVariantFormatId} onClick={() => void saveVariantEdit()} title="Guardar variante" type="button"><Save className="!size-4" /></button>
                    </div>
                  ) : <div><strong>{formatById.get(variant.formatId ?? '')?.name ?? variant.name}</strong> · {formatMoney(variant.priceCents)} · {variant.active ? 'Activa' : 'Inactiva'}{variant.isDefault ? ' · Predeterminada' : ''}</div>}
                  <div className="crm-action-group">
                    <button aria-label={editingVariantId === variant.id ? 'Cancelar edición de variante' : 'Editar variante'} className="crm-action-button" disabled={disabled} onClick={() => editingVariantId === variant.id ? setEditingVariantId('') : beginVariantEdit(variant.id)} title={editingVariantId === variant.id ? 'Cancelar' : 'Editar'} type="button">{editingVariantId === variant.id ? <X className="!size-4" /> : <Pencil className="!size-4" />}</button>
                    <button aria-label={variant.active ? 'Desactivar variante' : 'Activar variante'} className="crm-action-button" disabled={disabled || variant.isDefault || !variant.formatId} onClick={() => void mutate(() => catalogAdminService.updateVariant(catalog.venueId, { id: variant.id, productId: product.id, formatId: variant.formatId, name: variant.name, priceCents: variant.priceCents, active: !variant.active, isDefault: variant.isDefault, sortOrder: variant.sortOrder }))} title={variant.active ? 'Desactivar' : 'Activar'} type="button">{variant.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button>
                    {!variant.isDefault ? <button className="crm-secondary-button" disabled={disabled || !variant.active} onClick={() => void mutate(() => catalogAdminService.setDefaultVariant(catalog.venueId, product.id, variant.id))} type="button">Predeterminada</button> : null}
                    <button aria-label="Eliminar variante" className="crm-action-button crm-danger-button" disabled={disabled || variant.isDefault} onClick={() => void mutate(() => catalogAdminService.deleteVariant(catalog.venueId, product.id, variant.id))} type="button"><Trash2 className="!size-4" /></button>
                  </div>
                </div>
              ))}
              {!activeFormats.length ? <p className="!rounded-xl !bg-[var(--crm-yellow-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-yellow)]">No hay formatos activos. Créalo en Productos → Formatos.</p> : null}
              <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto]"><CrmSelect ariaLabel="Nuevo formato de venta" onChange={setNewVariantFormatId} options={activeFormats.map((format) => ({ label: format.name, value: format.id, disabled: productVariants.some((variant) => variant.formatId === format.id) }))} placeholder="Selecciona un formato" value={newVariantFormatId} /><input aria-label="Precio de la nueva variante" className="crm-input" inputMode="decimal" onChange={(event) => setNewVariantPrice(event.target.value)} value={newVariantPrice} /><button className="crm-secondary-button" disabled={disabled || !newVariantFormatId} onClick={() => void addVariant()} type="button"><Plus className="!size-4" /> Añadir</button></div>
            </section>

            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Apariciones en TPV</h3><p className="!text-sm !text-[var(--crm-text-muted)]">El producto puede mostrarse varias veces y fijar una variante distinta en cada ubicación.</p></div>
              <div className="!grid !gap-2 sm:!grid-cols-[1fr_1fr_1fr_auto_auto] sm:!items-center"><CrmSelect onChange={setPlacementTabId} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={placementTabId} /><CrmSelect onChange={setPlacementCategoryId} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={placementCategoryId} /><CrmSelect onChange={setPlacementVariantId} options={[{ label: 'Variante predeterminada', value: '' }, ...productVariants.filter((variant) => variant.active).map((variant) => ({ label: variant.name, value: variant.id }))]} value={placementVariantId} /><label className="!flex !min-h-11 !items-center !gap-2 !text-xs !font-semibold"><input checked={placementFeatured} disabled={disabled} onChange={(event) => setPlacementFeatured(event.target.checked)} type="checkbox" /> Destacado</label><button aria-label={placementEditId ? 'Guardar aparición' : 'Añadir aparición'} className="crm-action-button !bg-[var(--crm-blue)] !text-white" disabled={disabled || !placementTabId || !placementCategoryId} onClick={() => void savePlacement()} title={placementEditId ? 'Guardar aparición' : 'Añadir aparición'} type="button">{placementEditId ? <Save className="!size-4" /> : <Plus className="!size-4" />}</button></div>
              {productPlacements.map((placement) => (
                <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[minmax(0,1fr)_auto_auto] sm:!items-center" key={placement.id}><span>{catalog.tabs.find((tab) => tab.id === placement.tabId)?.label} / {catalog.categories.find((category) => category.id === placement.categoryId)?.name ?? 'Sin categoría'}{placement.pinnedVariantId ? ` · ${productVariants.find((variant) => variant.id === placement.pinnedVariantId)?.name}` : ''} · {placement.active ? 'Visible' : 'Oculta'}</span><label className="!flex !items-center !gap-2 !text-xs !font-semibold"><input checked={placement.featured} disabled={disabled} onChange={(event) => void mutate(() => catalogAdminService.updatePlacement(catalog.venueId, { ...placement, featured: event.target.checked }))} type="checkbox" /> Destacado</label><div className="crm-action-group"><button aria-label="Editar aparición" className="crm-action-button" disabled={disabled} onClick={() => editPlacement(placement.id)} title="Editar" type="button"><Pencil className="!size-4" /></button><button aria-label={placement.active ? 'Ocultar aparición' : 'Mostrar aparición'} className="crm-action-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.updatePlacement(catalog.venueId, { ...placement, active: !placement.active }))} title={placement.active ? 'Ocultar' : 'Mostrar'} type="button">{placement.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</button><button aria-label="Eliminar aparición" className="crm-action-button crm-danger-button" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deletePlacement(catalog.venueId, placement.id))} title="Eliminar" type="button"><Trash2 className="!size-4" /></button></div></div>
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
