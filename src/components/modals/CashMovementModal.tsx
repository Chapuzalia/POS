import { TextArea as UiTextArea } from "../ui/TextArea";
import { Input as UiInput } from "../ui/Input";
import { Button as UiButton } from "../ui/Button";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  CreditCard,
  LoaderCircle,
  X,
} from "lucide-react";
import { useRef, useState } from "react";
import { sileo } from "sileo";
import { getPrintAgentErrorMessage } from "../../features/local-printing/api/PrintAgentError";
import { usePrintAgent } from "../../features/local-printing/hooks/usePrintAgent";
import { centsToInput, formatMoney, parseMoneyToCents } from "../../lib/format";
import type { CashMovement, CashMovementType } from "../../types";
import { cx } from "../../utils/cx";
import { getReadableError } from "../../utils/errors";
import { AppModal, Button } from "../ui";

type Props = {
  isOnline: boolean;
  isSaving: boolean;
  onCancel: () => void;
  onConfirm: (input: {
    type: CashMovementType;
    amountCents: number;
    notes: string;
    requestId: string;
  }) => Promise<CashMovement>;
};

const options = [
  {
    type: "cash_in" as const,
    title: "Meter efectivo",
    description: "Añade efectivo físico a la caja.",
    defaultReason: "Cambio añadido a la caja",
    confirm: "Meter efectivo",
    Icon: ArrowDownToLine,
  },
  {
    type: "cash_out" as const,
    title: "Sacar efectivo",
    description: "Retira efectivo físico de la caja.",
    defaultReason: "Retirada de efectivo",
    confirm: "Sacar efectivo",
    Icon: ArrowUpFromLine,
  },
  {
    type: "card_cashback" as const,
    title: "Dar efectivo por pago con tarjeta",
    description:
      "Registra un cobro con tarjeta y entrega el mismo importe en efectivo. No genera una venta.",
    defaultReason: "Efectivo entregado al cliente",
    confirm: "Registrar efectivo por tarjeta",
    Icon: CreditCard,
  },
];

export function CashMovementModal({
  isOnline,
  isSaving,
  onCancel,
  onConfirm,
}: Props) {
  const [type, setType] = useState<CashMovementType | null>(null);
  const [amount, setAmount] = useState("");
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pendingRequest = useRef<{
    fingerprint: string;
    requestId: string;
  } | null>(null);
  const printAgent = usePrintAgent();
  const selected = options.find((option) => option.type === type) ?? null;
  const amountCents = parseMoneyToCents(amount);
  const busy = isSaving || submitting;
  const canSubmit = Boolean(
    selected &&
    amount.trim() &&
    amountCents > 0 &&
    notes.trim() &&
    isOnline &&
    !busy,
  );

  async function submit() {
    if (!selected || !canSubmit) return;
    const trimmedNotes = notes.trim();
    const fingerprint = `${selected.type}:${amountCents}:${trimmedNotes}`;
    const request =
      pendingRequest.current?.fingerprint === fingerprint
        ? pendingRequest.current
        : { fingerprint, requestId: crypto.randomUUID() };
    pendingRequest.current = request;
    setSubmitting(true);
    setError(null);
    try {
      const movement = await onConfirm({
        type: selected.type,
        amountCents,
        notes: trimmedNotes,
        requestId: request.requestId,
      });
      pendingRequest.current = null;
      onCancel();
      try {
        await printAgent.openCashDrawer({
          requestId: `cash-movement:${movement.id}:drawer`,
        });
        const label =
          selected.type === "cash_in"
            ? "Entrada"
            : selected.type === "cash_out"
              ? "Salida"
              : "Efectivo por tarjeta";
        sileo.success({
          title: `${label} de ${formatMoney(amountCents)} registrada`,
        });
      } catch (drawerError) {
        sileo.warning({
          title: "Movimiento registrado, pero no se pudo abrir el cajón",
          description: getPrintAgentErrorMessage(drawerError),
        });
      }
    } catch (submitError) {
      setError(getReadableError(submitError));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AppModal
      containerClassName="!p-4"
      maxWidth={672}
      dismissDisabled={busy}
      label="Movimiento de efectivo"
      onClose={onCancel}
    >
      <section
        aria-labelledby="cash-movement-title"
        className="flex max-h-[calc(100dvh-2rem)] min-w-0 max-w-full flex-col overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)]"
      >
        <header className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
          <div className="min-w-0">
            <h2 className="text-2xl font-bold" id="cash-movement-title">
              Movimientos de caja
            </h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Registra una entrada o salida de efectivo sin generar una venta.
            </p>
          </div>
          <Button
            aria-label="Cerrar"
            className="shrink-0"
            disabled={busy}
            onClick={onCancel}
            size="sm"
            type="button"
            variant="tertiary"
          >
            <X className="h-4 w-4" />
          </Button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-5">
          <fieldset className="min-w-0" disabled={busy}>
            <legend className="text-sm font-semibold text-[var(--muted)]">
              Tipo de movimiento
            </legend>
            <div className="mt-2 grid min-w-0 gap-2 md:grid-cols-3">
              {options.map((option) => {
                const active = option.type === type;
                return (
                  <UiButton
                    aria-pressed={active}
                    className={cx(
                      "flex min-h-28 w-full min-w-0 max-w-full flex-col items-center gap-2 overflow-hidden rounded-[var(--radius)] border p-4 text-left !whitespace-normal transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-45",
                      active
                        ? "border-[var(--accent)] bg-[var(--accent-soft)]"
                        : "border-[var(--separator)] bg-[var(--background)] hover:border-[var(--accent)]",
                    )}
                    key={option.type}
                    onClick={() => {
                      setType(option.type);
                      setNotes(option.defaultReason);
                      setError(null);
                    }}
                    type="button"
                  >
                    <option.Icon className="h-5 w-5 shrink-0 text-[var(--accent)]" />
                    <span className="min-w-0 max-w-full whitespace-normal break-words">
                      <strong className="block text-sm text-center ">
                        {option.title}
                      </strong>
                    </span>
                  </UiButton>
                );
              })}
            </div>
          </fieldset>
          {selected ? (
            <div className="mt-5 grid gap-4">
              <label>
                <span className="text-sm font-semibold text-[var(--muted)]">
                  Importe
                </span>
                <div className="mt-1 flex h-12 items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)]">
                  <span className="px-3 font-mono text-sm font-bold text-[var(--muted)]">
                    EUR
                  </span>
                  <UiInput
                    autoFocus
                    className="h-full min-w-0 flex-1 bg-transparent px-2 font-mono text-[var(--field-foreground)] outline-none"
                    disabled={busy}
                    inputMode="decimal"
                    onBlur={() => {
                      if (amountCents > 0) setAmount(centsToInput(amountCents));
                    }}
                    onChange={(event) => {
                      setAmount(event.target.value);
                      setError(null);
                    }}
                    placeholder="0,00"
                    value={amount}
                  />
                </div>
              </label>
              <label>
                <span className="text-sm font-semibold text-[var(--muted)]">
                  Motivo
                </span>
                <UiTextArea
                  className="mt-1 min-h-24 w-full resize-y rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] p-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
                  disabled={busy}
                  onChange={(event) => {
                    setNotes(event.target.value);
                    setError(null);
                  }}
                  value={notes}
                />
                <span className="mt-1 block text-xs text-[var(--muted)]">
                  Puedes editar el motivo antes de registrar el movimiento.
                </span>
              </label>
              <div className="min-w-0 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4">
                <p className="text-sm font-semibold text-[var(--muted)]">
                  Efecto en el arqueo
                </p>
                <div className="mt-2 grid min-w-0 gap-2 text-sm sm:grid-cols-2">
                  <p className="flex min-w-0 flex-wrap justify-between gap-3">
                    <span className="min-w-0">Efectivo en caja</span>
                    <strong className="shrink-0 font-mono">
                      {selected.type === "cash_in" ? "+" : "-"}
                      {formatMoney(amountCents)}
                    </strong>
                  </p>
                  <p className="flex min-w-0 flex-wrap justify-between gap-3">
                    <span className="min-w-0">Tarjeta</span>
                    <strong className="shrink-0 font-mono">
                      {selected.type === "card_cashback"
                        ? `+${formatMoney(amountCents)}`
                        : "Sin cambios"}
                    </strong>
                  </p>
                </div>
              </div>
              {!isOnline ? (
                <p className="rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-semibold text-amber-700">
                  Los movimientos de caja requieren conexión.
                </p>
              ) : null}
              {error ? (
                <p
                  className="rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]"
                  role="alert"
                >
                  {error}
                </p>
              ) : null}
              <Button
                className="min-w-0 max-w-full !whitespace-normal"
                disabled={!canSubmit}
                fullWidth
                onClick={() => void submit()}
                size="lg"
                type="button"
                variant="primary"
              >
                {busy ? (
                  <LoaderCircle className="h-5 w-5 shrink-0 animate-spin" />
                ) : null}
                {busy ? "Guardando..." : selected.confirm}
              </Button>
            </div>
          ) : null}
        </div>
      </section>
    </AppModal>
  );
}
