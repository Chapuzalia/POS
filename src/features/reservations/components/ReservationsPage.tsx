import { Input as UiInput } from '../../../components/ui/Input'
import { Button as UiButton } from '../../../components/ui/Button'
import {
  ArrowLeft,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  List,
  Map as MapIcon,
  RefreshCw,
  Search,
} from "lucide-react";
import { shiftDateKey } from "../domain/reservationAvailability";
import type { useReservationsController } from "../hooks/useReservationsController";
import type { ReservationTable } from "../types";
import { ReservationDetailPanel } from "./ReservationDetailPanel";
import { ReservationFormModal } from "./ReservationFormModal";
import { ReservationList } from "./ReservationList";
import { ReservationMapView } from "./ReservationMapView";

type Controller = ReturnType<typeof useReservationsController>;

type Props = {
  controller: Controller;
  isOnline: boolean;
  onOpenOrder: (orderId: string) => void;
};

export function ReservationsPage({ controller, isOnline, onOpenOrder }: Props) {
  const displayed = controller.query.trim()
    ? controller.searchResults
    : controller.reservations;
  const dateLabel =
    controller.date === controller.today
      ? "Hoy"
      : new Intl.DateTimeFormat("es", {
          dateStyle: "medium",
          timeZone: controller.timeZone,
        }).format(new Date(`${controller.date}T12:00:00Z`));
  const areaNames = new Map(
    controller.map.areas.map((area) => [area.id, area.name]),
  );
  const tables: ReservationTable[] = controller.map.tables.map((table) => ({
    id: table.id,
    name: table.name,
    capacity: table.capacity,
    areaId: table.areaId,
    areaName: areaNames.get(table.areaId) ?? "Sin zona",
    sortOrder: table.sortOrder,
    isActive: table.isActive,
  }));

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-[18px] max-[760px]:p-3">
      <header className="grid grid-cols-[1fr_auto_1fr] items-center gap-4 max-[1000px]:grid-cols-[1fr_auto] max-[760px]:flex max-[760px]:flex-col max-[760px]:items-stretch [&_svg]:size-[18px]">
        <div className="flex items-center gap-2 max-[760px]:justify-between [&>h1]:m-0 [&>h1]:text-2xl">
          <UiButton
            aria-label="Volver al POS"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45 max-[760px]:px-2.5"
            onClick={controller.close}
            type="button"
          >
            <ArrowLeft /> Volver
          </UiButton>
          <h1>Reservas</h1>
        </div>
        <div className="flex min-h-11 items-center gap-2 overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] max-[1000px]:col-span-full max-[1000px]:row-start-2 max-[1000px]:justify-self-center max-[760px]:self-center [&>button]:inline-flex [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:font-semibold [&>button]:text-[var(--foreground)]">
          <UiButton
            aria-label="Fecha anterior"
            onClick={() =>
              controller.setDate(shiftDateKey(controller.date, -1))
            }
            type="button"
          >
            <ChevronLeft />
          </UiButton>
          <UiButton
            className="min-w-[130px] border-x border-[var(--separator)]"
            onClick={() => controller.setDate(controller.today)}
            type="button"
          >
            {dateLabel}
          </UiButton>
          <UiButton
            aria-label="Fecha siguiente"
            onClick={() => controller.setDate(shiftDateKey(controller.date, 1))}
            type="button"
          >
            <ChevronRight />
          </UiButton>
        </div>
        <div className="flex flex-row items-center justify-end gap-2 max-[760px]:justify-between">
          <div aria-label="Vista" className="flex min-h-11 items-center gap-2 overflow-hidden rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] [&>button]:inline-flex [&>button]:min-h-11 [&>button]:min-w-11 [&>button]:items-center [&>button]:justify-center [&>button]:gap-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:font-semibold [&>button]:text-[var(--foreground)]">
            <UiButton
              className={controller.view === "list" ? "bg-[var(--accent-soft)] text-[var(--foreground)]" : ""}
              onClick={() => controller.setView("list")}
              type="button"
            >
              <List />
            </UiButton>
            <UiButton
              className={controller.view === "map" ? "bg-[var(--accent-soft)] text-[var(--foreground)]" : ""}
              onClick={() => controller.setView("map")}
              type="button"
            >
              <MapIcon />
            </UiButton>
          </div>
          <UiButton
            aria-label="Actualizar reservas"
            className="grid size-11 place-items-center rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)] disabled:opacity-45"
            disabled={!isOnline || controller.isLoading}
            onClick={() => void controller.refresh()}
            type="button"
          >
            <RefreshCw className={controller.isLoading ? "animate-spin" : ""} />
          </UiButton>
          {controller.canManage ? (
            <UiButton
              className="inline-flex max-[760px]:flex-1 min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45"
              disabled={!isOnline}
              onClick={() => controller.openCreate()}
              type="button"
            >
              <CalendarPlus /> Nueva reserva
            </UiButton>
          ) : null}
        </div>
      </header>
      {!isOnline ? (
        <div className="rounded-[var(--radius)] border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-[11px] font-bold text-[var(--warning)]">
          Sin conexión. Puedes consultar las reservas ya cargadas, pero las
          acciones están deshabilitadas.
        </div>
      ) : null}
      <section aria-label="Resumen del día" className="grid grid-cols-4 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] shadow-[var(--shadow)] max-[760px]:grid-cols-2 [&>div]:flex [&>div]:min-h-[76px] [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:border-r [&>div]:border-[var(--separator)] [&>div]:px-[22px] [&>div]:py-4 [&>div:last-child]:border-r-0 max-[1000px]:[&>div]:p-[13px] max-[760px]:[&>div]:min-h-[62px] max-[760px]:[&>div:nth-child(2)]:border-r-0 max-[760px]:[&>div:nth-child(-n+2)]:border-b [&_span]:font-bold [&_span]:text-[var(--muted)] [&_strong]:text-2xl">
        <div>
          <span>Próximas</span>
          <strong>{controller.summary.upcoming}</strong>
        </div>
        <div>
          <span>Han llegado</span>
          <strong>{controller.summary.arrived}</strong>
        </div>
        <div>
          <span>Retrasadas</span>
          <strong>{controller.summary.late}</strong>
        </div>
        <div>
          <span>Sin mesa</span>
          <strong>{controller.summary.unassigned}</strong>
        </div>
      </section>
      <label className="flex min-h-12 items-center gap-2.5 rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3.5 text-[var(--muted)] max-[760px]:flex-wrap [&_input]:min-w-0 [&_input]:flex-1 [&_input]:border-0 [&_input]:bg-transparent [&_input]:text-base [&_input]:text-[var(--field-foreground)] [&_input]:outline-none [&>small]:whitespace-nowrap max-[760px]:[&>small]:w-full max-[760px]:[&>small]:pb-2">
        <Search aria-hidden="true" />
        <span className="sr-only">Buscar reservas</span>
        <UiInput
          onChange={(event) => controller.setQuery(event.target.value)}
          placeholder="Buscar por nombre, teléfono o mesa"
          value={controller.query}
        />
        {controller.query.trim() ? (
          <small>Buscando en todas las fechas</small>
        ) : null}
      </label>
      <section className="flex min-h-[420px] flex-1 gap-3.5">
        {controller.view === "list" ? (
          <ReservationList
            onSelect={controller.openDetail}
            reservations={displayed}
            searchMode={Boolean(controller.query.trim())}
          />
        ) : (
          <ReservationMapView
            date={controller.date}
            map={controller.map}
            onCreate={controller.openCreate}
            onSelectReservation={controller.openDetail}
            reservations={controller.reservations}
          />
        )}
        {controller.detail ? (
          <ReservationDetailPanel
            canManage={controller.canManage}
            disabled={!isOnline || controller.isLoading}
            onClose={() => controller.setDetail(null)}
            onEdit={() => controller.openEdit(controller.detail!)}
            onOpenOrder={(orderId) => {
              controller.close();
              onOpenOrder(orderId);
            }}
            onSeat={() => void controller.seat(controller.detail!)}
            onStatus={(status, reason) =>
              void controller.updateStatus(controller.detail!, status, reason)
            }
            reservation={controller.detail}
          />
        ) : null}
      </section>
      {controller.editor ? (
        <ReservationFormModal
          conflicts={controller.conflicts}
          date={controller.date}
          disabled={!isOnline || controller.isLoading}
          onClose={() => controller.setEditor(null)}
          onSave={controller.save}
          onTableIdsChange={controller.setSelectedTableIds}
          preselectedTableIds={controller.editor.preselectedTableIds}
          reservation={controller.editor.reservation}
          tables={tables}
          timeZone={controller.timeZone}
        />
      ) : null}
    </main>
  );
}
