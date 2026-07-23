import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { loadCashClosingHistory } from "../../../cash-registers/service";
import { formatMoney } from "../../../../lib/format";
import type { CashClosingRecord, TenantContext } from "../../../../types";
import { KpiCard } from "../../dashboard/pages/DashboardPage";
import type { RunAction } from "../../shared/types";
import {
  buildCashClosingDailyValues,
  filterCashClosingsByDate,
  type CashClosingDailyValue,
} from "../services/cashClosingReportModel";

type Props = {
  disabled: boolean;
  runAction: RunAction;
  selectedVenueId: string;
  tenantContext: TenantContext;
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

export function CashClosingReportsCrm({
  disabled,
  runAction,
  selectedVenueId,
  tenantContext,
}: Props) {
  const [closings, setClosings] = useState<CashClosingRecord[] | null>(null);
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
    setDateFrom("");
    setDateTo("");
    void runAction(refresh);
  }, [refresh, runAction]);

  const filteredClosings = useMemo(
    () => filterCashClosingsByDate(closings ?? [], dateFrom, dateTo),
    [closings, dateFrom, dateTo],
  );
  const dailyValues = useMemo(
    () => buildCashClosingDailyValues(filteredClosings),
    [filteredClosings],
  );
  const totalSalesCents = filteredClosings.reduce(
    (total, closing) => total + closing.printSnapshot.summary.totalSalesCents,
    0,
  );
  const totalDifferenceCents = filteredClosings.reduce(
    (total, closing) =>
      total +
      closing.printSnapshot.differences.cashDifferenceCents +
      closing.printSnapshot.differences.cardDifferenceCents,
    0,
  );
  const totalTickets = filteredClosings.reduce(
    (total, closing) => total + closing.printSnapshot.summary.salesCount,
    0,
  );

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !flex-wrap !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 md:!px-[22px]">
          <div>
            <h2 className="!text-base !font-bold">Evolución de cierres</h2>
            <p>Valor total de los cierres agrupado por día</p>
          </div>
          <div className="!flex !flex-wrap !items-end !gap-2">
            <label className="!grid !gap-1 !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
              Desde
              <input
                className="crm-field !min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-[13px] !text-[var(--crm-text)]"
                max={dateTo || undefined}
                onChange={(event) => setDateFrom(event.target.value)}
                type="date"
                value={dateFrom}
              />
            </label>
            <label className="!grid !gap-1 !text-[11px] !font-semibold !text-[var(--crm-text-muted)]">
              Hasta
              <input
                className="crm-field !min-h-10 !rounded-[10px] !border-0 !bg-[var(--crm-input-bg)] !px-3 !text-[13px] !text-[var(--crm-text)]"
                min={dateFrom || undefined}
                onChange={(event) => setDateTo(event.target.value)}
                type="date"
                value={dateTo}
              />
            </label>
            <button
              aria-label="Actualizar informes X"
              className="crm-icon-button !inline-flex !size-10 !items-center !justify-center !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !text-[var(--crm-text-muted)]"
              disabled={disabled}
              onClick={() => void runAction(refresh)}
              type="button"
            >
              <RefreshCw className="!size-4" />
            </button>
          </div>
        </div>
        <div className="!px-[18px] !pt-3 !pb-2 md:!px-[22px]">
          <ClosingValuesChart values={dailyValues} />
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-2 !pb-[18px] sm:!grid-cols-2 md:!px-[22px] md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard
            color="blue"
            label="Cierres"
            value={filteredClosings.length}
          />
          <KpiCard
            color="green"
            label="Valor de cierres"
            value={formatMoney(totalSalesCents)}
          />
          <KpiCard
            color="neutral"
            label="Tickets incluidos"
            value={totalTickets}
          />
          <KpiCard
            color="neutral"
            label="Descuadre acumulado"
            value={formatMoney(totalDifferenceCents)}
          />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-list-toolbar !flex !items-center !justify-between !gap-3 !border-b !border-[var(--crm-border-subtle)] !bg-transparent !px-[18px] !py-5 !text-[var(--crm-text)] md:!px-[22px]">
          <div className="crm-list-title">
            <h2>Cierres de caja</h2>
            <p>
              {closings
                ? `${filteredClosings.length} resultados`
                : "Cargando cierres..."}
            </p>
          </div>
        </div>
        <div className="!overflow-x-auto">
          <table className="!w-full !min-w-[1050px] !border-collapse">
            <thead>
              <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
                <th className="!px-[22px] !py-3">Fecha</th>
                <th className="!px-3 !py-3">Caja / turno</th>
                <th className="!px-3 !py-3">Ventas</th>
                <th className="!px-3 !py-3">Efectivo</th>
                <th className="!px-3 !py-3">Tarjeta</th>
                <th className="!px-3 !py-3">Descuadre</th>
                <th className="!px-[22px] !py-3">Fondo inicial</th>
              </tr>
            </thead>
            <tbody>
              {filteredClosings.map((closing) => {
                const snapshot = closing.printSnapshot;
                const difference =
                  snapshot.differences.cashDifferenceCents +
                  snapshot.differences.cardDifferenceCents;
                return (
                  <tr
                    className="!border-b !border-[var(--crm-border-subtle)] last:!border-0"
                    key={closing.id}
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
                    <td className="!px-3 !py-4 !text-[13px]">
                      <span className="!block">
                        Esperado{" "}
                        {formatMoney(
                          snapshot.expectedAndCounted.expectedCashCents,
                        )}
                      </span>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        Contado{" "}
                        {formatMoney(
                          snapshot.expectedAndCounted.countedCashCents,
                        )}
                      </span>
                    </td>
                    <td className="!px-3 !py-4 !text-[13px]">
                      <span className="!block">
                        Esperado{" "}
                        {formatMoney(
                          snapshot.expectedAndCounted.expectedCardCents,
                        )}
                      </span>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        Contado{" "}
                        {formatMoney(
                          snapshot.expectedAndCounted.countedCardCents,
                        )}
                      </span>
                    </td>
                    <td
                      className={`!px-3 !py-4 !font-mono !text-[13px] !font-bold ${difference === 0 ? "!text-[var(--crm-green)]" : "!text-[var(--crm-red)]"}`}
                    >
                      {formatMoney(difference)}
                    </td>
                    <td className="!px-[22px] !py-4 !font-mono !text-[13px] !font-semibold">
                      {formatMoney(snapshot.cashFund.finalCashFundCents)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {closings && !filteredClosings.length ? (
            <div className="!grid !min-h-44 !place-items-center !px-6 !text-center !text-sm !font-semibold !text-[var(--crm-text-muted)]">
              No hay cierres de caja para el periodo seleccionado.
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
