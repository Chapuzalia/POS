import { LoaderCircle, Map as MapIcon, Rows3 } from "lucide-react";
import { useState } from "react";
import { Button as UiButton } from "../../../components/ui/Button";
import type { Reservation, ReservationMap } from "../types";
import { ReservationMapView } from "./ReservationMapView";
import { ReservationTimelineView } from "./ReservationTimelineView";

type Props = {
  availabilityError: string | null;
  conflictTableIds: string[];
  date: string;
  disabled: boolean;
  hasActiveConflicts: boolean;
  isCheckingAvailability: boolean;
  isLoadingReservations: boolean;
  map: ReservationMap;
  onSlotSelect: (tableIds: string[], startsAt: string) => void;
  onTableIdsChange: (tableIds: string[]) => void;
  partySize: number;
  reservations: Reservation[];
  reservationsError: string | null;
  schedule: { startsAt: string; endsAt: string } | null;
  selectedCapacity: number;
  tableIds: string[];
  timeZone: string;
};

type SelectionView = "map" | "timeline";

export function ReservationSelectionStep(props: Props) {
  const [view, setView] = useState<SelectionView>("map");
  const [areaId, setAreaId] = useState("all");
  return (
    <section className="flex min-h-0 flex-1 flex-col bg-[var(--background)]">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--separator)] px-4 py-3 md:min-h-[76px] md:px-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[11px] font-black uppercase tracking-wider text-[var(--accent)]">
              Paso 2 de 2 · Mesa y horario
            </span>
            <p
              aria-live="polite"
              className={`m-0 flex items-center gap-1.5 text-xs font-semibold ${props.availabilityError || props.reservationsError ? "text-[var(--warning)]" : "text-[var(--muted)]"}`}
              role="status"
            >
              {props.isCheckingAvailability || props.isLoadingReservations ? (
                <>
                  <LoaderCircle className="animate-spin" size={14} />
                  Actualizando disponibilidad…
                </>
              ) : props.availabilityError || props.reservationsError ? (
                props.availabilityError || props.reservationsError
              ) : (
                "Pulsa una mesa o un hueco libre para seleccionarlo."
              )}
            </p>
          </div>
          <h3 className="mb-0 mt-1 text-lg font-black">
            Elige sobre el plano real o el timeline
          </h3>
        </div>

        <div
          aria-label="Modo de selección de mesa"
          className="grid grid-cols-2 rounded-xl border border-[var(--separator)] bg-[var(--surface-secondary)] p-1"
          role="group"
        >
          <UiButton
            aria-pressed={view === "map"}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border-0 px-3 text-sm font-extrabold ${view === "map" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-transparent text-[var(--muted)]"}`}
            onClick={() => setView("map")}
            type="button"
          >
            <MapIcon size={16} /> Mapa real
          </UiButton>
          <UiButton
            aria-pressed={view === "timeline"}
            className={`flex min-h-10 items-center justify-center gap-2 rounded-lg border-0 px-3 text-sm font-extrabold ${view === "timeline" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-transparent text-[var(--muted)]"}`}
            onClick={() => setView("timeline")}
            type="button"
          >
            <Rows3 size={16} /> Timeline
          </UiButton>
        </div>
      </div>

      {view === "map" ? (
        <div className="flex min-h-0 flex-1 p-3">
          <ReservationMapView
            date={props.date}
            map={props.map}
            onCreate={() => undefined}
            onSelectReservation={() => undefined}
            reservations={props.reservations}
            selection={{
              conflictTableIds: props.conflictTableIds,
              disabled: props.disabled,
              hasActiveConflicts: props.hasActiveConflicts,
              onChange: props.onTableIdsChange,
              partySize: props.partySize,
              selectedCapacity: props.selectedCapacity,
              selectedTableIds: props.tableIds,
            }}
          />
        </div>
      ) : (
        <div className="grid min-h-0 flex-1 gap-3 p-3">
          <label className="flex items-center gap-2 text-sm font-extrabold">
            Zona
            <select
              aria-label="Filtrar timeline por zona"
              className="min-h-10 rounded-xl border border-[var(--field-border)] bg-[var(--surface)] px-3 text-sm font-bold"
              onChange={(event) => setAreaId(event.target.value)}
              value={areaId}
            >
              <option value="all">Todas las zonas</option>
              {props.map.areas.map((area) => (
                <option key={area.id} value={area.id}>
                  {area.name}
                </option>
              ))}
            </select>
          </label>
          <ReservationTimelineView
            allowUnassignedCreate={false}
            areaId={areaId}
            date={props.date}
            draft={
              props.schedule
                ? { ...props.schedule, tableIds: props.tableIds }
                : undefined
            }
            map={props.map}
            onCreate={(tableIds, startsAt) => {
              if (tableIds?.length && startsAt)
                props.onSlotSelect(tableIds, startsAt);
            }}
            onSelect={() => undefined}
            reservations={props.reservations}
            selectedId={null}
            timeZone={props.timeZone}
          />
        </div>
      )}
    </section>
  );
}
