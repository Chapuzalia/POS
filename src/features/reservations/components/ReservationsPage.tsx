import { useMemo, useState } from "react";
import { Button as UiButton } from "../../../components/ui/Button";
import { Input as UiInput } from "../../../components/ui/Input";
import {
  ArrowLeft,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  List,
  Map as MapIcon,
  RefreshCw,
  Search,
  Rows3,
} from "lucide-react";
import { shiftDateKey } from "../domain/reservationAvailability";
import { isReservationLate } from "../domain/reservationStatus";
import type { useReservationsController } from "../hooks/useReservationsController";
import type { Reservation, ReservationTable } from "../types";
import { ReservationDetailPanel } from "./ReservationDetailPanel";
import { ReservationFormModal } from "./ReservationFormModal";
import { ReservationList } from "./ReservationList";
import { ReservationMapView } from "./ReservationMapView";
import { ReservationTimelineView } from "./ReservationTimelineView";

type Controller = ReturnType<typeof useReservationsController>;
type ReservationFilter = "all" | "upcoming" | "arrived" | "late" | "unassigned";

type Props = {
  controller: Controller;
  isOnline: boolean;
  onOpenOrder: (orderId: string) => void;
};

function matchesFilter(reservation: Reservation, filter: ReservationFilter) {
  if (filter === "arrived") return reservation.status === "arrived";
  if (filter === "late") return isReservationLate(reservation);
  if (filter === "unassigned") {
    return (
      ["confirmed", "arrived"].includes(reservation.status) &&
      reservation.tableIds.length === 0
    );
  }
  if (filter === "upcoming") {
    return (
      reservation.status === "confirmed" &&
      new Date(reservation.endsAt) > new Date()
    );
  }
  return true;
}

export function ReservationsPage({ controller, isOnline, onOpenOrder }: Props) {
  const [filter, setFilter] = useState<ReservationFilter>("all");
  const [areaId, setAreaId] = useState("all");
  const searching = Boolean(controller.query.trim());
  const displayed = useMemo(() => {
    const source = searching
      ? controller.searchResults
      : controller.reservations;
    return source.filter(
      (reservation) =>
        matchesFilter(reservation, filter) &&
        (areaId === "all" ||
          reservation.tables.some((table) => table.areaId === areaId)),
    );
  }, [
    areaId,
    controller.reservations,
    controller.searchResults,
    filter,
    searching,
  ]);
  const formattedDate = new Intl.DateTimeFormat("es", {
    day: "numeric",
    month: "short",
    weekday: "short",
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
  const filters: Array<{
    id: ReservationFilter;
    label: string;
    count?: number;
    urgent?: boolean;
  }> = [
    { id: "all", label: "Todas", count: controller.reservations.length },
    { id: "upcoming", label: "Próximas", count: controller.summary.upcoming },
    { id: "arrived", label: "Han llegado", count: controller.summary.arrived },
    {
      id: "late",
      label: "Retrasadas",
      count: controller.summary.late,
      urgent: controller.summary.late > 0,
    },
    {
      id: "unassigned",
      label: "Sin mesa",
      count: controller.summary.unassigned,
      urgent: controller.summary.unassigned > 0,
    },
  ];

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto overscroll-contain bg-[var(--background)] p-0 [-webkit-overflow-scrolling:touch] md:gap-3 md:p-4">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--separator)] bg-[var(--surface)] p-3 md:gap-3 md:rounded-2xl md:border md:shadow-sm">
        <div className="flex min-w-0 flex-1 items-center gap-2 md:flex-none">
          <UiButton
            aria-label="Volver al POS"
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 font-extrabold text-[var(--foreground)] disabled:opacity-45"
            onClick={controller.close}
            type="button"
          >
            <ArrowLeft size={18} />{" "}
            <span className="max-sm:sr-only">Volver</span>
          </UiButton>
          <div className="min-w-0">
            <h1 className="m-0 text-xl font-black sm:text-2xl">Reservas</h1>
            <p className="m-0 truncate text-xs font-semibold capitalize text-[var(--muted)]">
              {controller.date === controller.today
                ? `Hoy · ${formattedDate}`
                : formattedDate}
            </p>
          </div>
        </div>

        <div className="order-3 flex min-h-11 w-full items-center overflow-hidden rounded-xl border border-[var(--separator)] bg-[var(--surface-secondary)] md:order-none md:ml-auto md:w-auto">
          <UiButton
            aria-label="Fecha anterior"
            className="grid size-11 place-items-center text-[var(--foreground)]"
            onClick={() =>
              controller.setDate(shiftDateKey(controller.date, -1))
            }
            type="button"
          >
            <ChevronLeft size={18} />
          </UiButton>
          <label className="flex min-h-11 flex-1 items-center justify-center gap-2 border-x border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-bold text-[var(--foreground)] md:flex-none">
            <CalendarDays aria-hidden="true" size={17} />
            <span className="sr-only">Ir a una fecha</span>
            <input
              aria-label="Fecha de las reservas"
              className="w-32 bg-transparent text-sm font-bold text-[var(--foreground)] outline-none"
              onChange={(event) =>
                event.target.value && controller.setDate(event.target.value)
              }
              type="date"
              value={controller.date}
            />
          </label>
          <UiButton
            aria-label="Fecha siguiente"
            className="grid size-11 place-items-center text-[var(--foreground)]"
            onClick={() => controller.setDate(shiftDateKey(controller.date, 1))}
            type="button"
          >
            <ChevronRight size={18} />
          </UiButton>
        </div>

        {controller.date !== controller.today ? (
          <UiButton
            className="order-3 min-h-11 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-extrabold text-[var(--foreground)] md:order-none"
            onClick={() => controller.setDate(controller.today)}
            type="button"
          >
            Hoy
          </UiButton>
        ) : null}

        {controller.canManage ? (
          <UiButton
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45 md:ml-auto"
            disabled={!isOnline}
            onClick={() => controller.openCreate()}
            type="button"
          >
            <CalendarPlus size={18} />
            <span className="max-sm:hidden">Nueva reserva</span>
            <span className="sm:hidden">Nueva</span>
          </UiButton>
        ) : null}
      </header>

      {!isOnline ? (
        <div
          className="rounded-xl border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-2.5 text-sm font-bold text-[var(--warning)]"
          role="status"
        >
          Sin conexión. Puedes consultar las reservas ya cargadas, pero las
          acciones están deshabilitadas.
        </div>
      ) : null}

      <section
        aria-label="Filtros de reservas"
        className="flex min-h-14 shrink-0 items-start gap-2 overflow-x-auto overscroll-x-contain px-3 pb-0.5 pt-3 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden md:min-h-0 md:px-0 md:pt-0"
      >
        {filters.map((item) => (
          <UiButton
            aria-pressed={filter === item.id}
            className={`inline-flex min-h-11 shrink-0 items-center gap-2 rounded-full border px-3 text-sm font-extrabold transition-colors md:min-h-10 ${filter === item.id ? "border-[var(--accent)] bg-[var(--accent)] text-[var(--accent-foreground)]" : item.urgent ? "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] text-[var(--warning)]" : "border-[var(--separator)] bg-[var(--surface)] text-[var(--foreground)]"}`}
            key={item.id}
            onClick={() => setFilter(item.id)}
            type="button"
          >
            {item.label}
            <span
              className={`rounded-md px-1.5 py-0.5 text-xs ${filter === item.id ? "bg-white/20" : "bg-[var(--surface-secondary)]"}`}
            >
              {item.count ?? 0}
            </span>
          </UiButton>
        ))}
      </section>

      <section
        aria-label="Herramientas de reservas"
        className="m-3 mb-0 flex lg:flex-row max-lg:flex-wrap shrink-0  items-center gap-2 rounded-xl border border-[var(--separator)] bg-[var(--surface)] p-2 md:m-0 md:rounded-2xl md:shadow-sm"
      >
        <label className="flex min-h-11 w-full basis-full items-center gap-2 rounded-xl bg-[var(--surface-secondary)] px-3 text-[var(--muted)] focus-within:ring-2 focus-within:ring-[var(--accent)] md:min-w-60 md:flex-1 md:basis-auto">
          <Search aria-hidden="true" size={18} />
          <span className="sr-only">Buscar reservas</span>
          <UiInput
            className="min-w-0 flex-1 !bg-transparent !p-0 !text-[var(--foreground)]"
            onChange={(event) => {
              controller.setQuery(event.target.value);
              if (event.target.value) {
                setFilter("all");
                setAreaId("all");
              }
            }}
            placeholder="Nombre, teléfono o mesa"
            value={controller.query}
          />
          {searching ? (
            <small className="hidden whitespace-nowrap text-[11px] font-bold sm:block">
              Todas las fechas
            </small>
          ) : null}
        </label>

        <select
          aria-label="Filtrar por zona"
          className="min-h-11  flex-1 rounded-xl border border-[var(--separator)] bg-[var(--surface)] px-3 text-sm font-bold text-[var(--foreground)] outline-none focus:ring-2 focus:ring-[var(--accent)] md:max-w-44"
          onChange={(event) => setAreaId(event.target.value)}
          value={areaId}
        >
          <option value="all">Todas las zonas</option>
          {controller.map.areas.map((area) => (
            <option key={area.id} value={area.id}>
              {area.name}
            </option>
          ))}
        </select>

        <div
          aria-label="Vista"
          className="flex min-h-11 items-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] p-1"
        >
          <UiButton
            aria-label="Vista de lista"
            aria-pressed={controller.view === "list"}
            className={`grid size-9 place-items-center rounded-lg ${controller.view === "list" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)]"}`}
            onClick={() => controller.setView("list")}
            type="button"
          >
            <List size={18} />
          </UiButton>
          <UiButton
            aria-label="Vista de horario"
            aria-pressed={controller.view === "timeline"}
            className={`grid size-9 place-items-center rounded-lg ${controller.view === "timeline" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)]"}`}
            onClick={() => controller.setView("timeline")}
            type="button"
          >
            <Rows3 size={18} />
          </UiButton>
          <UiButton
            aria-label="Vista de mapa"
            aria-pressed={controller.view === "map"}
            className={`grid size-9 place-items-center rounded-lg ${controller.view === "map" ? "bg-[var(--accent-soft)] text-[var(--accent)]" : "text-[var(--muted)]"}`}
            onClick={() => controller.setView("map")}
            type="button"
          >
            <MapIcon size={18} />
          </UiButton>
        </div>
        <UiButton
          aria-label="Actualizar reservas"
          className="grid size-11 place-items-center rounded-xl border border-[var(--separator)] bg-[var(--surface)] text-[var(--muted)] disabled:opacity-45"
          disabled={!isOnline || controller.isLoading}
          onClick={() => void controller.refresh()}
          type="button"
        >
          <RefreshCw
            className={controller.isLoading ? "animate-spin" : ""}
            size={18}
          />
        </UiButton>
      </section>

      <section className="flex min-h-0 flex-none gap-3 p-3 md:min-h-105 md:flex-1 md:p-0">
        {controller.view === "list" ? (
          <ReservationList
            onSelect={controller.openDetail}
            reservations={displayed}
            searchMode={searching}
            selectedId={controller.detail?.id ?? null}
          />
        ) : controller.view === "timeline" ? (
          <ReservationTimelineView
            areaId={areaId}
            date={controller.date}
            map={controller.map}
            onCreate={controller.openCreate}
            onSelect={controller.openDetail}
            reservations={displayed}
            selectedId={controller.detail?.id ?? null}
            timeZone={controller.timeZone}
          />
        ) : (
          <ReservationMapView
            date={controller.date}
            map={controller.map}
            onCreate={controller.openCreate}
            onSelectReservation={controller.openDetail}
            reservations={displayed}
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
          preselectedStartsAt={controller.editor.preselectedStartsAt}
          reservation={controller.editor.reservation}
          tables={tables}
          timeZone={controller.timeZone}
        />
      ) : null}
    </main>
  );
}
