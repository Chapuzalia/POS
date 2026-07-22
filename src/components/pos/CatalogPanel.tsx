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
import { getActiveTabs, getCategoriesForTab, resolveSellableCatalog } from '../../features/catalog/domain/resolver'
import type { CatalogData, ResolvedCatalogItem } from '../../features/catalog/domain/types'
import { formatMoney, normalizeText } from '../../lib/format'
import type { CatalogStartTab, ProductSalesStat } from '../../types'
import { Button } from '../ui'
import { getAvailableFormatCounts, groupCatalogItemsByProduct } from './catalogPanelModel'

const catalogIcons: Record<string, LucideIcon> = {
  beer_bottle: Beer,
  cocktail: Martini,
  copa: Wine,
  cubata: Martini,
  shot: Wine,
  soft_bottle: GlassWater,
}

type CatalogFilter = CatalogStartTab | string

function getCatalogIcon(icon: string, activeFilter: CatalogFilter) {
  if (activeFilter === 'top') return BarChart3
  if (activeFilter === 'all') return catalogIcons[icon] ?? GlassWater
  return catalogIcons[icon] ?? ReceiptText
}

function compareItems(left: ResolvedCatalogItem, right: ResolvedCatalogItem) {
  return left.product.name.localeCompare(right.product.name, 'es', { sensitivity: 'base' })
    || left.sortOrder - right.sortOrder
    || left.placement.id.localeCompare(right.placement.id)
}

type CatalogPanelProps = {
  catalog: CatalogData | null
  catalogStartTab: CatalogStartTab
  disabled: boolean
  onSelectProduct: (item: ResolvedCatalogItem, allowVariantSelection: boolean, sourceElement: HTMLElement) => void
  productSalesStats: ProductSalesStat[]
}

export function CatalogPanel({ catalog, catalogStartTab, disabled, onSelectProduct, productSalesStats }: CatalogPanelProps) {
  const [activeFilter, setActiveFilter] = useState<CatalogFilter>(catalogStartTab)
  const [search, setSearch] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const [canScrollTabsBack, setCanScrollTabsBack] = useState(false)
  const [canScrollTabsForward, setCanScrollTabsForward] = useState(false)
  const tabsScrollerRef = useRef<HTMLDivElement | null>(null)
  const resolved = useMemo(() => catalog ? resolveSellableCatalog(catalog) : { items: [], internalProducts: [], rejected: [] }, [catalog])
  const catalogTabs = useMemo(() => catalog ? getActiveTabs(catalog) : [], [catalog])
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
        icon: getCatalogIcon(tab.icon || tab.key, tab.id),
      })),
    ],
    [catalogStartTab, catalogTabs],
  )
  const categoryById = useMemo(
    () => new Map((catalog?.categories ?? []).map((category) => [category.id, category])),
    [catalog],
  )
  const normalizedSearch = normalizeText(search.trim())
  const productFilter: CatalogFilter = normalizedSearch ? 'all' : activeFilter
  const isTabFilter = activeFilter !== 'all' && activeFilter !== 'top'

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
    if (!scroller) return
    const resizeObserver = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(updateTabScrollState)
    resizeObserver?.observe(scroller)
    window.addEventListener('resize', updateTabScrollState)
    return () => {
      resizeObserver?.disconnect()
      window.removeEventListener('resize', updateTabScrollState)
    }
  }, [filterOptions.length])

  const activeItems = useMemo(() => {
    const source = productFilter === 'all' || productFilter === 'top'
      ? resolved.items
      : resolved.items.filter((item) => item.tab.id === productFilter)
    return source.filter((item) => {
      if (productFilter === 'top' && (productSalesById.get(item.product.id)?.quantity ?? 0) <= 0) return false
      if (selectedCategoryId && item.category?.id !== selectedCategoryId) return false
      if (!normalizedSearch && productFilter !== 'all' && productFilter !== 'top') {
        if (selectedCategoryId ? item.featured : !item.featured) return false
      }
      if (!normalizedSearch) return true
      const variantNames = catalog?.variants
        .filter((variant) => variant.productId === item.product.id && variant.active)
        .map((variant) => variant.name) ?? []
      const searchable = normalizeText([
        item.product.name,
        item.product.description ?? '',
        item.category?.name ?? '',
        item.tab.label,
        ...variantNames,
      ].join(' '))
      return searchable.includes(normalizedSearch)
    })
  }, [catalog, normalizedSearch, productFilter, productSalesById, resolved.items, selectedCategoryId])

  const availableFormatCounts = useMemo(() => getAvailableFormatCounts(activeItems), [activeItems])

  const visibleEntries = useMemo(() => groupCatalogItemsByProduct(activeItems).sort((left, right) => {
    if (productFilter !== 'top') return compareItems(left, right)
    const firstStat = productSalesById.get(left.product.id)
    const secondStat = productSalesById.get(right.product.id)
    return (secondStat?.quantity ?? 0) - (firstStat?.quantity ?? 0)
      || (secondStat?.totalCents ?? 0) - (firstStat?.totalCents ?? 0)
      || compareItems(left, right)
  }), [activeItems, productFilter, productSalesById])

  const visibleCategories = useMemo(() => {
    if (!catalog) return []
    const categoryIds = new Set((productFilter === 'all' || productFilter === 'top' ? resolved.items : resolved.items
      .filter((item) => item.tab.id === productFilter)).flatMap((item) => item.category?.id ?? []))
    const source = isTabFilter ? getCategoriesForTab(catalog, activeFilter) : catalog.categories.filter((category) => category.active)
    return source.filter((category) => categoryIds.has(category.id))
  }, [activeFilter, catalog, isTabFilter, productFilter, resolved.items])

  const categoryProductCounts = useMemo(() => new Map(visibleCategories.map((category) => [
    category.id,
    resolved.items.filter((item) => item.category?.id === category.id
      && (activeFilter === 'all' || activeFilter === 'top' || item.tab.id === activeFilter)
      && (activeFilter === 'all' || activeFilter === 'top' || !item.featured)).length,
  ])), [activeFilter, resolved.items, visibleCategories])
  const visibleCategoriesWithProducts = visibleCategories.filter((category) => (categoryProductCounts.get(category.id) ?? 0) > 0)
  const showCategories = activeFilter !== 'top'
    && !normalizedSearch
    && !selectedCategoryId
    && (isTabFilter ? visibleCategoriesWithProducts.length > 0 : visibleCategoriesWithProducts.length > 1)
  const showProductGrid = !showCategories || (isTabFilter && visibleEntries.length > 0)
  const selectedCategory = selectedCategoryId ? categoryById.get(selectedCategoryId) ?? null : null

  function handleFilterChange(filter: CatalogFilter) {
    if (filter !== activeFilter && search) setSearch('')
    setActiveFilter(filter)
    setSelectedCategoryId(null)
  }

  function updateTabScrollState() {
    const scroller = tabsScrollerRef.current
    if (!scroller) return
    const maxScrollLeft = scroller.scrollWidth - scroller.clientWidth
    setCanScrollTabsBack(scroller.scrollLeft > 1)
    setCanScrollTabsForward(scroller.scrollLeft < maxScrollLeft - 1)
  }

  function scrollTabs(direction: -1 | 1) {
    const scroller = tabsScrollerRef.current
    if (scroller) scroller.scrollBy({ left: direction * scroller.clientWidth, behavior: 'smooth' })
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
      <div className="relative min-w-0 max-w-full">
        <div className="catalog-tabs-scroll min-w-0 max-w-full overflow-x-auto pb-1" onScroll={updateTabScrollState} ref={tabsScrollerRef}>
          <div className="grid min-w-full grid-flow-col gap-2 lg:auto-cols-[calc((100%-3rem)/7)]">
            {filterOptions.map((option) => {
              const Icon = option.icon
              return <Button active={activeFilter === option.id} fullWidth key={option.id} onClick={() => handleFilterChange(option.id)} type="button" variant="tertiary">
                <span className="flex min-w-0 flex-col items-center gap-1"><Icon className="h-5 w-5" /><span className="truncate text-xs">{option.label}</span></span>
              </Button>
            })}
          </div>
        </div>
        {canScrollTabsBack ? <>
          <div className="pointer-events-none absolute inset-y-0 left-0 w-12 bg-gradient-to-r from-[var(--background)] to-transparent" />
          <button aria-label="Ver pestañas anteriores" className="absolute left-1 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]" onClick={() => scrollTabs(-1)} type="button"><ChevronLeft className="h-5 w-5" /></button>
        </> : null}
        {canScrollTabsForward ? <>
          <div className="pointer-events-none absolute inset-y-0 right-0 w-12 bg-gradient-to-l from-[var(--background)] to-transparent" />
          <button aria-label="Ver más pestañas" className="absolute right-1 top-1/2 z-10 grid h-9 w-9 -translate-y-1/2 place-items-center rounded-full border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]" onClick={() => scrollTabs(1)} type="button"><ChevronRight className="h-5 w-5" /></button>
        </> : null}
      </div>

      <div className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
        <div className="border-b border-[var(--separator)] p-4">
          <div className="flex min-h-12 items-center gap-2 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3">
            <Search className="h-5 w-5 shrink-0 text-[var(--muted)]" />
            <input className="h-full min-w-0 flex-1 bg-transparent text-[var(--field-foreground)] outline-none" onChange={(event) => { setSearch(event.target.value); setSelectedCategoryId(null) }} placeholder="Buscar producto..." value={search} />
            {search ? <Button onClick={() => setSearch('')} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button> : null}
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {selectedCategory ? <div className="mb-3 flex items-center gap-2"><Button onClick={() => setSelectedCategoryId(null)} size="sm" type="button" variant="tertiary"><ArrowLeft className="h-4 w-4" />{selectedCategory.name}</Button></div> : null}
          {showProductGrid ? visibleEntries.length ? (
            <div className="grid grid-cols-3 gap-3 md:grid-cols-4 2xl:grid-cols-5">
              {visibleEntries.map((item) => {
                const availableFormatCount = availableFormatCounts.get(item.product.id) ?? 1
                const ProductIcon = getCatalogIcon(item.tab.icon ?? item.category?.icon ?? '', productFilter)
                return <button
                  className="flex min-h-8 flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
                  disabled={disabled}
                  key={item.placement.id}
                  onClick={(event) => onSelectProduct(item, availableFormatCount > 1, event.currentTarget)}
                  type="button"
                >
                  <span className="grid aspect-square w-full place-items-center overflow-hidden bg-[var(--surface-secondary)] text-[var(--accent)]">
                    {item.image?.publicUrl ? <img alt="" className="h-full w-full object-cover" src={item.image.publicUrl} /> : <ProductIcon className="h-9 w-9" />}
                  </span>
                  <span className="flex min-h-0 flex-1 flex-col justify-between p-2">
                    <span><span className="line-clamp-2 font-bold text-[var(--foreground)]">{item.product.name}</span>{availableFormatCount > 1 ? <span className="mt-1 block text-sm text-[var(--muted)]">{availableFormatCount} formatos</span> : null}</span>
                    {availableFormatCount === 1 ? <span className="mt-0 font-mono text-xl font-black tabular-nums text-[var(--foreground)]">{formatMoney(item.basePriceCents)}</span> : null}
                  </span>
                </button>
              })}
            </div>
          ) : <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">No hay resultados en este catálogo.</div> : null}

          {showCategories ? <div className={`${showProductGrid && visibleEntries.length ? 'mt-3 ' : ''}grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5`}>
            {visibleCategoriesWithProducts.map((category) => {
              const Icon = getCatalogIcon(category.icon ?? '', activeFilter)
              const count = categoryProductCounts.get(category.id) ?? 0
              return <button className="min-h-28 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45" disabled={disabled || count === 0} key={category.id} onClick={() => setSelectedCategoryId(category.id)} type="button">
                <Icon className="mb-3 h-6 w-6 text-[var(--accent)]" /><p className="font-bold text-[var(--foreground)]">{category.name}</p><p className="mt-1 text-sm text-[var(--muted)]">{count} productos</p>
              </button>
            })}
          </div> : null}
        </div>
      </div>
    </section>
  )
}
