import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { CategoryFormPanel } from '../forms/CategoryForm'
import { EmptyList } from '../../shared/components/EmptyList'
import { Pencil, Plus, Search, Trash2 } from 'lucide-react'
import { deleteCategory } from '../services/catalogService'
import { type Category, type Product, type TenantContext } from '../../../../types'
import { type RunAction } from '../../shared/types'
import { useMemo, useState } from 'react'

export type CategoriesCrmProps = {
  categories: Category[]
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  tenantContext: TenantContext
}

export type CategoryEditorState =
  | {
      mode: 'create'
    }
  | {
      categoryId: string
      mode: 'edit'
    }

export function CategoriesCrm({ categories, disabled, onCatalogChanged, products, runAction, tenantContext }: CategoriesCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
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

    return categories.filter((category) => category.name.toLowerCase().includes(normalizedQuery))
  }, [categories, query])
  const totalPages = Math.max(1, Math.ceil(filteredCategories.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedCategories = filteredCategories.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
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
    <div className={editor?.mode === 'edit' ? 'crm-entity-layout !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1fr)_410px] xl:!gap-6' : 'crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4'}>
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Categorias</h2>
            <p>{filteredCategories.length} de {categories.length} categorias</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar categoria"
                value={query}
              />
            </label>
            <button className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => setEditor({ mode: 'create' })} type="button">
              <Plus className="h-4 w-4" />
              Anadir categoria
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-categories-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Categoria</span>
            <span>Funcion</span>
            <span>Productos</span>
            <span>Estado</span>
            <span>Acciones</span>
          </div>
          {paginatedCategories.map((category) => {
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
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredCategories.length}
        />
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

export type CategoryListRowProps = {
  category: Category
  disabled: boolean
  onDelete: () => void
  onEdit: () => void
  productCount: number
}

export function CategoryListRow({ category, disabled, onDelete, onEdit, productCount }: CategoryListRowProps) {
  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <div className="crm-cell-main">
        <strong>{category.name}</strong>
        <span>Orden {category.sortOrder}</span>
      </div>
      <span>Organizacion visual</span>
      <strong>{productCount}</strong>
      <span className={category.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {category.isActive ? 'Activa' : 'Oculta'}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onEdit} type="button">
          <Pencil className="h-4 w-4" />
          Editar
        </button>
        <button
          className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
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
