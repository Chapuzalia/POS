import { DataTable as UiDataTable } from '../../../../components/ui/DataTable'
import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { CrmModal } from '../../shared/components/CrmModal'
import { Pencil, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { sileo } from "sileo";
import {
  loadCashClosingHistory,
  updateCashClosingCounts,
} from "../../../cash-registers/service";
import { getCashClosingAmounts } from "../../../cash-registers/services/cashClosingAmounts";
import { centsToInput, formatMoney } from "../../../../lib/format";
import type { CashClosingRecord, TenantContext } from "../../../../types";
import type { RunAction } from "../../shared/types";
import {
  buildCashClosingDailyValues,
  filterCashClosingsByDate,
  projectCashClosingCounts,
  type CashClosingDailyValue,
} from "../services/cashClosingReportModel";
import type { OperationalDayConfig } from "../../../../lib/operationalDay";

type Props = {
  dayChangeTime: string | null;
  disabled: boolean;
  runAction: RunAction;
  selectedVenueId: string;
  tenantContext: TenantContext;
  timeZone: string;
};

const dateFormatter = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "medium",
  timeStyle: "short",
});

const dayFormatter = new Intl.DateTimeFormat("es-ES", {
  day: "2-digit",
  month: "short",
  timeZone: "UTC",
});

function formatDay(date: string) {
  return dayFormatter.format(new Date(`${date}T12:00:00Z`)).replace(".", "");
}

function ClosingValuesChart({ values }: { values: CashClosingDailyValue[] }) {
  const [hoveredPointIndex, setHoveredPointIndex] = useState<number | null>(
    null,
  );

  if (!values.length) {
    return (
      <div className="!grid !min-h-64 !place-items-center !rounded-xl !bg-[var(--crm-surface-soft)] !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
        No hay cierres en el periodo seleccionado.
      </div>
    );
  }

  const width = 1000;
  const height = 280;
  const padding = { bottom: 42, left: 86, right: 24, top: 24 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maximum = Math.max(...values.map((value) => value.totalCents), 1);
  const point = (value: CashClosingDailyValue, index: number) => ({
    ...value,
    x:
      padding.left +
      (values.length === 1
        ? chartWidth / 2
        : (index / (values.length - 1)) * chartWidth),
    y: padding.top + chartHeight - (value.totalCents / maximum) * chartHeight,
  });
  const points = values.map(point);
  const hoveredPoint =
    hoveredPointIndex === null ? null : (points[hoveredPointIndex] ?? null);
  const linePoints = points.map(({ x, y }) => `${x},${y}`).join(" ");
  const areaPoints = `${padding.left},${padding.top + chartHeight} ${linePoints} ${padding.left + chartWidth},${padding.top + chartHeight}`;
  const labelStep = Math.max(1, Math.ceil(values.length / 8));

  return (
    <div className="!overflow-x-auto">
      <svg
        aria-label="Valor diario de los cierres de caja"
        className="!h-auto !min-w-[680px] !w-full"
        role="img"
        viewBox={`0 0 ${width} ${height}`}
      >
        <defs>
          <linearGradient
            id="cash-closing-chart-area"
            x1="0"
            x2="0"
            y1="0"
            y2="1"
          >
            <stop offset="0%" stopColor="var(--crm-blue)" stopOpacity="0.24" />
            <stop
              offset="100%"
              stopColor="var(--crm-blue)"
              stopOpacity="0.02"
            />
          </linearGradient>
          <filter
            height="160%"
            id="cash-closing-tooltip-shadow"
            width="140%"
            x="-20%"
            y="-30%"
          >
            <feDropShadow
              dx="0"
              dy="4"
              floodColor="#000000"
              floodOpacity="0.22"
              stdDeviation="6"
            />
          </filter>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => {
          const y = padding.top + chartHeight - ratio * chartHeight;
          return (
            <g key={ratio}>
              <line
                stroke="var(--crm-border-subtle)"
                strokeWidth="1"
                x1={padding.left}
                x2={padding.left + chartWidth}
                y1={y}
                y2={y}
              />
              <text
                fill="var(--crm-text-muted)"
                fontSize="12"
                textAnchor="end"
                x={padding.left - 12}
                y={y + 4}
              >
                {formatMoney(Math.round(maximum * ratio))}
              </text>
            </g>
          );
        })}
        <polygon fill="url(#cash-closing-chart-area)" points={areaPoints} />
        {values.length > 1 ? (
          <polyline
            fill="none"
            points={linePoints}
            stroke="var(--crm-blue)"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="4"
          />
        ) : null}
        {points.map((value, index) => (
          <g key={value.date}>
            <circle
              cx={value.x}
              cy={value.y}
              fill="var(--crm-surface)"
              r="6"
              stroke="var(--crm-blue)"
              strokeWidth="4"
            />
            <circle
              aria-label={`${formatDay(value.date)}, ${formatMoney(value.totalCents)}, ${value.closingCount} ${value.closingCount === 1 ? "cierre" : "cierres"}`}
              className="!cursor-pointer !outline-none"
              cx={value.x}
              cy={value.y}
              fill="transparent"
              onBlur={() => setHoveredPointIndex(null)}
              onFocus={() => setHoveredPointIndex(index)}
              onMouseEnter={() => setHoveredPointIndex(index)}
              onMouseLeave={() => setHoveredPointIndex(null)}
              r="18"
              tabIndex={0}
            />
            {index % labelStep === 0 || index === points.length - 1 ? (
              <text
                fill="var(--crm-text-muted)"
                fontSize="12"
                textAnchor="middle"
                x={value.x}
                y={height - 12}
              >
                {formatDay(value.date)}
              </text>
            ) : null}
          </g>
        ))}
        {hoveredPoint
          ? (() => {
              const tooltipWidth = 190;
              const tooltipHeight = 66;
              const tooltipX = Math.min(
                width - padding.right - tooltipWidth,
                Math.max(padding.left, hoveredPoint.x - tooltipWidth / 2),
              );
              const tooltipY =
                hoveredPoint.y > padding.top + tooltipHeight + 18
                  ? hoveredPoint.y - tooltipHeight - 16
                  : hoveredPoint.y + 16;
              return (
                <g
                  filter="url(#cash-closing-tooltip-shadow)"
                  pointerEvents="none"
                  role="status"
                >
                  <rect
                    fill="var(--crm-surface)"
                    height={tooltipHeight}
                    rx="10"
                    stroke="var(--crm-border)"
                    width={tooltipWidth}
                    x={tooltipX}
                    y={tooltipY}
                  />
                  <text
                    fill="var(--crm-text-muted)"
                    fontSize="12"
                    fontWeight="600"
                    x={tooltipX + 14}
                    y={tooltipY + 22}
                  >
                    {formatDay(hoveredPoint.date)} · {hoveredPoint.closingCount}{" "}
                    {hoveredPoint.closingCount === 1 ? "cierre" : "cierres"}
                  </text>
                  <text
                    fill="var(--crm-text)"
                    fontSize="18"
                    fontWeight="800"
                    x={tooltipX + 14}
                    y={tooltipY + 49}
                  >
                    {formatMoney(hoveredPoint.totalCents)}
                  </text>
                </g>
              );
            })()
          : null}
      </svg>
    </div>
  );
}

function DetailValue({
  label,
  tone = "default",
  value,
}: {
  label: string;
  tone?: "default" | "danger" | "success";
  value: string;
}) {
  const toneClass =
    tone === "danger"
      ? "!text-[var(--crm-red)]"
      : tone === "success"
        ? "!text-[var(--crm-green)]"
        : "!text-[var(--crm-text)]";

  return (
    <div className="!rounded-xl !bg-[var(--crm-surface-soft)] !p-3">
      <span className="!block !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
        {label}
      </span>
      <strong className={`!mt-1 !block !font-mono !text-sm ${toneClass}`}>
        {value}
      </strong>
    </div>
  );
}

const MAX_CLOSING_COUNT_CENTS = 2_147_483_647;

function parseClosingCount(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (!/^\d+(?:\.\d{0,2})?$/.test(normalized)) return null;
  const cents = Math.round(Number(normalized) * 100);
  return Number.isSafeInteger(cents) && cents <= MAX_CLOSING_COUNT_CENTS
    ? cents
    : null;
}

function ClosingCountInput({
  disabled,
  invalid,
  label,
  onChange,
  value,
}: {
  disabled: boolean;
  invalid: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  return (
    <label className="!block !rounded-xl !bg-[var(--crm-blue-soft)] !p-3">
      <span className="!block !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
        {label}
      </span>
      <span className="!mt-1 !flex !items-center !gap-2">
        <UiInput
          aria-invalid={invalid}
          className="!h-9 !min-h-9 !rounded-lg !border !border-[var(--crm-border)] !bg-[var(--crm-surface)] !px-2.5 !font-mono !text-sm !font-bold !text-[var(--crm-text)] focus:!border-[var(--crm-blue)]"
          disabled={disabled}
          inputMode="decimal"
          onChange={(event) => onChange(event.target.value)}
          value={value}
        />
        <span className="!font-mono !text-sm !font-bold !text-[var(--crm-text-muted)]">
          €
        </span>
      </span>
    </label>
  );
}

function CashClosingDetailModal({
  closing,
  disabled,
  onClose,
  onSave,
}: {
  closing: CashClosingRecord;
  disabled: boolean;
  onClose: () => void;
  onSave: (
    countedCashCents: number,
    countedCardCents: number,
  ) => Promise<boolean>;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [countedCash, setCountedCash] = useState(() =>
    centsToInput(closing.printSnapshot.expectedAndCounted.countedCashCents),
  );
  const [countedCard, setCountedCard] = useState(() =>
    centsToInput(closing.printSnapshot.expectedAndCounted.countedCardCents),
  );
  const countedCashCents = parseClosingCount(countedCash);
  const countedCardCents = parseClosingCount(countedCard);
  const snapshot =
    isEditing && countedCashCents !== null && countedCardCents !== null
      ? projectCashClosingCounts(
          closing.printSnapshot,
          countedCashCents,
          countedCardCents,
        )
      : closing.printSnapshot;
  const amounts = getCashClosingAmounts(snapshot);
  const totalDifferenceCents =
    snapshot.differences.cashDifferenceCents +
    snapshot.differences.cardDifferenceCents;
  const otherPayments = snapshot.payments.filter(
    (payment) => payment.code !== "cash" && payment.code !== "card",
  );
  const countsChanged =
    countedCashCents !==
      closing.printSnapshot.expectedAndCounted.countedCashCents ||
    countedCardCents !==
      closing.printSnapshot.expectedAndCounted.countedCardCents;

  function beginEditing() {
    setCountedCash(
      centsToInput(closing.printSnapshot.expectedAndCounted.countedCashCents),
    );
    setCountedCard(
      centsToInput(closing.printSnapshot.expectedAndCounted.countedCardCents),
    );
    setIsEditing(true);
  }

  function cancelEditing() {
    setIsEditing(false);
    setCountedCash(
      centsToInput(closing.printSnapshot.expectedAndCounted.countedCashCents),
    );
    setCountedCard(
      centsToInput(closing.printSnapshot.expectedAndCounted.countedCardCents),
    );
  }

  async function saveCounts() {
    if (
      countedCashCents === null ||
      countedCardCents === null ||
      !countsChanged
    ) {
      return;
    }
    setIsSaving(true);
    try {
      if (await onSave(countedCashCents, countedCardCents)) {
        setIsEditing(false);
      }
    } finally {
      setIsSaving(false);
    }
  }


  return (
    <CrmModal
      label="Detalle del cierre"
      onClose={isSaving ? () => undefined : onClose}
      size="large"
    >
      <section
        aria-labelledby="cash-closing-detail-title"
        className="!max-h-[calc(100svh-32px)] !w-full !max-w-4xl !overflow-y-auto !rounded-2xl !bg-[var(--crm-surface)] !p-5 !text-[var(--crm-text)] !shadow-2xl sm:!p-6"
      >
        <header className="!flex !items-start !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !pb-4">
          <div>
            <h2
              className="!text-xl !font-black"
              id="cash-closing-detail-title"
            >
              Detalle del cierre
            </h2>
            <p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">
              {snapshot.registerName} · {snapshot.shiftLabel} ·{" "}
              {dateFormatter.format(new Date(closing.closedAt))}
            </p>
          </div>
          <div className="!flex !shrink-0 !items-center !gap-2">
            {!isEditing ? (
              <UiButton
                className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-xl !border-0 !bg-[var(--crm-blue-soft)] !px-3 !text-xs !font-bold !text-[var(--crm-blue)]"
                disabled={disabled}
                onClick={beginEditing}
                type="button"
              >
                <Pencil className="!size-4" /> Editar conteos
              </UiButton>
            ) : null}
            <UiButton
              aria-label="Cerrar detalle del cierre"
              className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !grid !size-10 !shrink-0 !place-items-center !rounded-xl !border-0 !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]"
              disabled={isSaving}
              onClick={onClose}
              type="button"
            >
              <X className="!size-4" />
            </UiButton>
          </div>
        </header>

        <div className="!mt-5 !grid !gap-5">
          <section>
            <h3 className="!mb-3 !text-sm !font-black !uppercase !tracking-wide">
              Facturación
            </h3>
            <div className="!grid !gap-3 sm:!grid-cols-2 lg:!grid-cols-4">
              <DetailValue
                label="Total final facturado"
                value={formatMoney(snapshot.summary.totalSalesCents)}
              />
              <DetailValue
                label="Efectivo facturado"
                value={formatMoney(amounts.billedCashCents)}
              />
              <DetailValue
                label="Tarjeta facturada"
                value={formatMoney(amounts.billedCardCents)}
              />
              <DetailValue
                label="Tickets / media"
                value={`${snapshot.summary.salesCount} · ${formatMoney(snapshot.summary.averageSaleCents)}`}
              />
              {otherPayments.map((payment) => (
                <DetailValue
                  key={payment.code}
                  label={`${payment.label} facturado`}
                  value={formatMoney(payment.amountCents)}
                />
              ))}
            </div>
          </section>

          <section>
            <h3 className="!mb-3 !text-sm !font-black !uppercase !tracking-wide">
              Arqueo de caja
            </h3>
            <div className="!grid !gap-3 sm:!grid-cols-2 lg:!grid-cols-4">
              <DetailValue
                label="Fondo inicial"
                value={formatMoney(snapshot.cashFund.openingCashFundCents)}
              />
              <DetailValue
                label="Efectivo esperado"
                value={formatMoney(
                  snapshot.expectedAndCounted.expectedCashCents,
                )}
              />
              {isEditing ? (
                <ClosingCountInput
                  disabled={disabled || isSaving}
                  invalid={countedCashCents === null}
                  label="Conteo final efectivo"
                  onChange={setCountedCash}
                  value={countedCash}
                />
              ) : (
                <DetailValue
                  label="Conteo final efectivo"
                  value={formatMoney(
                    snapshot.expectedAndCounted.countedCashCents,
                  )}
                />
              )}
              <DetailValue
                label={
                  amounts.cashToWithdrawCents >= 0
                    ? "Retirar de caja"
                    : "Añadir a caja"
                }
                value={formatMoney(Math.abs(amounts.cashToWithdrawCents))}
              />
              <DetailValue
                label="Fondo para el siguiente turno"
                value={formatMoney(snapshot.cashFund.finalCashFundCents)}
              />
              <DetailValue
                label="Cambio tarjeta → efectivo"
                value={formatMoney(snapshot.cashMovements.cardCashbackCents)}
              />
              <DetailValue
                label="Entradas de efectivo"
                value={formatMoney(snapshot.cashMovements.cashEntriesCents)}
              />
              <DetailValue
                label="Salidas de efectivo"
                value={formatMoney(snapshot.cashMovements.cashExitsCents)}
              />
            </div>
          </section>

          <section>
            <h3 className="!mb-3 !text-sm !font-black !uppercase !tracking-wide">
              Tarjeta
            </h3>
            <div className="!grid !gap-3 sm:!grid-cols-3">
              <DetailValue
                label="Datáfono esperado"
                value={formatMoney(amounts.cardTerminalExpectedCents)}
              />
              {isEditing ? (
                <ClosingCountInput
                  disabled={disabled || isSaving}
                  invalid={countedCardCents === null}
                  label="Conteo final datáfono"
                  onChange={setCountedCard}
                  value={countedCard}
                />
              ) : (
                <DetailValue
                  label="Conteo final datáfono"
                  value={formatMoney(
                    snapshot.expectedAndCounted.countedCardCents,
                  )}
                />
              )}
              <DetailValue
                label="Diferencia tarjeta"
                tone={
                  snapshot.differences.cardDifferenceCents === 0
                    ? "success"
                    : "danger"
                }
                value={formatMoney(snapshot.differences.cardDifferenceCents)}
              />
            </div>
          </section>

          <section>
            <h3 className="!mb-3 !text-sm !font-black !uppercase !tracking-wide">
              Descuadre
            </h3>
            <div className="!grid !gap-3 sm:!grid-cols-3">
              <DetailValue
                label="Diferencia efectivo"
                tone={
                  snapshot.differences.cashDifferenceCents === 0
                    ? "success"
                    : "danger"
                }
                value={formatMoney(snapshot.differences.cashDifferenceCents)}
              />
              <DetailValue
                label="Diferencia tarjeta"
                tone={
                  snapshot.differences.cardDifferenceCents === 0
                    ? "success"
                    : "danger"
                }
                value={formatMoney(snapshot.differences.cardDifferenceCents)}
              />
              <DetailValue
                label="Descuadre total"
                tone={totalDifferenceCents === 0 ? "success" : "danger"}
                value={formatMoney(totalDifferenceCents)}
              />
            </div>
            <div className="!mt-3 !rounded-xl !border !border-[var(--crm-border-subtle)] !p-4">
              <span className="!block !text-xs !font-bold !text-[var(--crm-text-muted)]">
                Motivo del descuadre
              </span>
              <p className="!mt-1 !whitespace-pre-wrap !text-sm">
                {closing.notes || "Sin observaciones registradas."}
              </p>
            </div>
          </section>

          {isEditing ? (
            <section className="!flex !flex-col !gap-3 !rounded-xl !border !border-[var(--crm-blue)] !bg-[var(--crm-blue-soft)] !p-4 sm:!flex-row sm:!items-center sm:!justify-between">
              <p className="!text-xs !font-semibold !text-[var(--crm-text-secondary)]">
                Se recalcularán los descuadres. Las próximas copias del cierre
                usarán los conteos corregidos.
              </p>
              <div className="!flex !shrink-0 !justify-end !gap-2">
                <UiButton
                  className="!min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-surface)] !px-4 !text-[13px] !font-semibold !text-[var(--crm-text-secondary)]"
                  disabled={isSaving}
                  onClick={cancelEditing}
                  type="button"
                >
                  Cancelar
                </UiButton>
                <UiButton
                  className="!inline-flex !min-h-10 !items-center !gap-2 !rounded-[10px] !border-0 !bg-[var(--crm-blue)] !px-4 !text-[13px] !font-semibold !text-white"
                  disabled={
                    disabled ||
                    isSaving ||
                    countedCashCents === null ||
                    countedCardCents === null ||
                    !countsChanged
                  }
                  onClick={() => void saveCounts()}
                  type="button"
                >
                  <Save className="!size-4" />
                  {isSaving ? "Guardando…" : "Guardar conteos"}
                </UiButton>
              </div>
            </section>
          ) : null}

          <section className="!grid !gap-3 !border-t !border-[var(--crm-border-subtle)] !pt-4 !text-xs !text-[var(--crm-text-muted)] sm:!grid-cols-2">
            <p>
              <strong className="!text-[var(--crm-text)]">Apertura:</strong>{" "}
              {dateFormatter.format(new Date(snapshot.openedAt))}
              {snapshot.openedBy ? ` · ${snapshot.openedBy}` : ""}
            </p>
            <p>
              <strong className="!text-[var(--crm-text)]">Cierre:</strong>{" "}
              {dateFormatter.format(new Date(snapshot.closedAt))}
              {snapshot.closedBy ? ` · ${snapshot.closedBy}` : ""}
            </p>
          </section>
        </div>
      </section>
    </CrmModal>
  );
}

export function CashClosingReportsCrm({
  dayChangeTime,
  disabled,
  runAction,
  selectedVenueId,
  tenantContext,
  timeZone,
}: Props) {
  const [closings, setClosings] = useState<CashClosingRecord[] | null>(null);
  const [selectedClosing, setSelectedClosing] =
    useState<CashClosingRecord | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setClosings([]);
      return;
    }
    setClosings(
      await loadCashClosingHistory(
        { ...tenantContext, venueId: selectedVenueId },
        1000,
      ),
    );
  }, [selectedVenueId, tenantContext]);

  useEffect(() => {
    setClosings(null);
    setSelectedClosing(null);
    setDateFrom("");
    setDateTo("");
    void runAction(refresh);
  }, [refresh, runAction]);

  const operationalDayConfig = useMemo<OperationalDayConfig>(
    () => ({ dayChangeTime, timeZone }),
    [dayChangeTime, timeZone],
  );
  const filteredClosings = useMemo(
    () => filterCashClosingsByDate(closings ?? [], dateFrom, dateTo, operationalDayConfig),
    [closings, dateFrom, dateTo, operationalDayConfig],
  );
  const dailyValues = useMemo(
    () => buildCashClosingDailyValues(filteredClosings, operationalDayConfig),
    [filteredClosings, operationalDayConfig],
  );

  const saveClosingCounts = useCallback(
    async (
      closingId: string,
      countedCashCents: number,
      countedCardCents: number,
    ) => {
      let updatedClosing: CashClosingRecord | null = null;
      await runAction(async () => {
        updatedClosing = await updateCashClosingCounts(
          { ...tenantContext, venueId: selectedVenueId },
          { closingId, countedCashCents, countedCardCents },
        );
      });
      if (!updatedClosing) return false;
      const savedClosing: CashClosingRecord = updatedClosing;
      setClosings((current) =>
        current?.map((item) =>
          item.id === savedClosing.id ? savedClosing : item,
        ) ?? null,
      );
      setSelectedClosing(savedClosing);
      sileo.success({ title: "Conteos del cierre actualizados" });
      return true;
    },
    [runAction, selectedVenueId, tenantContext],
  );

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!gap-6">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !flex-wrap !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 md:!px-[22px]">
          <div>
            <h2 className="!text-base !font-bold">Evolución de cierres</h2>
            <p>Valor total de los cierres agrupado por día operativo</p>
          </div>
          <div className="!flex !flex-wrap !items-end !gap-2">
            <label className="!grid !gap-1 !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
              Día operativo desde
              <UiInput
                className="!min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-[13px] !text-[var(--crm-text)]"
                max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
                type="date"
                value={dateFrom}
              />
            </label>
            <label className="!grid !gap-1 !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
              Día operativo hasta
              <UiInput
                className="!min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-[13px] !text-[var(--crm-text)]"
                min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
                type="date"
                value={dateTo}
              />
            </label>
            <UiButton
              aria-label="Actualizar informes X"
              className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]"
              disabled={disabled}
              onClick={() => void runAction(refresh)}
              type="button"
            >
              <RefreshCw className="!size-4" />
            </UiButton>
          </div>
        </div>
        <div className="!px-[18px] !pt-3 !pb-2 md:!px-[22px]">
          <ClosingValuesChart values={dailyValues} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 max-[760px]:flex-col max-[760px]:items-stretch !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
          <div className="min-w-0 [&_h2]:m-0 [&_h2]:text-[17px] [&_h2]:font-bold [&_h2]:tracking-[-0.02em] [&_h2]:text-[var(--crm-text)] [&_p]:mt-1 [&_p]:mb-0 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)]">
            <h2>Cierres de caja</h2>
            <p>
              {closings
                ? `${filteredClosings.length} resultados`
                : "Cargando cierres..."}
            </p>
          </div>
        </div>
        <div className="!overflow-x-auto">
          <UiDataTable className="!w-full !min-w-[1050px] !border-collapse">
            <thead>
              <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
                <th className="!px-[22px] !py-3">Fecha Cierre</th>
                <th className="!px-3 !py-3">Caja / turno</th>
                <th className="!px-3 !py-3">Ventas</th>
                <th className="!px-3 !py-3">Efectivo</th>
                <th className="!px-3 !py-3">Tarjeta</th>
                <th className="!px-3 !py-3">Descuadre</th>
                <th className="!px-[22px] !py-3">Fondos</th>
              </tr>
            </thead>
            <tbody>
              {filteredClosings.map((closing) => {
                const snapshot = closing.printSnapshot;
                const amounts = getCashClosingAmounts(snapshot);
                const difference =
                  snapshot.differences.cashDifferenceCents +
                  snapshot.differences.cardDifferenceCents;
                return (
                  <tr
                    aria-label={`Ver detalle del cierre de ${snapshot.registerName}`}
                    className="!cursor-pointer !border-b !border-[var(--crm-border-subtle)] !outline-none hover:!bg-[var(--crm-surface-soft)] focus-visible:!bg-[var(--crm-surface-soft)] last:!border-0"
                    key={closing.id}
                    onClick={() => setSelectedClosing(closing)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedClosing(closing);
                      }
                    }}
                    role="button"
                    tabIndex={0}
                  >
                    <td className="!whitespace-nowrap !px-[22px] !py-4 !text-[13px] !font-semibold">
                      {dateFormatter.format(new Date(closing.closedAt))}
                    </td>
                    <td className="!px-3 !py-4">
                      <strong className="!block !text-[13px]">
                        {snapshot.registerName}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        {snapshot.shiftLabel}
                      </span>
                    </td>
                    <td className="!px-3 !py-4">
                      <strong className="!block !font-mono !text-[13px]">
                        {formatMoney(snapshot.summary.totalSalesCents)}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        {snapshot.summary.salesCount} tickets
                      </span>
                    </td>
                    <td className="!px-3 !py-4">
                      <strong className="!block !font-mono !text-[13px]">
                        {formatMoney(amounts.billedCashCents)}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        Facturado
                      </span>
                      <span className="!block !text-xs !text-[var(--crm-text-muted)]">
                        Neto sobre fondo{" "}
                        {formatMoney(amounts.cashOverOpeningFundCents)}
                      </span>
                    </td>
                    <td className="!px-3 !py-4">
                      <strong className="!block !font-mono !text-[13px]">
                        {formatMoney(amounts.billedCardCents)}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        Facturado
                      </span>
                      <span className="!block !text-xs !text-[var(--crm-text-muted)]">
                        Datáfono esperado{" "}
                        {formatMoney(amounts.cardTerminalExpectedCents)}
                      </span>
                    </td>
                    <td
                      className={`!px-3 !py-4 !font-mono !text-[13px] !font-bold ${difference === 0 ? "!text-[var(--crm-green)]" : "!text-[var(--crm-red)]"}`}
                    >
                      {formatMoney(difference)}
                    </td>
                    <td className="!px-[22px] !py-4 !text-[13px]">
                      <span className="!block">
                        Inicial{" "}
                        {formatMoney(snapshot.cashFund.openingCashFundCents)}
                      </span>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        Contado{" "}
                        {formatMoney(
                          snapshot.expectedAndCounted.countedCashCents,
                        )}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </UiDataTable>
          {closings && !filteredClosings.length ? (
            <div className="!grid !min-h-44 !place-items-center !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
              No hay cierres de caja para el periodo seleccionado.
            </div>
          ) : null}
        </div>
      </section>
      {selectedClosing ? (
        <CashClosingDetailModal
          closing={selectedClosing}
          disabled={disabled}
          onClose={() => setSelectedClosing(null)}
          onSave={(countedCashCents, countedCardCents) =>
            saveClosingCounts(
              selectedClosing.id,
              countedCashCents,
              countedCardCents,
            )
          }
        />
      ) : null}
    </div>
  );
}
