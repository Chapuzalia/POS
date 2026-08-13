import { AlertTriangle, Clock3, Users } from "lucide-react";
import { useEffect, useMemo, useRef, type MouseEvent } from "react";
import {
  localDateKey,
  shiftDateKey,
  zonedLocalToUtc,
} from "../domain/reservationAvailability";
import {
  getReservationStatusLabel,
  isReservationLate,
} from "../domain/reservationStatus";
import type { Reservation, ReservationMap, ReservationStatus } from "../types";

type Props = {
  areaId: string;
  date: string;
  map: ReservationMap;
  onCreate: (tableIds?: string[], startsAt?: string) => void;
  onSelect: (reservation: Reservation) => void;
  reservations: Reservation[];
  selectedId: string | null;
  timeZone: string;
};

type PositionedReservation = {
  lane: number;
  reservation: Reservation;
  start: number;
  end: number;
};

const LABEL_WIDTH = 148;
const PIXELS_PER_MINUTE = 2;
const LANE_HEIGHT = 34;
const DEFAULT_START = 12 * 60;
const DEFAULT_END = 24 * 60;

function minutesInTimeZone(value: string | Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    timeZone,
  }).formatToParts(new Date(value));
  const hour =
    Number(parts.find((part) => part.type === "hour")?.value ?? 0) % 24;
  const minute = Number(
    parts.find((part) => part.type === "minute")?.value ?? 0,
  );
  return hour * 60 + minute;
}

function reservationMinutes(reservation: Reservation, timeZone: string) {
  const start = minutesInTimeZone(reservation.startsAt, timeZone);
  const duration = Math.max(
    15,
    Math.round(
      (new Date(reservation.endsAt).getTime() -
        new Date(reservation.startsAt).getTime()) /
        60_000,
    ),
  );
  return { start, end: start + duration };
}

function placeInLanes(reservations: Reservation[], timeZone: string) {
  const laneEnds: number[] = [];
  const positioned = reservations
    .map((reservation) => ({
      reservation,
      ...reservationMinutes(reservation, timeZone),
    }))
    .sort(
      (first, second) => first.start - second.start || first.end - second.end,
    )
    .map((item): PositionedReservation => {
      let lane = laneEnds.findIndex((end) => end <= item.start);
      if (lane === -1) lane = laneEnds.length;
      laneEnds[lane] = item.end;
      return { ...item, lane };
    });
  return { positioned, laneCount: Math.max(1, laneEnds.length) };
}

function statusClass(status: ReservationStatus, late: boolean) {
  if (late)
    return "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] text-[var(--warning)]";
  if (status === "arrived" || status === "seated")
    return "border-[var(--success)] bg-[var(--success-soft)] text-[var(--success)]";
  if (status === "cancelled" || status === "no_show")
    return "border-[var(--danger)] bg-[var(--danger-soft)] text-[var(--danger)] opacity-65";
  if (status === "completed")
    return "border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--muted)] opacity-70";
  return "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]";
}

function timeLabel(minutes: number) {
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:00`;
}

function ReservationBar({
  item,
  onSelect,
  selected,
  timeZone,
  timelineStart,
}: {
  item: PositionedReservation;
  onSelect: (reservation: Reservation) => void;
  selected: boolean;
  timeZone: string;
  timelineStart: number;
}) {
  const late = isReservationLate(item.reservation);
  const startLabel = new Intl.DateTimeFormat("es", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  }).format(new Date(item.reservation.startsAt));
  const width = Math.max(44, (item.end - item.start) * PIXELS_PER_MINUTE - 4);

  return (
    <button
      aria-current={selected ? "true" : undefined}
      aria-label={`${startLabel}, ${item.reservation.customerName}, ${item.reservation.partySize} personas, ${getReservationStatusLabel(item.reservation.status)}`}
      className={`absolute z-[2] flex h-[30px] min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border px-2 text-left text-xs font-extrabold shadow-sm transition-[filter,box-shadow] hover:brightness-[0.98] focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)] ${statusClass(item.reservation.status, late)} ${selected ? "ring-2 ring-[var(--accent)] ring-offset-1" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(item.reservation);
      }}
      style={{
        left: (item.start - timelineStart) * PIXELS_PER_MINUTE + 2,
        top: 7 + item.lane * LANE_HEIGHT,
        width,
      }}
      title={`${startLabel} · ${item.reservation.customerName} · ${item.reservation.partySize} pax`}
      type="button"
    >
      {late ? (
        <AlertTriangle aria-hidden="true" className="shrink-0" size={12} />
      ) : null}
      <time className="shrink-0 tabular-nums">{startLabel}</time>
      <span className="truncate">{item.reservation.customerName}</span>
      <span className="ml-auto flex shrink-0 items-center gap-0.5 opacity-75">
        <Users aria-hidden="true" size={11} />
        {item.reservation.partySize}
      </span>
    </button>
  );
}

export function ReservationTimelineView(props: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const schedule = useMemo(() => {
    const bounds = props.reservations.map((reservation) =>
      reservationMinutes(reservation, props.timeZone),
    );
    const earliest = bounds.length
      ? Math.min(...bounds.map((item) => item.start))
      : DEFAULT_START;
    const latest = bounds.length
      ? Math.max(...bounds.map((item) => item.end))
      : DEFAULT_END;
    const start = Math.max(
      0,
      Math.floor(Math.min(DEFAULT_START, earliest - 30) / 60) * 60,
    );
    const end = Math.min(
      30 * 60,
      Math.ceil(Math.max(DEFAULT_END, latest + 30) / 60) * 60,
    );
    return { start, end, width: (end - start) * PIXELS_PER_MINUTE };
  }, [props.reservations, props.timeZone]);

  const areas = useMemo(
    () =>
      props.map.areas
        .filter(
          (area) =>
            area.isActive &&
            (props.areaId === "all" || props.areaId === area.id),
        )
        .sort((first, second) => first.sortOrder - second.sortOrder),
    [props.areaId, props.map.areas],
  );
  const tablesByArea = useMemo(
    () =>
      new Map(
        areas.map((area) => [
          area.id,
          props.map.tables
            .filter((table) => table.isActive && table.areaId === area.id)
            .sort((first, second) => first.sortOrder - second.sortOrder),
        ]),
      ),
    [areas, props.map.tables],
  );
  const layoutsByTable = useMemo(() => {
    const grouped = new Map<string, Reservation[]>();
    for (const reservation of props.reservations) {
      for (const tableId of reservation.tableIds) {
        grouped.set(tableId, [...(grouped.get(tableId) ?? []), reservation]);
      }
    }
    return new Map(
      [...grouped].map(([tableId, reservations]) => [
        tableId,
        placeInLanes(reservations, props.timeZone),
      ]),
    );
  }, [props.reservations, props.timeZone]);
  const unassigned = props.reservations.filter(
    (reservation) => reservation.tableIds.length === 0,
  );
  const unassignedLayout = placeInLanes(unassigned, props.timeZone);
  const today = localDateKey(new Date(), props.timeZone);
  const nowMinutes = minutesInTimeZone(new Date(), props.timeZone);
  const showNow =
    props.date === today &&
    nowMinutes >= schedule.start &&
    nowMinutes <= schedule.end;

  useEffect(() => {
    if (!showNow) return;
    const frame = window.requestAnimationFrame(() => {
      const scroller = scrollRef.current;
      if (!scroller || scroller.scrollWidth <= scroller.clientWidth) return;
      const currentTimeOffset =
        (nowMinutes - schedule.start) * PIXELS_PER_MINUTE;
      scroller.scrollTo({
        left: Math.max(0, currentTimeOffset - 28),
        behavior: "instant",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [nowMinutes, schedule.start, showNow]);

  const createAt = (
    event: MouseEvent<HTMLDivElement>,
    tableIds: string[] = [],
  ) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const rawMinutes =
      schedule.start + (event.clientX - bounds.left) / PIXELS_PER_MINUTE;
    const snappedMinutes = Math.max(
      schedule.start,
      Math.min(schedule.end - 15, Math.round(rawMinutes / 15) * 15),
    );
    const dayOffset = Math.floor(snappedMinutes / (24 * 60));
    const minuteOfDay = snappedMinutes % (24 * 60);
    const date = shiftDateKey(props.date, dayOffset);
    const time = `${String(Math.floor(minuteOfDay / 60)).padStart(2, "0")}:${String(minuteOfDay % 60).padStart(2, "0")}`;
    props.onCreate(tableIds, zonedLocalToUtc(date, time, props.timeZone));
  };

  const hourMarks = [];
  for (let minute = schedule.start; minute <= schedule.end; minute += 60)
    hourMarks.push(minute);

  const renderLane = (
    layout: ReturnType<typeof placeInLanes>,
    tableIds: string[],
    emptyLabel: string,
  ) => {
    const height = Math.max(48, 14 + layout.laneCount * LANE_HEIGHT);
    return (
      <div
        aria-label={emptyLabel}
        className="relative cursor-crosshair border-b border-[var(--separator)] bg-[repeating-linear-gradient(to_right,var(--separator)_0_1px,transparent_1px_60px)] hover:bg-[color-mix(in_srgb,var(--accent)_3%,var(--surface))]"
        onClick={(event) => createAt(event, tableIds)}
        style={{ height, width: schedule.width }}
      >
        {!layout.positioned.length ? (
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-[var(--muted)] opacity-65">
            Pulsa para crear
          </span>
        ) : null}
        {layout.positioned.map((item) => (
          <ReservationBar
            item={item}
            key={item.reservation.id}
            onSelect={props.onSelect}
            selected={props.selectedId === item.reservation.id}
            timeZone={props.timeZone}
            timelineStart={schedule.start}
          />
        ))}
        {showNow ? (
          <div
            aria-label="Hora actual"
            className="pointer-events-none absolute inset-y-0 z-[3] w-0.5 bg-[var(--danger)]"
            style={{ left: (nowMinutes - schedule.start) * PIXELS_PER_MINUTE }}
          />
        ) : null}
      </div>
    );
  };

  return (
    <section
      aria-label="Horario de reservas"
      className="h-[min(68dvh,40rem)] min-h-110 min-w-0 flex-none flex-1 overflow-hidden rounded-xl border border-[var(--separator)] bg-[var(--surface)] shadow-sm md:h-auto md:min-h-0 md:rounded-2xl"
    >
      <div
        aria-label="Desplazar horario de reservas"
        className="h-full min-h-105 touch-auto overflow-auto overscroll-contain [-webkit-overflow-scrolling:touch]"
        ref={scrollRef}
        role="region"
        tabIndex={0}
      >
        <div style={{ minWidth: LABEL_WIDTH + schedule.width }}>
          <header className="sticky top-0 z-30 flex h-12 border-b border-[var(--separator)] bg-[var(--surface)] shadow-sm">
            <div
              className="sticky left-0 z-20 flex shrink-0 items-center gap-2 border-r border-[var(--separator)] bg-[var(--surface)] px-3 text-xs font-black uppercase tracking-wider text-[var(--muted)]"
              style={{ width: LABEL_WIDTH }}
            >
              <Clock3 aria-hidden="true" size={15} /> Mesa
            </div>
            <div
              className="relative shrink-0 bg-[var(--surface-secondary)]"
              style={{ width: schedule.width }}
            >
              {hourMarks.map((minute) => (
                <time
                  className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 text-xs font-black tabular-nums text-[var(--foreground)] first:translate-x-2"
                  dateTime={timeLabel(minute)}
                  key={minute}
                  style={{
                    left: (minute - schedule.start) * PIXELS_PER_MINUTE,
                  }}
                >
                  {timeLabel(minute)}
                </time>
              ))}
              {showNow ? (
                <span
                  className="absolute bottom-0 z-10 -translate-x-1/2 rounded-t bg-[var(--danger)] px-1.5 py-0.5 text-[9px] font-black uppercase text-white"
                  style={{
                    left: (nowMinutes - schedule.start) * PIXELS_PER_MINUTE,
                  }}
                >
                  Ahora
                </span>
              ) : null}
            </div>
          </header>

          {unassigned.length ? (
            <div className="flex">
              <div
                className="sticky left-0 z-20 flex shrink-0 items-start gap-2 border-b border-r border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_10%,var(--surface))] px-3 py-3 text-[var(--warning)]"
                style={{
                  width: LABEL_WIDTH,
                  height: Math.max(
                    48,
                    14 + unassignedLayout.laneCount * LANE_HEIGHT,
                  ),
                }}
              >
                <AlertTriangle
                  aria-hidden="true"
                  className="mt-0.5 shrink-0"
                  size={15}
                />
                <span className="min-w-0">
                  <strong className="block truncate text-xs">Sin mesa</strong>
                  <small className="text-[10px] font-bold">
                    {unassigned.length} pendientes
                  </small>
                </span>
              </div>
              {renderLane(unassignedLayout, [], "Reservas sin mesa")}
            </div>
          ) : null}

          {areas.map((area) => {
            const tables = tablesByArea.get(area.id) ?? [];
            return (
              <section
                aria-labelledby={`timeline-area-${area.id}`}
                key={area.id}
              >
                <h3
                  className="sticky left-0 z-20 m-0 flex h-9 items-center border-b border-[var(--separator)] bg-[var(--surface-secondary)] px-3 text-xs font-black uppercase tracking-wider text-[var(--foreground)]"
                  id={`timeline-area-${area.id}`}
                  style={{ width: LABEL_WIDTH + schedule.width }}
                >
                  <span className="sticky left-3">
                    {area.name} · {tables.length} mesas
                  </span>
                </h3>
                {tables.map((table) => {
                  const layout = layoutsByTable.get(table.id) ?? {
                    positioned: [],
                    laneCount: 1,
                  };
                  const rowHeight = Math.max(
                    48,
                    14 + layout.laneCount * LANE_HEIGHT,
                  );
                  return (
                    <div className="flex" key={table.id}>
                      <div
                        className="sticky left-0 z-20 flex shrink-0 items-center justify-between gap-2 border-b border-r border-[var(--separator)] bg-[var(--surface)] px-3"
                        style={{ height: rowHeight, width: LABEL_WIDTH }}
                      >
                        <span className="min-w-0">
                          <strong className="block truncate text-sm">
                            {table.name}
                          </strong>
                          <small className="flex items-center gap-1 text-[10px] font-semibold text-[var(--muted)]">
                            <Users aria-hidden="true" size={11} />
                            {table.capacity} plazas
                          </small>
                        </span>
                        {layout.laneCount > 1 ? (
                          <span
                            aria-label="Reservas solapadas"
                            className="grid size-5 shrink-0 place-items-center rounded-full bg-[color-mix(in_srgb,var(--warning)_14%,var(--surface))] text-[10px] font-black text-[var(--warning)]"
                          >
                            {layout.laneCount}
                          </span>
                        ) : null}
                      </div>
                      {renderLane(
                        layout,
                        [table.id],
                        `Horario de ${table.name}`,
                      )}
                    </div>
                  );
                })}
                {!tables.length ? (
                  <p className="m-0 border-b border-[var(--separator)] px-3 py-5 text-sm font-bold text-[var(--muted)]">
                    No hay mesas activas en esta sala.
                  </p>
                ) : null}
              </section>
            );
          })}
          {!areas.length ? (
            <p className="m-0 px-5 py-12 text-center font-extrabold text-[var(--muted)]">
              No hay salas disponibles con este filtro.
            </p>
          ) : null}
        </div>
      </div>
    </section>
  );
}
