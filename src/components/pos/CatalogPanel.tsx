import {
  ArrowLeft,
  Beer,
  GlassWater,
  Martini,
  ReceiptText,
  Search,
  Wine,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import {
  canSellProductStandalone,
  getProductSaleFormats,
  getProductVariantForSaleFormat,
  productSupportsSaleFormat,
} from '../../lib/catalog'
import { formatMoney, normalizeText } from '../../lib/format'
import type { Catalog, CatalogFilter, CatalogKind, Product, SaleFormat } from '../../types'
import { Button } from '../ui'

const filterOptions: Array<{ id: CatalogFilter; label: string; icon: LucideIcon }> = [
  { id: 'all', label: 'Todo', icon: ReceiptText },
  { id: 'cubata', label: 'Cubata', icon: Martini },
  { id: 'copa', label: 'Copa', icon: Wine },
  { id: 'shot', label: 'Chupito', icon: Wine },
  { id: 'beer_bottle', label: 'Cerveza', icon: Beer },
  { id: 'soft_bottle', label: 'Refresco', icon: GlassWater },
  { id: 'cocktail', label: 'Coctel', icon: Martini },
]

function getCatalogKindIcon(kind: CatalogKind, activeFilter: CatalogFilter) {
  if (activeFilter !== 'all') {
    return filterOptions.find((option) => option.id === activeFilter)?.icon ?? GlassWater
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
  if (filter === 'all') {
    return null
  }
  if (filter === 'cubata' || filter === 'copa' || filter === 'shot') {
    return ['alcohol', 'mixed', 'shot']
  }
  if (filter === 'beer_bottle') {
    return ['beer_bottle', 'beer']
  }
  if (filter === 'soft_bottle') {
    return ['soft_bottle', 'mixer', 'other']
  }
  if (filter === 'cocktail') {
    return ['cocktail']
  }

  return null
}

function getProductSaleFormat(product: Product, activeFilter: CatalogFilter): SaleFormat {
  if (activeFilter !== 'all') {
    return activeFilter
  }

  return getProductSaleFormats(product)[0] ?? 'soft_bottle'
}

type CatalogPanelProps = {
  catalog: Catalog | null
  disabled: boolean
  onSelectProduct: (product: Product, saleFormat: SaleFormat) => void
}

export function CatalogPanel({ catalog, disabled, onSelectProduct }: CatalogPanelProps) {
  const [activeFilter, setActiveFilter] = useState<CatalogFilter>('all')
  const [search, setSearch] = useState('')
  const [selectedCategoryId, setSelectedCategoryId] = useState<string | null>(null)
  const categories = useMemo(() => catalog?.categories ?? [], [catalog])
  const products = useMemo(() => catalog?.products ?? [], [catalog])
  const normalizedSearch = normalizeText(search.trim())

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
      .filter((product) => activeFilter === 'all' || productSupportsSaleFormat(product, activeFilter))
      .filter((product) => activeFilter !== 'soft_bottle' || canSellProductStandalone(product))
      .filter((product) => activeFilter !== 'beer_bottle' || canSellProductStandalone(product))
      .filter((product) => activeFilter !== 'cocktail' || canSellProductStandalone(product))
      .filter((product) => activeFilter !== 'all' || canSellProductStandalone(product))
      .filter((product) => !selectedCategoryId || product.categoryId === selectedCategoryId)
      .filter((product) => {
        if (!normalizedSearch) {
          return true
        }

        const categoryName = categories.find((category) => category.id === product.categoryId)?.name ?? ''
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
      .sort((a, b) => a.sortOrder - b.sortOrder)
  }, [activeFilter, categories, normalizedSearch, products, selectedCategoryId])

  const showCategories = !normalizedSearch && !selectedCategoryId
  const selectedCategory = selectedCategoryId
    ? categories.find((category) => category.id === selectedCategoryId) ?? null
    : null

  function handleFilterChange(filter: CatalogFilter) {
    setActiveFilter(filter)
    setSelectedCategoryId(null)
  }

  return (
    <section className="flex min-h-0 flex-1 flex-col gap-4">
      <div className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 shadow-[var(--shadow)]">
        <div className="grid grid-cols-7 gap-2 max-xl:grid-cols-4">
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

          {showCategories ? (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
              {visibleCategories.map((category) => {
                const Icon = getCatalogKindIcon(category.kind, activeFilter)
                const count = products.filter(
                  (product) =>
                    product.categoryId === category.id &&
                    product.isActive &&
                    (activeFilter === 'all' || productSupportsSaleFormat(product, activeFilter)) &&
                    (activeFilter === 'all' || activeFilter === 'cubata' || canSellProductStandalone(product)),
                ).length

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

          {!showCategories ? (
            visibleProducts.length ? (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-3 2xl:grid-cols-5">
                {visibleProducts.map((product) => {
                  const saleFormat = getProductSaleFormat(product, activeFilter)
                  const primaryVariant = getProductVariantForSaleFormat(product, saleFormat)

                  return (
                    <button
                      className="flex min-h-28 flex-col justify-between rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3 text-left transition hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:cursor-not-allowed disabled:opacity-45"
                      disabled={disabled || !primaryVariant}
                      key={product.id}
                      onClick={() => onSelectProduct(product, saleFormat)}
                      type="button"
                    >
                      <span>
                        <span className="line-clamp-2 font-bold text-[var(--foreground)]">{product.name}</span>
                        <span className="mt-1 block text-sm text-[var(--muted)]">
                          {product.variants.length <= 1 ? 'Formato unico' : `${product.variants.length} formatos`}
                        </span>
                      </span>
                      <span className="mt-3 font-mono text-xl font-black tabular-nums text-[var(--foreground)]">
                        {primaryVariant ? formatMoney(primaryVariant.priceCents) : 'Sin precio'}
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
        </div>
      </div>
    </section>
  )
}
