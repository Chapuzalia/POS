import {
  BarChart3,
  Boxes,
  ChevronRight,
  LayoutDashboard,
  LogOut,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Search,
  Store,
  Tags,
  Trash2,
  Upload,
  UserRound,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type CSSProperties, type ReactNode } from 'react'
import {
  canSellProductStandalone,
  canUseProductAsMixer,
  categoryKindOptions,
  getDefaultSaleFormatsForKind,
  getKindLabel,
  getProductSaleFormats,
  getSaleFormatLabel,
  productKindOptions,
  saleFormatOptions,
} from '../../lib/catalog'
import { centsToInput, formatMoney, parseMoneyToCents } from '../../lib/format'
import { parseRevoItemsCsv, type RevoImportParseResult } from '../../lib/revoImport'
import {
  createCategory,
  createProductWithVariant,
  createVariant,
  deleteCategory,
  deleteProduct,
  deleteVariant,
  importRevoCatalogProducts,
  loadCrmStats,
  updateCategory,
  updateProduct,
  updateVariant,
  type CatalogImportResult,
} from '../../services/crmService'
import type {
  Catalog,
  CatalogKind,
  Category,
  CrmStats,
  Product,
  ProductVariant,
  SaleFormat,
  TenantContext,
} from '../../types'
import { getReadableError } from '../../utils/errors'

type CrmSection = 'dashboard' | 'products' | 'categories' | 'import' | 'stats'

type CrmPageProps = {
  catalog: Catalog | null
  context: TenantContext
  error: string | null
  isOnline: boolean
  onBackToPos: () => void
  onCatalogChanged: () => Promise<void>
  onError: (error: string | null) => void
  onLogout: () => void
}

const navItems: Array<{ id: CrmSection; label: string; icon: LucideIcon }> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'products', label: 'Productos', icon: Boxes },
  { id: 'categories', label: 'Categorias', icon: Tags },
  { id: 'import', label: 'Importacion', icon: Upload },
  { id: 'stats', label: 'Estadisticas', icon: BarChart3 },
]

export function CrmPage({
  catalog,
  context,
  error,
  isOnline,
  onBackToPos,
  onCatalogChanged,
  onError,
  onLogout,
}: CrmPageProps) {
  const [activeSection, setActiveSection] = useState<CrmSection>('dashboard')
  const [isBusy, setIsBusy] = useState(false)
  const [stats, setStats] = useState<CrmStats | null>(null)
  const categories = catalog?.categories ?? []
  const products = catalog?.products ?? []
  const activeProducts = products.filter((product) => product.isActive)
  const activeCategories = categories.filter((category) => category.isActive)

  const runAction = useCallback(async (action: () => Promise<void>) => {
    setIsBusy(true)
    onError(null)
    try {
      await action()
    } catch (actionError) {
      onError(getReadableError(actionError))
    } finally {
      setIsBusy(false)
    }
  }, [onError])

  const refreshStats = useCallback(async () => {
    await runAction(async () => {
      setStats(await loadCrmStats(context))
    })
  }, [context, runAction])

  useEffect(() => {
    if ((activeSection === 'dashboard' || activeSection === 'stats') && isOnline) {
      void refreshStats()
    }
  }, [activeSection, isOnline, refreshStats])

  return (
    <div className="crm-shell">
      <aside className="crm-sidebar">
        <div className="crm-brand">
          <div className="crm-brand-mark">
            <Store className="h-7 w-7" />
          </div>
          <div>
            <p className="crm-brand-title">CLUB POS</p>
            <p className="crm-brand-subtitle">Backoffice</p>
          </div>
        </div>

        <nav className="crm-nav">
          {navItems.map((item) => {
            const Icon = item.icon
            return (
              <button
                className={activeSection === item.id ? 'crm-nav-item crm-nav-item-active' : 'crm-nav-item'}
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                type="button"
              >
                <Icon className="h-4 w-4" />
                <span>{item.label}</span>
              </button>
            )
          })}
        </nav>

        <div className="crm-sidebar-footer">
          <button className="crm-nav-item" onClick={onBackToPos} type="button">
            <Store className="h-4 w-4" />
            <span>Volver al TPV</span>
          </button>
          <button className="crm-nav-item" onClick={onLogout} type="button">
            <LogOut className="h-4 w-4" />
            <span>Cerrar sesion</span>
          </button>
        </div>
      </aside>

      <section className="crm-workspace">
        <header className="crm-topbar">
          <div>
            <div className="crm-breadcrumb">
              <LayoutDashboard className="h-4 w-4" />
              <span>{navItems.find((item) => item.id === activeSection)?.label}</span>
              <ChevronRight className="h-4 w-4" />
              <span>{context.tenantName}</span>
            </div>
            <h1>{getSectionTitle(activeSection)}</h1>
          </div>

          <div className="crm-topbar-actions">
            <div className="crm-date-chip">{new Intl.DateTimeFormat('es-ES').format(new Date())}</div>
            <div className={isOnline ? 'crm-status crm-status-online' : 'crm-status crm-status-offline'}>
              {isOnline ? 'Online' : 'Offline'}
            </div>
            <div className="crm-user-chip">
              <UserRound className="h-4 w-4" />
              <span>{context.userName}</span>
            </div>
          </div>
        </header>

        {error ? <div className="crm-error">{error}</div> : null}
        {!isOnline ? <div className="crm-warning">El CRM requiere conexion para guardar cambios en Supabase.</div> : null}

        <main className="crm-content">
          {activeSection === 'dashboard' ? (
            <DashboardCrm
              activeCategories={activeCategories.length}
              activeProducts={activeProducts.length}
              categories={categories}
              disabled={!isOnline || isBusy}
              onRefresh={refreshStats}
              products={products}
              stats={stats}
            />
          ) : null}

          {activeSection === 'products' ? (
            <ProductsCrm
              categories={categories}
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={products}
              runAction={runAction}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'categories' ? (
            <CategoriesCrm
              categories={categories}
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              products={products}
              runAction={runAction}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'import' ? (
            <RevoImportCrm
              disabled={!isOnline || isBusy}
              onCatalogChanged={onCatalogChanged}
              runAction={runAction}
              tenantContext={context}
            />
          ) : null}

          {activeSection === 'stats' ? (
            <StatsCrm disabled={!isOnline || isBusy} onRefresh={refreshStats} stats={stats} />
          ) : null}
        </main>
      </section>
    </div>
  )
}

function getSectionTitle(section: CrmSection) {
  if (section === 'products') {
    return 'Gestion de productos y precios'
  }
  if (section === 'categories') {
    return 'Categorias del catalogo'
  }
  if (section === 'import') {
    return 'Importacion REVO'
  }
  if (section === 'stats') {
    return 'Analitica comercial'
  }

  return 'Panel de control'
}

type RunAction = (action: () => Promise<void>) => Promise<void>

type DashboardCrmProps = {
  activeCategories: number
  activeProducts: number
  categories: Category[]
  disabled: boolean
  onRefresh: () => Promise<void>
  products: Product[]
  stats: CrmStats | null
}

function DashboardCrm({
  activeCategories,
  activeProducts,
  categories,
  disabled,
  onRefresh,
  products,
  stats,
}: DashboardCrmProps) {
  const categoryBars = categories.map((category) => ({
    ...category,
    count: products.filter((product) => product.categoryId === category.id).length,
  }))
  const maxCategoryCount = Math.max(1, ...categoryBars.map((category) => category.count))
  const activeRatio = products.length ? Math.round((activeProducts / products.length) * 100) : 0

  return (
    <div className="crm-dashboard-grid">
      <section className="crm-panel crm-panel-span">
        <div className="crm-panel-header">
          <span>Resumen del catalogo</span>
          <button className="crm-icon-button" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip">
          <KpiCard color="green" label="Productos activos" value={activeProducts} />
          <KpiCard color="orange" label="Productos totales" value={products.length} />
          <KpiCard color="red" label="Categorias" value={categories.length} />
          <KpiCard color="blue" label="Activas" value={activeCategories} />
        </div>
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Estado de catalogo</span>
        </div>
        <div className="crm-donut-row">
          <div className="crm-donut" style={{ '--crm-progress': `${activeRatio}%` } as CSSProperties}>
            <span>{activeRatio}%</span>
          </div>
          <div className="crm-stat-list">
            <div>
              <span>Activos</span>
              <strong>{activeProducts}</strong>
            </div>
            <div>
              <span>Ocultos</span>
              <strong>{products.length - activeProducts}</strong>
            </div>
            <div>
              <span>Ventas mes</span>
              <strong>{formatMoney(stats?.monthSalesCents ?? 0)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Actividad del mes</span>
        </div>
        <div className="crm-mini-metrics">
          <MiniMetric label="Tickets" value={String(stats?.monthTicketCount ?? 0)} />
          <MiniMetric label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <MiniMetric label="Ingresos" value={formatMoney(stats?.monthSalesCents ?? 0)} />
        </div>
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Productos por categoria</span>
        </div>
        <div className="crm-horizontal-bars">
          {categoryBars.map((category) => (
            <div className="crm-bar-row" key={category.id}>
              <span>{category.name}</span>
              <div>
                <i style={{ width: `${Math.max(8, (category.count / maxCategoryCount) * 100)}%` }} />
              </div>
              <strong>{category.count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  )
}

function KpiCard({ color, label, value }: { color: 'blue' | 'green' | 'orange' | 'red'; label: string; value: number | string }) {
  return (
    <div className={`crm-kpi crm-kpi-${color}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  )
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-mini-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  )
}

type RevoImportCrmProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
}

function RevoImportCrm({ disabled, onCatalogChanged, runAction, tenantContext }: RevoImportCrmProps) {
  const [fileError, setFileError] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [importResult, setImportResult] = useState<CatalogImportResult | null>(null)
  const [parseResult, setParseResult] = useState<RevoImportParseResult | null>(null)
  const products = useMemo(() => parseResult?.products ?? [], [parseResult])
  const variantCount = products.reduce((total, product) => total + product.variants.length, 0)
  const allWarnings = useMemo(() => {
    const productWarnings = products.flatMap((product) =>
      product.warnings.map((warning) => `${product.name}: ${warning}`),
    )
    return [...(parseResult?.warnings ?? []), ...productWarnings]
  }, [parseResult?.warnings, products])

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0] ?? null
    event.currentTarget.value = ''
    setFileError(null)
    setImportResult(null)

    if (!file) {
      return
    }

    try {
      const text = await file.text()
      const nextResult = parseRevoItemsCsv(text)
      setFileName(file.name)
      setParseResult(nextResult)

      if (!nextResult.products.length) {
        setFileError('No se han encontrado productos importables en el CSV.')
      }
    } catch (readError) {
      setFileName(file.name)
      setParseResult(null)
      setFileError(getReadableError(readError))
    }
  }

  async function handleImport() {
    if (!parseResult?.products.length) {
      return
    }

    setImportResult(null)
    await runAction(async () => {
      const nextResult = await importRevoCatalogProducts(tenantContext, parseResult.products)
      setImportResult(nextResult)
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-dashboard-grid">
      <section className="crm-panel crm-panel-span">
        <div className="crm-list-toolbar">
          <div className="crm-list-title">
            <h2>Importar articulos REVO</h2>
            <p>
              {fileName
                ? `${fileName} - ${products.length} productos y ${variantCount} formatos detectados`
                : 'Selecciona el CSV de articulos exportado desde REVO.'}
            </p>
          </div>
          <div className="crm-toolbar-actions">
            <label
              className={
                disabled
                  ? 'crm-secondary-button crm-file-button crm-file-button-disabled'
                  : 'crm-secondary-button crm-file-button'
              }
            >
              <Upload className="h-4 w-4" />
              Seleccionar CSV
              <input accept=".csv,text/csv" disabled={disabled} onChange={handleFileChange} type="file" />
            </label>
            <button
              className="crm-primary-button"
              disabled={disabled || !parseResult?.products.length}
              onClick={() => void handleImport()}
              type="button"
            >
              <Upload className="h-4 w-4" />
              Importar
            </button>
          </div>
        </div>

        <div className="crm-kpi-strip">
          <KpiCard color="green" label="Productos" value={products.length} />
          <KpiCard color="blue" label="Formatos" value={variantCount} />
          <KpiCard color="orange" label="Avisos" value={allWarnings.length} />
          <KpiCard color="red" label="Filas omitidas" value={parseResult?.skippedRows ?? 0} />
        </div>
      </section>

      {fileError ? <div className="crm-import-alert crm-import-alert-warning">{fileError}</div> : null}

      {allWarnings.length ? (
        <section className="crm-panel crm-panel-span">
          <div className="crm-panel-header">
            <span>Avisos de interpretacion</span>
          </div>
          <ul className="crm-import-warning-list">
            {allWarnings.slice(0, 8).map((warning, index) => (
              <li key={`${index}:${warning}`}>{warning}</li>
            ))}
            {allWarnings.length > 8 ? <li>{allWarnings.length - 8} avisos mas en el CSV.</li> : null}
          </ul>
        </section>
      ) : null}

      {importResult ? (
        <section className="crm-panel crm-panel-span">
          <div className="crm-panel-header">
            <span>Resultado de importacion</span>
          </div>
          <div className="crm-import-result-grid">
            <MiniMetric label="Categorias creadas" value={String(importResult.categoriesCreated)} />
            <MiniMetric label="Categorias actualizadas" value={String(importResult.categoriesUpdated)} />
            <MiniMetric label="Productos creados" value={String(importResult.productsCreated)} />
            <MiniMetric label="Productos actualizados" value={String(importResult.productsUpdated)} />
            <MiniMetric label="Formatos creados" value={String(importResult.variantsCreated)} />
            <MiniMetric label="Formatos actualizados" value={String(importResult.variantsUpdated)} />
          </div>
        </section>
      ) : null}

      {parseResult ? (
        <section className="crm-panel crm-panel-span">
          <div className="crm-panel-header">
            <span>Previsualizacion</span>
          </div>
          <div className="crm-data-table crm-import-table">
            <div className="crm-data-head">
              <span>Producto</span>
              <span>Categoria destino</span>
              <span>Formatos</span>
              <span>Precio</span>
              <span>Estado</span>
              <span>Avisos</span>
            </div>
            {products.map((product) => (
              <div className="crm-data-row" key={`${product.categoryName}:${product.name}`}>
                <div className="crm-cell-main">
                  <strong>{product.name}</strong>
                  <span>{product.sourceCategories.join(', ') || 'REVO'}</span>
                </div>
                <span>{product.categoryName}</span>
                <div className="crm-format-list">
                  {product.saleFormats.map((format) => (
                    <span key={format}>{getSaleFormatLabel(format)}</span>
                  ))}
                </div>
                <div className="crm-price-list">
                  {product.variants.map((variant) => (
                    <span key={variant.name}>
                      {variant.name}: {formatMoney(variant.priceCents)}
                    </span>
                  ))}
                </div>
                <span className={product.active ? 'crm-status-pill crm-status-pill-active' : 'crm-status-pill crm-status-pill-muted'}>
                  {product.active ? 'Activo' : 'Oculto'}
                </span>
                <span className="crm-import-warning-cell">
                  {product.warnings.length ? product.warnings.join(' ') : 'Sin avisos'}
                </span>
              </div>
            ))}
            {!products.length ? <EmptyList message="Carga un CSV de REVO para ver la previsualizacion." /> : null}
          </div>
        </section>
      ) : null}
    </div>
  )
}

type ProductsCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  tenantContext: TenantContext
}

type ProductEditorState =
  | {
      mode: 'create'
    }
  | {
      mode: 'edit'
      productId: string
    }

function ProductsCrm({
  categories,
  disabled,
  onCatalogChanged,
  products,
  runAction,
  tenantContext,
}: ProductsCrmProps) {
  const [query, setQuery] = useState('')
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
      const saleFormatNames = getProductSaleFormats(product).map(getSaleFormatLabel).join(' ')
      return [product.name, product.description ?? '', categoryName, getKindLabel(product.kind), saleFormatNames, variantNames]
        .join(' ')
        .toLowerCase()
        .includes(normalizedQuery)
    })
  }, [categoryById, products, query])
  const selectedProduct = editor?.mode === 'edit' ? products.find((product) => product.id === editor.productId) : null

  async function handleDeleteProduct(product: Product) {
    if (!window.confirm(`Eliminar el producto "${product.name}" de forma permanente?`)) {
      return
    }

    await runAction(async () => {
      await deleteProduct(tenantContext, product.id)
      if (editor?.mode === 'edit' && editor.productId === product.id) {
        setEditor(null)
      }
      await onCatalogChanged()
    })
  }

  return (
    <div className={editor ? 'crm-entity-layout' : 'crm-entity-layout crm-entity-layout-full'}>
      <section className="crm-panel crm-list-panel">
        <div className="crm-list-toolbar">
          <div className="crm-list-title">
            <h2>Productos</h2>
            <p>{filteredProducts.length} de {products.length} productos</p>
          </div>
          <div className="crm-toolbar-actions">
            <label className="crm-search">
              <Search className="h-4 w-4" />
              <input onChange={(event) => setQuery(event.target.value)} placeholder="Buscar producto" value={query} />
            </label>
            <button
              className="crm-primary-button"
              disabled={disabled || !categories.length}
              onClick={() => setEditor({ mode: 'create' })}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Anadir producto
            </button>
          </div>
        </div>

        <div className="crm-data-table crm-products-table">
          <div className="crm-data-head">
            <span>Producto</span>
            <span>Formatos</span>
            <span>Categoria / Tipo</span>
            <span>Precio base</span>
            <span>Uso</span>
            <span>Acciones</span>
          </div>
          {filteredProducts.map((product) => (
            <ProductListRow
              category={categoryById.get(product.categoryId)}
              disabled={disabled}
              key={product.id}
              onDelete={() => void handleDeleteProduct(product)}
              onEdit={() => setEditor({ mode: 'edit', productId: product.id })}
              product={product}
            />
          ))}
          {!filteredProducts.length ? <EmptyList message="No hay productos que coincidan con la busqueda." /> : null}
        </div>
      </section>

      {editor && (editor.mode === 'create' || selectedProduct) ? (
        <ProductFormPanel
          categories={categories}
          disabled={disabled}
          key={editor.mode === 'edit' ? editor.productId : 'create'}
          mode={editor.mode}
          onCatalogChanged={onCatalogChanged}
          onClose={() => setEditor(null)}
          product={selectedProduct ?? undefined}
          runAction={runAction}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

type ProductListRowProps = {
  category: Category | undefined
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  product: Product
}

function ProductListRow({ category, disabled, onDelete, onEdit, product }: ProductListRowProps) {
  const primaryVariant = product.variants.find((variant) => variant.isDefault) ?? product.variants[0]
  const usageLabel = canUseProductAsMixer(product)
    ? product.mixerSupplementCents
      ? `Mixer +${formatMoney(product.mixerSupplementCents)}`
      : 'Mixer'
    : canSellProductStandalone(product)
      ? 'Venta directa'
      : 'Interno'

  return (
    <div className="crm-data-row">
      <div className="crm-cell-main">
        <strong>{product.name}</strong>
        <span>{product.description || 'Sin descripcion'} · {product.isActive ? 'Activo' : 'Oculto'}</span>
      </div>
      <div className="crm-format-list">
        {getProductSaleFormats(product).map((format) => (
          <span key={format}>{getSaleFormatLabel(format)}</span>
        ))}
      </div>
      <span>{category?.name ?? 'Sin categoria'} · {getKindLabel(product.kind)}</span>
      <strong>{formatMoney(primaryVariant?.priceCents ?? 0)}</strong>
      <span className={product.isActive ? 'crm-status-pill crm-status-pill-active' : 'crm-status-pill crm-status-pill-muted'}>
        {usageLabel}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button className="crm-danger-button" disabled={disabled} onClick={onDelete} type="button">
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}

type ProductFormPanelProps = {
  categories: Category[]
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  product?: Product
  runAction: RunAction
  tenantContext: TenantContext
}

function ProductFormPanel({
  categories,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  product,
  runAction,
  tenantContext,
}: ProductFormPanelProps) {
  const firstCategory = categories[0]
  const isEditing = mode === 'edit'
  const primaryVariant = product?.variants.find((variant) => variant.isDefault) ?? product?.variants[0]
  const initialKind = product?.kind ?? firstCategory?.kind ?? 'other'
  const initialMixerSupplementCents = product?.mixerSupplementCents ?? 0
  const [name, setName] = useState(product?.name ?? '')
  const [categoryId, setCategoryId] = useState(product?.categoryId ?? firstCategory?.id ?? '')
  const [description, setDescription] = useState(product?.description ?? '')
  const [kind, setKind] = useState<CatalogKind>(initialKind)
  const [saleFormats, setSaleFormats] = useState<SaleFormat[]>(
    product ? getProductSaleFormats(product) : getDefaultSaleFormatsForKind(initialKind),
  )
  const [canSellStandalone, setCanSellStandalone] = useState(product ? canSellProductStandalone(product) : true)
  const [canUseAsMixer, setCanUseAsMixer] = useState(product ? canUseProductAsMixer(product) : initialKind === 'mixer')
  const [hasMixerSupplement, setHasMixerSupplement] = useState(initialMixerSupplementCents > 0)
  const [mixerSupplement, setMixerSupplement] = useState(centsToInput(initialMixerSupplementCents || 100))
  const [variantName, setVariantName] = useState('Normal')
  const [price, setPrice] = useState(centsToInput(primaryVariant?.priceCents ?? 0))
  const [newVariantName, setNewVariantName] = useState('')
  const [newVariantPrice, setNewVariantPrice] = useState('0.00')
  const selectedCategory = categories.find((category) => category.id === categoryId)

  useEffect(() => {
    if (!categoryId && firstCategory) {
      setCategoryId(firstCategory.id)
    }
  }, [categoryId, firstCategory])

  function handleCategoryChange(nextCategoryId: string) {
    const nextCategory = categories.find((category) => category.id === nextCategoryId)
    setCategoryId(nextCategoryId)

    if (!isEditing && nextCategory) {
      setKind(nextCategory.kind)
      setSaleFormats(getDefaultSaleFormatsForKind(nextCategory.kind))
      setCanSellStandalone(true)
      setCanUseAsMixer(nextCategory.kind === 'mixer')
      setHasMixerSupplement(false)
    }
  }

  function toggleSaleFormat(format: SaleFormat) {
    setSaleFormats((current) =>
      current.includes(format) ? current.filter((currentFormat) => currentFormat !== format) : [...current, format],
    )
  }

  function handleCanUseAsMixerChange(nextCanUseAsMixer: boolean) {
    setCanUseAsMixer(nextCanUseAsMixer)

    if (!nextCanUseAsMixer) {
      setHasMixerSupplement(false)
    }
  }

  async function saveProduct() {
    if (!selectedCategory || !name.trim()) {
      return
    }

    const mixerSupplementCents =
      canUseAsMixer && hasMixerSupplement ? parseMoneyToCents(mixerSupplement) : 0

    await runAction(async () => {
      if (isEditing && product) {
        await updateProduct(tenantContext, product.id, {
          canSellStandalone,
          canUseAsMixer,
          categoryId,
          description: description.trim(),
          kind,
          mixerSupplementCents,
          name: name.trim(),
          saleFormats,
        })
        if (primaryVariant) {
          await updateVariant(tenantContext, primaryVariant.id, {
            priceCents: parseMoneyToCents(price),
          })
        }
      } else {
        await createProductWithVariant(tenantContext, {
          canSellStandalone,
          canUseAsMixer,
          categoryId: selectedCategory.id,
          description: description.trim(),
          kind,
          mixerSupplementCents,
          name: name.trim(),
          priceCents: parseMoneyToCents(price),
          saleFormats,
          variantName: variantName.trim() || 'Normal',
        })
      }
      await onCatalogChanged()
      onClose()
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

  async function addVariant() {
    if (!product || !newVariantName.trim()) {
      return
    }

    await runAction(async () => {
      await createVariant(tenantContext, product.id, {
        name: newVariantName.trim(),
        priceCents: parseMoneyToCents(newVariantPrice),
      })
      setNewVariantName('')
      setNewVariantPrice('0.00')
      await onCatalogChanged()
    })
  }

  async function handleDeleteVariant(variant: ProductVariant) {
    if (!product) {
      return
    }

    if (product.variants.length <= 1) {
      window.alert('No se puede eliminar el unico formato del producto.')
      return
    }

    if (!window.confirm(`Eliminar el formato "${variant.name}"?`)) {
      return
    }

    const nextDefaultVariant = variant.isDefault ? product.variants.find((item) => item.id !== variant.id) : null

    await runAction(async () => {
      await deleteVariant(tenantContext, variant.id)
      if (nextDefaultVariant) {
        await updateVariant(tenantContext, nextDefaultVariant.id, {
          isDefault: true,
        })
      }
      await onCatalogChanged()
    })
  }

  return (
    <aside className="crm-panel crm-editor-panel">
      <div className="crm-editor-header">
        <div>
          <span>{isEditing ? 'Editar producto' : 'Nuevo producto'}</span>
          <small>{isEditing ? product?.name : 'Alta rapida de catalogo'}</small>
        </div>
        <button className="crm-editor-close" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="crm-form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void saveProduct()
        }}
      >
        <Field label="Producto">
          <input className="crm-input" onChange={(event) => setName(event.target.value)} value={name} />
        </Field>
        <Field label="Categoria">
          <select className="crm-input" onChange={(event) => handleCategoryChange(event.target.value)} value={categoryId}>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Tipo de producto">
          <select className="crm-input" onChange={(event) => setKind(event.target.value as CatalogKind)} value={kind}>
            {productKindOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Descripcion">
          <input className="crm-input" onChange={(event) => setDescription(event.target.value)} value={description} />
        </Field>
        <div>
          <span className="crm-field-label">Formatos de venta</span>
          <div className="crm-checkbox-list">
            {saleFormatOptions.map((option) => (
              <label key={option.value}>
                <input
                  checked={saleFormats.includes(option.value)}
                  onChange={() => toggleSaleFormat(option.value)}
                  type="checkbox"
                />
                <span>{option.label}</span>
              </label>
            ))}
          </div>
        </div>
        <div>
          <span className="crm-field-label">Usos</span>
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
            <span className="crm-field-label">Suplemento en cubatas</span>
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
              className="crm-input font-mono"
              inputMode="decimal"
              onChange={(event) => setMixerSupplement(event.target.value)}
              value={mixerSupplement}
            />
          </Field>
        ) : null}
        <div className={isEditing ? 'crm-one-field' : 'crm-two-fields'}>
          {isEditing ? (
            <Field label="Precio base">
              <input className="crm-input font-mono" inputMode="decimal" onChange={(event) => setPrice(event.target.value)} value={price} />
            </Field>
          ) : (
            <>
              <Field label="Formato">
              <input className="crm-input" onChange={(event) => setVariantName(event.target.value)} value={variantName} />
              </Field>
              <Field label="Precio">
                <input className="crm-input font-mono" inputMode="decimal" onChange={(event) => setPrice(event.target.value)} value={price} />
              </Field>
            </>
          )}
        </div>
        <div className="crm-editor-actions">
          <button className="crm-primary-button" disabled={disabled || !categories.length} type="submit">
            <Save className="h-4 w-4" />
            Guardar
          </button>
          {isEditing && product ? (
            <button
              className={product.isActive ? 'crm-state-button' : 'crm-state-button crm-state-button-danger'}
              disabled={disabled}
              onClick={toggleProduct}
              type="button"
            >
              {product.isActive ? 'Marcar oculto' : 'Activar'}
            </button>
          ) : null}
        </div>
      </form>

      {isEditing && product ? (
        <div className="crm-editor-section">
          <h3>Formatos y precios</h3>
          <div className="crm-variant-grid">
            {product.variants.map((variant) => (
              <VariantEditor
                canDelete={product.variants.length > 1}
                disabled={disabled}
                key={variant.id}
                onDelete={() => void handleDeleteVariant(variant)}
                onCatalogChanged={onCatalogChanged}
                runAction={runAction}
                tenantContext={tenantContext}
                variant={variant}
              />
            ))}
          </div>

          <div className="crm-new-variant">
            <input
              className="crm-input"
              onChange={(event) => setNewVariantName(event.target.value)}
              placeholder="Nuevo formato"
              value={newVariantName}
            />
            <input
              className="crm-input font-mono"
              inputMode="decimal"
              onChange={(event) => setNewVariantPrice(event.target.value)}
              value={newVariantPrice}
            />
            <button className="crm-secondary-button" disabled={disabled || !newVariantName.trim()} onClick={addVariant} type="button">
              Anadir
            </button>
          </div>
        </div>
      ) : null}
    </aside>
  )
}

type VariantEditorProps = {
  canDelete: boolean
  disabled: boolean
  onDelete: () => void
  onCatalogChanged: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
  variant: ProductVariant
}

function VariantEditor({
  canDelete,
  disabled,
  onDelete,
  onCatalogChanged,
  runAction,
  tenantContext,
  variant,
}: VariantEditorProps) {
  const [name, setName] = useState(variant.name)
  const [price, setPrice] = useState(centsToInput(variant.priceCents))

  async function saveVariant() {
    await runAction(async () => {
      await updateVariant(tenantContext, variant.id, {
        name: name.trim() || variant.name,
        priceCents: parseMoneyToCents(price),
      })
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-variant-editor">
      <label className="crm-variant-field">
        <span>Formato</span>
        <input className="crm-input" onChange={(event) => setName(event.target.value)} value={name} />
      </label>
      <button
        className="crm-delete-square-button"
        disabled={disabled || !canDelete}
        onClick={onDelete}
        title={canDelete ? `Eliminar ${variant.name}` : 'No se puede eliminar el unico formato.'}
        type="button"
      >
        <Trash2 className="h-4 w-4" />
      </button>
      <label className="crm-variant-field">
        <span>Precio</span>
        <input className="crm-input font-mono" inputMode="decimal" onChange={(event) => setPrice(event.target.value)} value={price} />
      </label>
      <button className="crm-save-button" disabled={disabled} onClick={saveVariant} type="button">
        <Save className="h-4 w-4" />
      </button>
    </div>
  )
}

type CategoriesCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  tenantContext: TenantContext
}

type CategoryEditorState =
  | {
      mode: 'create'
    }
  | {
      categoryId: string
      mode: 'edit'
    }

function CategoriesCrm({ categories, disabled, onCatalogChanged, products, runAction, tenantContext }: CategoriesCrmProps) {
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<CategoryEditorState | null>(null)
  const productsByCategory = useMemo(() => {
    const nextMap = new Map<string, number>()
    products.forEach((product) => {
      nextMap.set(product.categoryId, (nextMap.get(product.categoryId) ?? 0) + 1)
    })
    return nextMap
  }, [products])
  const filteredCategories = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return categories
    }

    return categories.filter((category) =>
      [category.name, category.kind, getKindLabel(category.kind)].join(' ').toLowerCase().includes(normalizedQuery),
    )
  }, [categories, query])
  const selectedCategory =
    editor?.mode === 'edit' ? categories.find((category) => category.id === editor.categoryId) : null

  async function handleDeleteCategory(category: Category) {
    const productCount = productsByCategory.get(category.id) ?? 0

    if (productCount > 0 || !window.confirm(`Eliminar la categoria "${category.name}" de forma permanente?`)) {
      return
    }

    await runAction(async () => {
      await deleteCategory(tenantContext, category.id)
      if (editor?.mode === 'edit' && editor.categoryId === category.id) {
        setEditor(null)
      }
      await onCatalogChanged()
    })
  }

  return (
    <div className={editor ? 'crm-entity-layout' : 'crm-entity-layout crm-entity-layout-full'}>
      <section className="crm-panel crm-list-panel">
        <div className="crm-list-toolbar">
          <div className="crm-list-title">
            <h2>Categorias</h2>
            <p>{filteredCategories.length} de {categories.length} categorias</p>
          </div>
          <div className="crm-toolbar-actions">
            <label className="crm-search">
              <Search className="h-4 w-4" />
              <input onChange={(event) => setQuery(event.target.value)} placeholder="Buscar categoria" value={query} />
            </label>
            <button className="crm-primary-button" disabled={disabled} onClick={() => setEditor({ mode: 'create' })} type="button">
              <Plus className="h-4 w-4" />
              Anadir categoria
            </button>
          </div>
        </div>

        <div className="crm-data-table crm-categories-table">
          <div className="crm-data-head">
            <span>Categoria</span>
            <span>Tipo</span>
            <span>Productos</span>
            <span>Estado</span>
            <span>Acciones</span>
          </div>
          {filteredCategories.map((category) => {
            const productCount = productsByCategory.get(category.id) ?? 0
            return (
              <CategoryListRow
                category={category}
                disabled={disabled}
                key={category.id}
                onDelete={() => void handleDeleteCategory(category)}
                onEdit={() => setEditor({ categoryId: category.id, mode: 'edit' })}
                productCount={productCount}
              />
            )
          })}
          {!filteredCategories.length ? <EmptyList message="No hay categorias que coincidan con la busqueda." /> : null}
        </div>
      </section>

      {editor && (editor.mode === 'create' || selectedCategory) ? (
        <CategoryFormPanel
          categories={categories}
          category={selectedCategory ?? undefined}
          disabled={disabled}
          key={editor.mode === 'edit' ? editor.categoryId : 'create'}
          mode={editor.mode}
          onCatalogChanged={onCatalogChanged}
          onClose={() => setEditor(null)}
          runAction={runAction}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  )
}

type CategoryListRowProps = {
  category: Category
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  productCount: number
}

function CategoryListRow({ category, disabled, onDelete, onEdit, productCount }: CategoryListRowProps) {
  return (
    <div className="crm-data-row">
      <div className="crm-cell-main">
        <strong>{category.name}</strong>
        <span>Orden {category.sortOrder}</span>
      </div>
      <span>{getKindLabel(category.kind)}</span>
      <strong>{productCount}</strong>
      <span className={category.isActive ? 'crm-status-pill crm-status-pill-active' : 'crm-status-pill crm-status-pill-muted'}>
        {category.isActive ? 'Activa' : 'Oculta'}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button
          className="crm-danger-button"
          disabled={disabled || productCount > 0}
          onClick={onDelete}
          title={productCount > 0 ? 'No se puede eliminar una categoria con productos asociados.' : undefined}
          type="button"
        >
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}

type CategoryFormPanelProps = {
  categories: Category[]
  category?: Category
  disabled: boolean
  mode: 'create' | 'edit'
  onCatalogChanged: () => Promise<void>
  onClose: () => void
  runAction: RunAction
  tenantContext: TenantContext
}

function CategoryFormPanel({
  categories,
  category,
  disabled,
  mode,
  onCatalogChanged,
  onClose,
  runAction,
  tenantContext,
}: CategoryFormPanelProps) {
  const isEditing = mode === 'edit'
  const [name, setName] = useState(category?.name ?? '')
  const [kind, setKind] = useState<CatalogKind>(category?.kind ?? 'alcohol')
  const nextSortOrder = useMemo(() => categories.length + 1, [categories.length])

  async function saveCategory() {
    if (!name.trim()) {
      return
    }

    await runAction(async () => {
      if (isEditing && category) {
        await updateCategory(tenantContext, category.id, {
          kind,
          name: name.trim(),
          sortOrder: category.sortOrder,
        })
      } else {
        await createCategory(tenantContext, {
          kind,
          name: name.trim(),
          sortOrder: nextSortOrder,
        })
      }
      await onCatalogChanged()
      onClose()
    })
  }

  async function toggleCategory() {
    if (!category) {
      return
    }

    await runAction(async () => {
      await updateCategory(tenantContext, category.id, {
        isActive: !category.isActive,
      })
      await onCatalogChanged()
    })
  }

  return (
    <aside className="crm-panel crm-editor-panel">
      <div className="crm-editor-header">
        <div>
          <span>{isEditing ? 'Editar categoria' : 'Nueva categoria'}</span>
          <small>{isEditing ? category?.name : 'Agrupa productos del TPV'}</small>
        </div>
        <button className="crm-editor-close" onClick={onClose} type="button">
          <X className="h-4 w-4" />
        </button>
      </div>

      <form
        className="crm-form-stack"
        onSubmit={(event) => {
          event.preventDefault()
          void saveCategory()
        }}
      >
      <Field label="Nombre">
        <input className="crm-input" onChange={(event) => setName(event.target.value)} value={name} />
      </Field>
      <Field label="Tipo">
        <select className="crm-input" onChange={(event) => setKind(event.target.value as CatalogKind)} value={kind}>
          {categoryKindOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>
      <div className="crm-editor-actions">
        <button className="crm-primary-button" disabled={disabled} type="submit">
          <Save className="h-4 w-4" />
          Guardar
        </button>
        {isEditing && category ? (
          <button
            className={category.isActive ? 'crm-state-button' : 'crm-state-button crm-state-button-danger'}
            disabled={disabled}
            onClick={toggleCategory}
            type="button"
          >
            {category.isActive ? 'Marcar oculta' : 'Activar'}
          </button>
        ) : null}
      </div>
      </form>
    </aside>
  )
}

function EmptyList({ message }: { message: string }) {
  return <div className="crm-empty-row">{message}</div>
}

type StatsCrmProps = {
  disabled: boolean
  onRefresh: () => Promise<void>
  stats: CrmStats | null
}

function StatsCrm({ disabled, onRefresh, stats }: StatsCrmProps) {
  return (
    <div className="crm-dashboard-grid">
      <section className="crm-panel crm-panel-span">
        <div className="crm-panel-header">
          <span>Ventas del mes</span>
          <button className="crm-icon-button" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip">
          <KpiCard color="green" label="Ventas" value={formatMoney(stats?.monthSalesCents ?? 0)} />
          <KpiCard color="blue" label="Tickets" value={stats?.monthTicketCount ?? 0} />
          <KpiCard color="orange" label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <KpiCard color="red" label="Top productos" value={stats?.topProducts.length ?? 0} />
        </div>
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Por metodo de pago</span>
        </div>
        <PaymentBreakdown stats={stats} />
      </section>

      <section className="crm-panel">
        <div className="crm-panel-header">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  )
}

function PaymentBreakdown({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-payment-list">
      {(stats?.byPayment ?? []).map((payment) => (
        <div className="crm-payment-row" key={payment.method}>
          <div>
            <strong>{payment.method}</strong>
            <span>{payment.count} operaciones</span>
          </div>
          <b>{formatMoney(payment.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

function TopProductsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-top-list">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="crm-top-row" key={product.productName}>
          <span>{index + 1}</span>
          <div>
            <strong>{product.productName}</strong>
            <small>{product.quantity} uds</small>
          </div>
          <b>{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

type FieldProps = {
  children: ReactNode
  className?: string
  label: string
}

function Field({ children, className, label }: FieldProps) {
  return (
    <label className={className ? `block ${className}` : 'block'}>
      <span className="crm-field-label">{label}</span>
      {children}
    </label>
  )
}
