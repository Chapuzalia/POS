import { useCallback, useEffect, useRef, useState } from 'react'
import { createId, getLineSignature } from '../../../lib/format'
import { calculateDiscountForLines } from '../../../lib/discounts'
import { buildSaleLine } from '../../catalog/services/saleLineBuilder'
import type { CatalogData, ResolvedCatalogItem, ResolvedSellableProduct } from '../../catalog/domain/types'
import type {
  AppliedDiscount,
  CashSession,
  Customer,
  PaymentMethod,
  ProductLineSelection,
  SaleCreatedPayload,
  TenantContext,
  TicketLine,
} from '../../../types'
import { nowIso } from '../../../utils/dates'
import { getReadableError } from '../../../utils/errors'
import {
  buildRestaurantPrintPayload,
  getEqualSplitPrintLines,
  getMovedRestaurantPrintLines,
  getRestaurantPrintSubtotal,
} from '../services/restaurantPrintPayload'
import { applySessionLayout, saveSessionTableLayout } from '../../tables/layout-service'
import {
  cancelEmptyRestaurantOrder,
  cleanupVirtualRoomRestaurantTable,
  closeRestaurantOrder,
  configureRestaurantEqualSplit,
  createVirtualRestaurantTable,
  deleteVirtualRestaurantTable,
  loadRestaurantEqualSplit,
  loadRestaurantOrder,
  loadRestaurantOrderGroup,
  loadRestaurantOrderPendingUnits,
  markRestaurantOrderFullyServed,
  markRestaurantOrderLineFullyServed,
  markRestaurantOrderLineUnitsServed,
  moveRestaurantOrder,
  moveRestaurantOrderLines,
  openRestaurantOrder,
  payRestaurantEqualPart,
  payRestaurantOrderItems,
  removeRestaurantOrderLineConfirmed,
  saveQuickSaleAsExistingTable,
  saveQuickSaleAsVirtualTable,
  saveRestaurantOrderLines,
} from '../../tables/service'
import { canDecreaseLineQuantity } from '../../tables/service-status'
import { autoIssueFiscalTicket, loadFiscalReceiptData } from '../../fiscal/service'
import { loadTicketInvoice } from '../../customers/service'
import type {
  PayRestaurantEqualPartResult,
  PayRestaurantOrderItemsResult,
  PosView,
  RestaurantEqualSplit,
  RestaurantOrderDetail,
  RestaurantOrderGroupDetail,
  RestaurantOrderLineMove,
  RestaurantTableShape,
} from '../../tables/types'
import { useRestaurantDraft } from './useRestaurantDraft'
import { isRestaurantRevisionConflict, requiresConfirmedRestaurantLineRemoval, shouldSaveBeforeLeavingOrder } from '../draft-policy'
import { getRestaurantCashClosureError } from '../services/validateCashClosure'
import { useRestaurantRealtime } from './useRestaurantRealtime'
import {
  finishCashlogyPayment,
  getCashlogyPaymentAmounts,
  settleCashlogyPaymentIfConfigured,
} from '../../local-printing/cashlogy/useCashlogyStore'
import { usePrintAgentStore } from '../../local-printing/store/usePrintAgentStore'
import type { CashlogyTransaction } from '../../local-printing/types'
import { hasTenantFeature } from '../../platform/tenantFeatureAccess'
import {
  loadOrderProductionState,
  sendProductionBatch,
  subscribeToOrderProduction,
} from '../../production/service'
import type { OrderProductionState, ProductionSelection } from '../../production/types'

async function fiscalizeTicketForPrint(context: TenantContext, ticketId: string) {
  try {
    return (await autoIssueFiscalTicket(context.tenantId, ticketId)).fiscal
  } catch (error) {
    console.error('Automatic fiscal submission failed before restaurant print', error)
    try {
      return await loadFiscalReceiptData(context.tenantId, ticketId) ?? undefined
    } catch (receiptError) {
      console.error('Could not load fiscal rejection before restaurant print', receiptError)
      return undefined
    }
  }
}

type PendingPayment = {
  method: PaymentMethod | null
  receivedCents: number | null
  pendingUnits: number
  cashlogyTransaction?: CashlogyTransaction | null
}

type Options = {
  appliedDiscount: AppliedDiscount | null
  catalog: CatalogData | null
  cashSession: CashSession | null
  context: TenantContext | null
  enabled: boolean
  isBusy: boolean
  isOnline: boolean
  onAddFeedback: (input: { feedbackType: 'added' | 'updated'; productName: string; sourceElement?: HTMLElement | null }) => void
  onError: (message: string | null) => void
  onPaidFeedback: (method: PaymentMethod | null) => void
  printSale: (payload: SaleCreatedPayload) => Promise<void>
  refreshCashSales: (saleId: string, missingTicketTitle: string, shouldPrint?: boolean) => Promise<void>
  refreshProductSalesStats: () => Promise<void>
  setAppliedDiscount: (discount: AppliedDiscount | null) => void
  setBusy: (busy: boolean) => void
  setMobileTicketOpen: (open: boolean) => void
  syncPendingEvents: () => Promise<void>
}

function withCalculationLines(
  discount: AppliedDiscount | null,
  lines: Array<{
    productId: string | null
    variantId: string | null
    unitPriceCents: number
    quantity: number
  }>,
) {
  return discount ? {
    ...discount,
    calculationLines: lines.map((line) => ({
      productId: line.productId ?? '',
      variantId: line.variantId,
      grossCents: line.unitPriceCents * line.quantity,
      quantity: line.quantity,
    })),
  } : null
}

function getVirtualRoomTable(detail: RestaurantOrderDetail) {
  return detail.tables.find((table) => table.isVirtual && table.areaId.startsWith('virtual:')) ?? null
}

function selectionContainsAllOrderLines(lines: RestaurantOrderDetail['lines'], moves: RestaurantOrderLineMove[]) {
  if (lines.length === 0) return false
  const selectedQuantities = new Map<string, number>()
  for (const move of moves) {
    selectedQuantities.set(move.lineId, (selectedQuantities.get(move.lineId) ?? 0) + move.quantity)
  }
  return lines.every((line) => (selectedQuantities.get(line.id) ?? 0) >= line.quantity)
}

export function useRestaurantController(options: Options) {
  const cashSessionId = options.cashSession?.id
  const deviceId = options.context?.deviceId
  const reportError = options.onError
  const paymentLockRef = useRef(false)
  const [posView, setPosView] = useState<PosView>({ type: 'quick_sale' })
  const [moveOrderId, setMoveOrderId] = useState<string | null>(null)
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null)
  const [invoiceCustomer, setInvoiceCustomer] = useState<Customer | null>(null)
  const [pendingLineRemoval, setPendingLineRemoval] = useState<RestaurantOrderDetail['lines'][number] | null>(null)
  const [splitOrderGroup, setSplitOrderGroup] = useState<RestaurantOrderGroupDetail | null>(null)
  const [equalSplitOpen, setEqualSplitOpen] = useState(false)
  const [equalSplit, setEqualSplit] = useState<RestaurantEqualSplit | null>(null)
  const [productionState, setProductionState] = useState<OrderProductionState | null>(null)
  const draft = useRestaurantDraft({
    context: options.context,
    isOnline: options.isOnline,
    onError: (message) => options.onError(message),
  })
  const invoiceOrderId = posView.type === 'table_order' ? posView.orderId : null
  useEffect(() => {
    setInvoiceCustomer(null)
  }, [invoiceOrderId])

  const productionAvailable = Boolean(
    options.context
    && options.context.deviceMode !== 'kds'
    && hasTenantFeature(options.context, 'production'),
  )
  const refreshProduction = useCallback(async (orderId = invoiceOrderId) => {
    if (!productionAvailable || !options.isOnline || !orderId) {
      setProductionState(null)
      return
    }
    setProductionState(await loadOrderProductionState(orderId))
  }, [invoiceOrderId, options.isOnline, productionAvailable])

  useEffect(() => {
    if (!options.context || !options.isOnline || !invoiceOrderId || !productionAvailable) {
      setProductionState(null)
      return undefined
    }
    void refreshProduction(invoiceOrderId).catch((cause) => options.onError(getReadableError(cause)))
    return subscribeToOrderProduction(options.context, invoiceOrderId, () => {
      void refreshProduction(invoiceOrderId).catch(() => undefined)
    })
  }, [invoiceOrderId, options, productionAvailable, refreshProduction])

  const settlePayment = useCallback(async (
    method: PaymentMethod | null,
    amountCents: number,
    receivedCents: number | null,
    confirmedTransaction: CashlogyTransaction | null = null,
  ) => {
    if (method !== 'cash') return { transaction: null, receivedCents, changeCents: null }
    const transaction = confirmedTransaction ?? await settleCashlogyPaymentIfConfigured(amountCents)
    if (transaction && transaction.requestedAmountCents !== amountCents) {
      throw new Error('El importe del cobro confirmado en Cashlogy no coincide con la venta actual.')
    }
    const amounts = getCashlogyPaymentAmounts(transaction, amountCents)
    return {
      transaction,
      receivedCents: transaction ? amounts.receivedCents : receivedCents,
      changeCents: amounts.changeCents,
    }
  }, [])
  const replaceDraftOrder = draft.replaceOrder
  useEffect(() => {
    if (options.enabled) return
    setPosView({ type: 'quick_sale' })
    setMoveOrderId(null)
    setPendingPayment(null)
    setPendingLineRemoval(null)
    setSplitOrderGroup(null)
    setEqualSplitOpen(false)
    setEqualSplit(null)
    replaceDraftOrder(null)
  }, [options.enabled, replaceDraftOrder])
  const realtime = useRestaurantRealtime({
    activeCashSessionId: options.cashSession?.id,
    context: options.context,
    enabled: options.enabled,
    equalSplitOpen,
    isOnline: options.isOnline,
    onError: (message) => options.onError(message),
    posView,
    replaceOrder: draft.replaceOrder,
    saveState: draft.saveState,
    setEqualSplit,
    setPosView,
    setSplitOrderGroup,
    splitOrderGroup,
  })

  const refreshState = useCallback(async (orderId?: string) => {
    if (!options.context || !options.isOnline) return
    const [nextMap, nextOrder] = await Promise.all([
      realtime.loadCurrentMap(options.context),
      orderId ? loadRestaurantOrder(options.context, orderId) : Promise.resolve(null),
    ])
    realtime.setMap(nextMap)
    if (nextOrder) draft.replaceOrder(nextOrder)
  }, [draft, options.context, options.isOnline, realtime])

  const cleanupVirtualRoomTable = useCallback(async (detail: RestaurantOrderDetail, closeAsPaid: boolean) => {
    const table = getVirtualRoomTable(detail)
    if (!cashSessionId || !deviceId || !table) return null
    try {
      const removed = await cleanupVirtualRoomRestaurantTable({ cashSessionId, deviceId, tableId: table.id, closeAsPaid })
      return removed ? table.areaId : null
    } catch (error) {
      reportError(`La comanda se ha actualizado, pero no se pudo retirar la mesa de la sala Virtual: ${getReadableError(error)}`)
      return null
    }
  }, [cashSessionId, deviceId, reportError])

  const runBusy = useCallback(async (action: () => Promise<void>) => {
    if (options.isBusy) return
    options.setBusy(true)
    options.onError(null)
    try {
      await action()
    } catch (error) {
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [options])

  const openTableOrder = useCallback((tableIds: string[], guestCount: number) => runBusy(async () => {
    if (!options.context?.canTakeOrders || !options.cashSession || !options.isOnline) return
    await options.syncPendingEvents()
    const orderId = await openRestaurantOrder({
      tableIds,
      guestCount,
      cashSessionId: options.cashSession.id,
      deviceId: options.context.deviceId,
    }).catch(async (error: unknown) => {
      if (/mesas? ya no est[áa] disponible/i.test(getReadableError(error))) {
        // Keep the RPC error even if the map cannot be reloaded (e.g. offline).
        await realtime.refreshMap().catch(() => undefined)
      }
      throw error
    })
    await refreshState(orderId)
    options.setAppliedDiscount(null)
    setPosView({ type: 'table_order', orderId })
  }), [options, realtime, refreshState, runBusy])

  const createVirtualTable = useCallback(async (input: { areaId: string | null; name: string; capacity: number; shape: RestaurantTableShape }) => {
    if (!options.context?.canTakeOrders || !options.cashSession || !options.isOnline || options.isBusy) return false
    options.setBusy(true)
    options.onError(null)
    try {
      await createVirtualRestaurantTable({
        ...input,
        cashSessionId: options.cashSession.id,
        deviceId: options.context.deviceId,
      })
      await realtime.refreshMap()
      setPosView({
        type: 'table_map',
        areaId: input.areaId ?? `virtual:${options.cashSession.id}`,
      })
      return true
    } catch (error) {
      options.onError(getReadableError(error))
      return false
    } finally {
      options.setBusy(false)
    }
  }, [options, realtime])

  const createVirtualTableFromQuickSale = useCallback(async (
    input: { areaId: string | null; name: string; capacity: number; shape: RestaurantTableShape },
    lines: TicketLine[],
    discount: AppliedDiscount | null,
  ) => {
    if (!options.context?.canTakeOrders || !options.cashSession || !options.isOnline || options.isBusy || lines.length === 0) return false
    options.setBusy(true)
    options.onError(null)
    try {
      await saveQuickSaleAsVirtualTable({
        ...input,
        cashSessionId: options.cashSession.id,
        deviceId: options.context.deviceId,
        lines,
        discount,
      })
    } catch (error) {
      options.onError(getReadableError(error))
      options.setBusy(false)
      return false
    }

    options.setAppliedDiscount(null)
    draft.clearOrder()
    setPosView({ type: 'table_map', areaId: input.areaId ?? `virtual:${options.cashSession.id}` })
    try {
      const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
      realtime.setMap(nextMap)
    } catch (error) {
      options.onError(`La mesa se ha guardado, pero el mapa no se ha podido actualizar: ${getReadableError(error)}`)
    } finally {
      options.setBusy(false)
    }
    return true
  }, [draft, options, realtime])

  const saveQuickSaleToExistingTable = useCallback(async (
    tableId: string,
    lines: TicketLine[],
    discount: AppliedDiscount | null,
  ) => {
    if (!options.context?.canTakeOrders || !options.cashSession || !options.isOnline || options.isBusy || lines.length === 0) return false
    options.setBusy(true)
    options.onError(null)
    try {
      await saveQuickSaleAsExistingTable({
        cashSessionId: options.cashSession.id,
        deviceId: options.context.deviceId,
        tableId,
        lines,
        discount,
      })
    } catch (error) {
      options.onError(getReadableError(error))
      options.setBusy(false)
      return false
    }

    try {
      const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
      realtime.setMap(nextMap)
    } catch (error) {
      options.onError(`La comanda se ha guardado, pero el mapa no se ha podido actualizar: ${getReadableError(error)}`)
    } finally {
      options.setBusy(false)
    }
    return true
  }, [options, realtime])

  const deleteVirtualTable = useCallback(async (tableId: string) => {
    if (!options.context?.canTakeOrders || !options.cashSession || !options.isOnline || options.isBusy) return false
    options.setBusy(true)
    options.onError(null)
    try {
      await deleteVirtualRestaurantTable({
        cashSessionId: options.cashSession.id,
        deviceId: options.context.deviceId,
        tableId,
      })
      const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
      realtime.setMap(nextMap)
      return true
    } catch (error) {
      options.onError(getReadableError(error))
      return false
    } finally {
      options.setBusy(false)
    }
  }, [options, realtime])

  const openExistingOrder = useCallback((orderId: string) => runBusy(async () => {
    if (!options.context || !options.isOnline) return
    const [detail, activeSplit] = await Promise.all([
      loadRestaurantOrder(options.context, orderId),
      loadRestaurantEqualSplit(options.context, orderId),
    ])
    draft.replaceOrder(detail)
    options.setAppliedDiscount(detail.order.draftDiscount)
    setPosView({ type: 'table_order', orderId })
    if (activeSplit?.paidParts) {
      setEqualSplit(activeSplit)
      setEqualSplitOpen(true)
    }
  }), [draft, options, runBusy])

  const returnToMap = useCallback(async () => {
    if (shouldSaveBeforeLeavingOrder(posView, draft.saveState) && !await draft.flush()) return
    try {
      const nextMap = options.context && options.isOnline
        ? await realtime.loadCurrentMap(options.context)
        : realtime.map
      options.setAppliedDiscount(null)
      draft.clearOrder()
      realtime.setMap(nextMap)
      setPosView({ type: 'table_map', areaId: nextMap.areas[0]?.id })
    } catch (error) {
      options.onError(getReadableError(error))
    }
  }, [draft, options, posView, realtime])

  const cancelEmptyOrder = useCallback(() => runBusy(async () => {
    const current = draft.getCurrentOrder()
    if (!options.context || !options.isOnline || !current || current.lines.length > 0) return
    const saved = await draft.flush()
    if (!saved || saved.lines.length > 0) return
    const areaId = saved.tables[0]?.areaId
    await cancelEmptyRestaurantOrder(saved.order.id, saved.order.revision)
    const cleanedAreaId = await cleanupVirtualRoomTable(saved, false)
    const nextMap = await realtime.loadCurrentMap(options.context)
    options.setAppliedDiscount(null)
    draft.clearOrder()
    setEqualSplitOpen(false)
    setEqualSplit(null)
    realtime.setMap(nextMap)
    setPosView({ type: 'table_map', areaId: cleanedAreaId ?? areaId ?? nextMap.areas[0]?.id })
  }), [cleanupVirtualRoomTable, draft, options, realtime, runBusy])

  const prepareMove = useCallback(async () => {
    const current = draft.getCurrentOrder()
    if (!current) return
    const saved = await draft.flush()
    if (!saved) return
    setMoveOrderId(saved.order.id)
    setPosView({ type: 'table_map', areaId: saved.tables[0]?.areaId })
  }, [draft])

  const moveOrder = useCallback((tableId: string) => runBusy(async () => {
    if (!moveOrderId || !options.isOnline) return
    const sourceOrder = draft.getCurrentOrder()
    await moveRestaurantOrder(moveOrderId, tableId)
    if (sourceOrder) await cleanupVirtualRoomTable(sourceOrder, false)
    await refreshState(moveOrderId)
    setPosView({ type: 'table_order', orderId: moveOrderId })
    setMoveOrderId(null)
  }), [cleanupVirtualRoomTable, draft, moveOrderId, options.isOnline, refreshState, runBusy])

  const removeLine = useCallback((lineId: string, confirmed: boolean) => runBusy(async () => {
    if (!options.context || !options.isOnline) return
    const saved = await draft.flush()
    if (!saved) return
    const currentLine = saved.lines.find((candidate) => candidate.id === lineId)
    if (!currentLine) {
      setPendingLineRemoval(null)
      return
    }
    if (requiresConfirmedRestaurantLineRemoval(currentLine.servedQuantity) && !confirmed) {
      setPendingLineRemoval(currentLine)
      return
    }
    try {
      if (requiresConfirmedRestaurantLineRemoval(currentLine.servedQuantity)) {
        await removeRestaurantOrderLineConfirmed(currentLine.id, saved.order.revision)
      } else {
        await saveRestaurantOrderLines({
          ...saved,
          lines: saved.lines.filter((candidate) => candidate.id !== currentLine.id),
        })
      }
      const cleanedAreaId = saved.lines.length === 1
        ? await cleanupVirtualRoomTable(saved, false)
        : null
      if (cleanedAreaId) {
        const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession?.id)
        realtime.setMap(nextMap)
        draft.clearOrder()
        options.setAppliedDiscount(null)
        options.setMobileTicketOpen(false)
        setPendingLineRemoval(null)
        setPosView({ type: 'table_map', areaId: cleanedAreaId })
        return
      }
      draft.replaceOrder(await loadRestaurantOrder(options.context, saved.order.id))
      setPendingLineRemoval(null)
    } catch (error) {
      if (!isRestaurantRevisionConflict(error)) throw error
      draft.replaceOrder(await loadRestaurantOrder(options.context, saved.order.id))
      setPendingLineRemoval(null)
      options.onError('La comanda cambió en otro dispositivo. Se ha recargado la versión más reciente.')
    }
  }), [cleanupVirtualRoomTable, draft, options, realtime, runBusy])

  const requestLineRemoval = useCallback((lineId: string) => {
    const line = draft.getCurrentOrder()?.lines.find((candidate) => candidate.id === lineId)
    if (!line || !options.isOnline) return
    if (requiresConfirmedRestaurantLineRemoval(line.servedQuantity)) {
      setPendingLineRemoval(line)
      return
    }
    void removeLine(line.id, false)
  }, [draft, options.isOnline, removeLine])

  const confirmLineRemoval = useCallback(() => {
    if (!pendingLineRemoval) return
    void removeLine(pendingLineRemoval.id, true)
  }, [pendingLineRemoval, removeLine])

  const openSplitOrder = useCallback(() => runBusy(async () => {
    if (!options.context || !options.isOnline || !draft.getCurrentOrder()) return
    const saved = await draft.flush()
    if (saved) setSplitOrderGroup(await loadRestaurantOrderGroup(options.context, saved.order.id))
  }), [draft, options, runBusy])

  const openEqualSplitOrder = useCallback(() => runBusy(async () => {
    if (!options.context || !options.isOnline || !draft.getCurrentOrder()) return
    const saved = await draft.flush()
    if (!saved) return
    draft.replaceOrder(saved)
    setEqualSplit(await loadRestaurantEqualSplit(options.context, saved.order.id))
    setEqualSplitOpen(true)
  }), [draft, options, runBusy])

  const configureEqualSplit = useCallback(async (partCount: number) => {
    const current = draft.getCurrentOrder()
    if (!current) throw new Error('No hay una comanda abierta.')
    options.setBusy(true)
    options.onError(null)
    try {
      const configured = await configureRestaurantEqualSplit(
        current.order.id,
        partCount,
        current.order.revision,
        withCalculationLines(options.appliedDiscount, current.lines),
      )
      setEqualSplit(configured)
      return configured
    } catch (error) {
      options.onError(getReadableError(error))
      throw error
    } finally {
      options.setBusy(false)
    }
  }, [draft, options])

  const refreshSales = useCallback(async (saleId: string, missingTicketTitle: string, shouldPrint = true) => {
    await Promise.all([
      options.refreshCashSales(saleId, missingTicketTitle, shouldPrint),
      options.refreshProductSalesStats(),
    ])
  }, [options])

  const payEqualSplitPart = useCallback(async (
    method: PaymentMethod | null,
    receivedCents: number | null,
    allowPending: boolean,
    discount: AppliedDiscount | null,
    useDefaultDiscount: boolean,
  ): Promise<PayRestaurantEqualPartResult> => {
    const current = draft.getCurrentOrder()
    if (!options.context || !options.cashSession || !equalSplit || !current) throw new Error('No hay una división activa.')
    if (paymentLockRef.current) throw new Error('Ya hay un cobro en curso.')
    paymentLockRef.current = true
    options.setBusy(true)
    options.onError(null)
    try {
      const paymentLines = getEqualSplitPrintLines(current.lines, equalSplit)
      if (method === 'cash' && !allowPending) {
        const pending = await loadRestaurantOrderPendingUnits(options.context, current.order.id)
        draft.replaceOrder(pending.detail)
        if (pending.pendingUnits > 0) return { requiresConfirmation: true, pendingUnits: pending.pendingUnits, split: equalSplit }
      }
      const effectiveDiscount = useDefaultDiscount ? equalSplit.nextDefaultDiscount : discount
      const amountCents = useDefaultDiscount
        ? equalSplit.nextDefaultTotalCents
        : calculateDiscountForLines(paymentLines.map((line) => ({
            productId: line.productId ?? '', variantId: line.variantId ?? '', grossCents: line.lineTotalCents ?? line.unitPriceCents * line.quantity, quantity: line.quantity,
          })), effectiveDiscount).totalCents
      const cashlogy = await settlePayment(method, amountCents, receivedCents)
      const result = await payRestaurantEqualPart(equalSplit.id, method, cashlogy.receivedCents, allowPending, withCalculationLines(discount, paymentLines), useDefaultDiscount, cashlogy.transaction)
      setEqualSplit(result.split)
      if (!result.requiresConfirmation) {
        finishCashlogyPayment(cashlogy.transaction)
        const cleanedAreaId = result.completed
          ? await cleanupVirtualRoomTable(current, true)
          : null
        const printLines = paymentLines
        const fiscal = await fiscalizeTicketForPrint(options.context, result.ticketId)
        void options.printSale(buildRestaurantPrintPayload({
          cashSession: options.cashSession,
          context: options.context,
          createdAt: nowIso(),
          discount: useDefaultDiscount ? equalSplit.nextDefaultDiscount : discount,
          lines: printLines,
          paymentId: result.paymentId,
          paymentMethod: method,
          receivedCents: cashlogy.receivedCents,
          changeCents: cashlogy.changeCents,
          saleId: result.saleId,
          subtotalCents: getRestaurantPrintSubtotal(printLines),
          ticketId: result.ticketId,
          totalCents: result.paidAmountCents,
          fiscal,
        }))
        await refreshSales(result.saleId, 'Pago completado sin imprimir', false)
        const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
        realtime.setMap(nextMap)
        if (result.completed) {
          const nextOrder = result.nextOrderId ? await loadRestaurantOrder(options.context, result.nextOrderId) : null
          draft.replaceOrder(nextOrder)
          options.setAppliedDiscount(null)
          options.setMobileTicketOpen(false)
          setPosView(nextOrder
            ? { type: 'table_order', orderId: nextOrder.order.id }
            : { type: 'table_map', areaId: cleanedAreaId ?? nextMap.areas[0]?.id })
        }
      }
      return result
    } catch (error) {
      options.onError(getReadableError(error))
      throw error
    } finally {
      options.setBusy(false)
      paymentLockRef.current = false
    }
  }, [cleanupVirtualRoomTable, draft, equalSplit, options, realtime, refreshSales, settlePayment])

  const paySelectedOrderItems = useCallback(async (
    moves: RestaurantOrderLineMove[],
    method: PaymentMethod | null,
    receivedCents: number | null,
    allowPending: boolean,
    discount: AppliedDiscount | null,
  ): Promise<PayRestaurantOrderItemsResult> => {
    const current = draft.getCurrentOrder()
    if (!options.context || !options.cashSession || !options.isOnline || !current) throw new Error('No hay una comanda abierta.')
    if (paymentLockRef.current) throw new Error('Ya hay un cobro en curso.')
    paymentLockRef.current = true
    options.setBusy(true)
    options.onError(null)
    try {
      const saved = await draft.flush()
      if (!saved) throw new Error('No se pudo guardar la comanda antes del cobro.')
      const paymentLines = getMovedRestaurantPrintLines(saved.lines, moves)
      if (method === 'cash' && !allowPending) {
        const pending = await loadRestaurantOrderPendingUnits(options.context, saved.order.id)
        draft.replaceOrder(pending.detail)
        if (pending.pendingUnits > 0) return { requiresConfirmation: true, pendingUnits: pending.pendingUnits }
      }
      const amountCents = calculateDiscountForLines(paymentLines.map((line) => ({
        productId: line.productId ?? '', variantId: line.variantId ?? '', grossCents: line.lineTotalCents ?? line.unitPriceCents * line.quantity, quantity: line.quantity,
      })), discount).totalCents
      const cashlogy = await settlePayment(method, amountCents, receivedCents)
      const result = await payRestaurantOrderItems(saved.order.id, saved.order.revision, moves, method, cashlogy.receivedCents, allowPending, withCalculationLines(discount, paymentLines), cashlogy.transaction)
      if (!result.requiresConfirmation) {
        finishCashlogyPayment(cashlogy.transaction)
        const cleanedAreaId = selectionContainsAllOrderLines(saved.lines, moves)
          ? await cleanupVirtualRoomTable(saved, true)
          : null
        const printLines = paymentLines
        const fiscal = await fiscalizeTicketForPrint(options.context, result.ticketId)
        void options.printSale(buildRestaurantPrintPayload({
          cashSession: options.cashSession,
          context: options.context,
          createdAt: nowIso(),
          discount,
          lines: printLines,
          paymentId: result.paymentId,
          paymentMethod: method,
          receivedCents: cashlogy.receivedCents,
          changeCents: cashlogy.changeCents,
          saleId: result.saleId,
          subtotalCents: result.subtotalCents,
          ticketId: result.ticketId,
          totalCents: result.totalCents,
          fiscal,
        }))
        await refreshSales(result.saleId, 'Cobro completado sin imprimir', false)
        const [nextOrder, nextMap] = await Promise.all([
          cleanedAreaId ? Promise.resolve(null) : loadRestaurantOrder(options.context, saved.order.id),
          realtime.loadCurrentMap(options.context, options.cashSession.id),
        ])
        draft.replaceOrder(nextOrder)
        realtime.setMap(nextMap)
        options.setAppliedDiscount(null)
        options.setMobileTicketOpen(false)
        setSplitOrderGroup(null)
        setPosView(nextOrder
          ? { type: 'table_order', orderId: nextOrder.order.id }
          : { type: 'table_map', areaId: cleanedAreaId ?? nextMap.areas[0]?.id })
      }
      return result
    } catch (error) {
      if (isRestaurantRevisionConflict(error)) {
        try {
          draft.replaceOrder(await loadRestaurantOrder(options.context, current.order.id))
          options.onError('La comanda cambió en otro dispositivo. Se ha recargado la versión más reciente.')
        } catch (reloadError) {
          options.onError(getReadableError(reloadError))
        }
      } else {
        options.onError(getReadableError(error))
      }
      throw error
    } finally {
      options.setBusy(false)
      paymentLockRef.current = false
    }
  }, [cleanupVirtualRoomTable, draft, options, realtime, refreshSales, settlePayment])
  const splitOrder = useCallback(async (
    sourceOrderId: string,
    targetOrderId: string | null,
    moves: RestaurantOrderLineMove[],
  ): Promise<string | null> => {
    if (!options.context || !options.isOnline || !splitOrderGroup) return null
    const source = splitOrderGroup.orders.find((detail) => detail.order.id === sourceOrderId)
    const target = targetOrderId ? splitOrderGroup.orders.find((detail) => detail.order.id === targetOrderId) : null
    if (!source || (targetOrderId && !target)) return null
    options.setBusy(true)
    options.onError(null)
    try {
      const result = await moveRestaurantOrderLines(
        sourceOrderId,
        targetOrderId,
        source.order.revision,
        target?.order.revision ?? null,
        moves,
      )
      const refreshedGroup = await loadRestaurantOrderGroup(options.context, result.targetOrderId)
      setSplitOrderGroup(refreshedGroup)
      const currentId = draft.getCurrentOrder()?.order.id
      const nextId = result.sourceCancelled && currentId === sourceOrderId ? result.targetOrderId : currentId ?? result.targetOrderId
      const next = refreshedGroup.orders.find((detail) => detail.order.id === nextId && detail.order.status === 'open')
        ?? refreshedGroup.orders.find((detail) => detail.order.status === 'open')
      if (next) {
        draft.replaceOrder(next)
        setPosView({ type: 'table_order', orderId: next.order.id })
      }
      realtime.setMap(await realtime.loadCurrentMap(options.context))
      return result.targetOrderId
    } catch (error) {
      if (isRestaurantRevisionConflict(error)) {
        try {
          const currentId = draft.getCurrentOrder()?.order.id ?? sourceOrderId
          const group = await loadRestaurantOrderGroup(options.context, currentId)
          setSplitOrderGroup(group)
          const current = group.orders.find((detail) => detail.order.id === currentId && detail.order.status === 'open')
          if (current) draft.replaceOrder(current)
          options.onError('Las comandas cambiaron en otro dispositivo. Se ha recargado la versión más reciente.')
        } catch (reloadError) {
          options.onError(getReadableError(reloadError))
        }
      } else {
        options.onError(getReadableError(error))
      }
      return null
    } finally {
      options.setBusy(false)
    }
  }, [draft, options, realtime, splitOrderGroup])

  const openOrderFromSplit = useCallback((orderId: string) => {
    const detail = splitOrderGroup?.orders.find((candidate) => candidate.order.id === orderId && candidate.order.status === 'open')
    if (!detail) return
    draft.replaceOrder(detail)
    options.setAppliedDiscount(null)
    options.setMobileTicketOpen(true)
    setPosView({ type: 'table_order', orderId })
    setSplitOrderGroup(null)
  }, [draft, options, splitOrderGroup])

  const completePayment = useCallback(async (
    method: PaymentMethod | null,
    receivedCents: number | null,
    forceWithPending = false,
    confirmedCashlogyTransaction: CashlogyTransaction | null = null,
  ) => {
    const context = options.context
    const cashSession = options.cashSession
    if (!context?.canTakePayments || !cashSession || !draft.getCurrentOrder() || !options.isOnline || paymentLockRef.current) return
    paymentLockRef.current = true
    options.setBusy(true)
    options.onError(null)
    try {
      const saved = await draft.flush()
      if (!saved) return
      const requiresCashlogyPreflight = method === 'cash'
        && usePrintAgentStore.getState().cashlogyConfigured
        && !forceWithPending
      if (requiresCashlogyPreflight) {
        const pendingCheck = await loadRestaurantOrderPendingUnits(context, saved.order.id)
        draft.replaceOrder(pendingCheck.detail)
        if (pendingCheck.pendingUnits > 0) {
          setPendingPayment({ method, receivedCents, pendingUnits: pendingCheck.pendingUnits })
          return
        }
      }
      const amountCents = calculateDiscountForLines(saved.lines.map((line) => ({
        productId: line.productId ?? '', variantId: line.variantId ?? '', grossCents: line.unitPriceCents * line.quantity, quantity: line.quantity,
      })), options.appliedDiscount).totalCents
      const recoveredCashlogy = confirmedCashlogyTransaction ?? (forceWithPending ? pendingPayment?.cashlogyTransaction ?? null : null)
      const cashlogy = await settlePayment(method, amountCents, receivedCents, recoveredCashlogy)
      const result = await closeRestaurantOrder(saved.order.id, method, cashlogy.receivedCents, forceWithPending, withCalculationLines(options.appliedDiscount, saved.lines), invoiceCustomer, cashlogy.transaction)
      if (result.requiresConfirmation) {
        setPendingPayment({ method, receivedCents: cashlogy.receivedCents, pendingUnits: result.pendingUnits, cashlogyTransaction: cashlogy.transaction })
        return
      }
      finishCashlogyPayment(cashlogy.transaction)
      const nextOrder = result.nextOrderId ? await loadRestaurantOrder(context, result.nextOrderId) : null
      const returnAreaId = getVirtualRoomTable(saved)?.areaId
        ?? saved.tables[0]?.areaId
        ?? realtime.map.areas[0]?.id
      if (!nextOrder) {
        const releasedTableIds = new Set(saved.tables.map((table) => table.id))
        realtime.setMap((current) => ({
          ...current,
          tables: current.tables
            .filter((table) => !releasedTableIds.has(table.id) || !table.isVirtual)
            .map((table) => releasedTableIds.has(table.id) ? {
              ...table,
              status: table.nextReservation ? 'reserved' : 'free',
              orderId: null,
              orderOpenedAt: null,
              guestCount: null,
              totalCents: 0,
              pendingUnits: 0,
              readyUnits: 0,
              groupTableIds: [],
            } : table),
        }))
      }
      draft.replaceOrder(nextOrder)
      setPendingPayment(null)
      options.setMobileTicketOpen(false)
      options.setAppliedDiscount(null)
      setInvoiceCustomer(null)
      options.onPaidFeedback(method)
      setPosView(nextOrder
        ? { type: 'table_order', orderId: nextOrder.order.id }
        : { type: 'table_map', areaId: returnAreaId })
      window.setTimeout(() => options.onPaidFeedback(null), 500)

      const refreshMapTask = (async () => {
        await cleanupVirtualRoomTable(saved, true)
        const nextMap = await realtime.loadCurrentMap(context, cashSession.id)
        realtime.setMap(nextMap)
      })()
      const refreshSalesTask = Promise.all([
        options.syncPendingEvents(),
        refreshSales(result.saleId, 'Cobro completado sin imprimir', false),
      ])
      const printTask = (async () => {
        const [fiscal, invoice] = await Promise.all([
          fiscalizeTicketForPrint(context, result.ticketId),
          invoiceCustomer ? loadTicketInvoice(context.tenantId, result.ticketId) : Promise.resolve(null),
        ])
        if (invoiceCustomer && !invoice) {
          throw new Error('El cobro se ha registrado, pero no se ha confirmado el número de factura. No se imprimirá como ticket normal.')
        }
        await options.printSale(buildRestaurantPrintPayload({
          cashSession,
          context,
          createdAt: nowIso(),
          discount: options.appliedDiscount,
          lines: saved.lines,
          paymentId: result.paymentId,
          paymentMethod: method,
          receivedCents: cashlogy.receivedCents,
          changeCents: cashlogy.changeCents,
          saleId: result.saleId,
          subtotalCents: getRestaurantPrintSubtotal(saved.lines),
          ticketId: result.ticketId,
          totalCents: result.totalCents,
          fiscal,
          invoice,
        }))
      })()
      void Promise.allSettled([refreshMapTask, refreshSalesTask, printTask]).then((tasks) => {
        const failures = tasks
          .filter((task): task is PromiseRejectedResult => task.status === 'rejected')
          .map((task) => getReadableError(task.reason))
        if (failures.length > 0) options.onError(failures.join(' '))
      })
    } catch (error) {
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
      paymentLockRef.current = false
    }
  }, [cleanupVirtualRoomTable, draft, invoiceCustomer, options, pendingPayment, realtime, refreshSales, settlePayment])

  const requestCloseCash = useCallback(async () => {
    if (!options.context || !options.cashSession) return false
    const closureError = await getRestaurantCashClosureError({
      cashSession: options.cashSession,
      context: options.context,
      isOnline: options.isOnline,
      tablesEnabled: realtime.tablesEnabled,
    })
    if (!closureError) return true
    options.onError(closureError)
    return false
  }, [options, realtime.tablesEnabled])

  const addLine = useCallback((
    sellable: ResolvedSellableProduct,
    selection: ProductLineSelection,
    item: ResolvedCatalogItem | null,
    lineId?: string,
    sourceElement?: HTMLElement | null,
  ) => {
    if (!options.isOnline) {
      options.onError('La gestión de mesas requiere conexión.')
      return false
    }
    const current = draft.getCurrentOrder()
    if (!current || !options.context || !options.catalog) return false
    const candidate = buildSaleLine(createId(), options.catalog, sellable, selection, item)
    if (lineId) {
      if ((productionState?.lines.find((line) => line.lineId === lineId)?.sentQuantity ?? 0) > 0
        && !window.confirm('Este producto ya se envió a producción. Se notificará la modificación a cocina/barra. ¿Continuar?')) return false
      const timestamp = nowIso()
      draft.updateDraft((detail) => ({
        ...detail,
        lines: detail.lines.map((line) => line.id === lineId ? {
          ...line,
          productId: candidate.productId,
          variantId: candidate.variantId,
          productName: candidate.productName,
          variantName: candidate.variantName,
          unitPriceCents: candidate.unitPriceCents,
          modifiers: candidate.modifiers,
          components: candidate.components,
          catalogSnapshot: candidate.catalogSnapshot,
          mixerProductId: candidate.mixerProductId ?? null,
          mixer: candidate.mixer ?? null,
          updatedAt: timestamp,
        } : line),
      }))
      options.onAddFeedback({ feedbackType: 'updated', productName: candidate.productName, sourceElement })
      return true
    }
    const signature = getLineSignature(candidate)
    const existing = current.lines.find((line) => line.productId !== null
      && line.note === null
      && getLineSignature({
        productId: line.productId,
        variantId: line.variantId ?? '',
        modifiers: line.modifiers,
        components: line.components,
        mixerProductId: line.mixerProductId,
      }) === signature)
    const timestamp = nowIso()
    draft.updateDraft((detail) => ({
      ...detail,
      lines: existing
        ? detail.lines.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1, updatedAt: timestamp } : line)
        : [...detail.lines, {
            id: candidate.id,
            tenantId: options.context!.tenantId,
            venueId: options.context!.venueId,
            orderId: detail.order.id,
            productId: candidate.productId,
            variantId: candidate.variantId,
            productName: candidate.productName,
            variantName: candidate.variantName,
            unitPriceCents: candidate.unitPriceCents,
            quantity: 1,
            servedQuantity: 0,
            fullyServedAt: null,
            modifiers: candidate.modifiers,
            components: candidate.components,
            catalogSnapshot: candidate.catalogSnapshot,
            mixerProductId: candidate.mixerProductId ?? null,
            mixer: candidate.mixer ?? null,
            note: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }],
    }))
    options.onAddFeedback({ feedbackType: 'added', productName: candidate.productName, sourceElement })
    return true
  }, [draft, options, productionState])

  const changeLineQuantity = useCallback((lineId: string, direction: 1 | -1) => {
    if (!options.isOnline) return
    const line = draft.getCurrentOrder()?.lines.find((item) => item.id === lineId)
    if (!line) return
    if (direction === -1
      && (productionState?.lines.find((state) => state.lineId === lineId)?.sentQuantity ?? 0) > line.quantity - 1
      && !window.confirm('Esta unidad ya se envió a producción. Se generará una anulación para cocina/barra. ¿Continuar?')) return
    if (direction === -1 && !canDecreaseLineQuantity(line)) {
      options.onError('No puedes reducir la cantidad por debajo de las unidades servidas.')
      return
    }
    draft.updateDraft((detail) => ({
      ...detail,
      lines: detail.lines
        .map((item) => item.id === lineId ? { ...item, quantity: item.quantity + direction, updatedAt: nowIso() } : item)
        .filter((item) => item.quantity > 0),
    }))
  }, [draft, options, productionState])

  const setLineQuantity = useCallback((lineId: string, quantity: number) => {
    if (!options.isOnline) return
    const line = draft.getCurrentOrder()?.lines.find((item) => item.id === lineId)
    if (!line || line.quantity === quantity) return
    if (!Number.isSafeInteger(quantity) || quantity < line.servedQuantity || quantity < 1) {
      options.onError('No puedes reducir la cantidad por debajo de las unidades servidas.')
      return
    }
    if (quantity < line.quantity
      && (productionState?.lines.find((state) => state.lineId === lineId)?.sentQuantity ?? 0) > quantity
      && !window.confirm('Parte de esta cantidad ya se envió a producción. Se generará una anulación para cocina/barra. ¿Continuar?')) return
    draft.updateDraft((detail) => ({
      ...detail,
      lines: detail.lines.map((item) => item.id === lineId ? { ...item, quantity, updatedAt: nowIso() } : item),
    }))
  }, [draft, options, productionState])

  const setLineUnitPrice = useCallback((lineId: string, unitPriceCents: number) => {
    if (!options.isOnline) return
    if (!Number.isSafeInteger(unitPriceCents) || unitPriceCents < 0) {
      options.onError('El precio unitario no es válido.')
      return
    }
    const line = draft.getCurrentOrder()?.lines.find((item) => item.id === lineId)
    if (!line || line.unitPriceCents === unitPriceCents) return
    draft.updateDraft((detail) => ({
      ...detail,
      lines: detail.lines.map((item) => item.id === lineId ? { ...item, unitPriceCents, updatedAt: nowIso() } : item),
    }))
  }, [draft, options])

  const runServiceAction = useCallback((action: (order: RestaurantOrderDetail) => Promise<void>) => runBusy(async () => {
    if (!options.context || !options.isOnline) return
    const saved = await draft.flush()
    if (!saved) return
    try {
      await action(saved)
    } finally {
      draft.replaceOrder(await loadRestaurantOrder(options.context, saved.order.id))
    }
  }), [draft, options, runBusy])

  const sendToProduction = useCallback((selection?: ProductionSelection[]) => runBusy(async () => {
    if (!options.context || !options.isOnline || !productionAvailable) return
    const saved = await draft.flush()
    if (!saved) return
    await sendProductionBatch({
      orderId: saved.order.id,
      expectedRevision: saved.order.revision,
      deviceId: options.context.deviceId,
      requestId: `pos:${options.context.deviceId}:${createId()}`,
      selection,
    })
    await refreshProduction(saved.order.id)
  }), [draft, options.context, options.isOnline, productionAvailable, refreshProduction, runBusy])

  const reset = useCallback((areaId?: string) => {
    draft.clearOrder()
    setPosView({ type: 'quick_sale', areaId })
    setMoveOrderId(null)
    setPendingPayment(null)
    setPendingLineRemoval(null)
    setSplitOrderGroup(null)
    setEqualSplitOpen(false)
    setEqualSplit(null)
    setInvoiceCustomer(null)
  }, [draft])

  return {
    addLine,
    cancelEmptyOrder,
    changeLineQuantity,
    clearTicket: () => draft.updateDraft((detail) => ({ ...detail, lines: [] })),
    completePayment,
    configureEqualSplit,
    createVirtualTable,
    createVirtualTableFromQuickSale,
    deleteVirtualTable,
    confirmLineRemoval,
    equalSplit,
    equalSplitOpen,
    invoiceCustomer,
    map: realtime.map,
    moveOrder,
    moveOrderId,
    openEqualSplitOrder,
    openExistingOrder,
    openOrderFromSplit,
    openSplitOrder,
    openTableOrder,
    order: draft.order,
    payEqualSplitPart,
    paySelectedOrderItems,
    pendingLineRemoval,
    pendingPayment,
    posView,
    prepareMove,
    requestCloseCash,
    requestLineRemoval,
    removeInvoiceCustomer: () => setInvoiceCustomer(null),
    reset,
    returnToMap,
    saveState: draft.saveState,
    saveQuickSaleToExistingTable,
    productionState,
    sendToProduction,
    serveLineFully: (lineId: string) => void runServiceAction(() => markRestaurantOrderLineFullyServed(lineId)),
    serveLineUnit: (lineId: string) => void runServiceAction(() => markRestaurantOrderLineUnitsServed(lineId, 1)),
    serveOrderFully: () => void runServiceAction((order) => markRestaurantOrderFullyServed(order.order.id)),
    setEqualSplit,
    setEqualSplitOpen,
    setInvoiceCustomer,
    setLineQuantity,
    setLineUnitPrice,
    setMap: realtime.setMap,
    setMoveOrderId,
    setPendingLineRemoval,
    setPendingPayment,
    setPosView,
    setSplitOrderGroup,
    splitOrder,
    splitOrderGroup,
    tablesConfigLoaded: realtime.configLoaded,
    tablesEnabled: realtime.tablesEnabled,
    updateDraft: draft.updateDraft,
    updateSessionLayout: async (cashSessionId: string, expectedRevision: number, tables: Parameters<typeof saveSessionTableLayout>[2]) => {
      const saved = await saveSessionTableLayout(cashSessionId, expectedRevision, tables)
      realtime.setMap((current) => applySessionLayout(current, saved))
      return saved
    },
    reloadMap: realtime.refreshMap,
  }
}
