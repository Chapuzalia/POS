import {
  ArrowLeft,
  BarChart3,
  Beer,
  ChevronLeft,
  ChevronRight,
  GlassWater,
  Martini,
  ReceiptText,
  Search,
  Wine,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
  canSellProductStandalone,
  getActiveSaleFormats,
  getSaleFormatLabel,
  getProductSaleFormats,
  getProductVariantForSaleFormat,
  productSupportsSaleFormat,
} from '../../lib/catalog'
import { formatMoney, normalizeText } from '../../lib/format'
import type { Catalog, CatalogFilter, CatalogKind, CatalogStartTab, Category, Product, ProductSalesStat, SaleFormat } from '../../types'
import { Button } from '../ui'

const saleFormatIcons: Record<string, LucideIcon> = {
  beer_bottle: Beer,
  cocktail: Martini,
  copa: Wine,
  cubata: Martini,
  shot: Wine,
  soft_bottle: GlassWater,
}

function getSaleFormatIcon(format: CatalogFilter) {
  if (format === 'all') {
    return ReceiptText
  }
  if (format === 'top') {
    return BarChart3
  }

  return saleFormatIcons[format] ?? ReceiptText
}

function compareProductNames(a: Product, b: Product) {
  return a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }) || a.sortOrder - b.sortOrder
}

function getCatalogKindIcon(kind: CatalogKind, activeFilter: CatalogFilter) {
  if (activeFilter === 'top') {
    return BarChart3
  }

  if (activeFilter !== 'all') {
    return getSaleFormatIcon(activeFilter)
  }

  if (kind === 'alcohol' || kind === 'mixed' || kind === 'shot') {
    return Wine
  }
  if (kind === 'beer' || kind === 'beer_bottle') {
    return Beer
  }
  if (kind === 'cocktail') {
    return Martini
  }

  return GlassWater
}

function getCategoryKindsForFilter(filter: CatalogFilter): CatalogKind[] | null {
  if (filter === 'all' || filter === 'top') {
    return null
  }
  if (filter === 'cubata' || filter === 'copa' || filter === 'shot') {
    return ['alcohol', 'mixed', 'shot']
  }
  if (filter === 'beer_bottle') {
    return ['beer_bottle', 'beer']
  }
  if (filter === 'soft_bottle') {
    return ['soft_bottle', 'mixer']
  }
  if (filter === 'cocktail') {
    return ['cocktail']
  }

  return null
}

function isSoftBottleCatalogProduct(product: Product, category: Category | undefined) {
  if (category?.kind === 'other') {
    return false
  }

  return product.kind === 'soft_bottle' || product.kind === 'mixer' || category?.kind === 'soft_bottle' || category?.kind === 'mixer'
}

function getProductSaleFormat(product: Product, activeFilter: CatalogFilter): SaleFormat {
  if (activeFilter !== 'all' && activeFilter !== 'top') {
    return activeFilter
  }

  return getProductSaleFormats(product)[0] ?? 'soft_bottle'
}

type CatalogPanelProps = {
  catalog: Catalog | null
  catalogStartTab: CatalogStartTab
  disabled: boolean
  onSelectProduct: (product: Product, saleFormat: SaleFormat, allowFormatSelection: boolean, sourceElement: HTMLElement) => void
  productSalesStats: ProductSalesStat[]
}

export function CatalogPanel({ catalog, catalogStartTab, disabled, onSelectProduct, productSalesStats }: CatalogPanelProps) {
  const [activeFilter, setActiveFilter] = useState<CatalogFilter>(catalogStartTab)
  const [search, setSearch] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [canScrollTabsBack, setCanScrollTabsBack] = useState(false)
  const [canScrollTabsForward, setCanScrollTabsForward] = useState(false)
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null)
  const categories = useMemo(() => catalog?.categories ?? [], [catalog])
  const products = useMemo(() => catalog?.products ?? [], [catalog])
  const saleFormats = useMemo(() => getActiveSaleFormats(catalog?.saleFormats), [catalog?.saleFormats])
  const productSalesById = useMemo(
    () => new Map(productSalesStats.map((stat) => [stat.productId, stat])),
    [productSalesStats],
  )
  const filterOptions = useMemo(
    () => [
      catalogStartTab === 'top'
        ? { id: 'top', label: 'Top items', icon: BarChart3 }
        : { id: 'all', label: 'Todo', icon: ReceiptText },
      ...saleFormats.map((format) => ({
        id: format.key,
        label: getSaleFormatLabel(format.key, saleFormats),
        icon: getSaleFormatIcon(format.key),
      })),
    ],
    [catalogStartTab, saleFormats],
  )
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const normalizedSearch = normalizeText(search.trim())
  const productFilter = normalizedSearch ? 'all' : activeFilter
  const isFormatFilter = activeFilter !== 'all' && activeFilter !== 'top'

  useEffect(() => {
    setActiveFilter(catalogStartTab)
    setSelectedCategoryId(null)
  }, [catalogStartTab])

  useEffect(() => {
    if (activeFilter !== 'all' && activeFilter !== 'top' && !saleFormats.some((format) => format.key === activeFilter)) {
      setActiveFilter(catalogStartTab)
      setSelectedCategoryId(null)
    }
  }, [activeFilter, catalogStartTab, saleFormats])

  useEffect(() => {
    updateTabScrollState()

    const scroller = tabsScrollerRef.current
    if (!scroller) {
      return
    }

    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTabScrollState)
    resizeObserver?.observe(scroller)
    window.addEventListener('resize', updateTabScrollState)

    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateTabScrollState)
    }
  }, [filterOptions.length])

  const visibleCategories = useMemo(
    () => {
      const allowedKinds = getCategoryKindsForFilter(activeFilter)
      return categories
        .filter((category) => !allowedKinds || allowedKinds.includes(category.kind))
        .sort((a, b) => a.sortOrder - b.sortOrder)
    },
    [activeFilter, categories],
  )

  const visibleProducts = useMemo(() => {
    return products
      .filter((product) => product.isActive)
      .filter((product) => productFilter === 'all' || productFilter === 'top' || productSupportsSaleFormat(product, productFilter))
      .filter((product) => productFilter !== 'top' || (productSalesById.get(product.id)?.quantity ?? 0) > 0)
      .filter((product) => productFilter !== 'soft_bottle' || isSoftBottleCatalogProduct(product, categoryById.get(product.categoryId)))
      .filter((product) => productFilter !== 'soft_bottle' || canSellProductStandalone(product))
      .filter((product) => productFilter !== 'beer_bottle' || canSellProductStandalone(product))
      .filter((product) => productFilter !== 'cocktail' || canSellProductStandalone(product))
      .filter((product) => productFilter !== 'all' || canSellProductStandalone(product))
      .filter((product) => !selectedCategoryId || product.categoryId === selectedCategoryId)
      .filter((product) => {
        if (normalizedSearch || productFilter === 'all' || productFilter === 'top') {
          return true
        }

        return selectedCategoryId ? !product.isFeatured : product.isFeatured
      })
      .filter((product) => {
        if (!normalizedSearch) {
          return true
        }

        const categoryName = categoryById.get(product.categoryId)?.name ?? ''
        const searchable = normalizeText(
          [
            product.name,
            product.description ?? '',
            categoryName,
            ...product.variants.map((variant) => variant.name),
          ].join(' '),
        )

        return searchable.includes(normalizedSearch)
      })
      .sort((a, b) => {
        if (productFilter !== 'top') {
          return compareProductNames(a, b)
        }

        const firstStat = productSalesById.get(a.id)
        const secondStat = productSalesById.get(b.id)
        return (
          (secondStat?.quantity ?? 0) - (firstStat?.quantity ?? 0) ||
          (secondStat?.totalCents ?? 0) - (firstStat?.totalCents ?? 0) ||
          compareProductNames(a, b)
        )
      })
  }, [categoryById, normalizedSearch, productFilter, productSalesById, products, selectedCategoryId])

  const categoryProductCounts = useMemo(() => {
    return new Map(
      visibleCategories.map((category) => [
        category.id,
        products.filter(
          (product) =>
            product.categoryId === category.id &&
            product.isActive &&
            (activeFilter === 'all' || activeFilter === 'top' || productSupportsSaleFormat(product, activeFilter)) &&
            (activeFilter === 'all' || activeFilter === 'top' || !product.isFeatured) &&
            (activeFilter === 'all' || activeFilter === 'top' || activeFilter === 'cubata' || canSellProductStandalone(product)),
        ).length,
      ]),
    )
  }, [activeFilter, products, visibleCategories])
  const visibleCategoriesWithProducts = visibleCategories.filter((category) => (categoryProductCounts.get(category.id) ?? 0) > 0)
  const showCategories =
    activeFilter !== 'top' &&
    !normalizedSearch &&
    !selectedCategoryId &&
    (isFormatFilter ? visibleCategoriesWithProducts.length > 0 : visibleCategoriesWithProducts.length > 1)
  const showProductGrid = !showCategories || (isFormatFilter && visibleProducts.length > 0)
  const selectedCategory = selectedCategoryId
    ? categories.find((category) => category.id === selectedCategoryId) ?? null
    : null

  function handleFilterChange(filter: CatalogFilter) {
    if (filter !== activeFilter && search) {
      setSearch('')
    }

    setActiveFilter(filter)
    setSelectedCategoryId(null)
  }

  function updateTabScrollState() {
    const scroller = tabsScrollerRef.current

    if (!scroller) {
      return
    }

    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth
    setCanScrollTabsBack(scroller.scrollLeft > 1)
    setCanScrollTabsForward(scroller.scrollLeft < maxScrollLeft - 1)
  }

  function scrollTabs(direction: -1 | 1) {
    const scroller = tabsScrollerRef.current

    if (!scroller) {
      return
    }

    scroller.scrollBy({ left: direction * scroller.clientWidth, behavior: 'smooth' })
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="relative min-w-0 max-w-full">
        <div
          className="catalog-tabs-scroll min-w-0 max-w-full overflow-x-auto pb-1"
          onScroll={updateTabScrollState}
          ref={tabsScrollerRef}
        >
          <div className="grid min-w-full grid-flow-col lg:auto-cols-[calc((100%-3rem)/7)] gap-2">
          {filterOptions.map((option) => {
            const Icon = option.icon
            return (
              <Button
                active={activeFilter === option.id}
                fullWidth
                key={option.id}
                onClick={() => handleFilterChange(option.id)}
                type="button"
                variant="tertiary"
              >
                <span className="flex min-w-0 flex-col items-center gap-1">
                  <Icon className="h-5 w-5" />
                  <span className="truncate text-xs">{option.label}</span>
                </span>
              </Button>
            )
          })}
          </div>
        </div>

        {canScrollTabsBack ? (
          <>
            <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[var(--background)] to-transparent" />
            <button
              aria-label="Ver pestanas anteriores"
              className="absolute left-1 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]"
              onClick={() => scrollTabs(-1)}
              type="button"
            >
              <ChevronLeft className="h-5 w-5" />
            </button>
          </>
        ) : null}

        {canScrollTabsForward ? (
          <>
            <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[var(--background)] to-transparent" />
            <button
              aria-label="Ver mas pestanas"
              className="absolute right-1 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]"
              onClick={() => scrollTabs(1)}
              type="button"
            >
              <ChevronRight className="h-5 w-5" />
            </button>
          </>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <div className="border-b border-[var(--separator)] p-4">
          <div className="flex min-h-12 items-center gap-2 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3">
            <Search className="h-5 w-5 shrink-0 text-[var(--muted)]" />
            <input
              className="h-full min-w-0 flex-1 bg-transparent text-[var(--field-foreground)] outline-none"
              onChange={(event) => {
                setSearch(event.target.value)
                setSelectedCategoryId(null)
              }}
              placeholder="Buscar producto..."
              value={search}
            />
            {search ? (
              <Button onClick={() => setSearch('')} size="sm" type="button" variant="tertiary">
                <X className="h-4 w-4" />
              </Button>
            ) : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {selectedCategory ? (
            <div className="mb-3 flex items-center gap-2">
              <Button onClick={() => setSelectedCategoryId(null)} size="sm" type="button" variant="tertiary">
                <ArrowLeft className="h-4 w-4" />
                {selectedCategory.name}
              </Button>
            </div>
          ) : null}

          {showProductGrid ? (
            visibleProducts.length ? (
              <div className="grid grid-cols-3 gap-3 md:grid-cols-4 2xl:grid-cols-5">
                {visibleProducts.map((product) => {
                  const saleFormat = getProductSaleFormat(product, productFilter)
                  const primaryVariant = getProductVariantForSaleFormat(product, saleFormat)
                  const allowFormatSelection = productFilter === 'all' || productFilter === 'top'
                  const ProductIcon = getCatalogKindIcon(product.kind, productFilter)

                  return (
                    <button
                      className="flex min-h-8 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={disabled || !primaryVariant}
                      key={product.id}
                      onClick={(event) => onSelectProduct(product, saleFormat, allowFormatSelection, event.currentTarget)}
                      type="button"
                    >
                      <span className="grid aspect-square w-full place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
                        {product.imageUrl ? (
                          <img alt="" className="h-full w-full object-cover" src={product.imageUrl} />
                        ) : (
                          <ProductIcon className="h-9 w-9" />
                        )}
                      </span>
                      <span className="flex min-h-0 flex-1 flex-col justify-between p-2">
                        <span>
                          <span className="line-clamp-2 font-bold text-[var(--foreground)]">{product.name}</span>
                          <span className="mt-1 block text-sm text-[var(--muted)]">
                            {product.variants.length <= 1 ? null : `${product.variants.length} formatos`}
                          </span>
                        </span>
                        <span className="mt-0 font-mono text-xl font-black tabular-nums text-[var(--foreground)]">
                          {primaryVariant ? formatMoney(primaryVariant.priceCents) : 'Sin precio'}
                        </span>
                      </span>
                    </button>
                  )
                })}
              </div>
            ) : (
              <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
                No hay resultados en este catalogo.
              </div>
            )
          ) : null}

          {showCategories ? (
            <div className={`${showProductGrid && visibleProducts.length ? 'mt-3 ' : ''}grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5`}>
              {visibleCategoriesWithProducts.map((category) => {
                const Icon = getCatalogKindIcon(category.kind, activeFilter)
                const count = categoryProductCounts.get(category.id) ?? 0

                return (
                  <button
                    className="min-h-28 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
                    disabled={disabled || count === 0}
                    key={category.id}
                    onClick={() => setSelectedCategoryId(category.id)}
                    type="button"
                  >
                    <Icon className="mb-3 h-6 w-6 text-[var(--accent)]" />
                    <p className="font-bold text-[var(--foreground)]">{category.name}</p>
                    <p className="mt-1 text-sm text-[var(--muted)]">{count} productos</p>
                  </button>
                )
              })}
            </div>
          ) : null}
        </div>
      </div>
    </section>
  )
}
