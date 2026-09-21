import { Check, CheckCheck, Minus, Pencil, Plus, Trash2 } from "lucide-react";
import {
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  centsToInput,
  formatMoney,
  formatQuantity,
  isValidQuantity,
  parseMoneyToCents,
  parseQuantity,
  quantityAmountCents,
} from "../../../lib/format";
import { getLineAdditionNames } from "../../../lib/mixers";
import type { LineDiscountAllocation } from "../../../lib/discounts";
import { Button } from "../../../components/ui";
import { NativeSelect } from "../../../components/ui/NativeSelect";
import {
  canDecreaseLineQuantity,
  getOrderPendingUnits,
  getPendingQuantity,
} from "../service-status";
import type { CatalogData } from "../../catalog/domain/types";
import type { RestaurantOrderDetail, RestaurantOrderLine } from "../types";
import { MenuComponentDetails } from "../../../components/pos/MenuComponentDetails";
import { InvoiceTicketNotice } from "../../../components/pos/InvoiceTicketNotice";
import { NumericKeypadModal } from "../../../components/ui/NumericKeypadModal";
import { ProductionControls } from "../../production/components/ProductionControls";
import {
  buildOptimisticProductionEntries,
  mergeProductionEntries,
} from "../../production/routing";
import type {
  OrderProductionState,
  ProductionRouting,
  ProductionSelection,
} from "../../production/types";

const swipeDeleteThreshold = 72;
const swipeMaxOffset = 96;

function isOrderLineActionTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('[data-order-line-action="true"]'))
  );
}

type Props = {
  isBusy: boolean;
  lineDiscounts: Record<string, LineDiscountAllocation>;
  order: RestaurantOrderDetail;
  invoiceCustomerName?: string | null;
  onChangeInvoiceCustomer?: () => void;
  onDecrement: (lineId: string) => void;
  onEdit: (line: RestaurantOrderLine) => void;
  onIncrement: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onRemoveInvoiceCustomer?: () => void;
  onServeAll: (lineId: string) => void;
  onServeAllOrder: () => void;
  onServeOne: (lineId: string) => void;
  onSetQuantity: (lineId: string, quantity: number) => void;
  onSetUnitPrice: (lineId: string, unitPriceCents: number) => void;
  productionState?: OrderProductionState | null;
  productionRouting?: ProductionRouting;
  catalog?: CatalogData | null;
  onSendToProduction?: (selection?: ProductionSelection[]) => void;
  onChangeProductionPass?: (input: {
    lineId: string;
    componentId?: string | null;
    passId: string;
  }) => void;
};

type OrderValueEditor = {
  initialValue: string;
  kind: "quantity" | "unitPrice";
  lineId: string;
  productName: string;
};

function OrderLineRow({
  discount,
  displayQuantity,
  displayServedQuantity,
  isBusy,
  line,
  onChangeProductionPass,
  onDecrement,
  onEdit,
  onIncrement,
  onOpenQuantityEditor,
  onOpenUnitPriceEditor,
  onRemove,
  onServeAll,
  onServeOne,
  productionRouting,
  productionState,
  readOnly = false,
}: Omit<
  Props,
  | "order"
  | "onServeAllOrder"
  | "lineDiscounts"
  | "onSendToProduction"
  | "onSetQuantity"
  | "onSetUnitPrice"
> & {
  discount?: LineDiscountAllocation;
  displayQuantity?: number;
  displayServedQuantity?: number;
  line: RestaurantOrderLine;
  onOpenQuantityEditor: () => void;
  onOpenUnitPriceEditor: () => void;
  readOnly?: boolean;
}) {
  const displayLine =
    displayQuantity === undefined
      ? line
      : {
          ...line,
          quantity: displayQuantity,
          servedQuantity: displayServedQuantity ?? 0,
        };
  const pending = getPendingQuantity(displayLine);
  const production = productionState?.lines.find(
    (state) => state.lineId === line.id,
  );
  const additionNames = getLineAdditionNames(line.modifiers, line.mixer);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [offsetX, setOffsetX] = useState(0);
  const longPressTimer = useRef<number | null>(null);
  const articleRef = useRef<HTMLElement | null>(null);
  const [passMenuOpen, setPassMenuOpen] = useState(false);
  const [passMenuPosition, setPassMenuPosition] = useState({
    left: 0,
    top: 0,
    width: 0,
  });
  const isDragging = dragStart !== null;
  const canChangeProductionPass =
    !readOnly &&
    Boolean(
      onChangeProductionPass &&
      productionRouting &&
      productionRouting.passes.length > 1 &&
      productionState?.entries.some(
        (entry) =>
          entry.lineId === line.id &&
          entry.unsentQuantity > 0 &&
          entry.sentQuantity === 0,
      ),
    );

  function openProductionPassEditor() {
    if (!canChangeProductionPass) return;
    const bounds = articleRef.current?.getBoundingClientRect();
    if (bounds)
      setPassMenuPosition({
        left: Math.max(
          8,
          Math.min(
            bounds.left + 8,
            window.innerWidth - Math.min(bounds.width - 16, 520) - 8,
          ),
        ),
        top: Math.min(bounds.top + 48, window.innerHeight - 80),
        width: Math.min(bounds.width - 16, 520),
      });
    setPassMenuOpen((current) => !current);
  }

  function clearLongPress() {
    if (longPressTimer.current !== null)
      window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
  }

  function handleContextMenu(event: MouseEvent<HTMLElement>) {
    if (!canChangeProductionPass) return;
    event.preventDefault();
    openProductionPassEditor();
  }

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (
      readOnly ||
      isBusy ||
      event.button !== 0 ||
      isOrderLineActionTarget(event.target)
    )
      return;
    clearLongPress();
    longPressTimer.current = window.setTimeout(openProductionPassEditor, 600);
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ x: event.clientX, y: event.clientY });
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (!dragStart) return;
    const deltaX = event.clientX - dragStart.x;
    const deltaY = event.clientY - dragStart.y;
    if (Math.abs(deltaX) > 8 || Math.abs(deltaY) > 8) clearLongPress();
    if (Math.abs(deltaY) > 16 && Math.abs(deltaY) > Math.abs(deltaX)) return;
    setOffsetX(Math.min(0, Math.max(deltaX, -swipeMaxOffset)));
  }

  function endSwipe(event: PointerEvent<HTMLElement>) {
    if (!dragStart) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
    }
    const shouldRemove = offsetX <= -swipeDeleteThreshold && !isBusy;
    clearLongPress();
    setDragStart(null);
    setOffsetX(0);
    if (shouldRemove && !readOnly) onRemove(line.id);
  }

  return (
    <div className="touch-pan-y relative rounded-[var(--radius)] bg-[var(--background)]">
      <div className="absolute inset-y-px right-px flex w-24 items-center justify-center rounded-r-[calc(var(--radius)-1px)] bg-[var(--danger)] text-white">
        <Trash2 aria-hidden="true" className="h-5 w-5" />
      </div>
      <article
        className={`relative z-[1] overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-2.5 ${isDragging ? "transition-none" : "transition-transform duration-150 ease-out"}`}
        onContextMenu={handleContextMenu}
        onPointerCancel={endSwipe}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endSwipe}
        ref={articleRef}
        style={{ transform: `translateX(${offsetX}px)` }}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <p className="truncate font-bold">
                {formatQuantity(displayLine.quantity)}x - {line.productName}
              </p>
              <span
                className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-black uppercase tracking-wide ${pending === 0 ? "bg-[var(--success)]/15 text-[var(--success)]" : "bg-[var(--warning)]/15 text-[var(--warning)]"}`}
              >
                {pending === 0
                  ? "Servido"
                  : pending === displayLine.quantity
                    ? "Pendiente"
                    : "Parcial"}
              </span>
            </div>
            {additionNames.length ? (
              <p className="text-sm text-[var(--muted)]">
                + {additionNames.join(", ")}
              </p>
            ) : null}
            <MenuComponentDetails compact components={line.components} />
            {displayQuantity === undefined &&
            pending > 0 &&
            pending < line.quantity ? (
              <p className="mt-1 text-xs font-semibold text-[var(--muted)]">
                {formatQuantity(line.servedQuantity)} servidas ·{" "}
                {formatQuantity(pending)} pendientes
              </p>
            ) : null}
            {productionState?.effective ? (
              <p className="mt-1  text-xs font-semibold text-[var(--muted)]">
                {formatQuantity(production?.unsentQuantity ?? line.quantity)}{" "}
                sin enviar · {formatQuantity(production?.readyQuantity ?? 0)}{" "}
                listas
              </p>
            ) : null}
          </div>
          <div
            className="flex shrink-0 flex-col items-end gap-2"
            data-order-line-action="true"
          >
            <div className="flex items-center gap-1">
              {!readOnly &&
              line.components.some(
                (component) => component.type === "menu_component",
              ) ? (
                <Button
                  aria-label="Editar selección del menú"
                  disabled={isBusy}
                  onClick={() => onEdit(line)}
                  size="sm"
                  title="Editar selección"
                  type="button"
                  variant="tertiary"
                >
                  <Pencil className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                aria-label="Reducir cantidad"
                disabled={readOnly || isBusy || !canDecreaseLineQuantity(line)}
                onClick={() => onDecrement(line.id)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                <Minus className="h-4 w-4" />
              </Button>
              <span className="w-7 text-center">
                <button
                  aria-haspopup="dialog"
                  aria-label={`Editar cantidad de ${line.productName}`}
                  className="inline cursor-pointer touch-manipulation border-0 bg-transparent p-0 font-mono font-bold tabular-nums focus:outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default"
                  disabled={readOnly || isBusy}
                  onClick={onOpenQuantityEditor}
                  type="button"
                >
                  {formatQuantity(line.quantity)}
                </button>
              </span>
              <Button
                aria-label="Aumentar cantidad"
                disabled={readOnly || isBusy}
                onClick={() => onIncrement(line.id)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
          </div>
        </div>
        <div
          className="mt-1 w-max  flex items-baseline gap-3 font-mono text-sm tabular-nums"
          data-order-line-action="true"
        >
          <button
            aria-haspopup="dialog"
            aria-label={`Editar precio unitario de ${line.productName}`}
            className="cursor-pointer touch-manipulation border-0 bg-transparent p-0 text-[var(--muted)] focus:outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default"
            disabled={readOnly || isBusy}
            onClick={onOpenUnitPriceEditor}
            type="button"
          >
            {formatMoney(line.unitPriceCents)}/u
          </button>
          {discount &&
          discount.discountAmountCents > 0 &&
          displayQuantity === undefined ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span className="text-[var(--muted)] line-through">
                {formatMoney(discount.grossCents)}
              </span>
              <strong className="text-[var(--success)]">
                {formatMoney(discount.netCents)}
              </strong>
              <span className="text-xs font-semibold text-[var(--success)]">
                -{formatMoney(discount.discountAmountCents)}
              </span>
            </div>
          ) : (
            <strong>
              {formatMoney(
                quantityAmountCents(line.unitPriceCents, displayLine.quantity),
              )}
            </strong>
          )}
        </div>
        {!readOnly && pending > 0 ? (
          <div
            className="mt-2 flex items-center justify-end gap-2 border-t border-[var(--separator)] pt-2"
            data-order-line-action="true"
          >
            {pending > 1 ? (
              <Button
                disabled={isBusy}
                onClick={() => onServeOne(line.id)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                <Check className="h-4 w-4" /> Servir 1
              </Button>
            ) : null}
            <Button
              disabled={isBusy}
              onClick={() => onServeAll(line.id)}
              size="sm"
              type="button"
              variant="secondary"
            >
              <CheckCheck className="h-4 w-4" />{" "}
              {pending === 1
                ? "Marcar servido"
                : `Servir ${formatQuantity(pending)}`}
            </Button>
          </div>
        ) : null}
      </article>
      {passMenuOpen && productionRouting
        ? createPortal(
            <>
              <button
                aria-label="Cerrar selector de pase"
                className="fixed inset-0 z-40 cursor-default"
                onClick={() => setPassMenuOpen(false)}
                type="button"
              />
              <div
                className="fixed z-50 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-3 shadow-[var(--shadow)]"
                data-order-line-action="true"
                style={{
                  left: passMenuPosition.left,
                  top: passMenuPosition.top,
                  width: passMenuPosition.width,
                }}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <strong className="text-sm">Cambiar pase</strong>
                  <button
                    aria-label="Cerrar selector de pase"
                    className="text-xs font-bold text-[var(--muted)]"
                    onClick={() => setPassMenuOpen(false)}
                    type="button"
                  >
                    Cerrar
                  </button>
                </div>
                <div className="space-y-2">
                  {productionState?.entries
                    .filter(
                      (entry) =>
                        entry.lineId === line.id &&
                        entry.unsentQuantity > 0 &&
                        entry.sentQuantity === 0,
                    )
                    .map((entry) => (
                      <label
                        className="block space-y-1"
                        key={`${entry.lineId}:${entry.componentId ?? ""}`}
                      >
                        <span className="block truncate text-xs font-bold text-[var(--muted)]">
                          {entry.productName}
                          {entry.parentProductName
                            ? ` · ${entry.parentProductName}`
                            : ""}
                        </span>
                        <NativeSelect
                          aria-label={`Pase de ${entry.productName}`}
                          disabled={isBusy}
                          onChange={(event) => {
                            if (event.target.value !== entry.passId)
                              onChangeProductionPass?.({
                                lineId: entry.lineId,
                                componentId: entry.componentId,
                                passId: event.target.value,
                              });
                          }}
                          triggerClassName="min-h-10"
                          value={entry.passId}
                        >
                          {productionRouting.passes.map((pass) => (
                            <option key={pass.id} value={pass.id}>
                              {pass.name}
                            </option>
                          ))}
                        </NativeSelect>
                      </label>
                    ))}
                </div>
              </div>
            </>,
            document.body,
          )
        : null}
    </div>
  );
}

export function RestaurantOrderPanel(props: Props) {
  const {
    invoiceCustomerName,
    isBusy,
    lineDiscounts,
    onChangeInvoiceCustomer,
    onRemoveInvoiceCustomer,
    order,
    onServeAllOrder,
    onSendToProduction,
    onChangeProductionPass,
    onSetQuantity,
    onSetUnitPrice,
    productionState,
    productionRouting,
    catalog,
    ...lineProps
  } = props;
  const [valueEditor, setValueEditor] = useState<OrderValueEditor | null>(null);
  const [valueEditorError, setValueEditorError] = useState<string | null>(null);
  const pendingLines = order.lines.filter(
    (line) => getPendingQuantity(line) > 0,
  );
  const servedLines = order.lines.filter(
    (line) => getPendingQuantity(line) === 0,
  );
  const productionEntries = useMemo(() => {
    const persistedLineIds = new Set(
      productionState?.lines.map((line) => line.lineId) ?? [],
    );
    const localLines = order.lines.filter(
      (line) => !persistedLineIds.has(line.id),
    );
    return mergeProductionEntries(
      productionState?.entries ?? [],
      buildOptimisticProductionEntries(
        localLines,
        catalog ?? null,
        productionRouting,
      ),
    );
  }, [
    catalog,
    order.lines,
    productionRouting,
    productionState?.entries,
    productionState?.lines,
  ]);
  const productionPasses = useMemo(() => {
    const grouped = new Map<
      string,
      NonNullable<OrderProductionState["entries"]>
    >();
    for (const entry of productionEntries) {
      const current = grouped.get(entry.passId) ?? [];
      current.push(entry);
      grouped.set(entry.passId, current);
    }
    return [...grouped.entries()]
      .map(([id, entries]) => ({
        id,
        name: entries[0]?.passName ?? "Directo",
        sortOrder: entries[0]?.passSortOrder ?? 0,
        entries,
      }))
      .sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      );
  }, [productionEntries]);
  const productionEntriesByLine = useMemo(() => {
    const grouped = new Map<
      string,
      NonNullable<OrderProductionState["entries"]>
    >();
    for (const entry of productionEntries) {
      const current = grouped.get(entry.lineId) ?? [];
      current.push(entry);
      grouped.set(entry.lineId, current);
    }
    return grouped;
  }, [productionEntries]);
  const pendingUnits = getOrderPendingUnits(order.lines);

  function closeValueEditor() {
    setValueEditor(null);
    setValueEditorError(null);
  }

  function confirmValueEditor(value: string) {
    if (!valueEditor) return;
    if (valueEditor.kind === "quantity") {
      const quantity = parseQuantity(value);
      const line = order.lines.find(
        (candidate) => candidate.id === valueEditor.lineId,
      );
      if (!isValidQuantity(quantity)) {
        setValueEditorError(
          "La cantidad debe ser positiva y tener como máximo tres decimales.",
        );
        return;
      }
      if (line && quantity < line.servedQuantity) {
        setValueEditorError(
          `La cantidad no puede ser inferior a las ${line.servedQuantity} unidades servidas.`,
        );
        return;
      }
      onSetQuantity(valueEditor.lineId, quantity);
    } else {
      onSetUnitPrice(valueEditor.lineId, parseMoneyToCents(value));
    }
    closeValueEditor();
  }

  const openQuantityEditor = (line: RestaurantOrderLine) => {
    setValueEditorError(null);
    setValueEditor({
      initialValue: formatQuantity(line.quantity),
      kind: "quantity",
      lineId: line.id,
      productName: line.productName,
    });
  };

  const openUnitPriceEditor = (line: RestaurantOrderLine) => {
    setValueEditorError(null);
    setValueEditor({
      initialValue: centsToInput(line.unitPriceCents),
      kind: "unitPrice",
      lineId: line.id,
      productName: line.productName,
    });
  };

  const renderLine = (
    line: RestaurantOrderLine,
    displayQuantity?: number,
    displayServedQuantity?: number,
    readOnly = false,
  ) => (
    <OrderLineRow
      {...lineProps}
      discount={lineDiscounts[line.id]}
      displayQuantity={displayQuantity}
      displayServedQuantity={displayServedQuantity}
      isBusy={isBusy}
      key={`${line.id}:${displayQuantity ?? "full"}`}
      line={line}
      onChangeProductionPass={onChangeProductionPass}
      onOpenQuantityEditor={() => openQuantityEditor(line)}
      onOpenUnitPriceEditor={() => openUnitPriceEditor(line)}
      productionRouting={productionRouting}
      productionState={productionState}
      readOnly={readOnly}
    />
  );

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
        {invoiceCustomerName &&
        onChangeInvoiceCustomer &&
        onRemoveInvoiceCustomer ? (
          <InvoiceTicketNotice
            customerName={invoiceCustomerName}
            disabled={isBusy}
            onChange={onChangeInvoiceCustomer}
            onRemove={onRemoveInvoiceCustomer}
          />
        ) : null}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-3">
          {order.lines.length === 0 ? (
            <div className="flex min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
              Pulsa un producto para añadirlo a la comanda.
            </div>
          ) : null}
          {(!productionState?.effective || productionPasses.length === 0) &&
          pendingLines.length ? (
            <section>
              <h2 className="mb-1.5 text-xs font-black uppercase tracking-wide text-[var(--warning)]">
                Pendientes · {formatQuantity(pendingUnits)}
              </h2>
              <div className="space-y-1.5">
                {pendingLines.map((line) =>
                  renderLine(line, getPendingQuantity(line)),
                )}
              </div>
            </section>
          ) : null}
          {productionState?.effective
            ? productionPasses.map((pass) => {
                const unsentEntries = pass.entries
                  .map((entry) => {
                    const line = order.lines.find(
                      (candidate) => candidate.id === entry.lineId,
                    );
                    return {
                      ...entry,
                      unsentQuantity: Math.max(
                        0,
                        entry.unsentQuantity - (line?.servedQuantity ?? 0),
                      ),
                    };
                  })
                  .filter((entry) => entry.unsentQuantity > 0);
                const unsent = unsentEntries.reduce(
                  (sum, entry) => sum + entry.unsentQuantity,
                  0,
                );
                const selection = unsentEntries.map((entry) => ({
                  lineId: entry.lineId,
                  componentId: entry.componentId,
                  quantity: entry.unsentQuantity,
                  passId: pass.id,
                  passName: pass.name,
                }));
                const lines = pendingLines.filter((line) =>
                  (productionEntriesByLine.get(line.id) ?? []).some(
                    (entry) => entry.passId === pass.id,
                  ),
                );
                if (lines.length === 0) return null;
                return (
                  <section key={pass.id}>
                    <div className="mb-1.5 flex items-center justify-between gap-2">
                      <h2 className="text-xs font-black uppercase tracking-wide text-[var(--warning)]">
                        {pass.name}
                        {unsent > 0
                          ? ` · ${formatQuantity(unsent)} nuevos`
                          : ""}
                      </h2>
                      {unsent > 0 && onSendToProduction ? (
                        <Button
                          disabled={isBusy}
                          onClick={() => onSendToProduction(selection)}
                          size="sm"
                          type="button"
                          variant="primary"
                        >
                          Enviar {pass.name} · {formatQuantity(unsent)}
                        </Button>
                      ) : null}
                    </div>
                    <div className="space-y-1.5">
                      {lines.map((line) =>
                        renderLine(line, getPendingQuantity(line)),
                      )}
                    </div>
                  </section>
                );
              })
            : null}
          {servedLines.length ||
          order.lines.some(
            (line) =>
              line.servedQuantity > 0 && line.servedQuantity < line.quantity,
          ) ? (
            <section>
              <h2 className="mb-1.5 text-xs font-black uppercase tracking-wide text-[var(--muted)]">
                Completados ·{" "}
                {formatQuantity(
                  order.lines.reduce(
                    (sum, line) => sum + line.servedQuantity,
                    0,
                  ),
                )}
              </h2>
              <div className="space-y-1.5">
                {order.lines
                  .filter((line) => line.servedQuantity > 0)
                  .map((line) =>
                    renderLine(
                      line,
                      line.servedQuantity,
                      line.servedQuantity,
                      line.servedQuantity < line.quantity,
                    ),
                  )}
              </div>
            </section>
          ) : null}
        </div>
        <div className="space-y-2 border-t border-[var(--separator)] p-3">
          {productionState?.warnings.map((warning, index) => (
            <p
              className="rounded-lg border border-[var(--danger)] p-2 text-sm font-bold text-[var(--danger)]"
              key={`${warning.destinationId}:${warning.status}:${index}`}
            >
              Impresión de producción{" "}
              {warning.status === "unknown" ? "sin confirmar" : "fallida"}:{" "}
              {warning.message}
            </p>
          ))}
          {productionState && onSendToProduction ? (
            <ProductionControls
              disabled={isBusy}
              onSend={onSendToProduction}
              order={order}
              state={productionState}
            />
          ) : null}
          {pendingUnits > 0 ? (
            <Button
              disabled={isBusy}
              fullWidth
              onClick={onServeAllOrder}
              size="md"
              type="button"
              variant="primary"
            >
              <CheckCheck className="h-4 w-4" /> Servir toda la comanda ·{" "}
              {formatQuantity(pendingUnits)}
            </Button>
          ) : order.lines.length ? (
            <p className="text-center text-sm font-bold text-[var(--success)]">
              Comanda completada
            </p>
          ) : null}
        </div>
      </section>
      {valueEditor ? (
        <NumericKeypadModal
          allowDecimal
          disabled={isBusy}
          error={valueEditorError}
          initialValue={valueEditor.initialValue}
          key={`${valueEditor.kind}:${valueEditor.lineId}`}
          maxDigits={valueEditor.kind === "quantity" ? 4 : 8}
          maxFractionDigits={valueEditor.kind === "quantity" ? 3 : 2}
          onCancel={closeValueEditor}
          onConfirm={confirmValueEditor}
          subtitle={valueEditor.productName}
          title={
            valueEditor.kind === "quantity"
              ? "Editar cantidad"
              : "Editar precio unitario"
          }
          unit={valueEditor.kind === "quantity" ? "unidades" : "€ / unidad"}
        />
      ) : null}
    </>
  );
}
