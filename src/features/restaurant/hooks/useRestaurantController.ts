import { useCallback, useState } from 'react'
import { createId, getLineSignature } from '../../../lib/format'
import type {
  AppliedDiscount,
  CashSession,
  PaymentMethod,
  Product,
  ProductLineSelection,
  ProductVariant,
  TenantContext,
} from '../../../types'
import { nowIso } from '../../../utils/dates'
import { getReadableError } from '../../../utils/errors'
import { applySessionLayout, saveSessionTableLayout } from '../../tables/layout-service'
import {
  cancelEmptyRestaurantOrder,
  closeRestaurantOrder,
  configureRestaurantEqualSplit,
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
  removeRestaurantOrderLineConfirmed,
  saveRestaurantOrderLines,
} from '../../tables/service'
import { canDecreaseLineQuantity } from '../../tables/service-status'
import type {
  PayRestaurantEqualPartResult,
  PosView,
  RestaurantEqualSplit,
  RestaurantOrderDetail,
  RestaurantOrderGroupDetail,
  RestaurantOrderLineMove,
} from '../../tables/types'
import { useRestaurantDraft } from './useRestaurantDraft'
import { isRestaurantRevisionConflict, requiresConfirmedRestaurantLineRemoval, shouldSaveBeforeLeavingOrder } from '../draft-policy'
import { getRestaurantCashClosureError } from '../services/validateCashClosure'
import { useRestaurantRealtime } from './useRestaurantRealtime'

type PendingPayment = { method: PaymentMethod | null; receivedCents: number | null; pendingUnits: number }

type Options = {
  appliedDiscount: AppliedDiscount | null
  cashSession: CashSession | null
  context: TenantContext | null
  enabled: boolean
  isBusy: boolean
  isOnline: boolean
  onAddFeedback: (input: { feedbackType: 'added' | 'updated'; productName: string; sourceElement?: HTMLElement | null }) => void
  onError: (message: string | null) => void
  onPaidFeedback: (method: PaymentMethod | null) => void
  refreshCashSales: (saleId: string, missingTicketTitle: string) => Promise<void>
  refreshProductSalesStats: () => Promise<void>
  setAppliedDiscount: (discount: AppliedDiscount | null) => void
  setBusy: (busy: boolean) => void
  setMobileTicketOpen: (open: boolean) => void
  syncPendingEvents: () => Promise<void>
}

export function useRestaurantController(options: Options) {
  const [posView, setPosView] = useState<PosView>({ type: 'quick_sale' })
  const [moveOrderId, setMoveOrderId] = useState<string | null>(null)
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null)
  const [pendingLineRemoval, setPendingLineRemoval] = useState<RestaurantOrderDetail['lines'][number] | null>(null)
  const [splitOrderGroup, setSplitOrderGroup] = useState<RestaurantOrderGroupDetail | null>(null)
  const [equalSplitOpen, setEqualSplitOpen] = useState(false)
  const [equalSplit, setEqualSplit] = useState<RestaurantEqualSplit | null>(null)
  const draft = useRestaurantDraft({
    context: options.context,
    isOnline: options.isOnline,
    onError: (message) => options.onError(message),
  })
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
    })
    await refreshState(orderId)
    options.setAppliedDiscount(null)
    setPosView({ type: 'table_order', orderId })
  }), [options, refreshState, runBusy])

  const openExistingOrder = useCallback((orderId: string) => runBusy(async () => {
    if (!options.context || !options.isOnline) return
    const [detail, activeSplit] = await Promise.all([
      loadRestaurantOrder(options.context, orderId),
      loadRestaurantEqualSplit(options.context, orderId),
    ])
    draft.replaceOrder(detail)
    options.setAppliedDiscount(null)
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
    if (!window.confirm('¿Cerrar esta mesa vacía? La comanda se cancelará y la mesa volverá a quedar libre.')) return
    const saved = await draft.flush()
    if (!saved || saved.lines.length > 0) return
    const areaId = saved.tables[0]?.areaId
    await cancelEmptyRestaurantOrder(saved.order.id, saved.order.revision)
    const nextMap = await realtime.loadCurrentMap(options.context)
    options.setAppliedDiscount(null)
    draft.clearOrder()
    setEqualSplitOpen(false)
    setEqualSplit(null)
    realtime.setMap(nextMap)
    setPosView({ type: 'table_map', areaId: areaId ?? nextMap.areas[0]?.id })
  }), [draft, options, realtime, runBusy])

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
    await moveRestaurantOrder(moveOrderId, tableId)
    await refreshState(moveOrderId)
    setPosView({ type: 'table_order', orderId: moveOrderId })
    setMoveOrderId(null)
  }), [moveOrderId, options.isOnline, refreshState, runBusy])

  const confirmLineRemoval = useCallback(() => runBusy(async () => {
    const line = pendingLineRemoval
    if (!options.context || !options.isOnline || !line) return
    const saved = await draft.flush()
    if (!saved) return
    const currentLine = saved.lines.find((candidate) => candidate.id === line.id)
    if (!currentLine) {
      setPendingLineRemoval(null)
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
      draft.replaceOrder(await loadRestaurantOrder(options.context, saved.order.id))
      setPendingLineRemoval(null)
    } catch (error) {
      if (!isRestaurantRevisionConflict(error)) throw error
      draft.replaceOrder(await loadRestaurantOrder(options.context, saved.order.id))
      setPendingLineRemoval(null)
      options.onError('La comanda cambió en otro dispositivo. Se ha recargado la versión más reciente.')
    }
  }), [draft, options, pendingLineRemoval, runBusy])

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
        options.appliedDiscount,
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

  const refreshSales = useCallback(async (saleId: string, missingTicketTitle: string) => {
    await Promise.all([
      options.refreshCashSales(saleId, missingTicketTitle),
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
    if (!options.context || !options.cashSession || !equalSplit) throw new Error('No hay una división activa.')
    options.setBusy(true)
    options.onError(null)
    try {
      const result = await payRestaurantEqualPart(equalSplit.id, method, receivedCents, allowPending, discount, useDefaultDiscount)
      setEqualSplit(result.split)
      if (!result.requiresConfirmation) {
        await refreshSales(result.saleId, 'Pago completado sin imprimir')
        const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
        realtime.setMap(nextMap)
        if (result.completed) {
          const nextOrder = result.nextOrderId ? await loadRestaurantOrder(options.context, result.nextOrderId) : null
          draft.replaceOrder(nextOrder)
          options.setAppliedDiscount(null)
          options.setMobileTicketOpen(false)
          setPosView(nextOrder
            ? { type: 'table_order', orderId: nextOrder.order.id }
            : { type: 'table_map', areaId: nextMap.areas[0]?.id })
        }
      }
      return result
    } catch (error) {
      options.onError(getReadableError(error))
      throw error
    } finally {
      options.setBusy(false)
    }
  }, [draft, equalSplit, options, realtime, refreshSales])

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
          options.onError('Las comandas cambiaron en otro dispositivo. Se ha recargado la version mas reciente.')
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
  ) => {
    if (!options.context?.canTakePayments || !options.cashSession || !draft.getCurrentOrder() || !options.isOnline) return
    options.setBusy(true)
    options.onError(null)
    try {
      const saved = await draft.flush()
      if (!saved) return
      const pendingCheck = await loadRestaurantOrderPendingUnits(options.context, saved.order.id)
      draft.replaceOrder(pendingCheck.detail)
      if (pendingCheck.pendingUnits > 0 && !forceWithPending) {
        setPendingPayment({ method, receivedCents, pendingUnits: pendingCheck.pendingUnits })
        return
      }
      const result = await closeRestaurantOrder(saved.order.id, method, receivedCents, forceWithPending, options.appliedDiscount)
      if (result.requiresConfirmation) {
        setPendingPayment({ method, receivedCents, pendingUnits: result.pendingUnits })
        return
      }
      await refreshSales(result.saleId, 'Cobro completado sin imprimir')
      const nextOrder = result.nextOrderId ? await loadRestaurantOrder(options.context, result.nextOrderId) : null
      const nextMap = await realtime.loadCurrentMap(options.context, options.cashSession.id)
      realtime.setMap(nextMap)
      draft.replaceOrder(nextOrder)
      setPendingPayment(null)
      options.setMobileTicketOpen(false)
      options.setAppliedDiscount(null)
      options.onPaidFeedback(method)
      setPosView(nextOrder
        ? { type: 'table_order', orderId: nextOrder.order.id }
        : { type: 'table_map', areaId: nextMap.areas[0]?.id })
      window.setTimeout(() => options.onPaidFeedback(null), 500)
    } catch (error) {
      options.onError(getReadableError(error))
    } finally {
      options.setBusy(false)
    }
  }, [draft, options, realtime, refreshSales])

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
    product: Product,
    variant: ProductVariant,
    selection: ProductLineSelection,
    lineId?: string,
    sourceElement?: HTMLElement | null,
  ) => {
    if (!options.isOnline) {
      options.onError('La gestion de mesas requiere conexion.')
      return false
    }
    const current = draft.getCurrentOrder()
    if (!current || !options.context) return false
    const { modifiers, mixerProductId, mixer } = selection
    const additionsTotal = modifiers.reduce((total, modifier) => total + modifier.priceCents, 0) + (mixer?.priceCents ?? 0)
    if (lineId) {
      const timestamp = nowIso()
      draft.updateDraft((detail) => ({
        ...detail,
        lines: detail.lines.map((line) => line.id === lineId ? {
          ...line,
          productId: product.id,
          variantId: variant.id,
          productName: product.name,
          variantName: variant.name,
          unitPriceCents: variant.priceCents + additionsTotal,
          modifiers,
          mixerProductId,
          mixer,
          updatedAt: timestamp,
        } : line),
      }))
      options.onAddFeedback({ feedbackType: 'updated', productName: product.name, sourceElement })
      return true
    }
    const signature = getLineSignature({ productId: product.id, variantId: variant.id, modifiers, mixerProductId })
    const existing = current.lines.find((line) => line.productId !== null
      && line.note === null
      && getLineSignature({
        productId: line.productId,
        variantId: line.variantId ?? '',
        modifiers: line.modifiers,
        mixerProductId: line.mixerProductId,
      }) === signature)
    const timestamp = nowIso()
    draft.updateDraft((detail) => ({
      ...detail,
      lines: existing
        ? detail.lines.map((line) => line.id === existing.id ? { ...line, quantity: line.quantity + 1, updatedAt: timestamp } : line)
        : [...detail.lines, {
            id: createId(),
            tenantId: options.context!.tenantId,
            venueId: options.context!.venueId,
            orderId: detail.order.id,
            productId: product.id,
            variantId: variant.id,
            productName: product.name,
            variantName: variant.name,
            unitPriceCents: variant.priceCents + additionsTotal,
            quantity: 1,
            servedQuantity: 0,
            fullyServedAt: null,
            modifiers,
            mixerProductId,
            mixer,
            note: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          }],
    }))
    options.onAddFeedback({ feedbackType: 'added', productName: product.name, sourceElement })
    return true
  }, [draft, options])

  const changeLineQuantity = useCallback((lineId: string, direction: 1 | -1) => {
    if (!options.isOnline) return
    const line = draft.getCurrentOrder()?.lines.find((item) => item.id === lineId)
    if (!line) return
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

  const reset = useCallback(() => {
    draft.clearOrder()
    setPosView({ type: 'quick_sale' })
    setMoveOrderId(null)
    setPendingPayment(null)
    setPendingLineRemoval(null)
    setSplitOrderGroup(null)
    setEqualSplitOpen(false)
    setEqualSplit(null)
  }, [draft])

  return {
    addLine,
    cancelEmptyOrder,
    changeLineQuantity,
    clearTicket: () => draft.updateDraft((detail) => ({ ...detail, lines: [] })),
    completePayment,
    configureEqualSplit,
    confirmLineRemoval,
    equalSplit,
    equalSplitOpen,
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
    pendingLineRemoval,
    pendingPayment,
    posView,
    prepareMove,
    requestCloseCash,
    reset,
    returnToMap,
    saveState: draft.saveState,
    serveLineFully: (lineId: string) => void runServiceAction(() => markRestaurantOrderLineFullyServed(lineId)),
    serveLineUnit: (lineId: string) => void runServiceAction(() => markRestaurantOrderLineUnitsServed(lineId, 1)),
    serveOrderFully: () => void runServiceAction((order) => markRestaurantOrderFullyServed(order.order.id)),
    setEqualSplit,
    setEqualSplitOpen,
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
