import { Minus, Pencil, Plus, Trash2 } from "lucide-react";
import { useRef, useState, type MouseEvent, type PointerEvent } from "react";
import {
  centsToInput,
  formatMoney,
  getLineTotal,
  parseMoneyToCents,
} from "../../lib/format";
import type { LineDiscountAllocation } from "../../lib/discounts";
import { getLineAdditionNames } from "../../lib/mixers";
import type { TicketLine } from "../../types";
import { cx } from "../../utils/cx";
import { Button } from "../ui";
import { NumericKeypadModal } from "../ui/NumericKeypadModal";
import { MenuComponentDetails } from "./MenuComponentDetails";
import { InvoiceTicketNotice } from './InvoiceTicketNotice'

type TicketPanelProps = {
  isBusy: boolean;
  lineDiscounts: LineDiscountAllocation[];
  lines: TicketLine[];
  invoiceCustomerName?: string | null;
  onChangeInvoiceCustomer?: () => void;
  onClear: () => void;
  onDecrement: (lineId: string) => void;
  onEdit: (line: TicketLine) => void;
  onIncrement: (lineId: string) => void;
  onRemove: (lineId: string) => void;
  onRemoveInvoiceCustomer?: () => void;
  onSetQuantity: (lineId: string, quantity: number) => void;
  onSetUnitPrice: (lineId: string, unitPriceCents: number) => void;
};

type TicketValueEditor = {
  initialValue: string;
  kind: "quantity" | "unitPrice";
  lineId: string;
  productName: string;
};

const swipeDeleteThreshold = 72;
const swipeMaxOffset = 96;
const duplicateActionWindowMs = 220;

function isTicketLineActionTarget(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('[data-ticket-line-action="true"]'))
  );
}

export function TicketPanel({
  lineDiscounts,
  isBusy,
  lines,
  invoiceCustomerName,
  onChangeInvoiceCustomer,
  onDecrement,
  onEdit,
  onIncrement,
  onRemove,
  onRemoveInvoiceCustomer,
  onSetQuantity,
  onSetUnitPrice,
}: TicketPanelProps) {
  const [valueEditor, setValueEditor] = useState<TicketValueEditor | null>(null);
  const [valueEditorError, setValueEditorError] = useState<string | null>(null);

  function closeValueEditor() {
    setValueEditor(null);
    setValueEditorError(null);
  }

  function confirmValueEditor(value: string) {
    if (!valueEditor) return;

    if (valueEditor.kind === "quantity") {
      const quantity = Number.parseInt(value, 10);
      if (!Number.isSafeInteger(quantity) || quantity < 1) {
        setValueEditorError("La cantidad debe ser al menos 1.");
        return;
      }
      onSetQuantity(valueEditor.lineId, quantity);
    } else {
      onSetUnitPrice(valueEditor.lineId, parseMoneyToCents(value));
    }

    closeValueEditor();
  }

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)]">
        {invoiceCustomerName && onChangeInvoiceCustomer && onRemoveInvoiceCustomer ? <InvoiceTicketNotice customerName={invoiceCustomerName} disabled={isBusy} onChange={onChangeInvoiceCustomer} onRemove={onRemoveInvoiceCustomer} /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-3">
          {lines.length === 0 ? (
            <div className="flex h-full min-h-52 items-center justify-center rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">
              Pulsa un producto para crear un ticket.
            </div>
          ) : (
            <div className="space-y-2">
              {lines.map((line, index) => (
                <TicketLineRow
                  isBusy={isBusy}
                  key={line.id}
                  line={line}
                  onDecrement={onDecrement}
                  onEdit={onEdit}
                  onIncrement={onIncrement}
                  onOpenQuantityEditor={() => {
                    setValueEditorError(null);
                    setValueEditor({
                      initialValue: String(line.quantity),
                      kind: "quantity",
                      lineId: line.id,
                      productName: line.productName,
                    });
                  }}
                  onOpenUnitPriceEditor={() => {
                    setValueEditorError(null);
                    setValueEditor({
                      initialValue: centsToInput(line.unitPriceCents),
                      kind: "unitPrice",
                      lineId: line.id,
                      productName: line.productName,
                    });
                  }}
                  discount={lineDiscounts[index]}
                  onRemove={onRemove}
                />
              ))}
            </div>
          )}
        </div>
      </section>
      {valueEditor ? (
        <NumericKeypadModal
          allowDecimal={valueEditor.kind === "unitPrice"}
          disabled={isBusy}
          error={valueEditorError}
          initialValue={valueEditor.initialValue}
          key={`${valueEditor.kind}:${valueEditor.lineId}`}
          maxDigits={valueEditor.kind === "quantity" ? 4 : 8}
          maxFractionDigits={valueEditor.kind === "unitPrice" ? 2 : undefined}
          onCancel={closeValueEditor}
          onConfirm={confirmValueEditor}
          subtitle={valueEditor.productName}
          title={valueEditor.kind === "quantity" ? "Editar cantidad" : "Editar precio unitario"}
          unit={valueEditor.kind === "quantity" ? "unidades" : "€ / unidad"}
        />
      ) : null}
    </>
  );
}

type TicketLineRowProps = {
  isBusy: boolean;
  line: TicketLine;
  onDecrement: (lineId: string) => void;
  onEdit: (line: TicketLine) => void;
  onIncrement: (lineId: string) => void;
  onOpenQuantityEditor: () => void;
  onOpenUnitPriceEditor: () => void;
  onRemove: (lineId: string) => void;
  discount?: LineDiscountAllocation;
};

function TicketLineRow({
  discount,
  isBusy,
  line,
  onDecrement,
  onEdit,
  onIncrement,
  onOpenQuantityEditor,
  onOpenUnitPriceEditor,
  onRemove,
}: TicketLineRowProps) {
  const additionNames = getLineAdditionNames(line.modifiers, line.mixer);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null,
  );
  const [offsetX, setOffsetX] = useState(0);
  const lastActionRef = useRef<{
    action: "decrement" | "increment";
    at: number;
  } | null>(null);
  const isDragging = dragStart !== null;

  function handlePointerDown(event: PointerEvent<HTMLElement>) {
    if (
      isBusy ||
      event.button !== 0 ||
      isTicketLineActionTarget(event.target)
    ) {
      return;
    }

    event.currentTarget.setPointerCapture(event.pointerId);
    setDragStart({ x: event.clientX, y: event.clientY });
  }

  function handlePointerMove(event: PointerEvent<HTMLElement>) {
    if (!dragStart) {
      return;
    }

    const deltaX = event.clientX - dragStart.x;
    const deltaY = event.clientY - dragStart.y;

    if (Math.abs(deltaY) > 16 && Math.abs(deltaY) > Math.abs(deltaX)) {
      return;
    }

    setOffsetX(Math.min(0, Math.max(deltaX, -swipeMaxOffset)));
  }

  function endSwipe(event: PointerEvent<HTMLElement>) {
    if (!dragStart) {
      return;
    }

    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // The browser can drop pointer capture before React receives pointerup.
      }
    }

    if (offsetX <= -swipeDeleteThreshold && !isBusy) {
      onRemove(line.id);
    }

    setDragStart(null);
    setOffsetX(0);
  }

  function runQuantityAction(action: "decrement" | "increment") {
    const now = performance.now();
    const lastAction = lastActionRef.current;

    if (
      lastAction?.action === action &&
      now - lastAction.at < duplicateActionWindowMs
    ) {
      return;
    }

    lastActionRef.current = { action, at: now };

    if (action === "decrement") {
      onDecrement(line.id);
      return;
    }

    onIncrement(line.id);
  }

  function handleQuantityClick(
    event: MouseEvent<HTMLButtonElement>,
    action: "decrement" | "increment",
  ) {
    event.stopPropagation();
    runQuantityAction(action);
  }

  return (
    <div className="touch-pan-y relative overflow-hidden rounded-[var(--radius)] bg-[var(--background)]">
      <div className="absolute inset-y-px right-px flex w-24 items-center justify-center rounded-r-[calc(var(--radius)-1px)] bg-[var(--danger)] text-white">
        <Trash2 className="h-5 w-5" />
      </div>
      <article
        className={cx(
          "relative z-[1] grid grid-cols-[1fr_auto] gap-3 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-3",
          isDragging
            ? "transition-none"
            : "transition-transform duration-150 ease-out",
          isBusy && "opacity-60",
        )}
        onPointerCancel={endSwipe}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={endSwipe}
        style={{ transform: `translateX(${offsetX}px)` }}
      >
        <div className="min-w-0">
          <p className="truncate font-bold text-[var(--foreground)]">
            {line.quantity}x - {line.productName}
          </p>
          <p className="text-sm text-[var(--muted)]">
            {additionNames.length ? ` + ${additionNames.join(", ")}` : ""}
          </p>
          <MenuComponentDetails compact components={line.components} />
          <button
            aria-haspopup="dialog"
            aria-label={`Editar precio unitario de ${line.productName}`}
            className="mt-1 inline cursor-pointer touch-manipulation border-0 bg-transparent p-0 font-mono text-sm tabular-nums text-[var(--muted)] focus:outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default"
            data-ticket-line-action="true"
            disabled={isBusy}
            onClick={onOpenUnitPriceEditor}
            type="button"
          >
            {formatMoney(line.unitPriceCents)}/u
          </button>
          {discount && discount.discountAmountCents > 0 ? (
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2">
              <span className="font-mono text-sm tabular-nums text-[var(--muted)] line-through">{formatMoney(discount.grossCents)}</span>
              <strong className="font-mono tabular-nums text-[var(--success)]">{formatMoney(discount.netCents)}</strong>
              <span className="text-xs font-semibold text-[var(--success)]">−{formatMoney(discount.discountAmountCents)}</span>
            </div>
          ) : line.quantity > 1 ? (
            <p className="font-mono text-sm font-bold tabular-nums text-[var(--foreground)]">
              {formatMoney(getLineTotal(line))}
            </p>
          ) : null}
        </div>
        <div
          className="flex items-center gap-1"
          data-ticket-line-action="true"
          onPointerCancel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerMove={(event) => event.stopPropagation()}
          onPointerUp={(event) => event.stopPropagation()}
        >
          {line.components.some((component) => component.type === "menu_component") ? (
            <Button
              aria-label={`Editar selección de ${line.productName}`}
              disabled={isBusy}
              onClick={(event) => { event.stopPropagation(); onEdit(line); }}
              size="lg"
              title="Editar selección"
              type="button"
              variant="tertiary"
            >
              <Pencil className="h-4 w-4" />
            </Button>
          ) : null}
          <Button
            disabled={isBusy}
            onClick={(event) => handleQuantityClick(event, "decrement")}
            size="lg"
            type="button"
            variant="tertiary"
            className=" rounded-none"
          >
            <Minus className="h-4 w-4" />
          </Button>
          <span className="w-7 text-center">
            <button
              aria-haspopup="dialog"
              aria-label={`Editar cantidad de ${line.productName}`}
              className="inline cursor-pointer touch-manipulation border-0 bg-transparent p-0 font-mono font-bold tabular-nums focus:outline-none focus-visible:rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-default"
              disabled={isBusy}
              onClick={onOpenQuantityEditor}
              type="button"
            >
              {line.quantity}
            </button>
          </span>
          <Button
            disabled={isBusy}
            onClick={(event) => handleQuantityClick(event, "increment")}
            size="lg"
            type="button"
            variant="tertiary"
            className=" rounded-none"
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </article>
    </div>
  );
}
