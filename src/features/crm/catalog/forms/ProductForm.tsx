import { Boxes, Save, Upload, X } from 'lucide-react'
import { COMMON_TAX_RATES, calculateGrossFromNet, calculateTaxFromGross, resolveEffectiveTaxRate } from '../../../../lib/tax'
import { CrmModal } from '../../shared/components/CrmModal'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { canSellProductStandalone, canUseProductAsMixer, findProductVariantForSaleFormat, getDefaultSaleFormatsForKind, getProductSaleFormats, productKindOptions } from '../../../../lib/catalog'
import { centsToInput, formatMoney, parseMoneyToCents } from '../../../../lib/format'
import { createProductWithVariant, createVariant, deleteProductImage, deleteVariant, updateProduct, updateVariant, uploadProductImage } from '../services/catalogService'
import { getDefaultProductImageFillColor } from '../../../../lib/productImages'
import { getReadableError } from '../../../../utils/errors'
import { sileo } from 'sileo'
import { type CatalogKind, type Category, type Product, type ProductVariant, type SaleFormat, type SaleFormatDefinition, type TenantContext } from '../../../../types'
import { type ChangeEvent, useEffect, useState } from 'react'
import { type RunAction } from '../../shared/types'
import { buildProductVariantInputs, getProductFormGuardError } from './productFormModel'

export type PriceInputMode = 'gross' | 'net'

export type ProductFormPanelProps = {
  categories: Category[]
  defaultTaxRate: number
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  product?: Product
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
}

function assignProductVariantsToSaleFormats(product: Product, formats: SaleFormat[]) {
  const assignedVariants = new Map<SaleFormat, ProductVariant>()
  const usedVariantIds = new Set<string>()

  formats.forEach((format) => {
    const matchingVariant = findProductVariantForSaleFormat(product, format)
    if (matchingVariant && !usedVariantIds.has(matchingVariant.id)) {
      assignedVariants.set(format, matchingVariant)
      usedVariantIds.add(matchingVariant.id)
    }
  })

  const remainingVariants = product.variants.filter((variant) => !usedVariantIds.has(variant.id))
  formats.forEach((format) => {
    if (assignedVariants.has(format)) return
    const fallbackVariant = remainingVariants.shift()
    if (fallbackVariant) {
      assignedVariants.set(format, fallbackVariant)
      usedVariantIds.add(fallbackVariant.id)
    }
  })

  return assignedVariants
}

export function ProductFormPanel({
  categories,
  defaultTaxRate,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  product,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
}: ProductFormPanelProps) {
  const firstCategory = categories[0]
  const isEditing = mode === 'edit'
  const primaryVariant = product?.variants.find((variant) => variant.isDefault) ?? product?.variants[0]
  const initialKind = product?.kind ?? firstCategory?.kind ?? 'other'
  const initialMixerSupplementCents = product?.mixerSupplementCents ?? 0
  const initialSaleFormats = product ? getProductSaleFormats(product) : getDefaultSaleFormatsForKind(initialKind)
  const initialVariantByFormat = product
    ? assignProductVariantsToSaleFormats(product, initialSaleFormats)
    : new Map<SaleFormat, ProductVariant>()
  const initialProductTaxRate = product?.taxRate ?? null
  const initialEffectiveTaxRate = resolveEffectiveTaxRate(initialProductTaxRate, defaultTaxRate)
  const initialGrossPrices = Object.fromEntries(
    saleFormats.map((format) => [
      format.key,
      centsToInput(initialVariantByFormat.get(format.key)?.priceCents ?? primaryVariant?.priceCents ?? 0),
    ]),
  ) as Record<SaleFormat, string>
  const [name, setName] = useState(product?.name ?? '')
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? firstCategory?.id ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [kind, setKind] = useState<CatalogKind>(initialKind)
  const [selectedSaleFormats, setSelectedSaleFormats] = useState<SaleFormat[]>(initialSaleFormats)
  const [taxRateInput, setTaxRateInput] = useState(initialProductTaxRate === null ? 'inherit' : String(initialProductTaxRate))
  const [priceInputMode, setPriceInputMode] = useState<PriceInputMode>('gross')
  const [saleFormatPrices, setSaleFormatPrices] = useState<Record<SaleFormat, string>>(initialGrossPrices)
  const [saleFormatNetPrices, setSaleFormatNetPrices] = useState<Record<SaleFormat, string>>(() => Object.fromEntries(
    saleFormats.map((format) => {
      const grossCents = parseMoneyToCents(initialGrossPrices[format.key] ?? '')
      return [format.key, centsToInput(calculateTaxFromGross(grossCents, initialEffectiveTaxRate).taxableBaseCents)]
    }),
  ))
  const [isFeatured, setIsFeatured] = useState(product?.isFeatured ?? false)
  const [canSellStandalone, setCanSellStandalone] = useState(product ? canSellProductStandalone(product) : true)
  const [canUseAsMixer, setCanUseAsMixer] = useState(product ? canUseProductAsMixer(product) : initialKind === 'mixer')
  const [hasMixerSupplement, setHasMixerSupplement] = useState(initialMixerSupplementCents > 0)
  const [mixerSupplement, setMixerSupplement] = useState(centsToInput(initialMixerSupplementCents || 100))
  const [imageFile, setImageFile] = useState<File | null>(null)
  const [imagePreviewUrl, setImagePreviewUrl] = useState(product?.imageUrl ?? '')
  const [imageObjectUrl, setImageObjectUrl] = useState<string | null>(null)
  const [imageFillColor, setImageFillColor] = useState(getDefaultProductImageFillColor)
  const [imageError, setImageError] = useState<string | null>(null)
  const [shouldRemoveImage, setShouldRemoveImage] = useState(false)
  const selectedCategory = categories.find((category) => category.id === categoryId)
  const selectedTaxRate = taxRateInput === 'inherit' ? null : Number(taxRateInput)
  const effectiveTaxRate = resolveEffectiveTaxRate(selectedTaxRate, defaultTaxRate)

  useEffect(() => {
    if (!categoryId && firstCategory) {
      setCategoryId(firstCategory.id)
    }
  }, [categoryId, firstCategory])

  useEffect(() => {
    return () => {
      if (imageObjectUrl) {
        URL.revokeObjectURL(imageObjectUrl)
      }
    }
  }, [imageObjectUrl])

  function handleCategoryChange(nextCategoryId: string) {
    const nextCategory = categories.find((category) => category.id === nextCategoryId)
    setCategoryId(nextCategoryId)

    if (!isEditing && nextCategory) {
      setKind(nextCategory.kind)
      setSelectedSaleFormats(getDefaultSaleFormatsForKind(nextCategory.kind))
      setCanSellStandalone(true)
      setCanUseAsMixer(nextCategory.kind === 'mixer')
      setHasMixerSupplement(false)
    }
  }

  function toggleSaleFormat(format: SaleFormat) {
    setSelectedSaleFormats((current) =>
      current.includes(format) ? current.filter((currentFormat) => currentFormat !== format) : [...current, format],
    )
  }

  function handleTaxRateChange(nextTaxRateInput: string) {
    const nextProductTaxRate = nextTaxRateInput === 'inherit' ? null : Number(nextTaxRateInput)
    const nextEffectiveTaxRate = resolveEffectiveTaxRate(nextProductTaxRate, defaultTaxRate)
    setTaxRateInput(nextTaxRateInput)

    if (priceInputMode === 'gross') {
      setSaleFormatNetPrices(Object.fromEntries(saleFormats.map((format) => {
        const grossCents = parseMoneyToCents(saleFormatPrices[format.key] ?? '')
        return [format.key, centsToInput(calculateTaxFromGross(grossCents, nextEffectiveTaxRate).taxableBaseCents)]
      })))
      return
    }

    setSaleFormatPrices(Object.fromEntries(saleFormats.map((format) => {
      const netCents = parseMoneyToCents(saleFormatNetPrices[format.key] ?? '')
      return [format.key, centsToInput(calculateGrossFromNet(netCents, nextEffectiveTaxRate).grossTotalCents)]
    })))
  }

  function updateSaleFormatPrice(format: SaleFormat, nextPrice: string) {
    if (priceInputMode === 'gross') {
      setSaleFormatPrices((current) => ({ ...current, [format]: nextPrice }))
      setSaleFormatNetPrices((current) => ({
        ...current,
        [format]: centsToInput(calculateTaxFromGross(parseMoneyToCents(nextPrice), effectiveTaxRate).taxableBaseCents),
      }))
      return
    }

    setSaleFormatNetPrices((current) => ({ ...current, [format]: nextPrice }))
    setSaleFormatPrices((current) => ({
      ...current,
      [format]: centsToInput(calculateGrossFromNet(parseMoneyToCents(nextPrice), effectiveTaxRate).grossTotalCents),
    }))
  }

  function getSaleFormatTaxBreakdown(format: SaleFormat) {
    return calculateTaxFromGross(parseMoneyToCents(saleFormatPrices[format] ?? ''), effectiveTaxRate)
  }

  function handleCanUseAsMixerChange(nextCanUseAsMixer: boolean) {
    setCanUseAsMixer(nextCanUseAsMixer)

    if (!nextCanUseAsMixer) {
      setHasMixerSupplement(false)
    }
  }

  function handleImageChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setImageError(null)

    if (!file) {
      return
    }

    if (!file.type.startsWith('image/')) {
      setImageError('Selecciona un archivo de imagen valido.')
      return
    }

    const nextObjectUrl = URL.createObjectURL(file)
    setImageFile(file)
    setImageObjectUrl(nextObjectUrl)
    setImagePreviewUrl(nextObjectUrl)
    setShouldRemoveImage(false)
  }

  function removeSelectedImage() {
    setImageFile(null)
    setImageObjectUrl(null)
    setImagePreviewUrl('')
    setImageError(null)
    setShouldRemoveImage(Boolean(product?.imagePath))
  }

  async function saveProduct() {
    const activePriceInputs = priceInputMode === 'gross' ? saleFormatPrices : saleFormatNetPrices
    const guardError = getProductFormGuardError({
      categoryId: selectedCategory?.id ?? '',
      name,
      priceInputs: activePriceInputs,
      selectedSaleFormats,
      venueId: selectedVenueId,
    })
    if (guardError === 'missing-product-data') {
      sileo.error({
        description: 'Revisa el nombre, la categoria y el local antes de guardar.',
        title: 'No se ha podido guardar el producto',
      })
      return
    }
    if (guardError === 'missing-sale-format-prices') {
      sileo.error({
        description: 'Selecciona al menos un formato e introduce su precio.',
        title: 'Faltan precios de venta',
      })
      return
    }
    if (!selectedCategory) return

    const formatVariants = buildProductVariantInputs(selectedSaleFormats, saleFormatPrices, saleFormats)
    const mixerSupplementCents =
      canUseAsMixer && hasMixerSupplement ? parseMoneyToCents(mixerSupplement) : 0

    await runAction(async () => {
      let uploadedImagePath: string | null = null
      const previousImagePath = product?.imagePath ?? null

      try {
        const nextImagePath = imageFile
          ? await uploadProductImage(tenantContext, imageFile, imageFillColor)
          : shouldRemoveImage
            ? null
            : previousImagePath

        uploadedImagePath = imageFile ? nextImagePath : null

        if (isEditing && product) {
          await updateProduct(tenantContext, product.id, {
            canSellStandalone,
            canUseAsMixer,
            categoryId,
            description: description.trim(),
            imagePath: nextImagePath,
            isFeatured,
            kind,
            mixerSupplementCents,
            name: name.trim(),
            saleFormats: selectedSaleFormats,
            taxRate: selectedTaxRate,
          })

          const assignedVariants = assignProductVariantsToSaleFormats(product, selectedSaleFormats)
          const assignedVariantIds = new Set<string>()
          for (const [index, formatVariant] of formatVariants.entries()) {
            const existingVariant = assignedVariants.get(formatVariant.format)
            if (existingVariant) {
              assignedVariantIds.add(existingVariant.id)
              await updateVariant(tenantContext, existingVariant.id, {
                isDefault: index === 0,
                name: formatVariant.name,
                priceCents: formatVariant.priceCents,
              })
            } else {
              await createVariant(tenantContext, product.id, {
                isDefault: index === 0,
                name: formatVariant.name,
                priceCents: formatVariant.priceCents,
              })
            }
          }

          for (const obsoleteVariant of product.variants.filter((variant) => !assignedVariantIds.has(variant.id))) {
            await deleteVariant(tenantContext, obsoleteVariant.id)
          }
        } else {
          await createProductWithVariant(tenantContext, {
            venueId: selectedVenueId,
            canSellStandalone,
            canUseAsMixer,
            categoryId: selectedCategory.id,
            description: description.trim(),
            imagePath: nextImagePath,
            isFeatured,
            kind,
            mixerSupplementCents,
            name: name.trim(),
            saleFormats: selectedSaleFormats,
            taxRate: selectedTaxRate,
            variants: formatVariants.map(({ name: variantLabel, priceCents }) => ({
              name: variantLabel,
              priceCents,
            })),
          })
        }

        if ((uploadedImagePath || shouldRemoveImage) && previousImagePath && previousImagePath !== nextImagePath) {
          await deleteProductImage(tenantContext, previousImagePath).catch(() => undefined)
        }

        await onCatalogChanged()
        sileo.success({
          description: `${name.trim()} se ha guardado correctamente.`,
          title: isEditing ? 'Producto actualizado' : 'Producto creado',
        })
        onClose()
      } catch (saveError) {
        await deleteProductImage(tenantContext, uploadedImagePath).catch(() => undefined)
        sileo.error({
          description: getReadableError(saveError),
          title: 'No se ha podido guardar el producto',
        })
        throw saveError
      }
    })
  }

  async function toggleProduct() {
    if (!product) {
      return
    }

    await runAction(async () => {
      await updateProduct(tenantContext, product.id, {
        isActive: !product.isActive,
      })
      await onCatalogChanged()
    })
  }

  const editorContent = (
    <>
      <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>{isEditing ? 'Editar producto' : 'Nuevo producto'}</span>
          <small>{isEditing ? product?.name : 'Alta rapida de catalogo'}</small>
        </div>
        <button aria-label="Cerrar editor de producto" className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="!min-h-0 !flex-1 !overflow-y-auto">
      <form
        className="crm-form-stack !grid !min-h-0 !gap-3.5 !px-[22px] !pt-5 !pb-[22px]"
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
      >
        <Field label="Producto">
          <input autoFocus={!isEditing} className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setName(event.target.value)} value={name} />
        </Field>
        <Field label="Categoria">
          <CrmSelect
            onChange={handleCategoryChange}
            options={categories.map((category) => ({ label: category.name, value: category.id }))}
            value={categoryId}
          />
        </Field>
        <Field label="Tipo de producto">
          <CrmSelect
            onChange={(nextKind) => setKind(nextKind as CatalogKind)}
            options={productKindOptions.map((option) => ({ label: option.label, value: option.value }))}
            value={kind}
          />
        </Field>
        <Field label="Descripcion">
          <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setDescription(event.target.value)} value={description} />
        </Field>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Imagen</span>
          <div className="crm-image-field !grid !grid-cols-1 !gap-3 md:!grid-cols-[96px_minmax(0,1fr)]">
            <div className="crm-image-preview" style={{ backgroundColor: imageFillColor }}>
              {imagePreviewUrl ? (
                <img alt="" src={imagePreviewUrl} />
              ) : (
                <Boxes className="h-7 w-7" />
              )}
            </div>
            <div className="crm-image-controls">
              <label
                className={
                  disabled
                    ? 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button crm-file-button-disabled'
                    : 'crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-file-button'
                }
              >
                <Upload className="h-4 w-4" />
                Cargar imagen
                <input accept="image/*" disabled={disabled} onChange={handleImageChange} type="file" />
              </label>
              <label className="crm-color-field">
                <span>Relleno</span>
                <input
                  disabled={disabled || !imageFile}
                  onChange={(event) => setImageFillColor(event.target.value)}
                  type="color"
                  value={imageFillColor}
                />
              </label>
              {imagePreviewUrl ? (
                <button className="crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]" disabled={disabled} onClick={removeSelectedImage} type="button">
                  <X className="h-4 w-4" />
                  Quitar
                </button>
              ) : null}
            </div>
          </div>
          {imageError ? <div className="crm-field-error">{imageError}</div> : null}
        </div>
        <div>
          <Field label="IVA aplicado">
            <CrmSelect
              onChange={handleTaxRateChange}
              options={[
                { label: 'Usar IVA por defecto del local', value: 'inherit' },
                ...COMMON_TAX_RATES.map((rate) => ({ label: rate + ' %', value: String(rate) })),
              ]}
              value={taxRateInput}
            />
          </Field>
          {selectedTaxRate === null ? (
            <p className="crm-form-help">Se aplicara el IVA por defecto del local: {defaultTaxRate} %.</p>
          ) : null}
        </div>
        <div>
          <div className="!mb-1.5 !flex !items-center !justify-between !gap-3">
            <span className="crm-field-label !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">
              {priceInputMode === 'gross' ? 'Formatos y precio final' : 'Formatos y base imponible'}
            </span>
            <button
              className="!border-0 !bg-transparent !p-0 !text-xs !font-semibold !text-[var(--crm-blue)]"
              onClick={() => setPriceInputMode((current) => current === 'gross' ? 'net' : 'gross')}
              type="button"
            >
              {priceInputMode === 'gross' ? 'Editar base imponible' : 'Volver a precio final'}
            </button>
          </div>
          {priceInputMode === 'net' ? (
            <p className="crm-form-help !mb-2">Estas editando la base; el precio final se recalcula con el IVA efectivo.</p>
          ) : null}
          <div className="!grid !gap-2">
            {saleFormats.map((option) => {
              const isSelected = selectedSaleFormats.includes(option.key)
              const breakdown = getSaleFormatTaxBreakdown(option.key)
              return (
                <div className="!grid !min-h-[58px] !grid-cols-[minmax(0,1fr)_120px] !items-center !gap-x-3 !gap-y-1 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-3.5 !py-2" key={option.key}>
                  <label className="!flex !min-w-0 !cursor-pointer !items-center !gap-2.5 !text-[13px] !font-semibold !text-[var(--crm-text)]">
                    <input
                      checked={isSelected}
                      className="!size-4 !shrink-0 !accent-[var(--crm-blue)]"
                      onChange={() => toggleSaleFormat(option.key)}
                      type="checkbox"
                    />
                    <span className="!truncate">{option.label}</span>
                  </label>
                  {isSelected ? (
                    <label className="!relative !block">
                      <span className="sr-only">{priceInputMode === 'gross' ? 'Precio final' : 'Base imponible'} de {option.label}</span>
                      <input
                        className="crm-input !h-10 !w-full !rounded-[9px] !border !border-transparent !bg-[var(--crm-input-bg)] !pr-10 !pl-3 !text-right !font-mono !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
                        inputMode="decimal"
                        onChange={(event) => updateSaleFormatPrice(option.key, event.target.value)}
                        placeholder="0,00"
                        value={(priceInputMode === 'gross' ? saleFormatPrices : saleFormatNetPrices)[option.key] ?? ''}
                      />
                      <span className="!pointer-events-none !absolute !top-1/2 !right-3 !-translate-y-1/2 !text-[10px] !font-semibold !text-[var(--crm-text-muted)]">EUR</span>
                    </label>
                  ) : (
                    <span className="!pr-3 !text-right !text-xs !font-medium !text-[var(--crm-text-muted)]">Sin precio</span>
                  )}
                  {isSelected ? (
                    <small className="!col-span-2 !text-[11px] !font-medium !text-[var(--crm-text-muted)]">
                      {priceInputMode === 'net' ? `Precio final: ${formatMoney(breakdown.grossTotalCents)} · ` : ''}
                      Base imponible: {formatMoney(breakdown.taxableBaseCents)} · IVA {effectiveTaxRate} %: {formatMoney(breakdown.taxAmountCents)}
                    </small>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Catalogo</span>
          <div className="crm-checkbox-list">
            <label>
              <input
                checked={isFeatured}
                onChange={(event) => setIsFeatured(event.target.checked)}
                type="checkbox"
              />
              <span>Producto Destacado</span>
            </label>
          </div>
        </div>
        <div>
          <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Usos</span>
          <div className="crm-checkbox-list">
            <label>
              <input
                checked={canSellStandalone}
                onChange={(event) => setCanSellStandalone(event.target.checked)}
                type="checkbox"
              />
              <span>Venta directa</span>
            </label>
            <label>
              <input
                checked={canUseAsMixer}
                onChange={(event) => handleCanUseAsMixerChange(event.target.checked)}
                type="checkbox"
              />
              <span>Mixer para cubatas</span>
            </label>
          </div>
        </div>
        {canUseAsMixer ? (
          <div>
            <span className="crm-field-label !mb-1.5 !block !text-xs !font-medium !text-[var(--crm-text-secondary)]">Suplemento en cubatas</span>
            <div className="crm-checkbox-list">
              <label>
                <input
                  checked={hasMixerSupplement}
                  onChange={(event) => setHasMixerSupplement(event.target.checked)}
                  type="checkbox"
                />
                <span>Aplicar suplemento</span>
              </label>
            </div>
          </div>
        ) : null}
        {canUseAsMixer && hasMixerSupplement ? (
          <Field label="Importe suplemento">
            <input
              className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 !font-mono"
              inputMode="decimal"
              onChange={(event) => setMixerSupplement(event.target.value)}
              value={mixerSupplement}
            />
          </Field>
        ) : null}
        <div className="crm-editor-actions">
          <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled || !categories.length} type="submit">
            <Save className="h-4 w-4" />
            Guardar
          </button>
          {isEditing && product ? (
            <button
              className={product.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
              disabled={disabled}
              onClick={toggleProduct}
              type="button"
            >
              {product.isActive ? 'Marcar oculto' : 'Activar'}
            </button>
          ) : null}
        </div>
      </form>
      </div>
    </>
  )

  return (
    <CrmModal label={isEditing ? 'Editar producto' : 'Anadir producto'} onClose={onClose} size="large">
      {editorContent}
    </CrmModal>
  )
}
