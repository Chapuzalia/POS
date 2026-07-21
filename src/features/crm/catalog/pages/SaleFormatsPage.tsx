import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { CrmModal } from '../../shared/components/CrmModal'
import { EmptyList } from '../../shared/components/EmptyList'
import { Field } from '../../shared/components/Field'
import { Plus, Save, Search, Trash2, X } from 'lucide-react'
import { createSaleFormat, deleteSaleFormat, updateSaleFormat } from '../services/catalogService'
import { getProductSaleFormats } from '../../../../lib/catalog'
import { type Product, type SaleFormat, type SaleFormatDefinition, type TenantContext } from '../../../../types'
import { type RunAction } from '../../shared/types'
import { useMemo, useState } from 'react'

export type SaleFormatsCrmProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  products: Product[]
  runAction: RunAction
  saleFormats: SaleFormatDefinition[]
  tenantContext: TenantContext
}

export function SaleFormatsCrm({
  disabled,
  onCatalogChanged,
  products,
  runAction,
  saleFormats,
  tenantContext,
}: SaleFormatsCrmProps) {
  const [query, setQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [newLabel, setNewLabel] = useState('')
  const productsByFormat = useMemo(() => {
    const nextMap = new Map<SaleFormat, number>()
    products.forEach((product) => {
      getProductSaleFormats(product).forEach((format) => {
        nextMap.set(format, (nextMap.get(format) ?? 0) + 1)
      })
    })
    return nextMap
  }, [products])
  const filteredSaleFormats = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase()

    if (!normalizedQuery) {
      return saleFormats
    }

    return saleFormats.filter((format) =>
      [format.label, format.key].join(' ').toLowerCase().includes(normalizedQuery),
    )
  }, [query, saleFormats])
  const totalPages = Math.max(1, Math.ceil(filteredSaleFormats.length / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const paginatedSaleFormats = filteredSaleFormats.slice(
    (visiblePage - 1) * CRM_PAGE_SIZE,
    visiblePage * CRM_PAGE_SIZE,
  )
  const nextSortOrder = Math.max(0, ...saleFormats.map((format) => format.sortOrder)) + 1

  function closeCreateDialog() {
    setIsCreateOpen(false)
    setNewLabel('')
  }

  async function addSaleFormat() {
    if (!newLabel.trim()) {
      return
    }

    await runAction(async () => {
      await createSaleFormat(tenantContext, {
        label: newLabel,
        sortOrder: nextSortOrder,
      })
      await onCatalogChanged()
      setNewLabel('')
      setIsCreateOpen(false)
    })
  }

  async function handleDeleteSaleFormat(saleFormat: SaleFormatDefinition) {
    const productCount = productsByFormat.get(saleFormat.key) ?? 0
    const message = productCount
      ? `Eliminar "${saleFormat.label}" y quitarlo de ${productCount} productos?`
      : `Eliminar "${saleFormat.label}"?`

    if (!window.confirm(message)) {
      return
    }

    await runAction(async () => {
      await deleteSaleFormat(tenantContext, saleFormat)
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-entity-layout crm-entity-layout-full !grid !grid-cols-1 !items-start !gap-4">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-list-panel !min-h-0 xl:!min-h-[calc(100dvh-var(--crm-topbar-height)-78px)]">
        <div className="crm-list-toolbar !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Formatos de venta</h2>
            <p>{filteredSaleFormats.length} de {saleFormats.length} formatos</p>
          </div>
          <div className="crm-toolbar-actions !flex !min-w-0 !flex-col !items-stretch !justify-end !gap-[9px] md:!flex-row md:!items-center">
            <label className="crm-search !flex !h-11 !w-full !items-center !gap-2 !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-[13px] !text-[13px] !font-medium !text-[var(--crm-text-muted)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 md:!w-[min(320px,100%)]">
              <Search className="h-4 w-4" />
              <input
                onChange={(event) => {
                  setQuery(event.target.value)
                  setCurrentPage(1)
                }}
                placeholder="Buscar formato"
                value={query}
              />
            </label>
            <button
              className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled}
              onClick={() => setIsCreateOpen(true)}
              type="button"
            >
              <Plus className="h-4 w-4" />
              Anadir formato
            </button>
          </div>
        </div>

        <div className="crm-data-table !grid !overflow-auto crm-sale-formats-table">
          <div className="crm-data-head !sticky !top-0 !z-[1] !grid !min-h-[50px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[22px] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
            <span>Formato</span>
            <span>Clave</span>
            <span>Productos</span>
            <span>Orden</span>
            <span>Estado</span>
            <span>Acciones</span>
          </div>
          {paginatedSaleFormats.map((saleFormat) => (
            <SaleFormatListRow
              disabled={disabled}
              key={saleFormat.key}
              onCatalogChanged={onCatalogChanged}
              onDelete={() => void handleDeleteSaleFormat(saleFormat)}
              productCount={productsByFormat.get(saleFormat.key) ?? 0}
              runAction={runAction}
              saleFormat={saleFormat}
              tenantContext={tenantContext}
            />
          ))}
          {!filteredSaleFormats.length ? <EmptyList message="No hay formatos que coincidan con la busqueda." /> : null}
        </div>
        <CrmPagination
          currentPage={visiblePage}
          onPageChange={setCurrentPage}
          totalResults={filteredSaleFormats.length}
        />
      </section>

      {isCreateOpen ? (
        <CrmModal label="Anadir formato de venta" onClose={closeCreateDialog}>
          <div className="crm-editor-header !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
            <div>
              <span>Nuevo formato de venta</span>
              <small>Define el nombre que aparecera en el catalogo.</small>
            </div>
            <button
              aria-label="Cerrar dialogo de formato"
              className="crm-editor-close !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              onClick={closeCreateDialog}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <form
            className="crm-form-stack !grid !min-h-0 !gap-3.5 !overflow-y-auto !px-[22px] !pt-5 !pb-[22px]"
            onSubmit={(event) => {
              event.preventDefault()
              void addSaleFormat()
            }}
          >
            <Field label="Nombre">
              <input
                autoFocus
                className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
                onChange={(event) => setNewLabel(event.target.value)}
                placeholder="Por ejemplo, Copa"
                value={newLabel}
              />
            </Field>
            <div className="crm-editor-actions">
              <button
                className="crm-secondary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
                onClick={closeCreateDialog}
                type="button"
              >
                Cancelar
              </button>
              <button
                className="crm-primary-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
                disabled={disabled || !newLabel.trim()}
                type="submit"
              >
                <Plus className="h-4 w-4" />
                Crear formato
              </button>
            </div>
          </form>
        </CrmModal>
      ) : null}
    </div>
  )
}

export type SaleFormatListRowProps = {
  disabled: boolean
  onCatalogChanged: () => Promise<void>
  onDelete: () => void
  productCount: number
  runAction: RunAction
  saleFormat: SaleFormatDefinition
  tenantContext: TenantContext
}

export function SaleFormatListRow({
  disabled,
  onCatalogChanged,
  onDelete,
  productCount,
  runAction,
  saleFormat,
  tenantContext,
}: SaleFormatListRowProps) {
  const [label, setLabel] = useState(saleFormat.label)
  const [sortOrder, setSortOrder] = useState(String(saleFormat.sortOrder))

  async function saveSaleFormat() {
    await runAction(async () => {
      await updateSaleFormat(tenantContext, saleFormat, {
        label,
        sortOrder: Number.parseInt(sortOrder, 10) || saleFormat.sortOrder,
      })
      await onCatalogChanged()
    })
  }

  async function toggleSaleFormat() {
    await runAction(async () => {
      await updateSaleFormat(tenantContext, saleFormat, {
        isActive: !saleFormat.isActive,
      })
      await onCatalogChanged()
    })
  }

  return (
    <div className="crm-data-row !grid !min-h-[72px] !min-w-[920px] !items-center !gap-3.5 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[22px] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] !transition-colors !duration-150 hover:!bg-[var(--crm-surface-hover)]">
      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150" onChange={(event) => setLabel(event.target.value)} value={label} />
      <code className="crm-code-cell">{saleFormat.key}</code>
      <strong>{productCount}</strong>
      <input className="crm-input !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150 !font-mono" inputMode="numeric" onChange={(event) => setSortOrder(event.target.value)} value={sortOrder} />
      <span className={saleFormat.isActive ? 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-active !bg-[var(--crm-green-soft)] !text-[var(--crm-green)]' : 'crm-status-pill !inline-flex !min-h-6 !w-fit !items-center !rounded-full !px-[9px] !text-[11px] !font-semibold crm-status-pill-muted !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-secondary)]'}>
        {saleFormat.isActive ? 'Activo' : 'Oculto'}
      </span>
      <div className="crm-action-group">
        <button className="crm-action-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-text)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void saveSaleFormat()} type="button">
          <Save className="h-4 w-4" />
          Guardar
        </button>
        <button
          className={saleFormat.isActive ? 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150' : 'crm-state-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-green-soft)] !px-[13px] !text-[13px] !font-semibold !text-[var(--crm-green)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150 crm-state-button-danger !bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'}
          disabled={disabled}
          onClick={() => void toggleSaleFormat()}
          type="button"
        >
          {saleFormat.isActive ? 'Ocultar' : 'Activar'}
        </button>
        <button className="crm-danger-button !inline-flex !min-h-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-red-soft)] !px-[11px] !text-[13px] !font-semibold !text-[var(--crm-red)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={onDelete} type="button">
          <Trash2 className="h-4 w-4" />
          Eliminar
        </button>
      </div>
    </div>
  )
}
