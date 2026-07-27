import { TextArea as UiTextArea } from '../../../../components/ui/TextArea'
import { Input as UiInput } from '../../../../components/ui/Input'
import { Checkbox as UiCheckbox } from '../../../../components/ui/Checkbox'
import { Button as UiButton } from '../../../../components/ui/Button'
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
        <UiButton aria-label="Cerrar" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" onClick={closeSafely} type="button"><X className="!size-5" /></UiButton>
      </header>
      <div className="!grid !gap-5 !overflow-y-auto !p-5">
        <form className="!grid !gap-4" onSubmit={(event) => void submitGeneral(event)}>
          <h3 className="!font-bold">Información general</h3>
          <div className="!grid !gap-3 sm:!grid-cols-2">
            <Field label="Nombre"><UiInput className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" onChange={(event) => { setName(event.target.value); markDirty() }} value={name} /></Field>
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
                {vatMode === 'custom' ? <UiInput aria-label="IVA personalizado (%)" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" inputMode="decimal" onChange={(event) => { setVatRate(event.target.value); markDirty() }} value={vatRate} /> : null}
              </div>
            </Field>
          </div>
          <Field label="Descripción"><UiTextArea className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !min-h-20" onChange={(event) => { setDescription(event.target.value); markDirty() }} value={description} /></Field>
          <div className="!grid !gap-3 sm:!grid-cols-[110px_1fr] sm:!items-center">
            <div className="grid size-[42px] shrink-0 place-items-center overflow-hidden rounded-xl border-0 bg-[var(--crm-surface-soft)] object-cover text-[var(--crm-text-muted)] !size-24 !overflow-hidden">{previewUrl ? <img alt="Previsualización" className="!size-full !object-cover" src={previewUrl} /> : <ImagePlus className="!size-5" />}</div>
            <div className="!grid !gap-2">
              <label className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !w-fit !cursor-pointer !items-center !gap-2"><ImagePlus className="!size-4" /> Seleccionar imagen<UiInput accept="image/jpeg,image/png,image/webp,image/avif" className="!sr-only" disabled={disabled} onChange={(event) => { setImageFile(event.target.files?.[0] ?? null); markDirty() }} type="file" /></label>
              <small className="!text-[var(--crm-text-muted)]">JPEG, PNG, WebP o AVIF, máximo 10 MB. Se optimiza a WebP.</small>
              {product?.image ? <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95 !w-fit" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deleteProductImage(catalog.venueId, product.id))} type="button">Eliminar imagen actual</UiButton> : null}
            </div>
          </div>

          {!product ? (
            <>
              <UiCheckbox checked={advanced} className="!text-sm !font-semibold" onChange={(checked) => { setAdvanced(checked); markDirty() }}>Configuración avanzada de variantes</UiCheckbox>
              {!activeFormats.length ? <p className="!rounded-xl !bg-[var(--crm-yellow-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-yellow)]">Crea al menos un formato en Productos → Formatos antes de crear el producto.</p> : null}
              <div className="!grid !gap-2">
                {(advanced ? variantDrafts : variantDrafts.slice(0, 1)).map((variant) => (
                  <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto_auto] sm:!items-center" key={variant.id}>
                    <CrmSelect ariaLabel="Formato de venta" onChange={(formatId) => updateDraft(variant.id, { formatId })} options={activeFormats.map((format) => ({ label: format.name, value: format.id, disabled: variantDrafts.some((draft) => draft.id !== variant.id && draft.formatId === format.id) }))} placeholder="Selecciona un formato" value={variant.formatId} />
                    <UiInput aria-label="Precio de variante" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" inputMode="decimal" onChange={(event) => updateDraft(variant.id, { price: event.target.value })} value={variant.price} />
                    <UiCheckbox checked={variant.active} className="!text-xs" onChange={(checked) => updateDraft(variant.id, { active: checked })}>Activa</UiCheckbox>
                    <UiCheckbox checked={variant.isDefault} className="!text-xs" onChange={() => updateDraft(variant.id, { isDefault: true })}>Predeterminada</UiCheckbox>
                  </div>
                ))}
                {advanced ? <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !w-fit" disabled={variantDrafts.length >= activeFormats.length} onClick={() => { const used = new Set(variantDrafts.map((variant) => variant.formatId)); const formatId = activeFormats.find((format) => !used.has(format.id))?.id ?? ''; setVariantDrafts((current) => [...current, { id: catalogAdminService.uuid(), formatId, price: '0,00', active: true, isDefault: false }]); markDirty() }} type="button"><Plus className="!size-4" /> Añadir variante</UiButton> : null}
              </div>
              <UiCheckbox checked={internal} className="!text-sm !font-semibold" onChange={(checked) => { setInternal(checked); markDirty() }}>Producto interno, sin aparición inicial en TPV</UiCheckbox>
              {!internal ? <div className="!grid !gap-3 sm:!grid-cols-[1fr_1fr_auto] sm:!items-end"><Field label="Pestaña inicial"><CrmSelect onChange={(value) => { setTabId(value); markDirty() }} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={tabId} /></Field><Field label="Categoría inicial"><CrmSelect onChange={(value) => { setCategoryId(value); markDirty() }} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={categoryId} /></Field><UiCheckbox checked={initialPlacementFeatured} className="!min-h-11 !text-xs !font-semibold" onChange={(checked) => { setInitialPlacementFeatured(checked); markDirty() }}>Destacado</UiCheckbox></div> : null}
            </>
          ) : null}
          {formError ? <p className="!rounded-lg !bg-red-500/10 !p-3 !text-sm !font-semibold !text-red-500" role="alert">{formError}</p> : null}
          <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold leading-none text-white shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-blue-hover)] hover:shadow-[0_8px_20px_rgba(20,120,237,0.22)] !inline-flex !w-fit !items-center !gap-2" disabled={disabled || (!product && !activeFormats.length)} type="submit"><Save className="!size-4" /> {product ? 'Guardar información' : 'Crear producto'}</UiButton>
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
                      <UiInput aria-label="Precio de variante" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" inputMode="decimal" onChange={(event) => setEditingVariantPrice(event.target.value)} value={editingVariantPrice} />
                      <UiButton aria-label="Guardar variante" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !bg-[var(--crm-blue)] !text-white" disabled={disabled || !editingVariantFormatId} onClick={() => void saveVariantEdit()} title="Guardar variante" type="button"><Save className="!size-4" /></UiButton>
                    </div>
                  ) : <div><strong>{formatById.get(variant.formatId ?? '')?.name ?? variant.name}</strong> · {formatMoney(variant.priceCents)} · {variant.active ? 'Activa' : 'Inactiva'}{variant.isDefault ? ' · Predeterminada' : ''}</div>}
                  <div className="flex min-w-0 items-center justify-end gap-[7px]">
                    <UiButton aria-label={editingVariantId === variant.id ? 'Cancelar edición de variante' : 'Editar variante'} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => editingVariantId === variant.id ? setEditingVariantId('') : beginVariantEdit(variant.id)} title={editingVariantId === variant.id ? 'Cancelar' : 'Editar'} type="button">{editingVariantId === variant.id ? <X className="!size-4" /> : <Pencil className="!size-4" />}</UiButton>
                    <UiButton aria-label={variant.active ? 'Desactivar variante' : 'Activar variante'} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || variant.isDefault || !variant.formatId} onClick={() => void mutate(() => catalogAdminService.updateVariant(catalog.venueId, { id: variant.id, productId: product.id, formatId: variant.formatId, name: variant.name, priceCents: variant.priceCents, active: !variant.active, isDefault: variant.isDefault, sortOrder: variant.sortOrder }))} title={variant.active ? 'Desactivar' : 'Activar'} type="button">{variant.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</UiButton>
                    {!variant.isDefault ? <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || !variant.active} onClick={() => void mutate(() => catalogAdminService.setDefaultVariant(catalog.venueId, product.id, variant.id))} type="button">Predeterminada</UiButton> : null}
                    <UiButton aria-label="Eliminar variante" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled || variant.isDefault} onClick={() => void mutate(() => catalogAdminService.deleteVariant(catalog.venueId, product.id, variant.id))} type="button"><Trash2 className="!size-4" /></UiButton>
                  </div>
                </div>
              ))}
              {!activeFormats.length ? <p className="!rounded-xl !bg-[var(--crm-yellow-soft)] !p-3 !text-sm !font-semibold !text-[var(--crm-yellow)]">No hay formatos activos. Créalo en Productos → Formatos.</p> : null}
              <div className="!grid !gap-2 sm:!grid-cols-[1fr_140px_auto]"><CrmSelect ariaLabel="Nuevo formato de venta" onChange={setNewVariantFormatId} options={activeFormats.map((format) => ({ label: format.name, value: format.id, disabled: productVariants.some((variant) => variant.formatId === format.id) }))} placeholder="Selecciona un formato" value={newVariantFormatId} /><UiInput aria-label="Precio de la nueva variante" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" inputMode="decimal" onChange={(event) => setNewVariantPrice(event.target.value)} value={newVariantPrice} /><UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled || !newVariantFormatId} onClick={() => void addVariant()} type="button"><Plus className="!size-4" /> Añadir</UiButton></div>
            </section>

            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Apariciones en TPV</h3><p className="!text-sm !text-[var(--crm-text-muted)]">El producto puede mostrarse varias veces y fijar una variante distinta en cada ubicación.</p></div>
              <div className="!grid !gap-2 sm:!grid-cols-[1fr_1fr_1fr_auto_auto] sm:!items-center"><CrmSelect onChange={setPlacementTabId} options={catalog.tabs.filter((tab) => tab.active).map((tab) => ({ label: tab.label, value: tab.id }))} value={placementTabId} /><CrmSelect onChange={setPlacementCategoryId} options={catalog.categories.filter((category) => category.active).map((category) => ({ label: category.name, value: category.id }))} value={placementCategoryId} /><CrmSelect onChange={setPlacementVariantId} options={[{ label: 'Variante predeterminada', value: '' }, ...productVariants.filter((variant) => variant.active).map((variant) => ({ label: variant.name, value: variant.id }))]} value={placementVariantId} /><UiCheckbox checked={placementFeatured} className="!min-h-11 !text-xs !font-semibold" disabled={disabled} onChange={setPlacementFeatured}>Destacado</UiCheckbox><UiButton aria-label={placementEditId ? 'Guardar aparición' : 'Añadir aparición'} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !bg-[var(--crm-blue)] !text-white" disabled={disabled || !placementTabId || !placementCategoryId} onClick={() => void savePlacement()} title={placementEditId ? 'Guardar aparición' : 'Añadir aparición'} type="button">{placementEditId ? <Save className="!size-4" /> : <Plus className="!size-4" />}</UiButton></div>
              {productPlacements.map((placement) => (
                <div className="!grid !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3 sm:!grid-cols-[minmax(0,1fr)_auto_auto] sm:!items-center" key={placement.id}><span>{catalog.tabs.find((tab) => tab.id === placement.tabId)?.label} / {catalog.categories.find((category) => category.id === placement.categoryId)?.name ?? 'Sin categoría'}{placement.pinnedVariantId ? ` · ${productVariants.find((variant) => variant.id === placement.pinnedVariantId)?.name}` : ''} · {placement.active ? 'Visible' : 'Oculta'}</span><UiCheckbox checked={placement.featured} className="!text-xs !font-semibold" disabled={disabled} onChange={(checked) => void mutate(() => catalogAdminService.updatePlacement(catalog.venueId, { ...placement, featured: checked }))}>Destacado</UiCheckbox><div className="flex min-w-0 items-center justify-end gap-[7px]"><UiButton aria-label="Editar aparición" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => editPlacement(placement.id)} title="Editar" type="button"><Pencil className="!size-4" /></UiButton><UiButton aria-label={placement.active ? 'Ocultar aparición' : 'Mostrar aparición'} className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)]" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.updatePlacement(catalog.venueId, { ...placement, active: !placement.active }))} title={placement.active ? 'Ocultar' : 'Mostrar'} type="button">{placement.active ? <EyeOff className="!size-4" /> : <Eye className="!size-4" />}</UiButton><UiButton aria-label="Eliminar aparición" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deletePlacement(catalog.venueId, placement.id))} title="Eliminar" type="button"><Trash2 className="!size-4" /></UiButton></div></div>
              ))}
            </section>

            <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-5">
              <div><h3 className="!font-bold">Grupos asignados</h3><p className="!text-sm !text-[var(--crm-text-muted)]">Aplica el grupo a todo el producto o limita su alcance a una variante concreta.</p></div>
              <div className="!grid !gap-2 sm:!grid-cols-5"><CrmSelect onChange={(value) => { setAssignmentDomain(value as typeof assignmentDomain); setAssignmentGroupId('') }} options={[{ label: 'Grupo de selección', value: 'selection' }, { label: 'Modificadores', value: 'modifier' }]} value={assignmentDomain} /><CrmSelect onChange={setAssignmentGroupId} options={assignmentGroups.filter((group) => group.active).map((group) => ({ label: group.name, value: group.id }))} value={assignmentGroupId} /><UiInput aria-label="Mínimo" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" min={0} onChange={(event) => setAssignmentMin(Number(event.target.value))} type="number" value={assignmentMin} /><UiInput aria-label="Máximo" className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px]" min={1} onChange={(event) => setAssignmentMax(Number(event.target.value))} type="number" value={assignmentMax} /><CrmSelect onChange={setAssignmentVariantId} options={[{ label: 'Todas las variantes', value: '' }, ...productVariants.map((variant) => ({ label: variant.name, value: variant.id }))]} value={assignmentVariantId} /></div>
              <UiButton className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !w-fit" disabled={disabled || !assignmentGroupId} onClick={() => void addAssignment()} type="button"><Plus className="!size-4" /> Asignar grupo</UiButton>
              {productAssignments.map((assignment) => <div className="!flex !items-center !justify-between !gap-3 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3" key={`${assignment.domain}-${assignment.id}`}><span><strong>{assignment.domain === 'selection' ? catalog.selectionGroups.find((group) => group.id === assignment.groupId)?.name : catalog.modifierGroups.find((group) => group.id === assignment.groupId)?.name}</strong> · {assignment.minSelection}–{assignment.maxSelection} · {assignment.appliesToAllVariants ? 'Todas las variantes' : assignment.variantIds.map((id) => productVariants.find((variant) => variant.id === id)?.name).join(', ')}</span><UiButton aria-label="Eliminar asignación" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-xs font-semibold text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-red)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:brightness-95" disabled={disabled} onClick={() => void mutate(() => catalogAdminService.deleteAssignment(catalog.venueId, assignment.domain, assignment.id))} type="button"><Trash2 className="!size-4" /></UiButton></div>)}
            </section>
          </>
        ) : null}
      </div>
    </CrmModal>
  )
}
