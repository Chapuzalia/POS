import { Boxes, Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { EmptyList } from '../../shared/components/EmptyList'
import { ProductFormPanel } from '../forms/ProductForm'
import { canSellProductStandalone, canUseProductAsMixer, getKindLabel, getProductSaleFormats, getSaleFormatLabel } from '../../../../lib/catalog'
import { deleteProduct, deleteProductImage } from '../services/catalogService'
import { formatMoney } from '../../../../lib/format'
import { type Category, type Product, type SaleFormatDefinition, type TenantContext } from '../../../../types'
import { type RunAction } from '../../shared/types'
import { useEffect, useMemo, useState } from 'react'

export type ProductsCrmProps = {
  defaultTaxRate: number
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  selectedVenueId: string
  tenantContext: TenantContext
}

export type ProductEditorState =
  | {
      mode: 'create'
    }
  | {
      mode: 'edit'
      productId: string
    }

export function ProductsCrm({
  defaultTaxRate,
  categories,
  disabled,
  onCatalogChanged,
  products,
  runAction,
  saleFormats,
  selectedVenueId,
  tenantContext,
}: ProductsCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [editor, setEditor] = useState<ProductEditorState | null>(null)
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const filteredProducts = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return products
    }

    return products.filter((product) => {
      const categoryName = categoryById.get(product.categoryId)?.name ?? ''
      const variantNames = product.variants.map((variant) => variant.name).join(' ')
      const saleFormatNames = getProductSaleFormats(product).map((format) => getSaleFormatLabel(format, saleFormats)).join(' ')
      return [product.name, product.description ?? '', categoryName, getKindLabel(product.kind), saleFormatNames, variantNames]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [categoryById, products, query, saleFormats])
  const totalPages = Math.max(1, Math.ceil(filteredProducts.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedProducts = filteredProducts.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const selectedProduct = editor?.mode === 'edit' ? products.find((product) => product.id === editor.productId) : null

  useEffect(() => {
    setCurrentPage(1)
  }, [selectedVenueId])

  async function handleDeleteProduct(product: Product) {
    if (!window.confirm(`Eliminar el producto "${product.name}" de este local de forma permanente?`)) {
      return
    }

    await runAction(async () => {
      await deleteProduct(tenantContext, product.id)
      await deleteProductImage(tenantContext, product.imagePath).catch(() => undefined)
      if (editor?.mode === 'edit' && editor.productId === product.id) {
        setEditor(null)
      }
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Productos</h2>
            <p>{filteredProducts.length} de {products.length} productos</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar producto"
                value={query}
              />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled || !categories.length || !selectedVenueId}
              onClick={() => setEditor({ mode: 'create' })}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Anadir producto
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-products-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Producto</span>
            <span>Formatos</span>
            <span>Categoria / Tipo</span>
            <span>Precio final</span>
            <span>Uso</span>
            <span>Acciones</span>
          </div>
          {paginatedProducts.map((product) => (
            <ProductListRow
              category={categoryById.get(product.categoryId)}
              disabled={disabled}
              key={product.id}
              onDelete={() => void handleDeleteProduct(product)}
              onEdit={() => setEditor({ mode: 'edit', productId: product.id })}
              product={product}
              saleFormats={saleFormats}
            />
          ))}
          {!filteredProducts.length ? <EmptyList message="No hay productos que coincidan con la busqueda." /> : null}
        </div>
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredProducts.length}
        />
      </section>

      {editor && (editor.mode === 'create' || selectedProduct) ? (
        <ProductFormPanel
          categories={categories}
          defaultTaxRate={defaultTaxRate}
          disabled={disabled}
          key={editor.mode === 'edit' ? editor.productId : 'create'}
          mode={editor.mode}
          onCatalogChanged={onCatalogChanged}
          onClose={() => setEditor(null)}
          product={selectedProduct ?? undefined}
          runAction={runAction}
          saleFormats={saleFormats}
          selectedVenueId={selectedVenueId}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

export type ProductListRowProps = {
  category: Category | undefined
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  product: Product
  saleFormats: SaleFormatDefinition[]
}

export function ProductListRow({
  category,
  disabled,
  onDelete,
  onEdit,
  product,
  saleFormats,
}: ProductListRowProps) {
  const primaryVariant = product.variants.find((variant) => variant.isDefault) ?? product.variants[0]
  const usageLabel = canUseProductAsMixer(product)
    ? product.mixerSupplementCents
      ? `Mixer +${formatMoney(product.mixerSupplementCents)}`
      : 'Mixer'
    : canSellProductStandalone(product)
      ? 'Venta directa'
      : 'Interno'

  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <div className="crm-product-cell">
        {product.imageUrl ? (
          <img alt="" className="crm-product-thumb" src={product.imageUrl} />
        ) : (
          <div className="crm-product-thumb crm-product-thumb-empty">
            <Boxes className="h-4 w-4" />
          </div>
        )}
        <div className="crm-cell-main">
          <strong>{product.name}</strong>
          <span>
            {product.description || 'Sin descripcion'} · {product.isActive ? 'Activo' : 'Oculto'} ·{' '}
            {product.isFeatured ? 'Destacado' : 'Normal'}
          </span>
        </div>
      </div>
      <div className="crm-format-list">
        {getProductSaleFormats(product).map((format) => (
          <span key={format}>{getSaleFormatLabel(format, saleFormats)}</span>
        ))}
      </div>
      <span>{category?.name ?? 'Sin categoria'} · {getKindLabel(product.kind)}</span>
      <strong>{formatMoney(primaryVariant?.priceCents ?? 0)}</strong>
      <span className={product.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {usageLabel}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onDelete} type="button">
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}
