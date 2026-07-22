import { useCallback, useMemo, useState } from 'react'
import type { CatalogData, ResolvedCatalogItem, ResolvedSellableProduct } from '../../catalog/domain/types'
import { getDefaultProductLineSelection } from '../../catalog/services/saleLineBuilder'
import { calculateAppliedDiscount } from '../../../lib/discounts'
import { getTicketTotal } from '../../../lib/format'
import { saveCachedTicket } from '../../../lib/offlineStore'
import { loadProductSalesStatsFromSupabase } from '../../../services/posService'
import type {
  AppliedDiscount,
  CashSession,
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
  const [productDialog, setProductDialog] = useState<ProductDialogState | null>(null)
  const [cashPaymentOpen, setCashPaymentOpen] = useState(false)
  const [discountModalOpen, setDiscountModalOpen] = useState(false)
  const [paidFeedback, setPaidFeedback] = useState<PaymentMethod | null>(null)

  const persistLines = useCallback((nextLines: TicketLine[]) => {
    setLines(nextLines)
    if (options.context) saveCachedTicket(options.context, nextLines)
  }, [options.context])

  const mergeProductStats = useCallback((soldLines: TicketLine[]) => {
    options.persistProductSalesStats(addProductSalesStats(options.productSalesStats, soldLines))
  }, [options])

  const completePayment = useQuickSalePayment({
    context: options.context,
    cashSession: options.cashSession,
    lines,
    discount,
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
      setDiscountModalOpen(false)
      setPaidFeedback(method)
      window.setTimeout(() => setPaidFeedback(null), 500)
    },
  })

  const addLine = useCallback<AddCatalogLine>((sellable, selection, item, sourceElement) => {
    if (!options.catalog) return false
    persistLines(addQuickSaleTicketLine(lines, options.catalog, sellable, selection, item))
    options.onAddFeedback({ feedbackType: 'added', productName: sellable.product.name, sourceElement })
    return true
  }, [lines, options, persistLines])

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
    () => calculateAppliedDiscount(subtotalCents, discount),
    [discount, subtotalCents],
  )

  const reset = useCallback((nextLines: TicketLine[] = []) => {
    setLines(nextLines)
    setDiscount(null)
    setProductDialog(null)
    setCashPaymentOpen(false)
    setDiscountModalOpen(false)
    setPaidFeedback(null)
  }, [])

  return {
    addLine,
    cashPaymentOpen,
    changeQuantity: (lineId: string, direction: 1 | -1) => {
      persistLines(changeQuickSaleTicketLineQuantity(lines, lineId, direction))
    },
    clear: () => {
      persistLines([])
      setDiscount(null)
    },
    closeCashPayment: () => setCashPaymentOpen(false),
    closeDiscountModal: () => setDiscountModalOpen(false),
    closeProductDialog: () => setProductDialog(null),
    completePayment,
    discount,
    discountAmountCents: discountCalculation.discountAmountCents,
    discountModalOpen,
    hydrate: (nextLines: TicketLine[]) => setLines(nextLines),
    lines,
    openCashPayment: () => setCashPaymentOpen(true),
    openDiscountModal: () => setDiscountModalOpen(true),
    openProductDialog: (dialog: ProductDialogState) => setProductDialog(dialog),
    paidFeedback,
    productDialog,
    refreshProductStats,
    removeLine: (lineId: string) => persistLines(lines.filter((line) => line.id !== lineId)),
    reset,
    selectProduct,
    setDiscount,
    subtotalCents,
    totalCents: discountCalculation.totalCents,
  }
}
