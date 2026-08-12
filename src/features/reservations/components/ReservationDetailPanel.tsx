import { useEffect, useState } from "react";
import { AppModal } from "../../../components/ui/AppModal";
import { Button as UiButton } from "../../../components/ui/Button";
import { Input as UiInput } from "../../../components/ui/Input";
import {
  CalendarDays,
  Clock3,
  Edit3,
  Mail,
  Phone,
  UserCheck,
  Users,
  Utensils,
  X,
} from "lucide-react";
import {
  getAllowedReservationActions,
  getReservationStatusLabel,
  reservationTimingLabel,
} from "../domain/reservationStatus";
import type { Reservation, ReservationStatus } from "../types";

type Props = {
  canManage: boolean;
  disabled: boolean;
  onClose: () => void;
  onEdit: () => void;
  onOpenOrder: (orderId: string) => void;
  onSeat: () => void;
  onStatus: (status: ReservationStatus, reason?: string) => void;
  reservation: Reservation;
};

function statusClass(status: ReservationStatus) {
  if (status === "arrived" || status === "seated")
    return "bg-[var(--success-soft)] text-[var(--success)]";
  if (status === "cancelled" || status === "no_show")
    return "bg-[var(--danger-soft)] text-[var(--danger)]";
  if (status === "completed")
    return "bg-[var(--surface-secondary)] text-[var(--muted)]";
  return "bg-[var(--accent-soft)] text-[var(--accent)]";
}

export function ReservationDetailPanel(props: Props) {
  const { reservation } = props;
  const actions = getAllowedReservationActions(reservation);
  const [confirmation, setConfirmation] = useState<
    "cancelled" | "no_show" | null
  >(null);
  const [reason, setReason] = useState("");
  const duration = Math.round(
    (new Date(reservation.endsAt).getTime() -
      new Date(reservation.startsAt).getTime()) /
      60_000,
  );
  const date = new Intl.DateTimeFormat("es", { dateStyle: "full" }).format(
    new Date(reservation.startsAt),
  );
  const time = new Intl.DateTimeFormat("es", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(reservation.startsAt));
  const timing = reservationTimingLabel(reservation);
  const needsTable = actions.seat && reservation.tableIds.length === 0;

  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirmation) setConfirmation(null);
      else props.onClose();
    };
    document.addEventListener("keydown", close);
    return () => document.removeEventListener("keydown", close);
  }, [confirmation, props]);

  return (
    <>
      <div className="contents max-[1000px]:fixed max-[1000px]:inset-0 max-[1000px]:z-40 max-[1000px]:flex max-[1000px]:justify-end">
        <button
          aria-label="Cerrar detalle"
          className="absolute inset-0 hidden border-0 bg-black/40 max-[1000px]:block"
          onClick={props.onClose}
          type="button"
        />
        <aside
          aria-label={`Reserva de ${reservation.customerName}`}
          className="relative z-[1] flex w-[min(390px,36vw)] min-w-[350px] flex-col overflow-hidden rounded-2xl border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)] max-[1000px]:h-full max-[1000px]:w-[min(440px,100%)] max-[1000px]:min-w-0 max-[1000px]:rounded-none max-[760px]:w-full"
        >
          <header className="flex items-start justify-between gap-3 border-b border-[var(--separator)] p-5">
            <div className="min-w-0">
              <span
                className={`inline-flex w-fit items-center rounded-full px-2.5 py-1 text-[11px] font-extrabold ${statusClass(reservation.status)}`}
              >
                {getReservationStatusLabel(reservation.status)}
              </span>
              <h2 className="mb-0 mt-2 truncate text-[22px] font-black">
                {reservation.customerName}
              </h2>
              {timing &&
              ["confirmed", "arrived"].includes(reservation.status) ? (
                <p className="mb-0 mt-1 text-xs font-extrabold text-[var(--warning)]">
                  {timing}
                </p>
              ) : null}
            </div>
            <UiButton
              aria-label="Cerrar detalle"
              className="grid size-11 shrink-0 place-items-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)]"
              onClick={props.onClose}
              type="button"
            >
              <X size={18} />
            </UiButton>
          </header>

          <div className="grid content-start gap-5 overflow-y-auto overscroll-contain p-5 [-webkit-overflow-scrolling:touch]">
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-[var(--surface-secondary)] p-3">
              <div>
                <span className="block text-[10px] font-black uppercase text-[var(--muted)]">
                  Personas
                </span>
                <strong className="mt-1 flex items-center gap-1.5 text-lg">
                  <Users size={17} className="text-[var(--accent)]" />
                  {reservation.partySize}
                </strong>
              </div>
              <div>
                <span className="block text-[10px] font-black uppercase text-[var(--muted)]">
                  Duración
                </span>
                <strong className="mt-1 flex items-center gap-1.5 text-lg">
                  <Clock3 size={17} className="text-[var(--accent)]" />
                  {duration} min
                </strong>
              </div>
            </div>

            <dl className="m-0 grid gap-3">
              <div className="grid grid-cols-[94px_minmax(0,1fr)] gap-3">
                <dt className="flex items-center gap-2 font-semibold text-[var(--muted)]">
                  <CalendarDays size={17} />
                  Fecha
                </dt>
                <dd className="m-0 font-extrabold capitalize">{date}</dd>
              </div>
              <div className="grid grid-cols-[94px_minmax(0,1fr)] gap-3">
                <dt className="flex items-center gap-2 font-semibold text-[var(--muted)]">
                  <Clock3 size={17} />
                  Hora
                </dt>
                <dd className="m-0 font-extrabold">{time}</dd>
              </div>
              <div className="grid grid-cols-[94px_minmax(0,1fr)] gap-3">
                <dt className="flex items-center gap-2 font-semibold text-[var(--muted)]">
                  <Utensils size={17} />
                  Mesas
                </dt>
                <dd
                  className={`m-0 font-extrabold ${needsTable ? "text-[var(--warning)]" : ""}`}
                >
                  {reservation.tables.length
                    ? reservation.tables
                        .map((table) => `${table.name} · ${table.areaName}`)
                        .join(", ")
                    : "Sin mesa asignada"}
                </dd>
              </div>
            </dl>

            <section className="grid gap-2 border-t border-[var(--separator)] pt-4">
              <h3 className="m-0 text-[11px] font-black uppercase tracking-wider text-[var(--muted)]">
                Contacto
              </h3>
              <a
                className="flex min-h-10 items-center gap-2 font-extrabold text-[var(--foreground)] no-underline"
                href={`tel:${reservation.customerPhone}`}
              >
                <Phone size={17} />
                {reservation.customerPhone}
              </a>
              {reservation.customerEmail ? (
                <a
                  className="flex min-h-10 items-center gap-2 truncate font-extrabold text-[var(--foreground)] no-underline"
                  href={`mailto:${reservation.customerEmail}`}
                >
                  <Mail size={17} />
                  {reservation.customerEmail}
                </a>
              ) : null}
            </section>
            {reservation.notes ? (
              <section className="grid gap-2 border-t border-[var(--separator)] pt-4">
                <h3 className="m-0 text-[11px] font-black uppercase tracking-wider text-[var(--muted)]">
                  Notas
                </h3>
                <p className="m-0 rounded-xl bg-[var(--accent-soft)]/50 p-3 leading-6 text-[var(--foreground)]">
                  {reservation.notes}
                </p>
              </section>
            ) : null}
            {reservation.cancellationReason ? (
              <section className="grid gap-2 border-t border-[var(--separator)] pt-4">
                <h3 className="m-0 text-[11px] font-black uppercase tracking-wider text-[var(--muted)]">
                  Motivo de cancelación
                </h3>
                <p className="m-0 text-[var(--muted)]">
                  {reservation.cancellationReason}
                </p>
              </section>
            ) : null}
            {reservation.arrivedAt || reservation.seatedAt ? (
              <section className="grid gap-2 border-t border-[var(--separator)] pt-4">
                <h3 className="m-0 text-[11px] font-black uppercase tracking-wider text-[var(--muted)]">
                  Seguimiento
                </h3>
                {reservation.arrivedAt ? (
                  <p className="m-0 text-sm text-[var(--muted)]">
                    Llegada:{" "}
                    {new Intl.DateTimeFormat("es", {
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(reservation.arrivedAt))}
                  </p>
                ) : null}
                {reservation.seatedAt ? (
                  <p className="m-0 text-sm text-[var(--muted)]">
                    Sentada:{" "}
                    {new Intl.DateTimeFormat("es", {
                      hour: "2-digit",
                      minute: "2-digit",
                    }).format(new Date(reservation.seatedAt))}
                  </p>
                ) : null}
              </section>
            ) : null}
          </div>

          <footer className="mt-auto grid gap-2.5 border-t border-[var(--separator)] bg-[var(--surface)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
            {actions.seat && props.canManage ? (
              <UiButton
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45"
                disabled={props.disabled}
                onClick={needsTable ? props.onEdit : props.onSeat}
                type="button"
              >
                <Utensils size={18} />
                {needsTable
                  ? "Asignar mesa"
                  : `Sentar${reservation.tables[0] ? ` en ${reservation.tables[0].name}` : ""}`}
              </UiButton>
            ) : null}
            {actions.openOrder && reservation.orderId ? (
              <UiButton
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)]"
                onClick={() => props.onOpenOrder(reservation.orderId!)}
                type="button"
              >
                <Utensils size={18} />
                Abrir comanda
              </UiButton>
            ) : null}
            <div className="grid grid-cols-3 gap-2 max-[390px]:grid-cols-2">
              {actions.arrive && props.canManage ? (
                <UiButton
                  className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-2 text-sm font-extrabold text-[var(--foreground)]"
                  disabled={props.disabled}
                  onClick={() => props.onStatus("arrived")}
                  type="button"
                >
                  <UserCheck size={17} />
                  Llegada
                </UiButton>
              ) : null}
              {actions.edit && props.canManage ? (
                <UiButton
                  className="inline-flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-2 text-sm font-extrabold text-[var(--foreground)]"
                  disabled={props.disabled}
                  onClick={props.onEdit}
                  type="button"
                >
                  <Edit3 size={17} />
                  Editar
                </UiButton>
              ) : null}
              <a
                className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-2 text-sm font-extrabold text-[var(--foreground)] no-underline"
                href={`tel:${reservation.customerPhone}`}
              >
                <Phone size={17} />
                Llamar
              </a>
              {actions.noShow && props.canManage ? (
                <UiButton
                  className="inline-flex min-h-11 items-center justify-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-2 text-sm font-extrabold text-[var(--foreground)]"
                  disabled={props.disabled}
                  onClick={() => setConfirmation("no_show")}
                  type="button"
                >
                  No presentado
                </UiButton>
              ) : null}
            </div>
            {actions.cancel && props.canManage ? (
              <UiButton
                className="inline-flex min-h-10 w-full items-center justify-center rounded-xl border border-transparent bg-transparent px-4 text-sm font-extrabold text-[var(--danger)] hover:bg-[var(--danger-soft)]"
                disabled={props.disabled}
                onClick={() => setConfirmation("cancelled")}
                type="button"
              >
                Cancelar reserva
              </UiButton>
            ) : null}
          </footer>
        </aside>
      </div>

      {confirmation ? (
        <AppModal
          containerClassName="!p-4"
          dismissDisabled={props.disabled}
          label={
            confirmation === "cancelled"
              ? "Cancelar reserva"
              : "Marcar como no presentada"
          }
          maxWidth={448}
          onClose={() => setConfirmation(null)}
        >
          <section className="w-full rounded-2xl bg-[var(--surface)] p-6 text-[var(--foreground)]">
            <h2 className="m-0 text-xl font-black">
              {confirmation === "cancelled"
                ? "Cancelar reserva"
                : "Marcar como no presentada"}
            </h2>
            <p className="mb-5 mt-2 text-[var(--muted)]">
              La reserva seguirá disponible en el historial.
            </p>
            {confirmation === "cancelled" ? (
              <label className="grid gap-2 text-sm font-extrabold">
                Motivo opcional
                <UiInput
                  autoFocus
                  className="rounded-xl border border-[var(--field-border)] !text-[var(--foreground)]"
                  onChange={(event) => setReason(event.target.value)}
                  value={reason}
                />
              </label>
            ) : null}
            <div className="mt-6 flex justify-end gap-2">
              <UiButton
                className="min-h-11 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold"
                onClick={() => setConfirmation(null)}
                type="button"
              >
                Volver
              </UiButton>
              <UiButton
                className="min-h-11 rounded-xl border border-[var(--danger)] bg-[var(--danger)] px-4 font-extrabold text-white"
                disabled={props.disabled}
                onClick={() => {
                  props.onStatus(confirmation, reason.trim() || undefined);
                  setConfirmation(null);
                }}
                type="button"
              >
                Confirmar
              </UiButton>
            </div>
          </section>
        </AppModal>
      ) : null}
    </>
  );
}
