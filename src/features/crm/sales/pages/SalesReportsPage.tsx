import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { DataTable as UiDataTable } from '../../../../components/ui/DataTable'
import { Ban, FileText, History, QrCode, RefreshCw, Send, SlidersHorizontal, X } from 'lucide-react'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { CrmModal } from '../../shared/components/CrmModal'
import { Field } from '../../shared/components/Field'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { KpiCard } from '../../dashboard/pages/DashboardPage'
import { formatMoney, normalizeText } from '../../../../lib/format'
import { getOperationalDayRangeIso } from '../../../../lib/operationalDay'
import { loadCrmSalesReportFilterOptions, loadCrmSalesReportPage, loadCrmSalesReports, type CrmSalesReportFilterOptions, type CrmSalesReportFilters, type CrmSalesReportPage } from '../services/salesReportsService'
import { buildSalesReportAggregates, buildSalesReportTicketTotals, buildSalesReportTotals, compareSalesReportValues, crmReportDateTimeFormatter, paymentLabels, salesReportTabs, type SalesReportAggregateView, type SalesReportSortDirection, type SalesReportSortKey, type SalesReportView } from '../services/salesReportModel'
import { type CrmSalesReportAggregate, type CrmSalesReports, type TenantContext } from '../../../../types'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type RunAction } from '../../shared/types'
import { openFiscalInvoiceDocument } from '../../integrations/services/fiscalInvoiceDocument'
import { cancelFiscalInvoice, fiscalQrDataUrl, issueFiscalTicket, loadFiscalInvoiceEvents, refreshFiscalInvoiceStatus, type FiscalCommunicationEvent } from '../../integrations/services/verifactiService'

export type SalesReportsCrmProps = {
  dayChangeTime: string | null
  disabled: boolean
  runAction: RunAction
  selectedVenueId: string
  tenantContext: TenantContext
  timeZone: string
}

function useDebouncedFilter(value: string, delayMs = 250) {
  const [debouncedValue, setDebouncedValue] = useState(value)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedValue(value), delayMs)
    return () => window.clearTimeout(timer)
  }, [delayMs, value])

  return debouncedValue
}

export function SalesReportsCrm({ dayChangeTime, disabled, runAction, selectedVenueId, tenantContext, timeZone }: SalesReportsCrmProps) {
  const [activeView, setActiveView] = useState<SalesReportView>('tickets')
  const [categoryQuery, setCategoryQuery] = useState('')
  const [currentPage, setCurrentPage] = useState(1)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [discountFilter, setDiscountFilter] = useState('all')
  const [filterOptions, setFilterOptions] = useState<CrmSalesReportFilterOptions | null>(null)
  const [isFiltersOpen, setIsFiltersOpen] = useState(false)
  const [isReportLoading, setIsReportLoading] = useState(true)
  const [productQuery, setProductQuery] = useState('')
  const [reports, setReports] = useState<CrmSalesReports | null>(null)
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)
  const [sortDirection, setSortDirection] = useState<SalesReportSortDirection>('desc')
  const [sortKey, setSortKey] = useState<SalesReportSortKey>('createdAt')
  const [ticketPage, setTicketPage] = useState<CrmSalesReportPage | null>(null)
  const debouncedProductQuery = useDebouncedFilter(productQuery)
  const debouncedCategoryQuery = useDebouncedFilter(categoryQuery)
  const requestVersion = useRef(0)
  const ticketPageNumber = activeView === 'tickets' ? currentPage : 1
  const ticketSortKey = activeView === 'tickets' ? sortKey : 'createdAt'
  const ticketSortDirection = activeView === 'tickets' ? sortDirection : 'desc'
  const operationalDayConfig = useMemo(() => ({ dayChangeTime, timeZone }), [dayChangeTime, timeZone])
  const reportFilters = useMemo<CrmSalesReportFilters>(() => ({
    categoryQuery: normalizeText(debouncedCategoryQuery.trim()),
    dateFromIso: dateFrom ? getOperationalDayRangeIso(operationalDayConfig, dateFrom).startIso : null,
    dateToIso: dateTo ? getOperationalDayRangeIso(operationalDayConfig, dateTo).endIso : null,
    discountFilter,
    productQuery: normalizeText(debouncedProductQuery.trim()),
  }), [dateFrom, dateTo, debouncedCategoryQuery, debouncedProductQuery, discountFilter, operationalDayConfig])
  const refresh = useCallback(async () => {
    const version = requestVersion.current + 1
    requestVersion.current = version
    setIsReportLoading(true)

    try {
      if (activeView === 'tickets') {
        const nextPage = await loadCrmSalesReportPage(
          tenantContext,
          selectedVenueId,
          reportFilters,
          ticketPageNumber,
          CRM_PAGE_SIZE,
          ticketSortKey,
          ticketSortDirection,
        )
        if (requestVersion.current !== version) return
        setTicketPage(nextPage)
        setReports(null)
        return
      }

      const nextReports = await loadCrmSalesReports(tenantContext, selectedVenueId, reportFilters)
      if (requestVersion.current !== version) return
      setReports(nextReports)
      setTicketPage(null)
    } finally {
      if (requestVersion.current === version) setIsReportLoading(false)
    }
  }, [activeView, reportFilters, selectedVenueId, tenantContext, ticketPageNumber, ticketSortDirection, ticketSortKey])

  useEffect(() => {
    setReports(null)
    setTicketPage(null)
    setFilterOptions(null)
    setCurrentPage(1)
    setSelectedTicketId(null)
  }, [selectedVenueId, tenantContext])

  useEffect(() => {
    void runAction(refresh)
  }, [refresh, runAction])

  useEffect(() => {
    if (!isFiltersOpen || filterOptions) return
    let cancelled = false
    void runAction(async () => {
      const options = await loadCrmSalesReportFilterOptions(tenantContext, selectedVenueId)
      if (!cancelled) setFilterOptions(options)
    })
    return () => { cancelled = true }
  }, [filterOptions, isFiltersOpen, runAction, selectedVenueId, tenantContext])

  const normalizedProductQuery = reportFilters.productQuery
  const normalizedCategoryQuery = reportFilters.categoryQuery
  const filteredTickets = useMemo(() => reports?.tickets ?? [], [reports])
  const activeAggregateView: SalesReportAggregateView = activeView === 'tickets' ? 'products' : activeView
  const activeAggregates = useMemo(() => buildSalesReportAggregates(
    filteredTickets,
    activeAggregateView,
    normalizedProductQuery,
    normalizedCategoryQuery,
  ), [activeAggregateView, filteredTickets, normalizedCategoryQuery, normalizedProductQuery])
  const sortedAggregates = useMemo(() => [...activeAggregates].sort((left, right) => {
    const leftValue = sortKey === 'label'
      ? left.label
      : sortKey === 'ticketCount'
        ? left.ticketCount
        : sortKey === 'quantity'
          ? left.quantity
          : sortKey === 'average'
            ? left.quantity ? left.totalCents / left.quantity : 0
            : left.totalCents
    const rightValue = sortKey === 'label'
      ? right.label
      : sortKey === 'ticketCount'
        ? right.ticketCount
        : sortKey === 'quantity'
          ? right.quantity
          : sortKey === 'average'
            ? right.quantity ? right.totalCents / right.quantity : 0
            : right.totalCents

    return compareSalesReportValues(leftValue, rightValue, sortDirection)
  }), [activeAggregates, sortDirection, sortKey])
  const aggregateReportTotals = useMemo(
    () => buildSalesReportTotals(filteredTickets, normalizedProductQuery, normalizedCategoryQuery),
    [filteredTickets, normalizedCategoryQuery, normalizedProductQuery],
  )
  const reportTotals = activeView === 'tickets' ? ticketPage?.summary ?? { paidTicketCount: 0, subtotalCents: 0, taxAmountCents: 0, totalCents: 0 } : aggregateReportTotals
  const paidTicketCount = activeView === 'tickets'
    ? ticketPage?.summary.paidTicketCount ?? 0
    : filteredTickets.filter((ticket) => ticket.status === 'paid').length
  const totalResults = activeView === 'tickets' ? ticketPage?.totalResults ?? 0 : sortedAggregates.length
  const totalPages = Math.max(1, Math.ceil(totalResults / CRM_PAGE_SIZE))
  const visiblePage = Math.min(currentPage, totalPages)
  const pageStart = (visiblePage - 1) * CRM_PAGE_SIZE
  const visibleTickets = ticketPage?.tickets ?? []
  const visibleAggregates = sortedAggregates.slice(pageStart, pageStart + CRM_PAGE_SIZE)
  const activeTab = salesReportTabs.find((tab) => tab.id === activeView) ?? salesReportTabs[0]
  const selectedTicket = ticketPage?.tickets.find((ticket) => ticket.id === selectedTicketId) ?? null
  const productOptions = filterOptions?.products ?? []
  const categoryOptions = filterOptions?.categories ?? []
  const discountOptions = filterOptions?.discounts ?? []
  const hasActiveFilters = Boolean(dateFrom || dateTo || productQuery || categoryQuery || discountFilter !== 'all')
  const activeFilterCount = [dateFrom || dateTo, productQuery, categoryQuery, discountFilter !== 'all'].filter(Boolean).length

  function handleSort(nextSortKey: SalesReportSortKey, nextDirection?: SalesReportSortDirection) {
    setCurrentPage(1)
    if (nextDirection) {
      setSortKey(nextSortKey)
      setSortDirection(nextDirection)
      return
    }
    if (sortKey === nextSortKey) {
      setSortDirection((current) => current === 'asc' ? 'desc' : 'asc')
      return
    }

    setSortKey(nextSortKey)
    setSortDirection(nextSortKey === 'label' || nextSortKey === 'ticketId' || nextSortKey === 'paymentMethod' || nextSortKey === 'status' ? 'asc' : 'desc')
  }

  function clearFilters() {
    setCategoryQuery('')
    setDateFrom('')
    setDateTo('')
    setDiscountFilter('all')
    setProductQuery('')
    setCurrentPage(1)
  }

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!gap-6">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <div>
            <h2>Resumen histórico</h2>
            <p>Datos del local seleccionado</p>
          </div>
          <UiButton
            aria-label="Actualizar informes de ventas"
            className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
            disabled={disabled}
            onClick={() => void runAction(refresh)}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
          </UiButton>
        </div>
        <div className="!grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] sm:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="neutral" label="Subtotal" value={formatMoney(reportTotals.subtotalCents)} />
          <KpiCard color="blue" label="Impuestos" value={formatMoney(reportTotals.taxAmountCents)} />
          <KpiCard color="green" label="Total" value={formatMoney(reportTotals.totalCents)} />
          <KpiCard color="neutral" label="Tickets cobrados" value={paidTicketCount} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !flex-col !items-stretch !justify-between !gap-[18px] !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 md:!flex-row md:!items-center md:!px-[22px]">
          <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]">
            <h2>{activeTab.label}</h2>
            <p>{isReportLoading && !ticketPage && !reports ? 'Cargando información de ventas...' : `${totalResults} resultados`}</p>
          </div>
          <UiButton
            aria-controls="crm-sales-report-filters"
            aria-expanded={isFiltersOpen}
            className={isFiltersOpen
              ? '!inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-blue)] !shadow-none !transition-[background-color,color,transform] !duration-150'
              : 'inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !items-center !justify-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
            onClick={() => setIsFiltersOpen((current) => !current)}
            type="button"
          >
            <SlidersHorizontal className="!size-4" />
            Filtros
            {activeFilterCount ? (
              <span className="!inline-grid !size-5 !place-items-center !rounded-full !bg-[var(--crm-blue)] !text-[10px] !font-bold !text-white">
                {activeFilterCount}
              </span>
            ) : null}
          </UiButton>
        </div>

        <div aria-label="Subsecciones de informes" className="!flex !gap-2 !overflow-x-auto !border-b !border-[var(--crm-border-subtle)] !px-[18px] !py-3 md:!px-[22px]" role="tablist">
          {salesReportTabs.map((tab) => (
            <UiButton
              aria-selected={activeView === tab.id}
              className={activeView === tab.id
                ? '!inline-flex !min-h-10 !shrink-0 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-blue-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-blue)] !shadow-none !transition-[background-color,color,transform] !duration-150'
                : 'inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !min-h-10 !shrink-0 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150'}
              key={tab.id}
              onClick={() => {
                setActiveView(tab.id)
                setCurrentPage(1)
                setSortDirection('desc')
                setSortKey(tab.id === 'tickets' ? 'createdAt' : 'totalCents')
              }}
              role="tab"
              type="button"
            >
              {tab.label}
            </UiButton>
          ))}
        </div>

        {isFiltersOpen ? (
        <div className="!grid !grid-cols-1 !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !px-[18px] !py-4 sm:!grid-cols-2 lg:!grid-cols-5 md:!px-[22px]" id="crm-sales-report-filters">
          <Field label="Día operativo desde">
            <UiInput
              className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              max={dateTo || undefined}
              onChange={(event) => {
                setDateFrom(event.target.value)
                setCurrentPage(1)
              }}
              type="date"
              value={dateFrom}
            />
          </Field>
          <Field label="Día operativo hasta">
            <UiInput
              className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              min={dateFrom || undefined}
              onChange={(event) => {
                setDateTo(event.target.value)
                setCurrentPage(1)
              }}
              type="date"
              value={dateTo}
            />
          </Field>
          <Field label="Producto">
            <UiInput
              className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              list="crm-report-products"
              onChange={(event) => {
                setProductQuery(event.target.value)
                setCurrentPage(1)
              }}
              placeholder="Buscar producto"
              type="search"
              value={productQuery}
            />
            <datalist id="crm-report-products">
              {productOptions.map((product) => <option key={product} value={product} />)}
            </datalist>
          </Field>
          <Field label="Categoría">
            <UiInput
              className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none !transition-[border-color,box-shadow,background-color] !duration-150"
              list="crm-report-categories"
              onChange={(event) => {
                setCategoryQuery(event.target.value)
                setCurrentPage(1)
              }}
              placeholder="Buscar categoría"
              type="search"
              value={categoryQuery}
            />
            <datalist id="crm-report-categories">
              {categoryOptions.map((category) => <option key={category} value={category} />)}
            </datalist>
          </Field>
          <Field label="Descuento">
            <CrmSelect
              onChange={(nextFilter) => {
                setDiscountFilter(nextFilter)
                setCurrentPage(1)
              }}
              options={[
                { label: 'Todos', value: 'all' },
                { label: 'Con descuento', value: 'with' },
                { label: 'Sin descuento', value: 'without' },
                ...discountOptions.map(({ id, name }) => ({ label: name, value: 'id:' + id })),
              ]}
              value={discountFilter}
            />
          </Field>
          <div className="!flex !items-end sm:!col-span-2 lg:!col-span-4 xl:!col-span-1">
            <UiButton
              className="inline-flex min-h-10 w-auto items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold leading-none text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,box-shadow,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !h-11 !w-full !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)] !shadow-none !transition-[background-color,color,transform] !duration-150 xl:!w-auto"
              disabled={!hasActiveFilters}
              onClick={clearFilters}
              type="button"
            >
              <X className="!size-4" />
              Limpiar
            </UiButton>
          </div>
        </div>
        ) : null}

        {activeView === 'tickets' ? (
          <SalesReportTicketsTable
            isLoading={isReportLoading}
            onSelect={setSelectedTicketId}
            onSort={handleSort}
            sortDirection={sortDirection}
            sortKey={sortKey}
            tickets={visibleTickets}
          />
        ) : (
          <SalesReportAggregateTable
            items={visibleAggregates}
            labelHeading={activeView === 'products' ? 'Producto' : activeView === 'variants' ? 'Variante' : activeView === 'categories' ? 'Categoría' : activeView === 'tabs' ? 'Pestaña' : activeView === 'mixers' ? 'Mixer' : activeView === 'menu-components' ? 'Selección' : activeView === 'modifiers' ? 'Modificador' : 'Formato'}
            loading={isReportLoading}
            onSort={handleSort}
            sortDirection={sortDirection}
            sortKey={sortKey}
          />
        )}
        <CrmPagination currentPage={visiblePage} onPageChange={setCurrentPage} totalResults={totalResults} />
      </section>

      {selectedTicket ? (
        <SalesReportTicketModal
          disabled={disabled}
          onClose={() => setSelectedTicketId(null)}
          onUpdated={refresh}
          runAction={runAction}
          tenantContext={tenantContext}
          ticket={selectedTicket}
        />
      ) : null}
    </div>
  )
}

function getReportDiscountLabel(ticket: CrmSalesReports['tickets'][number]) {
  if (ticket.discountName) {
    return `−${formatMoney(ticket.discountAmountCents)}`
  }
  return ticket.paymentMethod === 'invitation' ? 'Invitación (histórico)' : '—'
}

function getReportPaymentLabel(ticket: CrmSalesReports['tickets'][number]) {
  if (ticket.totalCents === 0 && !ticket.paymentMethod) return 'No requerido'
  return ticket.paymentMethod ? paymentLabels[ticket.paymentMethod] : 'Sin cobro'
}

const fiscalStatusLabels = {
  pending: 'Pendiente',
  accepted: 'Aceptada',
  accepted_with_errors: 'Aceptada con errores',
  rejected: 'Rechazada',
  cancelled: 'Anulada',
  error: 'Error',
} as const

function fiscalStatusClass(status: NonNullable<CrmSalesReports['tickets'][number]['fiscal']>['status']) {
  if (status === 'accepted') return '!bg-[var(--crm-green-soft)] !text-[var(--crm-green)]'
  if (status === 'pending') return '!bg-[var(--crm-blue-soft)] !text-[var(--crm-blue)]'
  if (status === 'accepted_with_errors') return '!bg-[var(--crm-yellow-soft)] !text-[var(--crm-yellow)]'
  return '!bg-[var(--crm-red-soft)] !text-[var(--crm-red)]'
}

export function SalesReportTicketsTable({
  isLoading,
  onSelect,
  onSort,
  sortDirection,
  sortKey,
  tickets,
}: {
  isLoading: boolean
  onSelect: (ticketId: string) => void
  onSort: (sortKey: SalesReportSortKey, direction?: SalesReportSortDirection) => void
  sortDirection: SalesReportSortDirection
  sortKey: SalesReportSortKey
  tickets: CrmSalesReports['tickets']
}) {
  return (
    <div className="!overflow-x-auto">
      <UiDataTable aria-label="Tickets de ventas" className="!w-full !min-w-[1200px] !border-collapse" emptyContent={isLoading ? 'Cargando tickets...' : 'No hay tickets para este local.'} filterable={false} onSortChange={({ column, direction }) => onSort(column as SalesReportSortKey, direction === 'ascending' ? 'asc' : 'desc')} sortDescriptor={{ column: sortKey, direction: sortDirection === 'asc' ? 'ascending' : 'descending' }}>
        <thead>
          <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
            <th className="!min-w-40 !px-[22px] !py-3" data-column-key="ticketId">Ticket</th>
            <th className="!min-w-[170px] !px-3 !py-3" data-column-key="createdAt">Fecha</th>
            <th className="!min-w-[90px] !px-3 !py-3" data-column-key="quantity">Artículos</th>
            <th className="!min-w-[120px] !px-3 !py-3" data-column-key="paymentMethod">Método</th>
            <th className="!min-w-[170px] !px-3 !py-3" data-sortable="false">Descuento</th>
            <th className="!min-w-[100px] !px-3 !py-3" data-column-key="status">Estado</th>
            <th className="!min-w-[180px] !px-3 !py-3" data-sortable="false">Estado fiscal</th>
            <th className="!min-w-[120px] !px-[22px] !py-3" data-column-key="totalCents">Total</th>
          </tr>
        </thead>
        <tbody>
          {tickets.map((ticket) => (
            <tr
              aria-label={`Ver detalles del ticket ${ticket.id.slice(0, 8)}`}
              className="!cursor-pointer !border-b !border-[var(--crm-border-subtle)] !outline-none hover:!bg-[var(--crm-surface-soft)] focus-visible:!bg-[var(--crm-surface-soft)] last:!border-0"
              key={ticket.id}
              onClick={() => onSelect(ticket.id)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  onSelect(ticket.id)
                }
              }}
              role="button"
              tabIndex={0}
            >
              <td className="!px-[22px] !py-4">
                <strong className="!block !truncate !text-sm !font-semibold !text-[var(--crm-text)]">
                  #{ticket.id.slice(0, 8).toUpperCase()}
                </strong>
                <span className="!block !truncate !text-xs !font-medium !text-[var(--crm-text-muted)]">
                  {ticket.lineCount} líneas
                </span>
              </td>
              <td className="!whitespace-nowrap !px-3 !py-4 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">
                {crmReportDateTimeFormatter.format(new Date(ticket.createdAt))}
              </td>
              <td className="!whitespace-nowrap !px-3 !py-4 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">
                {ticket.quantity} uds.
              </td>
              <td className="!px-3 !py-4 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">
                {getReportPaymentLabel(ticket)}
              </td>
              <td className="!max-w-[170px] !truncate !px-3 !py-4 !text-[13px] !font-medium !text-[var(--crm-text-secondary)]">
                {getReportDiscountLabel(ticket)}
              </td>
              <td className="!px-3 !py-4">
                <span className={ticket.status === 'paid'
                  ? '!inline-flex !min-h-6 !w-fit !items-center !whitespace-nowrap !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]'
                  : '!inline-flex !min-h-6 !w-fit !items-center !whitespace-nowrap !rounded-full !bg-[var(--crm-red-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-red)]'}>
                  {ticket.status === 'paid' ? 'Cobrado' : 'Anulado'}
                </span>
              </td>
              <td className="!px-3 !py-4">
                {ticket.fiscal ? (
                  <span className={`!inline-flex !min-h-6 !w-fit !items-center !whitespace-nowrap !rounded-full !px-[9px] !text-[11px] !font-semibold ${fiscalStatusClass(ticket.fiscal.status)}`}>
                    {fiscalStatusLabels[ticket.fiscal.status]} · {ticket.fiscal.provider === 'ticketbai' ? 'TicketBAI' : 'VeriFactu'}
                  </span>
                ) : <span className="!text-xs !text-[var(--crm-text-muted)]">Sin fiscalizar</span>}
              </td>
              <td className="!whitespace-nowrap !px-[22px] !py-4 !font-mono !text-[13px] !font-bold !text-[var(--crm-text)]">
                {formatMoney(ticket.totalCents)}
              </td>
            </tr>
          ))}
        </tbody>
      </UiDataTable>
    </div>
  )
}

export function SalesReportTicketModal({
  disabled,
  onClose,
  onUpdated,
  runAction,
  tenantContext,
  ticket,
}: {
  disabled: boolean
  onClose: () => void
  onUpdated: () => Promise<void>
  runAction: RunAction
  tenantContext: TenantContext
  ticket: CrmSalesReports['tickets'][number]
}) {
  const fiscalTotals = buildSalesReportTicketTotals(ticket)
  const [events, setEvents] = useState<FiscalCommunicationEvent[]>([])

  const refreshEvents = useCallback(async () => {
    setEvents(ticket.fiscal ? await loadFiscalInvoiceEvents(tenantContext, ticket.fiscal.id) : [])
  }, [tenantContext, ticket.fiscal])

  useEffect(() => { void refreshEvents() }, [refreshEvents])

  async function consultFiscalStatus() {
    if (!ticket.fiscal) return
    await runAction(async () => {
      await refreshFiscalInvoiceStatus(tenantContext, ticket.fiscal!.id)
      await Promise.all([onUpdated(), refreshEvents()])
    })
  }

  async function submitFiscalInvoice() {
    if (!ticket.fiscal) return
    await runAction(async () => {
      await issueFiscalTicket(tenantContext, ticket.id)
      await Promise.all([onUpdated(), refreshEvents()])
    })
  }

  async function cancelInvoice() {
    if (!ticket.fiscal || !window.confirm('¿Solicitar la anulación fiscal de esta factura? Esta operación no edita el documento original.')) return
    await runAction(async () => {
      await cancelFiscalInvoice(tenantContext, ticket.fiscal!.id)
      await Promise.all([onUpdated(), refreshEvents()])
    })
  }

  function viewQr() {
    const url = fiscalQrDataUrl(ticket.fiscal?.qrBase64)
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }

  return (
    <CrmModal label={`Detalle del ticket ${ticket.id.slice(0, 8)}`} onClose={onClose} size="large">
      <div className="flex items-center justify-between gap-3 border-b border-[var(--crm-border-subtle)] bg-transparent p-3 text-[var(--crm-text)] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-1 [&_span]:text-[15px] [&_span]:font-bold [&_small]:truncate [&_small]:text-xs [&_small]:font-medium [&_small]:text-[var(--crm-text-muted)] !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
        <div>
          <span>Ticket #{ticket.id.slice(0, 8).toUpperCase()}</span>
          <small>{crmReportDateTimeFormatter.format(new Date(ticket.createdAt))}</small>
        </div>
        <UiButton
          aria-label="Cerrar detalle del ticket"
          className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-muted)] shadow-none transition-colors duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,transform] !duration-150"
          onClick={onClose}
          type="button"
        >
          <X className="h-4 w-4" />
        </UiButton>
      </div>

      <div className="!min-h-0 !overflow-y-auto !px-[18px] !py-5 md:!px-[22px]">
        <div className="!mb-5 !grid !grid-cols-1 !gap-2.5 sm:!grid-cols-2 lg:!grid-cols-4 xl:!grid-cols-7">
          <TicketDetailSummary label="Estado">
            <span className={ticket.status === 'paid'
              ? '!inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-green-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-green)]'
              : '!inline-flex !min-h-6 !w-fit !items-center !rounded-full !bg-[var(--crm-red-soft)] !px-[9px] !text-[11px] !font-semibold !text-[var(--crm-red)]'}>
              {ticket.status === 'paid' ? 'Cobrado' : 'Anulado'}
            </span>
          </TicketDetailSummary>
          <TicketDetailSummary label="Método de pago">
            <strong>{getReportPaymentLabel(ticket)}</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Productos">
            <strong>{ticket.lineCount} líneas · {ticket.quantity} uds.</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Subtotal">
            <strong className="!font-mono">{formatMoney(fiscalTotals.subtotalCents)}</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Impuestos">
            <strong className="!font-mono">{formatMoney(fiscalTotals.taxAmountCents)}</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Descuento">
            <strong>{getReportDiscountLabel(ticket)}</strong>
          </TicketDetailSummary>
          <TicketDetailSummary label="Total cobrado">
            <strong className="!font-mono !text-base">{formatMoney(ticket.totalCents)}</strong>
          </TicketDetailSummary>
        </div>

        {ticket.status === 'void' ? (
          <div className="!mb-4 !rounded-[10px] !bg-[var(--crm-red-soft)] !px-3.5 !py-3 !text-xs !font-semibold !text-[var(--crm-red)]">
            Este ticket fue anulado y no se contabiliza en los informes de ventas.
          </div>
        ) : null}

        {ticket.fiscal ? (
          <section className="!mb-5 !grid !gap-4 !rounded-xl !border !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !p-4">
            <div className="!flex !flex-wrap !items-start !justify-between !gap-3">
              <div>
                <div className="!flex !flex-wrap !items-center !gap-2">
                  <h3 className="!m-0 !text-sm !font-bold !text-[var(--crm-text)]">Factura fiscal {ticket.fiscal.series}-{ticket.fiscal.number}</h3>
                  <span className={`!inline-flex !min-h-6 !items-center !rounded-full !px-2.5 !text-[11px] !font-semibold ${fiscalStatusClass(ticket.fiscal.status)}`}>
                    {fiscalStatusLabels[ticket.fiscal.status]}
                  </span>
                </div>
                <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">
                  {ticket.fiscal.provider === 'ticketbai' ? 'TicketBAI' : 'VeriFactu'} · {ticket.fiscal.environment === 'production' ? 'Produccion' : 'Pruebas'} · {ticket.fiscal.invoiceType === 'simplified' ? 'Simplificada' : ticket.fiscal.invoiceType === 'corrective' ? 'Rectificativa' : 'Normal'}
                </p>
              </div>
              <div className="!flex !flex-wrap !gap-2">
                {!ticket.fiscal.externalUuid && (ticket.fiscal.status === 'pending' || (ticket.fiscal.status === 'error' && (ticket.fiscal.errorCode === 'network_error' || /^http_(429|5\d\d)$/.test(ticket.fiscal.errorCode ?? '')))) ? (
                  <UiButton className="!inline-flex !min-h-9 !items-center !gap-2 !rounded-lg !border-0 !bg-[var(--crm-blue-soft)] !px-3 !text-xs !font-semibold !text-[var(--crm-blue)]" disabled={disabled} onClick={() => void submitFiscalInvoice()} type="button"><Send className="!size-3.5" />{ticket.fiscal.status === 'error' ? 'Reintentar envío' : 'Enviar ahora'}</UiButton>
                ) : null}
                <UiButton className="!inline-flex !min-h-9 !items-center !gap-2 !rounded-lg !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-xs !font-semibold !text-[var(--crm-text)]" disabled={disabled || !ticket.fiscal.externalUuid} onClick={() => void consultFiscalStatus()} type="button"><RefreshCw className="!size-3.5" />Consultar estado</UiButton>
                <UiButton className="!inline-flex !min-h-9 !items-center !gap-2 !rounded-lg !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-xs !font-semibold !text-[var(--crm-text)]" disabled={!ticket.fiscal.qrBase64} onClick={viewQr} type="button"><QrCode className="!size-3.5" />Ver QR</UiButton>
                <UiButton className="!inline-flex !min-h-9 !items-center !gap-2 !rounded-lg !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-xs !font-semibold !text-[var(--crm-text)]" onClick={() => openFiscalInvoiceDocument(ticket, tenantContext)} type="button"><FileText className="!size-3.5" />Imprimir / PDF</UiButton>
                {['accepted', 'accepted_with_errors'].includes(ticket.fiscal.status) ? (
                  <UiButton className="!inline-flex !min-h-9 !items-center !gap-2 !rounded-lg !border-0 !bg-[var(--crm-red-soft)] !px-3 !text-xs !font-semibold !text-[var(--crm-red)]" disabled={disabled} onClick={() => void cancelInvoice()} type="button"><Ban className="!size-3.5" />Anular</UiButton>
                ) : null}
              </div>
            </div>

            <div className="!grid !grid-cols-1 !gap-2 sm:!grid-cols-2">
              <div className="!rounded-lg !bg-[var(--crm-surface)] !p-3"><span className="!block !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">UUID</span><code className="!mt-1 !block !break-all !text-xs !text-[var(--crm-text)]">{ticket.fiscal.externalUuid ?? 'Pendiente de asignación'}</code></div>
              <div className="!rounded-lg !bg-[var(--crm-surface)] !p-3"><span className="!block !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">Último error</span><p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text)]">{ticket.fiscal.errorMessage ?? 'Sin errores'}{ticket.fiscal.errorCode ? ` (${ticket.fiscal.errorCode})` : ''}</p></div>
            </div>

            <div>
              <h4 className="!m-0 !flex !items-center !gap-2 !text-xs !font-bold !text-[var(--crm-text-secondary)]"><History className="!size-4" />Historial de comunicaciones</h4>
              <div className="!mt-2 !grid !gap-1.5">
                {events.map((event) => (
                  <div className="!flex !flex-wrap !items-center !justify-between !gap-2 !rounded-lg !bg-[var(--crm-surface)] !px-3 !py-2 !text-xs" key={event.id}>
                    <span className="!font-semibold !text-[var(--crm-text)]">{event.event_type.replaceAll('_', ' ')}</span>
                    <span className="!text-[var(--crm-text-muted)]">{event.source} · {event.http_status ?? '—'} · {crmReportDateTimeFormatter.format(new Date(event.created_at))}</span>
                    {event.error_message ? <span className="!basis-full !text-[var(--crm-red)]">{event.error_message}</span> : null}
                  </div>
                ))}
                {!events.length ? <p className="!m-0 !text-xs !text-[var(--crm-text-muted)]">Todavía no hay comunicaciones registradas.</p> : null}
              </div>
            </div>
            <p className="!m-0 !text-xs !leading-5 !text-[var(--crm-text-muted)]">La factura emitida es inmutable. Cualquier corrección debe tramitarse mediante factura rectificativa, anulación o subsanación.</p>
          </section>
        ) : (
          <div className="!mb-5 !rounded-[10px] !bg-[var(--crm-surface-soft)] !px-3.5 !py-3 !text-xs !font-medium !text-[var(--crm-text-muted)]">Este ticket no tiene un registro fiscal asociado.</div>
        )}

        <div className="!overflow-hidden !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)]">
          <UiDataTable aria-label="Líneas del ticket" className="!w-full !min-w-[660px] !border-collapse" emptyContent="Este ticket no contiene líneas de producto." filterPlaceholder="Filtrar líneas del ticket…">
            <thead><tr className="!min-h-11 !border-b !border-[var(--crm-border)] !text-[10px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
              <th className="!min-w-[240px] !px-4 !py-3">Producto</th><th className="!min-w-[150px] !px-3 !py-3">Formato</th><th className="!w-[80px] !px-3 !py-3">Cantidad</th><th className="!w-[120px] !px-3 !py-3">Precio / ud.</th><th className="!w-[120px] !px-3 !py-3">Total</th>
            </tr></thead>
            <tbody>
          {ticket.lines.map((line) => (
            <tr className="!min-h-[68px] !border-b !border-[var(--crm-border)] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] last:!border-b-0" key={line.id}>
              <td className="!min-w-[240px] !px-4 !py-3"><div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]">
                <strong>{line.productName}</strong>
                {line.modifiers.length ? (
                  <span>{line.modifiers.map((modifier) => `+ ${modifier.name}${modifier.priceCents ? ` (${formatMoney(modifier.priceCents)})` : ''}`).join(' · ')}</span>
                ) : !line.components.length ? (
                  <span>Sin modificadores</span>
                ) : null}
                {line.components.length ? <div className="!mt-1.5 !grid !gap-1 !border-l-2 !border-[var(--crm-border)] !pl-2.5">
                  {line.components.toSorted((left, right) => left.sortOrder - right.sortOrder).map((component) => <span className="!whitespace-normal" key={component.id}>
                    <strong>{component.selectionGroupName || 'Elección'}</strong> · {component.quantity > 1 ? `${component.quantity} × ` : ''}{component.productName}{component.variantName ? ` (${component.variantName})` : ''}{component.priceDeltaCents ? ` · ${component.priceDeltaCents > 0 ? '+' : ''}${formatMoney(component.priceDeltaCents * component.quantity)}` : ''}
                    {component.modifiers?.length ? ` · ${component.modifiers.map((modifier) => modifier.name).join(', ')}` : ''}
                  </span>)}
                </div> : null}
              </div></td>
              <td className="!min-w-[150px] !px-3 !py-3">{line.variantName || 'Sin formato'}</td>
              <td className="!w-[80px] !px-3 !py-3" data-sort-value={line.quantity}>{line.quantity}</td>
              <td className="!w-[120px] !px-3 !py-3 !font-mono" data-sort-value={line.quantity ? Math.round(line.lineTotalCents / line.quantity) : line.unitPriceCents}>{formatMoney(line.quantity ? Math.round(line.lineTotalCents / line.quantity) : line.unitPriceCents)}</td>
              <td className="!w-[120px] !px-3 !py-3 !font-mono !font-bold !text-[var(--crm-text)]" data-sort-value={line.lineTotalCents}>{formatMoney(line.lineTotalCents)}</td>
            </tr>
          ))}
            </tbody>
          </UiDataTable>
        </div>
      </div>

      <div className="!flex !flex-wrap !items-center !justify-end !gap-x-8 !gap-y-3 !border-t !border-[var(--crm-border-subtle)] !px-[18px] !py-4 md:!px-[22px]">
        <span className="!grid !gap-1"><small className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">Subtotal</small><strong className="!font-mono !text-sm !text-[var(--crm-text)]">{formatMoney(fiscalTotals.subtotalCents)}</strong></span>
        <span className="!grid !gap-1"><small className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">Impuestos</small><strong className="!font-mono !text-sm !text-[var(--crm-text)]">{formatMoney(fiscalTotals.taxAmountCents)}</strong></span>
        <span className="!grid !gap-1"><small className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">Total del ticket</small><strong className="!font-mono !text-xl !text-[var(--crm-text)]">{formatMoney(ticket.totalCents)}</strong></span>
      </div>
    </CrmModal>
  )
}

export function TicketDetailSummary({ children, label }: { children: ReactNode; label: string }) {
  return (
    <div className="!grid !min-h-[76px] !content-center !gap-1.5 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-3.5 !py-3">
      <span className="!text-[11px] !font-medium !text-[var(--crm-text-muted)]">{label}</span>
      <div className="!text-[13px] !font-semibold !text-[var(--crm-text)]">{children}</div>
    </div>
  )
}

export function SalesReportAggregateTable({
  items,
  labelHeading,
  loading,
  onSort,
  sortDirection,
  sortKey,
}: {
  items: CrmSalesReportAggregate[]
  labelHeading: string
  loading: boolean
  onSort: (sortKey: SalesReportSortKey, direction?: SalesReportSortDirection) => void
  sortDirection: SalesReportSortDirection
  sortKey: SalesReportSortKey
}) {
  return (
    <div className="overflow-auto">
      <UiDataTable aria-label={`Ventas agrupadas por ${labelHeading.toLowerCase()}`} className="!w-full !min-w-[760px] !border-collapse" emptyContent={loading ? 'Calculando informe...' : `No hay ventas agrupadas por ${labelHeading.toLowerCase()}.`} filterable={false} onSortChange={({ column, direction }) => onSort(column as SalesReportSortKey, direction === 'ascending' ? 'asc' : 'desc')} sortDescriptor={{ column: sortKey, direction: sortDirection === 'asc' ? 'ascending' : 'descending' }}>
        <thead><tr className="!border-b !border-[var(--crm-border-subtle)] !bg-[var(--crm-surface-soft)] !text-[11px] !font-semibold !uppercase !tracking-[0.045em] !text-[var(--crm-text-muted)]">
          <th className="!min-w-[250px] !px-[22px] !py-3" data-column-key="label">{labelHeading}</th><th className="!w-[120px] !px-3 !py-3" data-column-key="ticketCount">Tickets</th><th className="!w-[120px] !px-3 !py-3" data-column-key="quantity">Unidades</th><th className="!w-[150px] !px-3 !py-3" data-column-key="average">Media / unidad</th><th className="!w-[150px] !px-[22px] !py-3" data-column-key="totalCents">Ventas</th>
        </tr></thead>
        <tbody>
      {items.map((item) => (
        <tr className="!min-h-[72px] !border-b !border-[var(--crm-border-subtle)] !text-[13px] !font-medium !text-[var(--crm-text-secondary)] hover:!bg-[var(--crm-surface-hover)]" key={item.id}>
          <td className="!min-w-[250px] !px-[22px] !py-3"><div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]">
            <strong>{item.label}</strong>
            <span>{item.ticketCount === 1 ? '1 operación' : `${item.ticketCount} operaciones`}</span>
          </div></td>
          <td className="!w-[120px] !px-3 !py-3" data-sort-value={item.ticketCount}>{item.ticketCount}</td>
          <td className="!w-[120px] !px-3 !py-3" data-sort-value={item.quantity}>{item.quantity}</td>
          <td className="!w-[150px] !px-3 !py-3 !font-mono" data-sort-value={item.quantity ? item.totalCents / item.quantity : 0}>{formatMoney(item.quantity ? Math.round(item.totalCents / item.quantity) : 0)}</td>
          <td className="!w-[150px] !px-[22px] !py-3 !font-mono !font-bold !text-[var(--crm-text)]" data-sort-value={item.totalCents}>{formatMoney(item.totalCents)}</td>
        </tr>
      ))}
        </tbody>
      </UiDataTable>
    </div>
  )
}
