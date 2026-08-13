import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { sileo } from 'sileo'
import type { CatalogData, ResolvedCatalogItem, ResolvedSellableProduct } from '../../catalog/domain/types'
import { getDefaultProductLineSelection } from '../../catalog/services/saleLineBuilder'
import { calculateDiscountForLines, resolveTicketDiscount, type DiscountScheduleContext } from '../../../lib/discounts'
import { getLineTotal, getTicketTotal } from '../../../lib/format'
import { saveCachedTicket } from '../../../lib/offlineStore'
import { loadProductSalesStatsFromSupabase } from '../../../services/posService'
import type {
  AppliedDiscount,
  CashSession,
  Discount,
  PaymentMethod,
  ProductLineSelection,
  ProductSalesStat,
  SaleRecord,
  SessionTicketRecord,
  TenantContext,
  TicketLine,
} from '../../../types'
import { addProductSalesStats } from '../services/productSalesStats'
import { addQuickSaleTicketLine, changeQuickSaleTicketLineQuantity } from '../services/ticketLines'
import { applyQuickSaleLinesUpdate } from '../services/lineUpdates'
import { useQuickSalePayment } from './useQuickSalePayment'

export type AddCatalogLine = (
  sellable: ResolvedSellableProduct,
  selection: ProductLineSelection,
  item: ResolvedCatalogItem | null,
  sourceElement?: HTMLElement | null,
) => boolean

export type ProductDialogState = {
  allowVariantSelection: boolean
  initialSelection?: ProductLineSelection
  initialVariantId?: string
  lineId?: string
  item: ResolvedCatalogItem
}

type Options = {
  discounts: Discount[]
  discountSchedule: Omit<DiscountScheduleContext, 'now'>
  catalog: CatalogData | null
  cashSession: CashSession | null
  context: TenantContext | null
  isOnline: boolean
  ledger: SaleRecord[]
  onAddFeedback: (input: { feedbackType: 'added' | 'updated'; productName: string; sourceElement?: HTMLElement | null }) => void
  persistLedger: (ledger: SaleRecord[]) => void
  persistProductSalesStats: (stats: ProductSalesStat[]) => void
  persistTickets: (tickets: SessionTicketRecord[]) => void
  printSale: (payload: SessionTicketRecord['payload']) => Promise<void>
  productSalesStats: ProductSalesStat[]
  refreshPendingCount: () => void
  setMobileTicketOpen: (open: boolean) => void
  syncPendingEvents: () => Promise<void>
  tickets: SessionTicketRecord[]
}

export function useQuickSale(options: Options) {
  const [lines, setLines] = useState<TicketLine[]>([])
  const [discount, setDiscount] = useState<AppliedDiscount | null>(null)
  const [excludedAutomaticDiscountIds, setExcludedAutomaticDiscountIds] = useState<string[]>([])
  const [productDialog, setProductDialog] = useState<ProductDialogState | null>(null)
  const [cashPaymentOpen, setCashPaymentOpen] = useState(false)
  const [discountModalOpen, setDiscountModalOpen] = useState(false)
  const [paidFeedback, setPaidFeedback] = useState<PaymentMethod | null>(null)
  const activeDiscount = resolveTicketDiscount(
    discount,
    options.discounts,
    options.context?.venueId ?? '',
    options.discountSchedule,
    excludedAutomaticDiscountIds,
  )

  const activePromotionId = activeDiscount?.ruleKind === 'promotion'
    ? activeDiscount.discountId ?? activeDiscount.name
    : null
  const activePromotionName = activeDiscount?.ruleKind === 'promotion' ? activeDiscount.name : null

  const previousPromotionRef = useRef<{ id: string; name: string } | null>(null)
  useEffect(() => {
    const previous = previousPromotionRef.current
    if (previous && !activePromotionId && !excludedAutomaticDiscountIds.includes(previous.id)) {
      sileo.info({ title: `${previous.name} ha dejado de estar disponible` })
    }
    previousPromotionRef.current = activePromotionId && activePromotionName
      ? { id: activePromotionId, name: activePromotionName }
      : null
  }, [activePromotionId, activePromotionName, excludedAutomaticDiscountIds])

  const resetDiscount = useCallback((nextDiscount: AppliedDiscount | null) => {
    setExcludedAutomaticDiscountIds((current) => current.length ? [] : current)
    setDiscount(nextDiscount)
  }, [])

  const applyDiscount = useCallback((nextDiscount: AppliedDiscount) => {
    if (nextDiscount.discountId) {
      setExcludedAutomaticDiscountIds((current) => current.filter((id) => id !== nextDiscount.discountId))
    }
    setDiscount(nextDiscount)
  }, [])

  const removeDiscount = useCallback(() => {
    const automaticDiscountId = activeDiscount?.automatic ? activeDiscount.discountId : null
    if (automaticDiscountId) {
      setExcludedAutomaticDiscountIds((current) => current.includes(automaticDiscountId)
        ? current
        : [...current, automaticDiscountId])
    }
    setDiscount(null)
  }, [activeDiscount])


  const updateLines = useCallback((update: (previous: TicketLine[]) => TicketLine[]) => {
    setLines((previous) => applyQuickSaleLinesUpdate(
      previous,
      update,
      (next) => { if (options.context) saveCachedTicket(options.context, next) },
    ))
  }, [options.context])

  const persistLines = useCallback((nextLines: TicketLine[]) => {
    updateLines(() => nextLines)
  }, [updateLines])

  const mergeProductStats = useCallback((soldLines: TicketLine[]) => {
    options.persistProductSalesStats(addProductSalesStats(options.productSalesStats, soldLines))
  }, [options])

  const completePayment = useQuickSalePayment({
    context: options.context,
    cashSession: options.cashSession,
    lines,
    discount: activeDiscount,
    ledger: options.ledger,
    tickets: options.tickets,
    isOnline: options.isOnline,
    persistLedger: options.persistLedger,
    persistTickets: options.persistTickets,
    persistLines,
    mergeProductStats,
    refreshPendingCount: options.refreshPendingCount,
    syncPendingEvents: options.syncPendingEvents,
    printSale: options.printSale,
    resetUi: (method) => {
      options.setMobileTicketOpen(false)
      setDiscount(null)
      setExcludedAutomaticDiscountIds([])
      setDiscountModalOpen(false)
      setPaidFeedback(method)
      window.setTimeout(() => setPaidFeedback(null), 500)
    },
  })

  const addLine = useCallback<AddCatalogLine>((sellable, selection, item, sourceElement) => {
    const catalog = options.catalog
    if (!catalog) return false
    updateLines((previous) => addQuickSaleTicketLine(previous, catalog, sellable, selection, item))
    options.onAddFeedback({ feedbackType: 'added', productName: sellable.product.name, sourceElement })
    return true
  }, [options, updateLines])

  const selectProduct = useCallback((
    item: ResolvedCatalogItem,
    allowVariantSelection: boolean,
    sourceElement: HTMLElement,
    onImmediateAdd: AddCatalogLine = addLine,
  ) => {
    if (!options.catalog) return
    const hasConfiguredSelections = item.selectionGroups.length > 0 || item.modifierGroups.length > 0
    const defaultSelection = !allowVariantSelection && hasConfiguredSelections
      ? getDefaultProductLineSelection(options.catalog, item)
      : null
    const variantCount = options.catalog.variants.filter((variant) => variant.productId === item.product.id && variant.active).length
    const needsDialog = (hasConfiguredSelections && !defaultSelection)
      || (allowVariantSelection && variantCount > 1)
    if (!needsDialog) {
      onImmediateAdd(
        item,
        defaultSelection ?? { modifiers: [], components: [], mixerProductId: null, mixer: null },
        item,
        sourceElement,
      )
      return
    }
    setProductDialog({ allowVariantSelection, item })
  }, [addLine, options.catalog])

  const refreshProductStats = useCallback(async () => {
    if (!options.context) return
    options.persistProductSalesStats(await loadProductSalesStatsFromSupabase(options.context))
  }, [options])
  const subtotalCents = useMemo(() => getTicketTotal(lines), [lines])
  const discountCalculation = useMemo(
    () => calculateDiscountForLines(lines.map((line) => ({ ...line, grossCents: getLineTotal(line) })), activeDiscount),
    [activeDiscount, lines],
  )

  const reset = useCallback((nextLines: TicketLine[] = []) => {
    setLines(nextLines)
    setDiscount(null)
    setExcludedAutomaticDiscountIds([])
    setProductDialog(null)
    setCashPaymentOpen(false)
    setDiscountModalOpen(false)
    setPaidFeedback(null)
  }, [])

  return {
    addLine,
    applyDiscount,
    cashPaymentOpen,
    changeQuantity: (lineId: string, direction: 1 | -1) => {
      updateLines((previous) => changeQuickSaleTicketLineQuantity(previous, lineId, direction))
    },
    clear: () => {
      updateLines(() => [])
      setDiscount(null)
      setExcludedAutomaticDiscountIds([])
    },
    closeCashPayment: () => setCashPaymentOpen(false),
    closeDiscountModal: () => setDiscountModalOpen(false),
    closeProductDialog: () => setProductDialog(null),
    completePayment,
    discount: activeDiscount,
    discountAmountCents: discountCalculation.discountAmountCents,
    discountModalOpen,
    hydrate: (nextLines: TicketLine[]) => setLines(nextLines),
    lineDiscounts: discountCalculation.lineAllocations,
    lines,
    openCashPayment: () => setCashPaymentOpen(true),
    openDiscountModal: () => setDiscountModalOpen(true),
    openProductDialog: (dialog: ProductDialogState) => setProductDialog(dialog),
    paidFeedback,
    productDialog,
    refreshProductStats,
    removeDiscount,
    removeLine: (lineId: string) => updateLines((previous) => previous.filter((line) => line.id !== lineId)),
    reset,
    selectProduct,
    setDiscount: resetDiscount,
    subtotalCents,
    totalCents: discountCalculation.totalCents,
  }
}
