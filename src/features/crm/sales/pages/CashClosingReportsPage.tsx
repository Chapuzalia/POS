import { ClosingValuesChart } from '../components/ClosingValuesChart';
import { DataTable as UiDataTable, type DataTableSortDescriptor } from '../../../../components/ui/DataTable'
import { CRM_PAGE_SIZE, CrmPagination } from '../../shared/components/CrmPagination'
import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { CrmModal } from '../../shared/components/CrmModal'
import { Pencil, RefreshCw, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { sileo } from "sileo";
import {
  updateCashClosingCounts,
} from "../../../cash-registers/service";
import { getCashClosingAmounts } from "../../../cash-registers/services/cashClosingAmounts";
import { centsToInput, formatMoney } from "../../../../lib/format";
import type { CashClosingRecord, TenantContext } from "../../../../types";
import type { RunAction } from "../../shared/types";
import {
  buildCashClosingDailyValues,
  getDefaultClosingDateRange,
  sortCashClosings,
  filterCashClosingsByDate,
  getCashClosingDay,
  projectCashClosingCounts,
  isImportedCashClosing,
  type CashClosingReportRecord,
} from "../services/cashClosingReportModel";
import type { OperationalDayConfig } from "../../../../lib/operationalDay";
import { loadCashClosingReports } from '../services/revoCashClosingService';
import { ImportedClosingDetail } from '../components/ImportedClosingDetail';
import { formatRevoDate, type ImportedCashClosing } from '../../../../lib/revoCashClosings.ts';

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
const operationalDateFormatter = new Intl.DateTimeFormat("es-ES", {
  dateStyle: "medium",
  timeZone: "UTC",
});

function formatOperationalDate(date: string) {
  return operationalDateFormatter.format(new Date(`${date}T12:00:00Z`));
}

function renderClosingDate(
  closing: CashClosingReportRecord,
  operationalDayConfig: OperationalDayConfig,
) {
  const actualDate = isImportedCashClosing(closing)
    ? formatRevoDate(closing.date)
    : dateFormatter.format(new Date(closing.closedAt));

  return (
    <>
      <span className="!block">{formatOperationalDate(getCashClosingDay(closing, operationalDayConfig))}</span>
      <span className="!mt-0.5 !block !text-xs !font-normal !text-[var(--crm-text-muted)]">({actualDate})</span>
    </>
  );
}

// DataTable reads literal <tr>/<td> elements from its children before rendering.
function renderImportedClosingRow(
  closing: ImportedCashClosing,
  onSelect: () => void,
  operationalDayConfig: OperationalDayConfig,
) {
  return <tr key={closing.id} aria-label={`Ver cierre REVO del ${formatRevoDate(closing.date)}`} className="!cursor-pointer !border-b !border-[var(--crm-border-subtle)] hover:!bg-[var(--crm-surface-soft)] focus-visible:!bg-[var(--crm-surface-soft)]"
    onClick={onSelect} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect() } }} role="button" tabIndex={0}>
    <td className="!px-[22px] !py-4 !text-[13px] !font-semibold" data-sort-value={Date.parse(`${closing.date}T12:00:00Z`)}>{renderClosingDate(closing, operationalDayConfig)}</td>
    <td className="!px-3 !py-4 !text-[13px]"><strong className="!block">REVO</strong><span className="!text-xs !text-[var(--crm-text-muted)]">Histórico importado · resumen diario</span></td>
    <td className="!px-3 !py-4 !font-mono !text-[13px]" data-sort-value={closing.cashCents + closing.cardCents}>{formatMoney(closing.cashCents + closing.cardCents)}</td>
    <td className="!px-3 !py-4 !font-mono !text-[13px]" data-sort-value={closing.cashCents}>{formatMoney(closing.cashCents)}</td>
    <td className="!px-3 !py-4 !font-mono !text-[13px]" data-sort-value={closing.cardCents}>{formatMoney(closing.cardCents)}</td>
    <td className="!px-3 !py-4 !text-xs !text-[var(--crm-text-muted)]">No disponible</td>
    <td className="!px-[22px] !py-4 !text-xs !text-[var(--crm-text-muted)]">No disponible</td>
  </tr>
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
  const [closings, setClosings] = useState<CashClosingReportRecord[] | null>(null);
  const [selectedClosing, setSelectedClosing] =
    useState<CashClosingReportRecord | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [sortDescriptor, setSortDescriptor] = useState<DataTableSortDescriptor>({ column: 'column-0', direction: 'descending' });
  const requestId = useRef(0);
  const operationalDayConfig = useMemo<OperationalDayConfig>(
    () => ({ dayChangeTime, timeZone }),
    [dayChangeTime, timeZone],
  );
  const [initialDateRange] = useState(() => getDefaultClosingDateRange(timeZone));
  const [dateFrom, setDateFrom] = useState(initialDateRange.dateFrom);
  const [dateTo, setDateTo] = useState(initialDateRange.dateTo);
  useEffect(() => {
    const range = getDefaultClosingDateRange(timeZone);
    setDateFrom(range.dateFrom);
    setDateTo(range.dateTo);
  }, [selectedVenueId, timeZone]);
  const refresh = useCallback(async () => {
    const currentRequest = ++requestId.current;
    if (!selectedVenueId) {
      setClosings([]);
      return;
    }
    const next = await loadCashClosingReports(
        { ...tenantContext, venueId: selectedVenueId },
        operationalDayConfig,
    );
    if (currentRequest === requestId.current) setClosings(next);
  }, [selectedVenueId, tenantContext, operationalDayConfig]);

  useEffect(() => {
    setClosings(null);
    setSelectedClosing(null);
    void runAction(refresh);
    return () => { requestId.current += 1; };
  }, [refresh, runAction]);
  const filteredClosings = useMemo(
    () => filterCashClosingsByDate(closings ?? [], dateFrom, dateTo, operationalDayConfig),
    [closings, dateFrom, dateTo, operationalDayConfig],
  );
  useEffect(() => {
    setCurrentPage(1);
  }, [dateFrom, dateTo, selectedVenueId, timeZone, dayChangeTime]);
  const sortedClosings = useMemo(
    () => sortCashClosings(filteredClosings, sortDescriptor.column, sortDescriptor.direction),
    [filteredClosings, sortDescriptor],
  );
  const totalPages = Math.max(1, Math.ceil(sortedClosings.length / CRM_PAGE_SIZE));
  const visiblePage = Math.min(currentPage, totalPages);
  const pageStart = (visiblePage - 1) * CRM_PAGE_SIZE;
  const visibleClosings = sortedClosings.slice(pageStart, pageStart + CRM_PAGE_SIZE);
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
            <p>Importes de los cierres por periodo, según el día operativo</p>
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
              aria-label="Actualizar informes Z"
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
          <UiDataTable aria-label="Cierres de caja" className="!w-full !min-w-[1050px] !border-collapse" emptyContent={closings ? 'No hay cierres de caja para el período seleccionado.' : 'Cargando cierres…'} filterable={false}
            sortDescriptor={sortDescriptor} onSortChange={(descriptor) => { setSortDescriptor(descriptor); setCurrentPage(1); }}>
            <thead>
              <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-[10px] !font-semibold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">
                <th className="!px-[22px] !py-3" data-row-header="true">Fecha</th>
                <th className="!px-3 !py-3">Caja / turno</th>
                <th className="!px-3 !py-3">Ventas</th>
                <th className="!px-3 !py-3">Efectivo</th>
                <th className="!px-3 !py-3">Tarjeta</th>
                <th className="!px-3 !py-3">Descuadre</th>
                <th className="!px-[22px] !py-3">Fondos</th>
              </tr>
            </thead>
            <tbody>
              {visibleClosings.map((closing) => {
                if (isImportedCashClosing(closing)) return renderImportedClosingRow(closing, () => setSelectedClosing(closing), operationalDayConfig);
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
                    <td className="!whitespace-nowrap !px-[22px] !py-4 !text-[13px] !font-semibold" data-sort-value={new Date(closing.closedAt).getTime()}>
                      {renderClosingDate(closing, operationalDayConfig)}
                    </td>
                    <td className="!px-3 !py-4">
                      <strong className="!block !text-[13px]">
                        {snapshot.registerName}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        {snapshot.shiftLabel}
                      </span>
                    </td>
                    <td className="!px-3 !py-4" data-sort-value={snapshot.summary.totalSalesCents}>
                      <strong className="!block !font-mono !text-[13px]">
                        {formatMoney(snapshot.summary.totalSalesCents)}
                      </strong>
                      <span className="!text-xs !text-[var(--crm-text-muted)]">
                        {snapshot.summary.salesCount} tickets
                      </span>
                    </td>
                    <td className="!px-3 !py-4" data-sort-value={amounts.billedCashCents}>
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
                    <td className="!px-3 !py-4" data-sort-value={amounts.billedCardCents}>
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
                      data-sort-value={difference}
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
        </div>
        <CrmPagination currentPage={visiblePage} onPageChange={setCurrentPage} totalResults={filteredClosings.length} />
      </section>
      {selectedClosing && isImportedCashClosing(selectedClosing) ? <ImportedClosingDetail closing={selectedClosing} onClose={() => setSelectedClosing(null)} /> : selectedClosing ? (
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
