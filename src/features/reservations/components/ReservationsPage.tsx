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
import "../reservations.css";

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
    <main className="reservations-screen">
      <header className="reservations-toolbar">
        <div className="reservations-title">
          <button
            aria-label="Volver al POS"
            className="table-action secondary"
            onClick={controller.close}
            type="button"
          >
            <ArrowLeft /> Volver
          </button>
          <h1>Reservas</h1>
        </div>
        <div className="reservations-date-nav">
          <button
            aria-label="Fecha anterior"
            onClick={() =>
              controller.setDate(shiftDateKey(controller.date, -1))
            }
            type="button"
          >
            <ChevronLeft />
          </button>
          <button
            className="date-label"
            onClick={() => controller.setDate(controller.today)}
            type="button"
          >
            {dateLabel}
          </button>
          <button
            aria-label="Fecha siguiente"
            onClick={() => controller.setDate(shiftDateKey(controller.date, 1))}
            type="button"
          >
            <ChevronRight />
          </button>
        </div>
        <div className="reservations-toolbar-actions flex flex-row">
          <div aria-label="Vista" className="reservations-view-toggle">
            <button
              className={controller.view === "list" ? "active" : ""}
              onClick={() => controller.setView("list")}
              type="button"
            >
              <List />
            </button>
            <button
              className={controller.view === "map" ? "active" : ""}
              onClick={() => controller.setView("map")}
              type="button"
            >
              <MapIcon />
            </button>
          </div>
          <button
            aria-label="Actualizar reservas"
            className="reservation-icon-button"
            disabled={!isOnline || controller.isLoading}
            onClick={() => void controller.refresh()}
            type="button"
          >
            <RefreshCw className={controller.isLoading ? "animate-spin" : ""} />
          </button>
          {controller.canManage ? (
            <button
              className="table-action primary"
              disabled={!isOnline}
              onClick={() => controller.openCreate()}
              type="button"
            >
              <CalendarPlus /> Nueva reserva
            </button>
          ) : null}
        </div>
      </header>
      {!isOnline ? (
        <div className="table-offline-warning">
          Sin conexión. Puedes consultar las reservas ya cargadas, pero las
          acciones están deshabilitadas.
        </div>
      ) : null}
      <section aria-label="Resumen del día" className="reservations-summary">
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
      <label className="reservations-search">
        <Search aria-hidden="true" />
        <span className="sr-only">Buscar reservas</span>
        <input
          onChange={(event) => controller.setQuery(event.target.value)}
          placeholder="Buscar por nombre, teléfono o mesa"
          value={controller.query}
        />
        {controller.query.trim() ? (
          <small>Buscando en todas las fechas</small>
        ) : null}
      </label>
      <section className="reservations-content">
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
