import { CalendarDateTime } from "@internationalized/date";
import { Calendar, DateField, DatePicker, Label } from "@heroui/react";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UIEvent } from "react";
import { AppModal } from "../../../components/ui/AppModal";
import { Button as UiButton } from "../../../components/ui/Button";
import { NativeSelect as UiNativeSelect } from "../../../components/ui/NativeSelect";
import {
  AlertTriangle,
  Check,
  Clock3,
  Minus,
  Plus,
  ShieldAlert,
  X,
} from "lucide-react";
import {
  totalReservationTableCapacity,
  zonedLocalToUtc,
} from "../domain/reservationAvailability";
import type {
  Reservation,
  ReservationConflict,
  ReservationDraft,
  ReservationTable,
} from "../types";

type Props = {
  conflicts: ReservationConflict[];
  date: string;
  disabled: boolean;
  onClose: () => void;
  onSave: (draft: ReservationDraft, allowConflict: boolean) => Promise<boolean>;
  onTableIdsChange: (tableIds: string[]) => void;
  preselectedTableIds: string[];
  preselectedStartsAt?: string;
  reservation: Reservation | null;
  tables: ReservationTable[];
  timeZone: string;
};

type FieldErrors = Partial<
  Record<
    | "date"
    | "time"
    | "duration"
    | "partySize"
    | "customerName"
    | "customerPhone",
    string
  >
>;
type MobileFormSection = "service" | "client" | "tables";
const durationOptions = [60, 90, 120, 150, 180];
const hourOptions = Array.from({ length: 24 }, (_, index) => index);
const minuteOptions = Array.from({ length: 12 }, (_, index) => index * 5);
const infiniteCycleCount = 5;

function localParts(value: string, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA-u-ca-iso8601-nu-latn", {
      day: "2-digit",
      hour: "2-digit",
      hourCycle: "h23",
      minute: "2-digit",
      month: "2-digit",
      timeZone,
      year: "numeric",
    })
      .formatToParts(new Date(value))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
  };
}

function FieldError({ children }: { children?: string }) {
  return children ? (
    <small className="font-semibold text-[var(--danger)]" role="alert">
      {children}
    </small>
  ) : null;
}

function InfiniteTimeColumn({
  label,
  options,
  suffix,
  value,
  onChange,
}: {
  label: string;
  onChange: (value: number) => void;
  options: number[];
  suffix: string;
  value: number;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const centerSelected = () => {
      const selected = viewport.querySelector<HTMLElement>(
        `[data-cycle="2"][data-value="${value}"]`,
      );
      if (selected)
        viewport.scrollTop =
          selected.offsetTop -
          (viewport.clientHeight - selected.offsetHeight) / 2;
    };
    centerSelected();
    const observer = new ResizeObserver(centerSelected);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [options, value]);

  function preserveInfiniteLoop(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    const cycleHeight = viewport.scrollHeight / infiniteCycleCount;
    if (viewport.scrollTop < cycleHeight) viewport.scrollTop += cycleHeight * 2;
    else if (viewport.scrollTop > cycleHeight * 3)
      viewport.scrollTop -= cycleHeight * 2;
  }

  return (
    <div
      aria-label={label}
      className="min-h-0 overflow-y-auto overscroll-contain [overflow-anchor:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      onScroll={preserveInfiniteLoop}
      ref={viewportRef}
      role="listbox"
    >
      {Array.from({ length: infiniteCycleCount }, (_, cycle) =>
        options.map((option) => (
          <button
            aria-label={`${String(option).padStart(2, "0")} ${suffix}`}
            aria-selected={value === option}
            className={`mx-2 mb-1 grid min-h-11 w-[calc(100%-1rem)] snap-center place-items-center rounded-lg border text-base font-black transition ${value === option ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]" : "border-transparent bg-[var(--surface)] text-[var(--foreground)] hover:border-[var(--field-border)]"}`}
            data-cycle={cycle}
            data-value={option}
            key={`${cycle}:${option}`}
            onClick={() => onChange(option)}
            role="option"
            type="button"
          >
            {String(option).padStart(2, "0")}
          </button>
        )),
      )}
    </div>
  );
}

export function ReservationFormModal(props: Props) {
  const initialSchedule = props.reservation
    ? localParts(props.reservation.startsAt, props.timeZone)
    : props.preselectedStartsAt
      ? localParts(props.preselectedStartsAt, props.timeZone)
    : { date: props.date, time: "20:00" };
  const initialValues = useMemo(
    () => ({
      date: initialSchedule.date,
      time: initialSchedule.time,
      duration: props.reservation
        ? Math.round(
            (new Date(props.reservation.endsAt).getTime() -
              new Date(props.reservation.startsAt).getTime()) /
              60_000,
          )
        : 120,
      partySize: props.reservation?.partySize ?? 2,
      customerName: props.reservation?.customerName ?? "",
      customerPhone: props.reservation?.customerPhone ?? "",
      customerEmail: props.reservation?.customerEmail ?? "",
      notes: props.reservation?.notes ?? "",
      tableIds: props.preselectedTableIds,
    }),
    [
      initialSchedule.date,
      initialSchedule.time,
      props.preselectedTableIds,
      props.reservation,
    ],
  );
  const [date, setDate] = useState(initialValues.date);
  const [time, setTime] = useState(initialValues.time);
  const [duration, setDuration] = useState(initialValues.duration);
  const [partySize, setPartySize] = useState(initialValues.partySize);
  const [customerName, setCustomerName] = useState(initialValues.customerName);
  const [customerPhone, setCustomerPhone] = useState(
    initialValues.customerPhone,
  );
  const [customerEmail, setCustomerEmail] = useState(
    initialValues.customerEmail,
  );
  const [notes, setNotes] = useState(initialValues.notes);
  const [tableIds, setTableIds] = useState(initialValues.tableIds);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [dateTimeOpen, setDateTimeOpen] = useState(false);
  const [activeMobileSection, setActiveMobileSection] =
    useState<MobileFormSection>("service");
  const calendarPaneRef = useRef<HTMLDivElement>(null);
  const dateTimeLayoutRef = useRef<HTMLDivElement>(null);
  const formScrollRef = useRef<HTMLDivElement>(null);
  const serviceSectionRef = useRef<HTMLElement>(null);
  const clientSectionRef = useRef<HTMLElement>(null);
  const tablesSectionRef = useRef<HTMLElement>(null);
  const [pastConfirmation, setPastConfirmation] = useState(false);
  const [discardConfirmation, setDiscardConfirmation] = useState(false);
  const [conflictAcknowledged, setConflictAcknowledged] = useState(false);
  const [areaId, setAreaId] = useState("all");
  const lockedSchedule = props.reservation?.status === "seated";
  const selectedCapacity = totalReservationTableCapacity(
    props.tables,
    tableIds,
  );
  const conflictTableIds = useMemo(
    () => new Set(props.conflicts.map((conflict) => conflict.tableId)),
    [props.conflicts],
  );
  const activeConflicts = props.conflicts.filter((conflict) =>
    tableIds.includes(conflict.tableId),
  );
  const hasActiveConflicts = activeConflicts.length > 0;
  const areas = useMemo(
    () => [
      ...new Map(
        props.tables.map((table) => [table.areaId, table.areaName]),
      ).entries(),
    ],
    [props.tables],
  );
  const visibleTables =
    areaId === "all"
      ? props.tables
      : props.tables.filter((table) => table.areaId === areaId);
  const dirty =
    date !== initialValues.date ||
    time !== initialValues.time ||
    duration !== initialValues.duration ||
    partySize !== initialValues.partySize ||
    customerName !== initialValues.customerName ||
    customerPhone !== initialValues.customerPhone ||
    customerEmail !== initialValues.customerEmail ||
    notes !== initialValues.notes ||
    tableIds.join("|") !== initialValues.tableIds.join("|");
  const capacityInsufficient =
    tableIds.length > 0 && selectedCapacity < partySize;
  const [year, month, day] = date.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const visibleMinuteOptions = minuteOptions.includes(minute)
    ? minuteOptions
    : [...minuteOptions, minute].sort((a, b) => a - b);
  const dateTimeValue = new CalendarDateTime(year, month, day, hour, minute);
  const inputClass =
    "h-12 w-full rounded-xl border border-[var(--field-border)] bg-[var(--background)] px-3 text-base font-semibold text-[var(--foreground)] shadow-[inset_0_1px_2px_rgba(17,24,39,0.06)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:bg-[var(--surface-secondary)] disabled:text-[var(--muted)] md:bg-[var(--surface)]";

  useLayoutEffect(() => {
    const calendarPane = calendarPaneRef.current;
    const layout = dateTimeLayoutRef.current;
    if (!dateTimeOpen || !calendarPane || !layout) return;
    const syncHeight = () =>
      layout.style.setProperty(
        "--calendar-pane-height",
        `${calendarPane.getBoundingClientRect().height}px`,
      );
    syncHeight();
    const observer = new ResizeObserver(syncHeight);
    observer.observe(calendarPane);
    return () => observer.disconnect();
  }, [dateTimeOpen]);

  function requestClose() {
    if (dirty && !props.disabled) setDiscardConfirmation(true);
    else props.onClose();
  }

  function scrollToMobileSection(section: MobileFormSection) {
    const target =
      section === "service"
        ? serviceSectionRef.current
        : section === "client"
          ? clientSectionRef.current
          : tablesSectionRef.current;
    setActiveMobileSection(section);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function trackMobileSection() {
    const viewport = formScrollRef.current;
    if (!viewport) return;
    const viewportTop = viewport.getBoundingClientRect().top + 96;
    const sections: Array<[MobileFormSection, HTMLElement | null]> = [
      ["service", serviceSectionRef.current],
      ["client", clientSectionRef.current],
      ["tables", tablesSectionRef.current],
    ];
    let next: MobileFormSection = "service";
    for (const [section, element] of sections) {
      if (element && element.getBoundingClientRect().top <= viewportTop)
        next = section;
    }
    setActiveMobileSection((current) => (current === next ? current : next));
  }

  function validate() {
    const next: FieldErrors = {};
    if (!date) next.date = "Selecciona una fecha.";
    if (!time) next.time = "Selecciona una hora.";
    if (duration <= 0) next.duration = "Indica una duración válida.";
    if (partySize <= 0) next.partySize = "Debe haber al menos una persona.";
    if (!customerName.trim())
      next.customerName = "Escribe el nombre de la reserva.";
    if (!customerPhone.trim())
      next.customerPhone = "Escribe un teléfono de contacto.";
    setErrors(next);
    return Object.keys(next).length === 0;
  }

  async function submit(allowConflict: boolean) {
    if (!validate()) return;
    const startsAt = zonedLocalToUtc(date, time, props.timeZone);
    const endsAt = new Date(
      new Date(startsAt).getTime() + duration * 60_000,
    ).toISOString();
    if (
      !props.reservation &&
      new Date(startsAt).getTime() < Date.now() - 30 * 60_000 &&
      !pastConfirmation
    ) {
      setPastConfirmation(true);
      return;
    }
    if (allowConflict && !conflictAcknowledged) return;
    await props.onSave(
      {
        id: props.reservation?.id,
        customerName: customerName.trim(),
        customerPhone: customerPhone.trim(),
        customerEmail: customerEmail.trim() || null,
        partySize,
        startsAt,
        endsAt,
        notes: notes.trim() || null,
        tableIds,
        expectedUpdatedAt: props.reservation?.updatedAt,
      },
      allowConflict,
    );
  }

  return (
    <>
      <AppModal
        containerClassName="!items-end !p-0 md:!items-center md:!p-6"
        dialogClassName="!max-h-[calc(100dvh-3.5rem)] !rounded-b-none !rounded-t-2xl !border-x-0 !border-b-0 md:!max-h-[calc(100dvh-3rem)] md:!rounded-2xl md:!border"
        dismissDisabled={props.disabled}
        label={props.reservation ? "Editar reserva" : "Nueva reserva"}
        maxWidth={1200}
        onClose={requestClose}
        placement="bottom"
      >
        <section className="flex h-[calc(100dvh-3.5rem)] w-full flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)] md:h-[min(48.75rem,calc(100dvh-3rem))]">
          <div aria-hidden="true" className="flex h-5 shrink-0 items-center justify-center md:hidden">
            <span className="h-1 w-10 rounded-full bg-[var(--separator)]" />
          </div>
          <header className="flex shrink-0 items-start justify-between gap-3 border-b border-[var(--separator)] px-5 pb-4 md:p-6">
            <div>
              <h2 className="m-0 text-xl font-black md:text-2xl">
                {props.reservation ? "Editar reserva" : "Nueva reserva"}
              </h2>
              <p className="mb-0 mt-1 text-[11px] font-semibold text-[var(--muted)] md:text-xs">
                Horario del local · {props.timeZone}
              </p>
            </div>
            <UiButton
              aria-label="Cerrar formulario"
              className="grid size-10 shrink-0 place-items-center rounded-full border-0 bg-[var(--background)] text-[var(--muted)] md:size-11 md:rounded-xl md:border md:border-[var(--separator)] md:bg-[var(--surface)] md:text-[var(--foreground)]"
              onClick={requestClose}
              type="button"
            >
              <X size={18} />
            </UiButton>
          </header>

          <nav aria-label="Secciones de la reserva" className="flex shrink-0 items-center justify-between gap-2 border-b border-[var(--separator)] bg-[var(--surface)] px-5 py-3 md:hidden">
            {(["service", "client", "tables"] as const).map((section, index) => {
              const label = section === "service" ? "Servicio" : section === "client" ? "Cliente" : "Mesas";
              const active = activeMobileSection === section;
              return (
                <button aria-current={active ? "step" : undefined} className={`flex min-h-8 items-center gap-1.5 rounded-lg px-1.5 text-[11px] font-extrabold ${active ? "text-[var(--accent)]" : "text-[var(--muted)]"}`} key={section} onClick={() => scrollToMobileSection(section)} type="button">
                  <span className={`grid size-5 place-items-center rounded-full text-[10px] ${active ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--surface-secondary)] text-[var(--muted)]"}`}>{index + 1}</span>
                  {label}
                </button>
              );
            })}
          </nav>

          <div className="grid min-h-0 flex-1 grid-cols-1 overflow-y-auto overscroll-contain bg-[var(--background)] pb-32 [-webkit-overflow-scrolling:touch] md:pb-0 lg:grid-cols-5 lg:overflow-hidden lg:bg-transparent" onScroll={trackMobileSection} ref={formScrollRef}>
            <div className="overflow-visible overscroll-contain p-4 [-webkit-overflow-scrolling:touch] md:p-6 lg:col-span-3 lg:overflow-y-auto lg:border-r lg:border-[var(--separator)]">
              {lockedSchedule ? (
                <div className="mb-5 flex items-start gap-2 rounded-xl bg-[var(--accent-soft)] p-3 text-sm font-semibold">
                  <ShieldAlert className="mt-0.5 shrink-0" size={18} />
                  La reserva ya está sentada. Para proteger la comanda, no
                  pueden modificarse su horario ni sus mesas.
                </div>
              ) : null}
              {pastConfirmation ? (
                <div className="mb-5 rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] p-3 text-sm text-[var(--warning)]">
                  <strong className="flex items-center gap-2">
                    <AlertTriangle size={17} />
                    Reserva en el pasado
                  </strong>
                  <p className="mb-0 mt-1">
                    Se guardará para el {date} a las {time}. Confirma con el
                    botón inferior si es intencionado.
                  </p>
                </div>
              ) : null}

              <div className="grid gap-4 md:gap-7">
                <section className="grid scroll-mt-4 gap-4 rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[0_2px_8px_rgba(17,24,39,.04)] md:rounded-none md:border-0 md:p-0 md:shadow-none" ref={serviceSectionRef}>
                  <div>
                    <span className="text-[11px] font-black uppercase tracking-wider text-[var(--accent)]">
                      1 · Servicio
                    </span>
                    <h3 className="mb-0 mt-1 text-base font-black">
                      Cuándo y para cuántas personas
                    </h3>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <DatePicker
                      className="col-span-full grid gap-1.5"
                      granularity="minute"
                      hideTimeZone
                      hourCycle={24}
                      isOpen={dateTimeOpen}
                      isDisabled={lockedSchedule}
                      isInvalid={Boolean(errors.date || errors.time)}
                      onOpenChange={setDateTimeOpen}
                      onChange={(value) => {
                        if (!value) return;
                        setDate(
                          `${value.year}-${String(value.month).padStart(2, "0")}-${String(value.day).padStart(2, "0")}`,
                        );
                        setTime(
                          `${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`,
                        );
                        setErrors((current) => ({
                          ...current,
                          date: undefined,
                          time: undefined,
                        }));
                      }}
                      shouldCloseOnSelect={false}
                      value={dateTimeValue}
                    >
                      <Label className="text-[13px] font-extrabold">
                        Fecha y hora *
                      </Label>
                      <DateField.Group
                        className="min-h-12 cursor-pointer rounded-xl border border-[var(--field-border)] bg-[var(--background)] px-3 shadow-[inset_0_1px_2px_rgba(17,24,39,0.06)] focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] disabled:cursor-not-allowed md:bg-[var(--surface)]"
                        fullWidth
                        onClick={(event) => {
                          if (
                            !lockedSchedule &&
                            !(event.target as HTMLElement).closest("button")
                          )
                            setDateTimeOpen(true);
                        }}
                        variant="secondary"
                      >
                        <DateField.Input  className="min-w-0 flex-1 text-base font-semibold">
                          {(segment) => (
                            <DateField.Segment
                              className="rounded px-0.5 text-[var(--foreground)] data-[placeholder]:text-[var(--muted)]"
                              segment={segment}
                            />
                          )}
                        </DateField.Input>
                        <DateField.Suffix>
                          <DatePicker.Trigger
                            aria-label="Abrir calendario"
                            className="grid size-10 place-items-center rounded-lg text-[var(--muted)] hover:bg-[var(--surface-secondary)]"
                          >
                            <DatePicker.TriggerIndicator />
                          </DatePicker.Trigger>
                        </DateField.Suffix>
                      </DateField.Group>
                      <DatePicker.Popover className="w-[calc(100vw-1.5rem)] max-w-2xl rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-0 shadow-[var(--shadow)]">
                        <div
                          className="grid grid-cols-1 items-stretch sm:grid-cols-5"
                          ref={dateTimeLayoutRef}
                        >
                          <div className="p-4 sm:col-span-3 sm:p-5" ref={calendarPaneRef}>
                            <Calendar aria-label="Seleccionar fecha de la reserva">
                              <Calendar.Header>
                                <Calendar.NavButton slot="previous" />
                                <Calendar.Heading />
                                <Calendar.NavButton slot="next" />
                              </Calendar.Header>
                              <Calendar.Grid>
                                <Calendar.GridHeader>
                                  {(weekDay) => (
                                    <Calendar.HeaderCell>
                                      {weekDay}
                                    </Calendar.HeaderCell>
                                  )}
                                </Calendar.GridHeader>
                                <Calendar.GridBody>
                                  {(calendarDate) => (
                                    <Calendar.Cell date={calendarDate} />
                                  )}
                                </Calendar.GridBody>
                              </Calendar.Grid>
                            </Calendar>
                          </div>
                          <section
                            aria-label="Seleccionar hora de la reserva"
                            className="relative h-[var(--calendar-pane-height)] min-h-0 border-t border-[var(--separator)] bg-[var(--background)] sm:col-span-2 sm:h-auto sm:border-l sm:border-t-0"
                          >
                            <div className="absolute inset-0 flex min-h-0 flex-col">
                              <header className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--separator)] px-4 py-3">
                                <span className="flex items-center gap-2 text-sm font-black">
                                  <Clock3 size={17} />
                                  Hora
                                </span>
                                <strong className="rounded-lg bg-[var(--accent-soft)] px-2.5 py-1 text-base font-black text-[var(--accent)]">
                                  {time}
                                </strong>
                              </header>
                              <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-[var(--separator)]">
                                <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                                  <span className="block px-4 py-2 text-[10px] font-black uppercase tracking-wider text-[var(--muted)]">
                                    Hora
                                  </span>
                                  <InfiniteTimeColumn
                                    label="Horas"
                                    onChange={(option) => {
                                      setTime(
                                        `${String(option).padStart(2, "0")}:${String(minute).padStart(2, "0")}`,
                                      );
                                      setErrors((current) => ({
                                        ...current,
                                        time: undefined,
                                      }));
                                    }}
                                    options={hourOptions}
                                    suffix="horas"
                                    value={hour}
                                  />
                                </div>
                                <div className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)]">
                                  <span className="block px-4 py-2 text-[10px] font-black uppercase tracking-wider text-[var(--muted)]">
                                    Minuto
                                  </span>
                                  <InfiniteTimeColumn
                                    label="Minutos"
                                    onChange={(option) => {
                                      setTime(
                                        `${String(hour).padStart(2, "0")}:${String(option).padStart(2, "0")}`,
                                      );
                                      setErrors((current) => ({
                                        ...current,
                                        time: undefined,
                                      }));
                                    }}
                                    options={visibleMinuteOptions}
                                    suffix="minutos"
                                    value={minute}
                                  />
                                </div>
                              </div>
                              <div className="shrink-0 border-t border-[var(--separator)] p-3">
                                <button
                                  className="min-h-11 w-full rounded-xl bg-[var(--accent)] px-4 font-black text-[var(--accent-foreground)]"
                                  onClick={() => setDateTimeOpen(false)}
                                  type="button"
                                >
                                  Listo
                                </button>
                              </div>
                            </div>
                          </section>
                        </div>
                      </DatePicker.Popover>
                      <FieldError>{errors.date ?? errors.time}</FieldError>
                    </DatePicker>

                    <label className="grid gap-1.5 text-[13px] font-extrabold">
                      Duración *
                      <UiNativeSelect
                        className="w-full"
                        disabled={lockedSchedule}
                        onChange={(event) =>
                          setDuration(Number(event.target.value))
                        }
                        triggerClassName="!min-h-12 !rounded-xl !border !border-[var(--field-border)] !bg-[var(--background)] !px-3 !text-sm !font-semibold !shadow-[inset_0_1px_2px_rgba(17,24,39,0.06)] md:!bg-[var(--surface)] md:!text-base"
                        value={duration}
                      >
                        {durationOptions.map((minutes) => (
                          <option key={minutes} value={minutes}>
                            {minutes} min
                          </option>
                        ))}
                      </UiNativeSelect>
                      <FieldError>{errors.duration}</FieldError>
                    </label>
                    <div className="grid gap-1.5 text-[13px] font-extrabold">
                      <span>Personas *</span>
                      <div className="grid h-12 grid-cols-[3rem_minmax(3rem,1fr)_3rem] overflow-hidden rounded-xl border border-[var(--field-border)] bg-[var(--background)] shadow-[inset_0_1px_2px_rgba(17,24,39,0.06)] md:bg-[var(--surface)]">
                        <UiButton
                          aria-label="Quitar una persona"
                          className="grid min-h-12 place-items-center border-0 border-r border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--foreground)] disabled:opacity-40"
                          disabled={partySize <= 1}
                          onClick={() => {
                            setPartySize((current) => Math.max(1, current - 1));
                            setErrors((current) => ({
                              ...current,
                              partySize: undefined,
                            }));
                          }}
                          type="button"
                        >
                          <Minus size={20} />
                        </UiButton>
                        <output
                          aria-live="polite"
                          className="grid place-items-center text-lg font-black"
                        >
                          {partySize}
                        </output>
                        <UiButton
                          aria-label="Añadir una persona"
                          className="grid min-h-12 place-items-center border-0 border-l border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--foreground)]"
                          onClick={() => {
                            setPartySize((current) => current + 1);
                            setErrors((current) => ({
                              ...current,
                              partySize: undefined,
                            }));
                          }}
                          type="button"
                        >
                          <Plus size={20} />
                        </UiButton>
                      </div>
                      <FieldError>{errors.partySize}</FieldError>
                    </div>
                  </div>
                </section>

                <section className="grid scroll-mt-4 gap-4 rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[0_2px_8px_rgba(17,24,39,.04)] md:rounded-none md:border-x-0 md:border-b-0 md:p-0 md:pt-6 md:shadow-none" ref={clientSectionRef}>
                  <div>
                    <span className="text-[11px] font-black uppercase tracking-wider text-[var(--accent)]">
                      2 · Cliente
                    </span>
                    <h3 className="mb-0 mt-1 text-base font-black">
                      Datos de contacto y preferencias
                    </h3>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 [&_label]:grid [&_label]:gap-1.5 [&_label]:text-[13px] [&_label]:font-extrabold">
                    <label className="sm:col-span-full">
                      Nombre *
                      <input
                        autoFocus
                        className={inputClass}
                        onChange={(event) => {
                          setCustomerName(event.target.value);
                          setErrors((current) => ({
                            ...current,
                            customerName: undefined,
                          }));
                        }}
                        value={customerName}
                      />
                      <FieldError>{errors.customerName}</FieldError>
                    </label>
                    <label>
                      Teléfono *
                      <input
                        className={inputClass}
                        inputMode="tel"
                        onChange={(event) => {
                          setCustomerPhone(event.target.value);
                          setErrors((current) => ({
                            ...current,
                            customerPhone: undefined,
                          }));
                        }}
                        value={customerPhone}
                      />
                      <FieldError>{errors.customerPhone}</FieldError>
                    </label>
                    <label>
                      Email opcional
                      <input
                        className={inputClass}
                        inputMode="email"
                        onChange={(event) =>
                          setCustomerEmail(event.target.value)
                        }
                        type="email"
                        value={customerEmail}
                      />
                    </label>
                    <label className="sm:col-span-full">
                      Notas opcionales
                      <textarea
                        className="min-h-20 w-full resize-y rounded-xl border border-[var(--field-border)] bg-[var(--background)] p-3 text-base font-medium text-[var(--foreground)] shadow-[inset_0_1px_2px_rgba(17,24,39,0.06)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] md:min-h-24 md:bg-[var(--surface)]"
                        onChange={(event) => setNotes(event.target.value)}
                        rows={3}
                        value={notes}
                      />
                    </label>
                  </div>
                </section>
              </div>
            </div>

            <aside className="flex min-h-0 scroll-mt-4 flex-col border-t border-[var(--separator)] bg-[var(--background)] lg:col-span-2 lg:border-t-0" ref={tablesSectionRef}>
              <div className="m-4 overflow-visible rounded-2xl border border-[var(--separator)] bg-[var(--surface)] p-4 shadow-[0_2px_8px_rgba(17,24,39,.04)] [-webkit-overflow-scrolling:touch] md:m-0 md:rounded-none md:border-0 md:p-6 md:shadow-none lg:overflow-y-auto">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <span className="text-[11px] font-black uppercase tracking-wider text-[var(--accent)]">
                      3 · Mesas
                    </span>
                    <h3 className="mb-0 mt-1 text-base font-black">
                      Disponibilidad y capacidad
                    </h3>
                  </div>
                  <select
                    aria-label="Filtrar mesas por zona"
                    className="min-h-11 rounded-xl border border-[var(--field-border)] bg-[var(--surface)] px-3 text-sm font-extrabold shadow-sm"
                    onChange={(event) => setAreaId(event.target.value)}
                    value={areaId}
                  >
                    <option value="all">Todas las zonas</option>
                    {areas.map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div
                  className={`mt-4 rounded-xl border p-3 text-sm font-semibold ${capacityInsufficient ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] text-[var(--warning)]" : "border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)]"}`}
                >
                  <strong>
                    {tableIds.length
                      ? `${selectedCapacity} plazas para ${partySize} personas`
                      : "Sin mesa asignada"}
                  </strong>
                  <p className="mb-0 mt-1 text-xs font-medium opacity-80">
                    {capacityInsufficient
                      ? `Faltan ${partySize - selectedCapacity} plazas. Añade otra mesa antes de guardar.`
                      : tableIds.length
                        ? "La capacidad seleccionada es suficiente."
                        : "Puedes guardar la reserva y asignar mesa más tarde."}
                  </p>
                </div>
                {hasActiveConflicts ? (
                  <div
                    className="mt-3 rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] p-3 text-sm text-[var(--warning)]"
                    role="alert"
                  >
                    <strong className="flex items-center gap-2">
                      <ShieldAlert size={17} />
                      {activeConflicts.length}{" "}
                      {activeConflicts.length === 1
                        ? "conflicto detectado"
                        : "conflictos detectados"}
                    </strong>
                    <div className="mt-2 grid gap-1.5">
                      {activeConflicts.map((conflict) => (
                        <span
                          key={`${conflict.reservationId}:${conflict.tableId}`}
                        >
                          <b>{conflict.tableName}</b> · {conflict.customerName}{" "}
                          ·{" "}
                          {new Intl.DateTimeFormat("es", {
                            hour: "2-digit",
                            minute: "2-digit",
                          }).format(new Date(conflict.startsAt))}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
                <div className="mt-4 grid grid-cols-2 gap-2">
                  {visibleTables.map((table) => {
                    const selected = tableIds.includes(table.id);
                    const conflict = conflictTableIds.has(table.id);
                    const insufficient = table.capacity < partySize;
                    return (
                      <UiButton
                        aria-pressed={selected}
                        className={`grid min-h-[86px] gap-1 rounded-xl border-2 bg-[var(--surface)] p-3 text-left text-[var(--foreground)] disabled:opacity-45 ${selected ? "border-[var(--accent)] bg-[var(--accent-soft)] shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_10%,transparent)]" : conflict ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_8%,var(--surface))]" : "border-[var(--separator)]"}`}
                        disabled={lockedSchedule || !table.isActive}
                        key={table.id}
                        onClick={() =>
                          setTableIds((current) => {
                            const next = current.includes(table.id)
                              ? current.filter((id) => id !== table.id)
                              : [...current, table.id];
                            props.onTableIdsChange(next);
                            setConflictAcknowledged(false);
                            return next;
                          })
                        }
                        type="button"
                      >
                        <span className="flex items-center justify-between">
                          <strong>{table.name}</strong>
                          {selected ? (
                            <Check className="text-[var(--accent)]" size={17} />
                          ) : null}
                        </span>
                        <small className="text-[var(--muted)]">
                          {table.areaName} · {table.capacity} plazas
                        </small>
                        <em
                          className={`text-[10px] font-black uppercase not-italic ${conflict ? "text-[var(--warning)]" : insufficient ? "text-[var(--muted)]" : "text-[var(--success)]"}`}
                        >
                          {!table.isActive
                            ? "Inactiva"
                            : conflict
                              ? "Conflicto"
                              : insufficient
                                ? "Insuficiente sola"
                                : "Disponible"}
                        </em>
                      </UiButton>
                    );
                  })}
                </div>
              </div>
              <footer className="fixed inset-x-0 bottom-0 z-20 mt-auto border-t border-[var(--separator)] bg-[var(--surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-[0_-8px_20px_rgba(17,24,39,.05)] md:static md:shadow-none">
                <div className="mb-3 flex items-center justify-between gap-3 text-xs md:text-sm">
                  <span className="flex items-center gap-2 font-extrabold text-[var(--foreground)]">
                    <i aria-hidden="true" className="size-2 rounded-full bg-[var(--success)]" />
                    Resumen de reserva
                  </span>
                  <strong className="whitespace-nowrap text-[var(--accent)]">
                    {date} · {time} · {partySize} pax
                  </strong>
                </div>
                {hasActiveConflicts ? (
                  <label className="mb-3 flex items-start gap-2 text-xs font-semibold text-[var(--muted)]">
                    <input
                      checked={conflictAcknowledged}
                      className="mt-0.5 size-4"
                      onChange={(event) =>
                        setConflictAcknowledged(event.target.checked)
                      }
                      type="checkbox"
                    />
                    Entiendo que se solapará con otra reserva y quiero conservar
                    esta asignación.
                  </label>
                ) : null}
                <div className="grid grid-cols-[auto_minmax(0,1fr)] gap-2">
                  <UiButton
                    className="min-h-12 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] md:min-h-11"
                    onClick={requestClose}
                    type="button"
                  >
                    Cancelar
                  </UiButton>
                  <UiButton
                    className={`min-h-12 rounded-xl border px-4 font-extrabold md:min-h-11 ${hasActiveConflicts ? "border-[var(--warning)] bg-[var(--surface)] text-[var(--warning)]" : "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"}`}
                    disabled={
                      props.disabled ||
                      (hasActiveConflicts && !conflictAcknowledged)
                    }
                    onClick={() => void submit(hasActiveConflicts)}
                    type="button"
                  >
                    {hasActiveConflicts
                      ? "Guardar igualmente"
                      : pastConfirmation
                        ? "Confirmar fecha y guardar"
                        : "Guardar reserva"}
                  </UiButton>
                </div>
              </footer>
            </aside>
          </div>
        </section>
      </AppModal>

      {discardConfirmation ? (
        <AppModal
          containerClassName="!p-4"
          label="Descartar cambios"
          maxWidth={420}
          onClose={() => setDiscardConfirmation(false)}
        >
          <section className="w-full rounded-2xl bg-[var(--surface)] p-6 text-[var(--foreground)]">
            <h2 className="m-0 text-xl font-black">¿Descartar los cambios?</h2>
            <p className="mb-6 mt-2 text-sm leading-6 text-[var(--muted)]">
              Los datos modificados de esta reserva se perderán.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <UiButton
                className="min-h-11 rounded-xl border border-[var(--separator)] bg-[var(--surface)] font-extrabold"
                onClick={() => setDiscardConfirmation(false)}
                type="button"
              >
                Seguir editando
              </UiButton>
              <UiButton
                className="min-h-11 rounded-xl border border-[var(--danger)] bg-[var(--danger)] font-extrabold text-white"
                onClick={props.onClose}
                type="button"
              >
                Descartar
              </UiButton>
            </div>
          </section>
        </AppModal>
      ) : null}
    </>
  );
}
