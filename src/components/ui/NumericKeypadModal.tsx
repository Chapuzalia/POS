import { Delete, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppModal } from "./AppModal";
import { Button } from "./Button";

export type NumericKeypadModalProps = {
  allowDecimal?: boolean;
  confirmLabel?: string;
  decimalSeparator?: "." | ",";
  disabled?: boolean;
  initialValue?: string;
  maxDigits?: number;
  maxFractionDigits?: number;
  onCancel: () => void;
  onChange?: (value: string) => void;
  onConfirm: (value: string) => void;
  subtitle?: string;
  title?: string;
  unit?: string;
};

const digitKeys = ["7", "8", "9", "4", "5", "6", "1", "2", "3"] as const;

function sanitizeValue(
  value: string,
  decimalSeparator: "." | ",",
  allowDecimal: boolean,
  maxDigits: number,
  maxFractionDigits?: number,
) {
  const normalized = value.replace(",", ".").replace(/[^\d.]/g, "");
  const [integerPart = "", ...fractionParts] = normalized.split(".");
  const integer =
    integerPart.replace(/^0+(?=\d)/, "").slice(0, maxDigits) || "0";

  if (!allowDecimal || fractionParts.length === 0) return integer;

  const fractionLimit = Math.max(
    0,
    Math.min(maxFractionDigits ?? maxDigits, maxDigits - integer.length),
  );
  const fraction = fractionParts.join("").slice(0, fractionLimit);
  return `${integer}${decimalSeparator}${fraction}`;
}

export function NumericKeypadModal({
  allowDecimal = true,
  confirmLabel = "Aceptar",
  decimalSeparator = ",",
  disabled = false,
  initialValue = "0",
  maxDigits = 12,
  maxFractionDigits,
  onCancel,
  onChange,
  onConfirm,
  subtitle,
  title,
  unit,
}: NumericKeypadModalProps) {
  const safeMaxDigits = Math.max(1, maxDigits);
  const [value, setValue] = useState(() =>
    sanitizeValue(
      initialValue,
      decimalSeparator,
      allowDecimal,
      safeMaxDigits,
      maxFractionDigits,
    ),
  );
  const replaceValueOnNextInput = useRef(true);

  function updateValue(nextValue: string) {
    setValue(nextValue);
    onChange?.(nextValue);
  }

  function appendDigit(digit: string) {
    if (replaceValueOnNextInput.current) {
      replaceValueOnNextInput.current = false;
      updateValue(digit);
      return;
    }

    const digitCount = value.replace(/\D/g, "").length;
    if (digitCount >= safeMaxDigits) return;

    const decimalIndex = value.indexOf(decimalSeparator);
    const fractionLength =
      decimalIndex < 0 ? 0 : value.length - decimalIndex - 1;
    if (
      decimalIndex >= 0 &&
      maxFractionDigits !== undefined &&
      fractionLength >= maxFractionDigits
    )
      return;

    updateValue(value === "0" ? digit : `${value}${digit}`);
  }

  function appendDecimal() {
    if (!allowDecimal) return;

    if (replaceValueOnNextInput.current) {
      replaceValueOnNextInput.current = false;
      updateValue(`0${decimalSeparator}`);
      return;
    }

    if (value.includes(decimalSeparator)) return;
    updateValue(`${value || "0"}${decimalSeparator}`);
  }

  function removeLastCharacter() {
    replaceValueOnNextInput.current = false;
    updateValue(value.length > 1 ? value.slice(0, -1) : "0");
  }

  function clearValue() {
    replaceValueOnNextInput.current = false;
    updateValue("0");
  }

  function confirmValue() {
    const normalizedValue = value.endsWith(decimalSeparator)
      ? value.slice(0, -1)
      : value;
    onConfirm(normalizedValue || "0");
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (disabled || event.ctrlKey || event.metaKey || event.altKey) return;

      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        appendDigit(event.key);
        return;
      }

      if ((event.key === "." || event.key === ",") && allowDecimal) {
        event.preventDefault();
        appendDecimal();
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        removeLastCharacter();
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        clearValue();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        confirmValue();
      }
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const keyClassName =
    "!h-16 !min-h-16 select-none w-full !p-0 !font-mono !text-2xl !font-black tabular-nums active:!scale-[0.97] !rounded-xl";

  return (
    <AppModal
      containerClassName="!p-3"
      dismissDisabled={disabled}
      label={title}
      maxWidth={430}
      onClose={onCancel}
    >
      <section
        aria-labelledby="numeric-keypad-title"
        className="w-full bg-[var(--surface)] p-4 text-[var(--foreground)] sm:p-5"
      >
        <header className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <h2 className="text-xl font-bold" id="numeric-keypad-title">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-1 text-sm text-[var(--muted)]">{subtitle}</p>
            ) : null}
          </div>
          <Button
            aria-label="Cerrar teclado numérico"
            className="shrink-0 !rounded-none"
            disabled={disabled}
            onClick={onCancel}
            size="lg"
            type="button"
            variant="tertiary"
          >
            <X aria-hidden="true" className="h-4 w-4" />
          </Button>
        </header>

        <output
          aria-live="polite"
          className="mt-4 flex min-h-20 items-center justify-end gap-3 overflow-hidden rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-5 py-3 text-right text-[var(--field-foreground)]"
        >
          <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-4xl font-black tabular-nums">
            {value}
          </span>
          {unit ? (
            <span className="shrink-0 text-sm font-bold text-[var(--muted)]">
              {unit}
            </span>
          ) : null}
        </output>
        <div className="flex ">
          <div
            aria-label="Teclado numérico"
            className="flex flex-row  w-full pt-4 gap-4"
            role="group"
          >
            <div className="col-span-3 grid grid-cols-3 gap-2 w-full ">
              {digitKeys.map((digit) => (
                <Button
                  aria-label={`Número ${digit}`}
                  className={`${keyClassName} !rounded-xl bg-[var(--field)]`}
                  disabled={disabled}
                  key={digit}
                  onClick={() => appendDigit(digit)}
                  type="button"
                  variant="tertiary"
                >
                  {digit}
                </Button>
              ))}
              <Button
                aria-label="Número 0"
                className={`${keyClassName} ${allowDecimal ? "!col-span-2" : "!col-span-3"}  bg-[var(--field)]`}
                disabled={disabled}
                onClick={() => appendDigit("0")}
                type="button"
                variant="tertiary"
              >
                0
              </Button>
              {allowDecimal ? (
                <Button
                  aria-label="Separador decimal"
                  className={`${keyClassName} !rounded-xl bg-[var(--field)]`}
                  disabled={disabled}
                  onClick={appendDecimal}
                  type="button"
                  variant="tertiary"
                >
                  {decimalSeparator}
                </Button>
              ) : null}
            </div>
            <div className="flex grow flex-col gap-2 w-1/4 h-full items-center justify-between">
              <Button
                aria-label="Borrar último número"
                className={`${keyClassName} flex !items-center !justify-items-center`}
                disabled={disabled}
                onClick={removeLastCharacter}
                type="button"
                variant="tertiary"
              >
                <Delete aria-hidden="true" className="h-6 w-6" />
              </Button>
              <Button
                className={`${keyClassName} !col-start-4 !row-span-4 !row-start-2  !min-h-auto !text-base h-auto grow`}
                disabled={disabled}
                onClick={confirmValue}
                type="button"
                variant="primary"
              >
                {confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      </section>
    </AppModal>
  );
}
