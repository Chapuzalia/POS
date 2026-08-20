import { useEffect, useRef, useState } from "react";
import { centsToInput, formatMoney, parseMoneyToCents } from "../../lib/format";
import { cx } from "../../utils/cx";
import { AppModal, Button } from "../ui";
import { NumericKeypadModal } from "../ui/NumericKeypadModal";
import { addCashDenomination, cashDenominationsCents } from "./cash-payment";

type CashPaymentModalProps = {
  isBusy: boolean;
  onCancel: () => void;
  onConfirm: (receivedCents: number) => void;
  totalCents: number;
};

export function CashPaymentModal({
  isBusy,
  onCancel,
  onConfirm,
  totalCents,
}: CashPaymentModalProps) {
  const [delivered, setDelivered] = useState(centsToInput(totalCents));
  const [deliveredKeypadOpen, setDeliveredKeypadOpen] = useState(false);
  const deliveredCents = parseMoneyToCents(delivered);
  const difference = deliveredCents - totalCents;
  const initialExactRef = useRef(true);

  function selectExactAmount() {
    initialExactRef.current = true;
    setDelivered(centsToInput(totalCents));
  }

  function addDenomination(amount: number) {
    setDelivered((current) =>
      centsToInput(
        addCashDenomination(
          parseMoneyToCents(current),
          amount,
          initialExactRef.current,
        ),
      ),
    );
    initialExactRef.current = false;
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (deliveredKeypadOpen) return;

      if (event.key === "Escape" && !isBusy) {
        onCancel();
      }

      if (event.key === "Enter" && !isBusy && difference >= 0) {
        onConfirm(deliveredCents);
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    deliveredCents,
    deliveredKeypadOpen,
    difference,
    isBusy,
    onCancel,
    onConfirm,
  ]);

  return (
    <>
      <AppModal
        dismissDisabled={isBusy || deliveredKeypadOpen}
        maxWidth={600}
        label="Cobro en efectivo"
        onClose={onCancel}
      >
        <section className="w-full max-w-xl rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]">
          <div className="mt-0 flex flex-row items-center justify-between gap-2">
            <div className="rounded-[var(--radius)] w-full border border-[var(--separator)] bg-[var(--background)] p-4">
              <p className="text-sm font-semibold text-[var(--muted)]">
                Total a cobrar
              </p>
              <p className="mt-1 font-mono text-4xl font-black tabular-nums">
                {formatMoney(totalCents)}
              </p>
            </div>

            <button
              aria-label="Introducir dinero entregado"
              className="w-full rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4 text-left disabled:cursor-not-allowed"
              disabled={isBusy}
              onClick={() => setDeliveredKeypadOpen(true)}
              type="button"
            >
              <p className="text-sm font-semibold text-[var(--muted)]">
                Entregado
              </p>
              <p className="mt-1 font-mono text-4xl font-black tabular-nums">
                {formatMoney(deliveredCents)}
              </p>
            </button>
          </div>

          <div className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-4">
            <Button
              onClick={selectExactAmount}
              type="button"
              className="!text-xl !rounded-lg w-full border-1 min-h-12"
              variant="primary"
              size="lg"
            >
              Exacto
            </Button>
            {cashDenominationsCents.map((amount) => (
              <Button
                key={amount}
                className="bg-(--field) !text-xl !rounded-lg border-1 w-full min-h-12"
                onClick={() => addDenomination(amount)}
                type="button"
                variant="tertiary"
                size="lg"
              >
                {formatMoney(amount)}
              </Button>
            ))}
          </div>

          <div
            className={cx(
              "mt-4 rounded-[var(--radius)] border p-4",
              difference >= 0
                ? "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]"
                : "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)]",
            )}
          >
            <p className="text-sm font-semibold">
              {difference >= 0 ? "Cambio" : "Falta"}
            </p>
            <p className="font-mono text-2xl font-black tabular-nums">
              {formatMoney(Math.abs(difference))}
            </p>
          </div>

          <Button
            className="mt-4 min-h-14"
            disabled={isBusy || difference < 0}
            fullWidth
            onClick={() => onConfirm(deliveredCents)}
            size="lg"
            type="button"
            variant="primary"
          >
            Confirmar cobro
          </Button>
        </section>
      </AppModal>

      {deliveredKeypadOpen ? (
        <NumericKeypadModal
          confirmLabel="Aceptar"
          disabled={isBusy}
          initialValue={delivered}
          maxFractionDigits={2}
          onCancel={() => setDeliveredKeypadOpen(false)}
          onConfirm={(value) => {
            initialExactRef.current = false;
            setDelivered(centsToInput(parseMoneyToCents(value)));
            setDeliveredKeypadOpen(false);
          }}
          title=""
          showCloseButton={false}
          unit="EUR"
        />
      ) : null}
    </>
  );
}
