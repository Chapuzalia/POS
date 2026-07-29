import { NativeSelect as UiNativeSelect } from "../../../components/ui/NativeSelect";
import { TextArea as UiTextArea } from "../../../components/ui/TextArea";
import { Input as UiInput } from "../../../components/ui/Input";
import { Button as UiButton } from "../../../components/ui/Button";
import { AppModal } from "../../../components/ui/AppModal";
import { AlertTriangle, Check, X } from "lucide-react";
import { useMemo, useState } from "react";
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
  reservation: Reservation | null;
  tables: ReservationTable[];
  timeZone: string;
};

const durationOptions = [60, 90, 120, 150, 180];

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

export function ReservationFormModal(props: Props) {
  const initial = props.reservation
    ? localParts(props.reservation.startsAt, props.timeZone)
    : { date: props.date, time: "20:00" };
  const initialDuration = props.reservation
    ? Math.round(
        (new Date(props.reservation.endsAt).getTime() -
          new Date(props.reservation.startsAt).getTime()) /
          60_000,
      )
    : 120;
  const [date, setDate] = useState(initial.date);
  const [time, setTime] = useState(initial.time);
  const [duration, setDuration] = useState(initialDuration);
  const [partySize, setPartySize] = useState(props.reservation?.partySize ?? 2);
  const [customerName, setCustomerName] = useState(
    props.reservation?.customerName ?? "",
  );
  const [customerPhone, setCustomerPhone] = useState(
    props.reservation?.customerPhone ?? "",
  );
  const [customerEmail, setCustomerEmail] = useState(
    props.reservation?.customerEmail ?? "",
  );
  const [notes, setNotes] = useState(props.reservation?.notes ?? "");
  const [tableIds, setTableIds] = useState(props.preselectedTableIds);
  const [validation, setValidation] = useState<string | null>(null);
  const [allowPast, setAllowPast] = useState(false);
  const lockedSchedule = props.reservation?.status === "seated";
  const selectedCapacity = totalReservationTableCapacity(
    props.tables,
    tableIds,
  );
  const conflictTableIds = useMemo(
    () => new Set(props.conflicts.map((conflict) => conflict.tableId)),
    [props.conflicts],
  );

  async function submit(allowConflict: boolean) {
    if (
      !date ||
      !time ||
      duration <= 0 ||
      partySize <= 0 ||
      !customerName.trim() ||
      !customerPhone.trim()
    ) {
      setValidation("Completa los campos obligatorios con valores válidos.");
      return;
    }
    const startsAt = zonedLocalToUtc(date, time, props.timeZone);
    const endsAt = new Date(
      new Date(startsAt).getTime() + duration * 60_000,
    ).toISOString();
    if (new Date(endsAt) <= new Date(startsAt)) {
      setValidation("La hora final debe ser posterior a la hora inicial.");
      return;
    }
    if (
      new Date(startsAt).getTime() < Date.now() - 30 * 60_000 &&
      !props.reservation &&
      !allowPast
    ) {
      setAllowPast(true);
      setValidation(
        "La reserva está claramente en el pasado. Pulsa Guardar reserva de nuevo para continuar.",
      );
      return;
    }
    setValidation(null);
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
    <AppModal
      containerClassName="!p-0 sm:!p-4"
      maxWidth={1200}
      dismissDisabled={props.disabled}
      label={props.reservation ? "Editar reserva" : "Nueva reserva"}
      onClose={props.onClose}
      placement="bottom"
    >
      <section className="flex h-full w-[min(1200px,100%)] flex-col overflow-hidden bg-[var(--surface)] text-[var(--foreground)] shadow-[var(--shadow)] [&_svg]:size-[18px] [&>header]:flex [&>header]:items-start [&>header]:justify-between [&>header]:gap-3 [&>header]:border-b [&>header]:border-[var(--separator)] [&>header]:p-[18px] [&_h2]:mt-[7px] [&_h2]:mb-0 [&_h2]:text-[22px] [&>header_p]:mt-[5px] [&>header_p]:mb-0 [&>header_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-1.5 [&_label]:text-[13px] [&_label]:font-extrabold [&_label]:text-[var(--foreground)] [&>footer]:flex [&>footer]:justify-end [&>footer]:gap-2.5 [&>footer]:border-t [&>footer]:border-[var(--separator)] [&>footer]:p-4 max-[760px]:[&>footer]:grid max-[760px]:[&>footer]:grid-cols-2">
        <header>
          <div>
            <h2 id="reservation-form-title">
              {props.reservation ? "Editar reserva" : "Nueva reserva"}
            </h2>
            <p>Los horarios se guardan en la zona horaria del local.</p>
          </div>
          <UiButton
            aria-label="Cerrar formulario"
            className="grid size-11 shrink-0 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] [&_svg]:size-[18px]"
            onClick={props.onClose}
            type="button"
          >
            <X />
          </UiButton>
        </header>
        <div className="grid gap-4 overflow-auto p-[18px]">
          {lockedSchedule ? (
            <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--accent-soft)] px-3 py-[11px] text-[13px] font-semibold">
              La reserva ya está sentada. Su horario y sus mesas no pueden
              modificarse.
            </div>
          ) : null}
          {validation ? (
            <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[var(--danger-soft)] px-3 py-[11px] text-[13px] font-semibold text-[var(--danger)]">
              <AlertTriangle /> {validation}
            </div>
          ) : null}
          {props.conflicts.length ? (
            <div className="flex flex-col items-start gap-2 rounded-[var(--radius)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3 py-[11px] text-[13px] font-semibold text-[var(--warning)]">
              <strong>
                Conflicto con {props.conflicts.length}{" "}
                {props.conflicts.length === 1 ? "reserva" : "reservas"}
              </strong>
              {props.conflicts.map((conflict) => (
                <span key={`${conflict.reservationId}:${conflict.tableId}`}>
                  {conflict.tableName} · {conflict.customerName} ·{" "}
                  {new Intl.DateTimeFormat("es", {
                    hour: "2-digit",
                    minute: "2-digit",
                  }).format(new Date(conflict.startsAt))}
                </span>
              ))}
            </div>
          ) : null}
          <div className="grid grid-cols-2 gap-3.5 max-[760px]:grid-cols-1">
            <label>
              Fecha *
              <UiInput
                disabled={lockedSchedule}
                onChange={(event) => setDate(event.target.value)}
                required
                type="date"
                value={date}
              />
            </label>
            <label>
              Hora *
              <UiInput
                disabled={lockedSchedule}
                onChange={(event) => setTime(event.target.value)}
                required
                type="time"
                value={time}
              />
            </label>
            <label>
              Duración *
              <UiNativeSelect
                disabled={lockedSchedule}
                onChange={(event) => setDuration(Number(event.target.value))}
                value={duration}
              >
                {durationOptions.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes} min
                  </option>
                ))}
              </UiNativeSelect>
            </label>
            <label>
              Personas *
              <UiInput
                min="1"
                onChange={(event) =>
                  setPartySize(Math.max(1, Number(event.target.value)))
                }
                required
                type="number"
                value={partySize}
              />
            </label>
            <label className="col-span-full max-[760px]:col-span-1">
              Nombre *
              <UiInput
                autoFocus
                required
                onChange={(event) => setCustomerName(event.target.value)}
                value={customerName}
              />
            </label>
            <label>
              Teléfono *
              <UiInput
                inputMode="tel"
                required
                onChange={(event) => setCustomerPhone(event.target.value)}
                value={customerPhone}
              />
            </label>
            <label>
              Email opcional
              <UiInput
                inputMode="email"
                onChange={(event) => setCustomerEmail(event.target.value)}
                type="email"
                value={customerEmail}
              />
            </label>
            <label className="col-span-full max-[760px]:col-span-1">
              Notas opcionales
              <UiTextArea
                onChange={(event) => setNotes(event.target.value)}
                rows={3}
                value={notes}
              />
            </label>
          </div>
          <section className="grid gap-3 border-t border-[var(--separator)] pt-4 [&>div:first-child]:flex [&>div:first-child]:items-center [&>div:first-child]:justify-between [&>div:first-child]:gap-3 [&_h3]:m-0 [&_h3]:text-[13px] [&_h3]:uppercase [&>div:first-child_span]:text-xs [&>div:first-child_span]:text-[var(--muted)]">
            <div>
              <h3>Mesas opcionales</h3>
              <span>
                {tableIds.length
                  ? `${selectedCapacity} plazas seleccionadas`
                  : "La reserva puede guardarse sin mesa"}
              </span>
            </div>
            {tableIds.length && selectedCapacity < partySize ? (
              <div className="flex items-center gap-2 rounded-[var(--radius)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3 py-[11px] text-[13px] font-semibold text-[var(--warning)]">
                <AlertTriangle /> La capacidad seleccionada es inferior al
                número de personas.
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2 max-[760px]:grid-cols-1 [&_button]:grid [&_button]:min-h-[78px] [&_button]:gap-1 [&_button]:rounded-[var(--radius)] [&_button]:border [&_button]:border-[var(--separator)] [&_button]:bg-[var(--surface-secondary)] [&_button]:p-2.5 [&_button]:text-left [&_button]:text-[var(--foreground)] [&_button:disabled]:opacity-50 [&_button_span]:flex [&_button_span]:items-center [&_button_span]:gap-1.5 [&_button_small]:text-[var(--muted)] [&_button_em]:text-[10px] [&_button_em]:font-extrabold [&_button_em]:not-italic [&_button_em]:uppercase [&_button_em]:text-[var(--muted)]">
              {props.tables.map((table) => {
                const selected = tableIds.includes(table.id);
                const conflict = conflictTableIds.has(table.id);
                return (
                  <UiButton
                    className={`${selected ? "!border-[var(--accent)] !shadow-[inset_0_0_0_1px_var(--accent)]" : ""}${conflict ? " !border-[var(--warning)]" : ""}`}
                    disabled={lockedSchedule || !table.isActive}
                    key={table.id}
                    onClick={() =>
                      setTableIds((current) => {
                        const next = current.includes(table.id)
                          ? current.filter((id) => id !== table.id)
                          : [...current, table.id];
                        props.onTableIdsChange(next);
                        return next;
                      })
                    }
                    type="button"
                  >
                    <span>
                      {selected ? <Check /> : null}
                      <strong>{table.name}</strong>
                    </span>
                    <small>
                      {table.areaName} · {table.capacity} plazas
                    </small>
                    <em>
                      {!table.isActive
                        ? "Desactivada"
                        : conflict
                          ? "Conflicto"
                          : table.capacity < partySize
                            ? "Capacidad insuficiente"
                            : "Disponible"}
                    </em>
                  </UiButton>
                );
              })}
            </div>
          </section>
        </div>
        <footer>
          <UiButton
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline bg-[var(--surface)] text-[var(--foreground)]"
            onClick={props.onClose}
            type="button"
          >
            Cancelar
          </UiButton>
          {props.conflicts.length ? (
            <UiButton
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
              disabled={props.disabled}
              onClick={() => void submit(true)}
              type="button"
            >
              Guardar igualmente
            </UiButton>
          ) : (
            <UiButton
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] px-4 font-extrabold no-underline border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]"
              disabled={props.disabled}
              onClick={() => void submit(false)}
              type="button"
            >
              Guardar reserva
            </UiButton>
          )}
        </footer>
      </section>
    </AppModal>
  );
}
