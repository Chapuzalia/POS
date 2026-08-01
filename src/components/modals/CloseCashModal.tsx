import { TextArea as UiTextArea } from "../ui/TextArea";
import { X } from "lucide-react";
import { useState } from "react";
import { centsToInput, formatMoney, parseMoneyToCents } from "../../lib/format";
import type { CashClosedPayload, CashSession, CashSummary } from "../../types";
import { nowIso } from "../../utils/dates";
import { AppModal, Button, Metric } from "../ui";
import { NumericKeypadModal } from "../ui/NumericKeypadModal";

type CloseCashModalProps = {
  cashSession: CashSession;
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: (payload: CashClosedPayload) => void;
  summary: CashSummary;
  userId: string;
};

export function CloseCashModal({
  cashSession,
  isBusy,
  onCancel,
  onConfirm,
  summary,
  userId,
}: CloseCashModalProps) {
  const [countedCash, setCountedCash] = useState(
    centsToInput(summary.cashCents),
  );
  const [countedCard, setCountedCard] = useState(
    centsToInput(summary.cardCents),
  );
  const [finalCashFund] = useState(
    centsToInput(cashSession.openingFloatCents),
  );
  const [countedAmountKeypad, setCountedAmountKeypad] = useState<
    "cash" | "card" | null
  >(null);
  const [notes, setNotes] = useState("");
  const countedCashCents = parseMoneyToCents(countedCash);
  const countedCardCents = parseMoneyToCents(countedCard);
  const finalCashFundCents = parseMoneyToCents(finalCashFund);
  const expectedTotal = summary.cashCents + summary.cardCents;
  const countedTotal = countedCashCents + countedCardCents;
  const discrepancy = countedTotal - expectedTotal;
  const notesRequired = discrepancy !== 0 && !notes.trim();

  function handleConfirm() {
    onConfirm({
      sessionId: cashSession.id,
      tenantId: cashSession.tenantId,
      closedAt: nowIso(),
      closedBy: userId,
      expectedCashCents: summary.cashCents,
      expectedCardCents: summary.cardCents,
      expectedInvitationCents: summary.invitationCents,
      expectedOtherCents: summary.otherCents,
      countedCashCents,
      countedCardCents,
      countedInvitationCents: summary.invitationCents,
      countedOtherCents: summary.otherCents,
      discrepancyCents: discrepancy,
      finalCashFundCents,
      notes: notes.trim(),
    });
  }

  function handleCountedAmountConfirm(value: string) {
    const normalizedValue = centsToInput(parseMoneyToCents(value));

    if (countedAmountKeypad === "cash") {
      setCountedCash(normalizedValue);
    } else if (countedAmountKeypad === "card") {
      setCountedCard(normalizedValue);
    }

    setCountedAmountKeypad(null);
  }

  return (
    <>
      <AppModal
        dismissDisabled={isBusy || countedAmountKeypad !== null}
        label="Cierre de caja"
        onClose={onCancel}
        maxWidth={600}
      >
        <section className="max-h-[calc(100svh-32px)] w-full max-w-3xl overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold">Cierre de caja</h2>
              <p className="text-sm text-[var(--muted)]">
                Revisa importes esperados y contado real.
              </p>
            </div>
            <Button
              disabled={isBusy}
              onClick={onCancel}
              size="sm"
              type="button"
              variant="tertiary"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <Metric
              label="Efectivo esperado"
              value={formatMoney(summary.cashCents)}
            />
            <Metric
              label="Tarjeta TPV"
              value={formatMoney(summary.cardCents)}
            />
          </div>

          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            {[
              {
                field: "cash" as const,
                label: "Efectivo",
                value: countedCash,
              },
              {
                field: "card" as const,
                label: "Datafono",
                value: countedCard,
              },
            ].map(({ field, label, value }) => (
              <div className="block" key={field}>
                <span className="text-sm font-semibold text-[var(--muted)]">
                  {label}
                </span>
                <button
                  aria-label={`Introducir ${label.toLowerCase()}`}
                  className="mt-1 flex h-12 w-full items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] text-left text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                  disabled={isBusy}
                  onClick={() => setCountedAmountKeypad(field)}
                  type="button"
                >
                  <span className="px-3 font-mono text-sm font-bold text-[var(--muted)]">
                    EUR
                  </span>
                  <span className="min-w-0 flex-1 px-2 font-mono">
                    {value}
                  </span>
                </button>
              </div>
            ))}
          </div>

          <label className="mt-5 block">
            <span className="text-sm font-semibold text-[var(--muted)]">
              Notas
            </span>
            <UiTextArea
              className="mt-1 min-h-14 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] p-3 text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)]"
              onChange={(event) => setNotes(event.target.value)}
              value={notes}
            />
          </label>

          <Button
            className="mt-4"
            disabled={
              isBusy || notesRequired || parseMoneyToCents(finalCashFund) < 0
            }
            fullWidth
            onClick={handleConfirm}
            size="lg"
            type="button"
            variant="danger"
          >
            Cerrar caja
          </Button>
        </section>
      </AppModal>

      {countedAmountKeypad ? (
        <NumericKeypadModal
          confirmLabel="Aceptar"
          disabled={isBusy}
          initialValue={
            countedAmountKeypad === "cash" ? countedCash : countedCard
          }
          maxFractionDigits={2}
          onCancel={() => setCountedAmountKeypad(null)}
          onConfirm={handleCountedAmountConfirm}
          showCloseButton={false}
          title={countedAmountKeypad === "cash" ? "Efectivo" : "Datáfono"}
          unit="EUR"
        />
      ) : null}
    </>
  );
}
