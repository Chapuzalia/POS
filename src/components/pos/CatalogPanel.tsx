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
  getProductSaleFormats,
} from '../../lib/catalog'
import { getCatalogPlacements, getCatalogTabs } from '../../features/catalog/services/catalogAccess'
import { formatMoney, normalizeText } from '../../lib/format'
import type { Catalog, CatalogFilter, CatalogPlacement, CatalogStartTab, Product, ProductSalesStat, ProductVariant, SaleFormat, SaleLineCatalogSnapshot } from '../../types'
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

function getCatalogIcon(icon: string, activeFilter: CatalogFilter) {
  if (activeFilter === 'top') {
    return BarChart3
  }

  if (activeFilter !== 'all') {
    return getSaleFormatIcon(activeFilter)
  }

  return saleFormatIcons[icon] ?? GlassWater
}

function getProductSaleFormat(product: Product, variant: ProductVariant | null): SaleFormat {
  return variant?.saleFormatKey ?? getProductSaleFormats(product)[0] ?? 'other'
}

type CatalogPanelProps = {
  catalog: Catalog | null
  catalogStartTab: CatalogStartTab
  disabled: boolean
  onSelectProduct: (product: Product, saleFormat: SaleFormat, allowFormatSelection: boolean, sourceElement: HTMLElement, catalogSnapshot: SaleLineCatalogSnapshot) => void
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
  const catalogTabs = useMemo(() => catalog ? getCatalogTabs(catalog) : [], [catalog])
  const allPlacements = useMemo(() => catalog ? getCatalogPlacements(catalog) : [], [catalog])
  const productSalesById = useMemo(
    () => new Map(productSalesStats.map((stat) => [stat.productId, stat])),
    [productSalesStats],
  )
  const filterOptions = useMemo(
    () => [
      catalogStartTab === 'top'
        ? { id: 'top', label: 'Top items', icon: BarChart3 }
        : { id: 'all', label: 'Todo', icon: ReceiptText },
      ...catalogTabs.map((tab) => ({
        id: tab.id,
        label: tab.label,
        icon: getSaleFormatIcon(tab.icon || tab.key),
      })),
    ],
    [catalogStartTab, catalogTabs],
  )
  const categoryById = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const normalizedSearch = normalizeText(search.trim())
  const productFilter: CatalogFilter = normalizedSearch ? 'all' : activeFilter
  const isFormatFilter = activeFilter !== 'all' && activeFilter !== 'top'

  useEffect(() => {
    setActiveFilter(catalogStartTab)
    setSelectedCategoryId(null)
  }, [catalogStartTab])

  useEffect(() => {
    if (activeFilter !== 'all' && activeFilter !== 'top' && !catalogTabs.some((tab) => tab.id === activeFilter)) {
      setActiveFilter(catalogStartTab)
      setSelectedCategoryId(null)
    }
  }, [activeFilter, catalogStartTab, catalogTabs])

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

  const activePlacements = useMemo(() => {
    const source = productFilter === 'all' || productFilter === 'top'
      ? allPlacements
      : allPlacements.filter((placement) => placement.tabId === productFilter)
    const byProduct = new Map<string, CatalogPlacement>()
    for (const placement of source) {
      if (!byProduct.has(placement.productId)) byProduct.set(placement.productId, placement)
    }
    return [...byProduct.values()]
  }, [allPlacements, productFilter])

  const visibleCategories = useMemo(() => {
    const categoryIds = new Set(activePlacements.map((placement) => placement.categoryId))
    return categories.filter((category) => category.isActive && categoryIds.has(category.id))
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [activePlacements, categories])

  const visibleEntries = useMemo(() => activePlacements
    .flatMap((placement) => {
      const product = products.find((candidate) => candidate.id === placement.productId)
      if (!product?.isActive || ((productFilter === 'all' || productFilter === 'top') && !canSellProductStandalone(product))) return []
      if (productFilter === 'top' && (productSalesById.get(product.id)?.quantity ?? 0) <= 0) return []
      if (selectedCategoryId && placement.categoryId !== selectedCategoryId) return []
      if (!normalizedSearch && productFilter !== 'all' && productFilter !== 'top') {
        if (selectedCategoryId ? placement.isFeatured : !placement.isFeatured) return []
      }
      if (normalizedSearch) {
        const categoryName = categoryById.get(placement.categoryId)?.name ?? ''
        const searchable = normalizeText([product.name, product.description ?? '', categoryName, ...product.variants.map((variant) => variant.name)].join(' '))
        if (!searchable.includes(normalizedSearch)) return []
      }
      const variant = product.variants.find((candidate) => candidate.id === placement.defaultVariantId && candidate.isActive !== false)
        ?? product.variants.find((candidate) => candidate.isDefault && candidate.isActive !== false)
        ?? product.variants.find((candidate) => candidate.isActive !== false)
        ?? null
      return [{ product, placement, variant }]
    })
    .sort((a, b) => {
      if (productFilter !== 'top') return compareProductNames(a.product, b.product)
      const firstStat = productSalesById.get(a.product.id)
      const secondStat = productSalesById.get(b.product.id)
      return (secondStat?.quantity ?? 0) - (firstStat?.quantity ?? 0)
        || (secondStat?.totalCents ?? 0) - (firstStat?.totalCents ?? 0)
        || compareProductNames(a.product, b.product)
    }), [activePlacements, categoryById, normalizedSearch, productFilter, productSalesById, products, selectedCategoryId])

  const categoryProductCounts = useMemo(() => new Map(visibleCategories.map((category) => [
    category.id,
    activePlacements.filter((placement) => placement.categoryId === category.id && (
      activeFilter === 'all' || activeFilter === 'top' || !placement.isFeatured
    )).length,
  ])), [activeFilter, activePlacements, visibleCategories])
  const visibleCategoriesWithProducts = visibleCategories.filter((category) => (categoryProductCounts.get(category.id) ?? 0) > 0)
  const showCategories =
    activeFilter !== 'top' &&
    !normalizedSearch &&
    !selectedCategoryId &&
    (isFormatFilter ? visibleCategoriesWithProducts.length > 0 : visibleCategoriesWithProducts.length > 1)
  const showProductGrid = !showCategories || (isFormatFilter && visibleEntries.length > 0)
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
            visibleEntries.length ? (
              <div className="grid grid-cols-3 gap-3 md:grid-cols-4 2xl:grid-cols-5">
                {visibleEntries.map(({ product, placement, variant: primaryVariant }) => {
                  const saleFormat = getProductSaleFormat(product, primaryVariant)
                  const allowFormatSelection = productFilter === 'all' || productFilter === 'top'
                  const tabIcon = catalogTabs.find((tab) => tab.id === placement.tabId)?.icon
                  const ProductIcon = getCatalogIcon(tabIcon ?? categoryById.get(placement.categoryId)?.icon ?? '', productFilter)

                  return (
                    <button
                      className="flex min-h-8 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={disabled || !primaryVariant}
                      key={product.id}
                      onClick={(event) => {
                        const tab = catalogTabs.find((candidate) => candidate.id === placement.tabId)
                        const category = categoryById.get(placement.categoryId)
                        const saleFormatDefinition = catalog?.saleFormats.find((format) => format.id === primaryVariant?.saleFormatId || format.key === primaryVariant?.saleFormatKey)
                        onSelectProduct(product, saleFormat, allowFormatSelection, event.currentTarget, {
                          saleFormatId: saleFormatDefinition?.id ?? primaryVariant?.saleFormatId ?? null,
                          saleFormatName: saleFormatDefinition?.label ?? primaryVariant?.name ?? '',
                          categoryId: category?.id ?? placement.categoryId,
                          categoryName: category?.name ?? '',
                          catalogTabId: tab?.id ?? placement.tabId,
                          catalogTabName: tab?.label ?? '',
                        })
                      }}
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
            <div className={`${showProductGrid && visibleEntries.length ? 'mt-3 ' : ''}grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5`}>
              {visibleCategoriesWithProducts.map((category) => {
                const Icon = getCatalogIcon(category.icon, activeFilter)
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
