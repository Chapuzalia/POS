import { Button as UiButton } from '../components/ui/Button'
import { AppModal } from '../components/ui/AppModal'
import type { RefObject, ReactNode } from 'react'
import { useEffect, useMemo, useState } from 'react'
import { AppHeader } from '../components/layout/AppHeader'
import {
  CashPaymentModal,
  CashClosingResultModal,
  CashClosingsHistoryModal,
  CashMovementModal,
  CloseCashModal,
  ConfigModal,
  DiscountModal,
  ProductDialog,
  SessionTicketsModal,
} from '../components/modals'
import { CatalogPanel, MobileTicketModal, PaymentPanel, TicketPanel } from '../components/pos'
import { AddProductFlyAnimation } from '../components/feedback/AddProductFlyAnimation'
import { EqualSplitOrderModal } from '../features/tables/components/EqualSplitOrderModal'
import { RemoveOrderLineModal } from '../features/tables/components/RemoveOrderLineModal'
import { RestaurantOrderPanel } from '../features/tables/components/RestaurantOrderPanel'
import { SplitOrderModal } from '../features/tables/components/SplitOrderModal'
import { TableMapView } from '../features/tables/components/TableMapView'
import { TableOrderBar } from '../features/tables/components/TableOrderBar'
import { useMobileTableMapLayout } from '../features/tables/useMobileTableMapLayout'
import { resolveSellableCatalog } from '../features/catalog/domain/resolver'
import type { CatalogData } from '../features/catalog/domain/types'
import { hasTenantFeature } from '../features/platform/tenantFeatureAccess'
import { calculateDiscountForLines, type DiscountScheduleContext } from '../lib/discounts'
import { getLineTotal, getTicketTotal } from '../lib/format'
import { addDiagnosticBreadcrumb } from '../lib/diagnostics'
import { validateConfiguredDiscountPin, validateManualDiscountPin } from '../services/discountRules'
import type { useCashSession } from '../features/cash-registers'
import type { useQuickSale } from '../features/quick-sale'
import type { useRestaurantController } from '../features/restaurant'
import { ReservationsPage, type useReservationsController } from '../features/reservations'
import type {
  CatalogStartTab,
  Discount,
  PaymentMethod,
  ProductSalesStat,
  ThemeDefinition,
  TicketLine,
  TenantContext,
} from '../types'

type CashController = ReturnType<typeof useCashSession>
type QuickSaleController = ReturnType<typeof useQuickSale>
type RestaurantController = ReturnType<typeof useRestaurantController>
type ReservationsController = ReturnType<typeof useReservationsController>

type AddFeedback = {
  announcement: string
  flyFeedback: Parameters<typeof AddProductFlyAnimation>[0]['feedback']
  isAddSuccess: boolean
  shouldAnimateCount: boolean
  successId: string | null
}

type Props = {
  addFeedback: AddFeedback
  cash: CashController
  catalog: CatalogData | null
  catalogStartTab: CatalogStartTab
  discounts: Discount[]
  discountSchedule: Omit<DiscountScheduleContext, 'now'>
  manualDiscountEnabled: boolean
  manualDiscountRequiresPin: boolean
  context: TenantContext
  error: string | null
  floatingTicketButtonRef: RefObject<HTMLButtonElement | null>
  isBusy: boolean
  isLoading: boolean
  isOnline: boolean
  mobileTicketOpen: boolean
  onLogout: () => Promise<void>
  onRefreshCatalog: () => Promise<void>
  onSelectProduct: Parameters<typeof CatalogPanel>[0]['onSelectProduct']
  onSetError: (message: string | null) => void
  onSetMobileTicketOpen: (open: boolean) => void
  onUpdateCatalogStartTab: (tab: CatalogStartTab) => void
  offline: {
    lastSyncError: string | null
    pendingCount: number
    retry: () => Promise<void>
  }
  productSalesStats: ProductSalesStat[]
  quickSale: QuickSaleController
  restaurant: RestaurantController
  reservations: ReservationsController
  restaurantPaidFeedback: PaymentMethod | null
  selectedThemeId: string
  setThemeId: (id: string) => void
  themes: ThemeDefinition[]
}

export function PosPage(props: Props) {
  const [configOpen, setConfigOpen] = useState(false)
  const mobileTableMapLayout = useMobileTableMapLayout()
  const restaurant = props.restaurant
  const quickSale = props.quickSale
  const cash = props.cash
  const discountsEnabled = hasTenantFeature(props.context, 'discounts')
  const restaurantEnabled = hasTenantFeature(props.context, 'restaurant')
  const reservationsEnabled = restaurantEnabled && hasTenantFeature(props.context, 'reservations')
  const appliedDiscount = discountsEnabled ? quickSale.discount : null
  useEffect(() => {
    addDiagnosticBreadcrumb('pos.mount', { venueId: props.context.venueId })
    return () => addDiagnosticBreadcrumb('pos.unmount', { venueId: props.context.venueId })
  }, [props.context.venueId])
  const resolvedCatalog = useMemo(() => props.catalog ? resolveSellableCatalog(props.catalog) : null, [props.catalog])
  const activeLines: TicketLine[] = restaurant.posView.type === 'table_order' && restaurant.order
    ? restaurant.order.lines.map((line) => ({
        id: line.id,
        productId: line.productId ?? '',
        productName: line.productName,
        variantId: line.variantId ?? '',
        variantName: line.variantName,
        basePriceCents: line.catalogSnapshot.basePriceCents ?? line.unitPriceCents,
        componentDeltaCents: line.components.reduce((total, component) => total + component.priceDeltaCents, 0),
        modifierDeltaCents: line.modifiers.reduce((total, modifier) => total + modifier.priceCents, 0),
        unitPriceCents: line.unitPriceCents,
        quantity: line.quantity,
        modifiers: line.modifiers,
        components: line.components,
        catalogSnapshot: line.catalogSnapshot,
        mixerProductId: line.mixerProductId,
        mixer: line.mixer,
      }))
    : quickSale.lines
  const canSell = Boolean(
    props.context.canTakePayments
      && cash.session
      && activeLines.length > 0
      && !props.isBusy
      && (restaurant.posView.type !== 'table_order' || props.isOnline),
  )
  const subtotalCents = getTicketTotal(activeLines)
  const discountCalculation = calculateDiscountForLines(
    activeLines.map((line) => ({ ...line, grossCents: getLineTotal(line) })),
    appliedDiscount,
  )
  const totalCents = discountCalculation.totalCents
  const itemCount = activeLines.reduce((total, line) => total + line.quantity, 0)
  const paidFeedback = restaurant.posView.type === 'table_order'
    ? props.restaurantPaidFeedback
    : quickSale.paidFeedback
  const tableMapVisible = restaurantEnabled && !props.reservations.isOpen && restaurant.tablesEnabled && restaurant.posView.type === 'table_map'

  const updateQuantity = (lineId: string, direction: 1 | -1) => {
    if (restaurant.posView.type === 'table_order') restaurant.changeLineQuantity(lineId, direction)
    else quickSale.changeQuantity(lineId, direction)
  }

  const activeTicketPanel: ReactNode = restaurant.posView.type === 'table_order' && restaurant.order
    ? <RestaurantOrderPanel
        isBusy={props.isBusy || !props.isOnline}
        lineDiscounts={Object.fromEntries(
          activeLines.map((line, index) => [line.id, discountCalculation.lineAllocations[index]]),
        )}
        onDecrement={(lineId) => updateQuantity(lineId, -1)}
        onIncrement={(lineId) => updateQuantity(lineId, 1)}
        onEdit={(line) => {
          if (line.servedQuantity > 0) {
            props.onSetError('No se puede editar una línea con productos ya servidos.')
            return
          }
          const item = resolvedCatalog?.items.find((candidate) => (
            candidate.product.id === line.productId
            && (line.variantId ? candidate.variant.id === line.variantId : true)
          )) ?? null
          if (!item) {
            props.onSetError('El producto de esta línea ya no está disponible.')
            return
          }
          quickSale.openProductDialog({
            allowVariantSelection: false,
            initialSelection: {
              modifiers: line.modifiers,
              components: line.components,
              catalogSnapshot: line.catalogSnapshot,
              mixerProductId: line.mixerProductId,
              mixer: line.mixer,
            },
            initialVariantId: line.variantId ?? undefined,
            lineId: line.id,
            item,
          })
        }}
        onRemove={(lineId) => {
          const line = restaurant.order?.lines.find((candidate) => candidate.id === lineId)
          if (line) restaurant.setPendingLineRemoval(line)
        }}
        onServeAll={restaurant.serveLineFully}
        onServeAllOrder={restaurant.serveOrderFully}
        onServeOne={restaurant.serveLineUnit}
        order={restaurant.order}
      />
    : <TicketPanel
        isBusy={props.isBusy}
        lines={activeLines}
        onClear={quickSale.clear}
        onDecrement={(lineId) => updateQuantity(lineId, -1)}
        lineDiscounts={discountCalculation.lineAllocations}
        onIncrement={(lineId) => updateQuantity(lineId, 1)}
        onRemove={quickSale.removeLine}
      />

  const handlePayment = (method: PaymentMethod | null) => {
    if (method === 'cash') {
      quickSale.openCashPayment()
      return
    }
    if (restaurant.posView.type === 'table_order') void restaurant.completePayment(method, null)
    else void quickSale.completePayment(method, null)
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <div aria-atomic="true" aria-live="polite" className="sr-only">{props.addFeedback.announcement}</div>
      <AppHeader
        cashSession={cash.session}
        canCloseCash={props.context.canCloseCashSession === true}
        canManageCash={Boolean(props.context.canManageCash || ['manager', 'owner'].includes(props.context.role))}
        canOpenCashDrawer={Boolean(props.context.canManageCash || ['manager', 'owner'].includes(props.context.role))}
        canOpenReservations={Boolean(reservationsEnabled && restaurant.tablesEnabled && (props.context.canTakeOrders || ['manager', 'owner'].includes(props.context.role)))}
        compactMobile={props.context.deviceMode === 'satellite'}
        isLoading={props.isLoading}
        isOnline={props.isOnline}
        onCloseCash={() => void (async () => {
          if (await restaurant.requestCloseCash()) cash.openCloseModal()
        })()}
        onOpenConfig={() => setConfigOpen(true)}
        onOpenReservations={props.reservations.open}
        onOpenCashClosingHistory={() => void cash.openClosingHistory()}
        onOpenCashMovements={() => cash.setMovementModalOpen(true)}
        onOpenTicketHistory={() => void cash.ticketActions.openHistory()}
        onRefreshCatalog={() => void props.onRefreshCatalog()}
        onLogout={() => void props.onLogout()}
        pendingCount={props.offline.pendingCount}
        themeMode={props.themes.find((theme) => theme.id === props.selectedThemeId)?.mode ?? 'light'}
      />
      {props.error ? <div className="mx-auto max-w-[1600px] px-4 pt-4">
        <div className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]">
          {props.error}
        </div>
      </div> : null}
      <AddProductFlyAnimation feedback={props.addFeedback.flyFeedback} />
      {reservationsEnabled && props.reservations.isOpen ? <ReservationsPage controller={props.reservations} isOnline={props.isOnline} onOpenOrder={(orderId) => void restaurant.openExistingOrder(orderId)} /> : null}

      {restaurantEnabled && !props.reservations.isOpen && restaurant.tablesEnabled && restaurant.posView.type !== 'table_map' ? <TableOrderBar
        isBusy={props.isBusy}
        isOnline={props.isOnline}
        onBack={() => void restaurant.returnToMap()}
        onCancelEmpty={() => void restaurant.cancelEmptyOrder()}
        onMove={() => void restaurant.prepareMove()}
        onSplitItems={() => void restaurant.openSplitOrder()}
        onSplitEqual={() => void restaurant.openEqualSplitOrder()}
        order={restaurant.posView.type === 'table_order' ? restaurant.order : null}
        quickSale={restaurant.posView.type === 'quick_sale'}
        saveState={restaurant.saveState}
        canSell={canSell}
      /> : null}

      {restaurantEnabled && !props.reservations.isOpen && restaurant.tablesEnabled && restaurant.posView.type === 'table_map' && cash.session ? <TableMapView
        canOpen={Boolean(props.context.canTakeOrders)}
        cashSessionId={cash.session.id}
        canQuickSale={props.context.canTakePayments === true}
        isBusy={props.isBusy}
        isOnline={props.isOnline}
        map={restaurant.map}
        mobileLayout={mobileTableMapLayout}
        moveOrderId={restaurant.moveOrderId}
        onAreaChange={(areaId) => restaurant.setPosView({ type: 'table_map', areaId })}
        onCancelMove={() => restaurant.setMoveOrderId(null)}
        onError={props.onSetError}
        onLayoutChange={async (tables, expectedRevision) => {
          try {
            return await restaurant.updateSessionLayout(cash.session!.id, expectedRevision, tables)
          } catch (error) {
            try { await restaurant.reloadMap() } catch { /* conserva el mapa confirmado */ }
            throw error
          }
        }}
        onMove={restaurant.moveOrder}
        onOpen={restaurant.openTableOrder}
        onOpenOrder={(orderId) => void restaurant.openExistingOrder(orderId)}
        onOpenReservation={(reservationId) => void props.reservations.openReservation(reservationId)}
        onQuickSale={() => {
          if (!props.context.canTakePayments) return
          restaurant.reset()
          quickSale.setDiscount(null)
        }}
        selectedAreaId={restaurant.posView.areaId}
      /> : null}

      <main className={`mx-auto min-h-0 w-full max-w-[1600px] flex-1 gap-4 overflow-hidden p-4 pb-[max(1rem,env(safe-area-inset-bottom))] max-lg:flex-col ${reservationsEnabled && props.reservations.isOpen || tableMapVisible ? 'hidden' : 'flex'}`}>
        <section className="flex min-h-0 w-[35%] min-w-[360px] flex-col gap-4 max-lg:hidden max-lg:w-full max-lg:min-w-0">
          {activeTicketPanel}
          <PaymentPanel
            allowDiscount={discountsEnabled}
            discount={appliedDiscount}
            disabled={!canSell}
            feedback={paidFeedback}
            heading={undefined}
            onOpenDiscount={quickSale.openDiscountModal}
            onPayment={handlePayment}
            onRemoveDiscount={quickSale.removeDiscount}
            subtotalCents={subtotalCents}
            totalCents={totalCents}
          />
        </section>
        <CatalogPanel
          catalog={props.catalog}
          catalogStartTab={props.catalogStartTab}
          disabled={props.isBusy || (restaurant.posView.type === 'table_order' && !props.isOnline)}
          onSelectProduct={props.onSelectProduct}
          productSalesStats={props.productSalesStats}
        />
      </main>

      {reservationsEnabled && props.reservations.isOpen || tableMapVisible ? null : <MobileTicketModal
        floatingButtonRef={props.floatingTicketButtonRef}
        isAddSuccess={props.addFeedback.isAddSuccess}
        isOpen={props.mobileTicketOpen}
        itemCount={itemCount}
        onClose={() => props.onSetMobileTicketOpen(false)}
        onOpen={() => props.onSetMobileTicketOpen(true)}
        shouldAnimateCount={props.addFeedback.shouldAnimateCount}
        successId={props.addFeedback.successId}
        title={restaurant.posView.type === 'table_order' ? 'Comanda' : 'Ticket'}
        totalCents={totalCents}
      >
        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden p-4">
          {activeTicketPanel}
          <PaymentPanel
            allowDiscount={discountsEnabled}
            discount={appliedDiscount}
            disabled={!canSell}
            feedback={paidFeedback}
            heading={undefined}
            onOpenDiscount={quickSale.openDiscountModal}
            onPayment={handlePayment}
            onRemoveDiscount={quickSale.removeDiscount}
            subtotalCents={subtotalCents}
            totalCents={totalCents}
          />
        </div>
      </MobileTicketModal>}

      {restaurantEnabled && restaurant.pendingPayment ? <AppModal containerClassName="!p-4" maxWidth={448} dismissDisabled={props.isBusy} label="Productos pendientes" onClose={() => restaurant.setPendingPayment(null)}>
        <section className="w-full max-w-[440px] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-6 text-[var(--foreground)] shadow-[var(--shadow)] [&_h2]:mb-2 [&_h2]:mt-0 [&_p]:mb-[18px] [&_p]:mt-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-[7px] [&_label]:font-extrabold [&_input]:min-h-12 [&_input]:rounded-[var(--radius)] [&_input]:border [&_input]:border-[var(--field-border)] [&_input]:bg-[var(--field)] [&_input]:px-3 [&_input]:text-lg [&_input]:text-[var(--field-foreground)] [&>div]:mt-[22px] [&>div]:flex [&>div]:justify-end [&>div]:gap-2.5">
          <h2 id="pending-service-title">Productos pendientes</h2>
          <p>Quedan {restaurant.pendingPayment.pendingUnits} {restaurant.pendingPayment.pendingUnits === 1 ? 'producto pendiente' : 'productos pendientes'} de servir.</p>
          <div>
            <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45" onClick={() => restaurant.setPendingPayment(null)} type="button">Volver a la comanda</UiButton>
            <UiButton className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45" onClick={() => {
              const payment = restaurant.pendingPayment
              restaurant.setPendingPayment(null)
              if (payment) void restaurant.completePayment(payment.method, payment.receivedCents, true)
            }} type="button">Cobrar igualmente</UiButton>
          </div>
        </section>
      </AppModal> : null}
      {restaurantEnabled && restaurant.pendingLineRemoval ? <RemoveOrderLineModal
        isBusy={props.isBusy}
        line={restaurant.pendingLineRemoval}
        onCancel={() => restaurant.setPendingLineRemoval(null)}
        onConfirm={() => void restaurant.confirmLineRemoval()}
      /> : null}
      {restaurantEnabled && restaurant.splitOrderGroup && restaurant.order ? <SplitOrderModal
        defaultDiscount={appliedDiscount}
        discountSchedule={props.discountSchedule}
        discounts={discountsEnabled ? props.discounts : []}
        isBusy={props.isBusy}
        manualDiscountEnabled={discountsEnabled && props.manualDiscountEnabled}
        manualDiscountRequiresPin={discountsEnabled && props.manualDiscountRequiresPin}
        onClose={() => restaurant.setSplitOrderGroup(null)}
        onPay={restaurant.paySelectedOrderItems}
        order={restaurant.order}
        venueId={props.context.venueId}
        validatePin={validateConfiguredDiscountPin}
        validateManualPin={validateManualDiscountPin}
      /> : null}
      {restaurantEnabled && restaurant.equalSplitOpen && restaurant.order ? <EqualSplitOrderModal
        defaultDiscount={appliedDiscount}
        discounts={discountsEnabled ? props.discounts : []}
        discountSchedule={props.discountSchedule}
        isBusy={props.isBusy}
        manualDiscountEnabled={discountsEnabled && props.manualDiscountEnabled}
        manualDiscountRequiresPin={discountsEnabled && props.manualDiscountRequiresPin}
        onClose={() => { restaurant.setEqualSplitOpen(false); restaurant.setEqualSplit(null) }}
        onCompleted={() => { restaurant.setEqualSplitOpen(false); restaurant.setEqualSplit(null) }}
        onConfigure={restaurant.configureEqualSplit}
        onPay={restaurant.payEqualSplitPart}
        order={restaurant.order}
        split={restaurant.equalSplit}
        venueId={props.context.venueId}
        validatePin={validateConfiguredDiscountPin}
        validateManualPin={validateManualDiscountPin}
      /> : null}
      {quickSale.cashPaymentOpen ? <CashPaymentModal
        isBusy={props.isBusy}
        onCancel={quickSale.closeCashPayment}
        onConfirm={(receivedCents) => {
          quickSale.closeCashPayment()
          if (restaurant.posView.type === 'table_order') void restaurant.completePayment('cash', receivedCents)
          else void quickSale.completePayment('cash', receivedCents)
        }}
        totalCents={totalCents}
      /> : null}
      {quickSale.productDialog && props.catalog ? <ProductDialog
        allowVariantSelection={quickSale.productDialog.allowVariantSelection}
        catalog={props.catalog}
        initialSelection={quickSale.productDialog.initialSelection}
        initialVariantId={quickSale.productDialog.initialVariantId}
        isBusy={props.isBusy}
        item={quickSale.productDialog.item}
        key={`${quickSale.productDialog.item.placement.id}-${quickSale.productDialog.initialVariantId ?? quickSale.productDialog.item.variant.id}-${quickSale.productDialog.lineId ?? 'new'}`}
        onAdd={(sellable, selection, item, sourceElement) => restaurant.posView.type === 'table_order'
          ? restaurant.addLine(sellable, selection, item, quickSale.productDialog?.lineId, sourceElement)
          : quickSale.addLine(sellable, selection, item, sourceElement)}
        onCancel={quickSale.closeProductDialog}
      /> : null}
      {discountsEnabled && quickSale.discountModalOpen ? <DiscountModal
        discounts={props.discounts}
        isBusy={props.isBusy}
        manualDiscountEnabled={props.manualDiscountEnabled}
        manualDiscountRequiresPin={props.manualDiscountRequiresPin}
        onCancel={quickSale.closeDiscountModal}
        onSelect={(discount) => { quickSale.applyDiscount(discount); quickSale.closeDiscountModal() }}
        subtotalCents={subtotalCents}
        schedule={props.discountSchedule}
        validatePin={validateConfiguredDiscountPin}
        validateManualPin={validateManualDiscountPin}
        venueId={props.context.venueId}
      /> : null}
      {cash.movementModalOpen && cash.session ? <CashMovementModal
        isOnline={props.isOnline}
        isSaving={cash.movementSaving}
        onCancel={() => cash.setMovementModalOpen(false)}
        onConfirm={cash.registerMovement}
      /> : null}
      {cash.closeModalOpen && cash.session ? <CloseCashModal
        cashSession={cash.session}
        isBusy={props.isBusy}
        onCancel={() => cash.setCloseModalOpen(false)}
        onConfirm={async (payload) => {
          if (await cash.close(payload)) {
            quickSale.clear()
            restaurant.reset()
          }
        }}
        summary={cash.summary}
        userId={props.context.userId}
      /> : null}
      {cash.historyOpen ? <SessionTicketsModal
        canReprint={Boolean(props.context.canManageCash || props.context.canCloseCashSession || ['manager', 'owner'].includes(props.context.role))}
        isBusy={props.isBusy}
        onChangePayment={cash.ticketActions.changePayment}
        onClose={() => cash.setHistoryOpen(false)}
        onReprint={(ticket) => void cash.ticketActions.reprint(ticket)}
        onVoidTicket={cash.ticketActions.voidTicket}
        tickets={cash.tickets}
      /> : null}
      {cash.completedClosing ? <CashClosingResultModal
        closing={cash.completedClosing}
        isPrinting={cash.printingClosingId === cash.completedClosing.id}
        onClose={() => cash.setCompletedClosing(null)}
        onPrint={() => void cash.printClosing(cash.completedClosing!)}
      /> : null}
      {cash.closingHistoryOpen ? <CashClosingsHistoryModal
        canReprint={Boolean(props.context.canManageCash || ['manager', 'owner'].includes(props.context.role))}
        closings={cash.cashClosings}
        onClose={() => cash.setClosingHistoryOpen(false)}
        onReprint={(closing) => void cash.printClosing(closing, { isReprint: true, copyNumber: closing.printCopies + 1 })}
        printingClosingId={cash.printingClosingId}
      /> : null}
      {configOpen ? <ConfigModal
        context={props.context}
        catalogStartTab={props.catalogStartTab}
        lastSyncError={props.offline.lastSyncError}
        onClose={() => setConfigOpen(false)}
        onCatalogStartTabChange={props.onUpdateCatalogStartTab}
        onRetrySync={() => void props.offline.retry()}
        onThemeChange={props.setThemeId}
        pendingCount={props.offline.pendingCount}
        themeId={props.selectedThemeId}
        themes={props.themes}
      /> : null}
    </div>
  )
}
