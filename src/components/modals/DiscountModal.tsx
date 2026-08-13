import { Tags, X } from "lucide-react";
import { useState } from "react";

import {
  calculateDiscount,
  formatDiscountRounding,
  formatDiscountValue,
  getAvailableVenueDiscounts,
  toAppliedDiscount,
  type DiscountScheduleContext,
} from "../../lib/discounts";
import { parseMoneyToCents } from "../../lib/format";
import type {
  AppliedDiscount,
  Discount,
  DiscountCalculationType,
} from "../../types";
import { AppModal } from "../ui/AppModal";
import { Button } from "../ui/Button";
import { NumericKeypadModal } from "../ui/NumericKeypadModal";
import { DiscountOptionRow } from "./DiscountOptionRow";

export type DiscountModalProps = {
  description?: string;
  discounts: Discount[];
  isBusy: boolean;
  manualDiscountEnabled: boolean;
  manualDiscountRequiresPin: boolean;
  onCancel: () => void;
  onSelect: (discount: AppliedDiscount) => void;
  schedule?: Omit<DiscountScheduleContext, "now">;
  subtotalCents: number;
  validatePin?: (discountId: string, pin: string) => Promise<boolean>;
  validateManualPin?: (venueId: string, pin: string) => Promise<boolean>;
  venueId: string;
};

export function DiscountModal({
  description = "Solo se descontarán las líneas elegibles.",
  discounts,
  isBusy,
  manualDiscountEnabled,
  manualDiscountRequiresPin,
  onCancel,
  onSelect,
  schedule,
  subtotalCents,
  validatePin,
  validateManualPin,
  venueId,
}: DiscountModalProps) {
  const [manualOpen, setManualOpen] = useState(false);
  const [manualType, setManualType] =
    useState<DiscountCalculationType>("percentage");
  const [manualValue, setManualValue] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);
  const [pinDiscount, setPinDiscount] = useState<Discount | null>(null);
  const [pendingManualDiscount, setPendingManualDiscount] =
    useState<AppliedDiscount | null>(null);
  const [manualValueKeypadOpen, setManualValueKeypadOpen] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinBusy, setPinBusy] = useState(false);
  const availableDiscounts = getAvailableVenueDiscounts(
    discounts,
    venueId,
    schedule ?? { dayChangeTime: null, timeZone: "UTC" },
  );

  function applyConfigured(discount: Discount) {
    if (discount.requiresPin) {
      setPinDiscount(discount);
      setPinError(null);
      return;
    }
    onSelect(toAppliedDiscount(discount, false));
  }

  async function confirmPin(pin: string) {
    if (!pinDiscount || pinBusy) return;
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("Introduce un PIN de entre 4 y 8 dígitos.");
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      if (!validatePin || !(await validatePin(pinDiscount.id, pin))) {
        setPinError("PIN incorrecto. Vuelve a intentarlo.");
        return;
      }
      onSelect(toAppliedDiscount(pinDiscount, false));
    } catch {
      setPinError("No se ha podido validar el PIN. Inténtalo de nuevo.");
    } finally {
      setPinBusy(false);
    }
  }

  function buildManualDiscount(): AppliedDiscount {
    const value =
      manualType === "fixed"
        ? parseMoneyToCents(manualValue)
        : Number(manualValue.replace(",", "."));
    calculateDiscount(subtotalCents, manualType, value);
    return {
      discountId: null,
      name: "Descuento manual",
      type: "manual",
      calculationType: manualType,
      value,
      roundingIncrementCents: null,
      color: null,
      ruleKind: "discount",
      scope: "general",
      targets: [],
      requiresPin: manualDiscountRequiresPin,
      activeWeekdays: [],
      startsAt: null,
      endsAt: null,
      automatic: false,
    };
  }

  function applyManual() {
    try {
      const nextDiscount = buildManualDiscount();
      if (manualDiscountRequiresPin) {
        setPendingManualDiscount(nextDiscount);
        setPinError(null);
        return;
      }
      onSelect(nextDiscount);
    } catch (error) {
      setValidationError(
        error instanceof Error ? error.message : "El descuento no es válido.",
      );
    }
  }

  async function confirmManualPin(pin: string) {
    if (!pendingManualDiscount || pinBusy) return;
    if (!/^\d{4,8}$/.test(pin)) {
      setPinError("Introduce un PIN de entre 4 y 8 dígitos.");
      return;
    }
    setPinBusy(true);
    setPinError(null);
    try {
      if (!validateManualPin || !(await validateManualPin(venueId, pin))) {
        setPinError("PIN incorrecto. Vuelve a intentarlo.");
        return;
      }
      onSelect(pendingManualDiscount);
    } catch {
      setPinError("No se ha podido validar el PIN. Inténtalo de nuevo.");
    } finally {
      setPinBusy(false);
    }
  }

  if (pendingManualDiscount) {
    return (
      <NumericKeypadModal
        allowDecimal={false}
        confirmLabel="Validar PIN"
        disabled={pinBusy || isBusy}
        error={pinError}
        initialValue=""
        maxDigits={8}
        onCancel={() => {
          if (!pinBusy) setPendingManualDiscount(null);
        }}
        onChange={() => setPinError(null)}
        onConfirm={(pin) => void confirmManualPin(pin)}
        subtitle="Descuento manual libre"
        title="Introduce el PIN"
        password={true}
        unit="PIN"
      />
    );
  }

  if (pinDiscount) {
    return (
      <NumericKeypadModal
        allowDecimal={false}
        confirmLabel="Validar PIN"
        disabled={pinBusy || isBusy}
        error={pinError}
        initialValue=""
        maxDigits={8}
        onCancel={() => {
          if (!pinBusy) setPinDiscount(null);
        }}
        onChange={() => setPinError(null)}
        onConfirm={(pin) => void confirmPin(pin)}
        subtitle={pinDiscount.name}
        title="Introduce el PIN"
        password={true}
        unit="PIN"
      />
    );
  }

  return (
    <>
      <AppModal
        dismissDisabled={isBusy || manualValueKeypadOpen}
        label="Aplicar descuento o promoción"
        maxWidth={600}
        onClose={onCancel}
        placement="center"
      >
        <section
          aria-labelledby="discount-title"
          className="max-h-[85svh] w-full max-w-xl overflow-y-auto rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] p-5 text-[var(--foreground)] shadow-[var(--shadow)]"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-2xl font-bold" id="discount-title">
                Aplicar descuento
              </h2>
              <p className="text-sm text-[var(--muted)]">{description}</p>
            </div>
            <button
              aria-label="Cerrar"
              className="grid h-9 w-9 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)]"
              disabled={isBusy}
              onClick={onCancel}
              type="button"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="mt-5 grid gap-2">
            {availableDiscounts.map((discount) => (
              <DiscountOptionRow
                color={discount.color}
                disabled={isBusy}
                key={discount.id}
                label={discount.name}
                onSelect={() => applyConfigured(discount)}
                roundingLabel={[
                  discount.ruleKind === "promotion" ? "Promoción activa" : null,
                  discount.scope === "specific"
                    ? "Productos específicos"
                    : "General",
                  discount.requiresPin ? "Requiere PIN" : null,
                  discount.roundingIncrementCents
                    ? formatDiscountRounding(discount.roundingIncrementCents)
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                valueLabel={formatDiscountValue(discount.type, discount.value)}
              />
            ))}
            {!availableDiscounts.length && !manualDiscountEnabled ? (
              <p className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-5 text-center text-sm font-semibold text-[var(--muted)]">
                No hay descuentos o promociones disponibles ahora.
              </p>
            ) : null}
          </div>

          {manualDiscountEnabled ? (
            <div className="mt-4 border-t border-[var(--separator)] pt-4">
              {!manualOpen ? (
                <button
                  className="flex h-11 min-h-11 w-full items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] px-4 text-sm font-medium"
                  onClick={() => setManualOpen(true)}
                  type="button"
                >
                  <Tags className="h-4 w-4" />
                  Descuento manual libre
                </button>
              ) : (
                <div className="grid gap-3 rounded-[var(--radius)] bg-[var(--background)] p-4">
                  <div className="grid grid-cols-2 gap-2 justify-items-center">
                    <Button
                      active={manualType === "percentage"}
                      className="rounded-md "
                      onClick={() => setManualType("percentage")}
                      type="button"
                      variant="secondary"
                    >
                      Porcentaje
                    </Button>
                    <Button
                      active={manualType === "fixed"}
                      className="rounded-md "
                      onClick={() => setManualType("fixed")}
                      type="button"
                      variant="secondary"
                    >
                      Importe fijo
                    </Button>
                  </div>
                  <div>
                    <button
                      aria-label={`Introducir ${manualType === "percentage" ? "porcentaje" : "importe"}`}
                      className="mt-1 flex h-12 w-full items-center rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3 text-left text-[var(--field-foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={isBusy}
                      onClick={() => setManualValueKeypadOpen(true)}
                      type="button"
                    >
                      <span
                        className={`min-w-0 flex-1 font-mono ${manualValue ? "" : "text-[var(--muted)]"}`}
                      >
                        {manualValue || "Introducir valor"}
                      </span>
                      <span className="text-sm font-bold text-[var(--muted)]">
                        {manualType === "percentage" ? "%" : "EUR"}
                      </span>
                    </button>
                  </div>
                  {validationError ? (
                    <p className="text-sm font-semibold text-[var(--danger)]">
                      {validationError}
                    </p>
                  ) : null}
                  <Button
                    disabled={isBusy || !manualValue.trim()}
                    fullWidth
                    onClick={applyManual}
                    type="button"
                    variant="primary"
                  >
                    Aplicar descuento manual
                  </Button>
                </div>
              )}
            </div>
          ) : null}
        </section>
      </AppModal>

      {manualValueKeypadOpen ? (
        <NumericKeypadModal
          confirmLabel="Aceptar"
          disabled={isBusy}
          initialValue={manualValue}
          maxFractionDigits={2}
          onCancel={() => setManualValueKeypadOpen(false)}
          onConfirm={(value) => {
            setManualValue(value);
            setValidationError(null);
            setManualValueKeypadOpen(false);
          }}
          showCloseButton={false}
          title={manualType === "percentage" ? "Porcentaje" : "Importe fijo"}
          unit={manualType === "percentage" ? "%" : "EUR"}
        />
      ) : null}
    </>
  );
}
