import { Button as UiButton } from '../../../../components/ui/Button'
import { ChevronLeft, ChevronRight } from 'lucide-react'

export const CRM_PAGE_SIZE = 12

export type CrmPaginationProps = {
  currentPage: number
  onPageChange: (page: number) => void
  totalResults: number
}

export function CrmPagination({ currentPage, onPageChange, totalResults }: CrmPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(totalResults / CRM_PAGE_SIZE))
  const firstResult = totalResults ? (currentPage - 1) * CRM_PAGE_SIZE + 1 : 0
  const lastResult = Math.min(currentPage * CRM_PAGE_SIZE, totalResults)
  const firstVisiblePage = Math.max(1, Math.min(currentPage - 2, totalPages - 4))
  const lastVisiblePage = Math.min(totalPages, firstVisiblePage + 4)
  const visiblePages = Array.from(
    { length: lastVisiblePage - firstVisiblePage + 1 },
    (_, index) => firstVisiblePage + index,
  )

  return (
    <div className="!flex !min-h-[68px] !flex-col !items-center !justify-between !gap-3 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-3.5 sm:!flex-row md:!px-[22px]">
      <p className="!m-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">
        Mostrando {firstResult}-{lastResult} de {totalResults} resultados
      </p>
      <nav aria-label="Paginacion de resultados" className="!flex !flex-wrap !items-center !justify-center !gap-1.5">
        <UiButton
          aria-label="Pagina anterior"
          className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-9 !items-center !justify-center !gap-1.5 !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !px-2.5 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          disabled={currentPage === 1}
          onClick={() => onPageChange(currentPage - 1)}
          type="button"
        >
          <ChevronLeft className="!size-4" />
          <span className="!hidden sm:!inline">Anterior</span>
        </UiButton>
        {visiblePages.map((page) => (
          <UiButton
            aria-current={page === currentPage ? 'page' : undefined}
            aria-label={`Pagina ${page}`}
            className={page === currentPage
              ? '!inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-blue)] !p-0 !text-xs !font-bold !text-white !shadow-none !transition-[background-color,color,transform] !duration-150'
              : 'inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-9 !min-h-9 !min-w-9 !items-center !justify-center !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !p-0 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
            key={page}
            onClick={() => onPageChange(page)}
            type="button"
          >
            {page}
          </UiButton>
        ))}
        <UiButton
          aria-label="Pagina siguiente"
          className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-9 !items-center !justify-center !gap-1.5 !rounded-[9px] !border-0 !bg-[var(--crm-surface-soft)] !px-2.5 !text-xs !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          disabled={currentPage === totalPages}
          onClick={() => onPageChange(currentPage + 1)}
          type="button"
        >
          <span className="!hidden sm:!inline">Siguiente</span>
          <ChevronRight className="!size-4" />
        </UiButton>
      </nav>
    </div>
  )
}
