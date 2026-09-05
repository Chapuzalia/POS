import { Input as UiInput } from '../../../components/ui/Input'
import { Button as UiButton } from '../../../components/ui/Button'
import { AppModal } from '../../../components/ui/AppModal'
import {
  ArrowRightLeft,
  Check,
  Pencil,
  Plus,
  Save,
  ShoppingBag,
  Trash2,
  Unlink,
  Users,
  X,
} from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { formatMoney as formatCurrency } from "../../../lib/format";
import { getReadableError } from "../../../utils/errors";
import { snapTableAlignment } from "../alignment";
import {
  getAreaSwipeEntryOffset,
  getAreaSwipeTarget,
  getAreaSwipeVisualFeedback,
} from "../area-swipe";
import {
  externalLabelSize,
  placeExternalLabels,
  tableContentMode,
  tableVisualRect,
  type LabelSide,
} from "../external-label-layout";
import {
  boundsOf,
  compositionHasOpenOrder,
  findJoinProposal,
  getJoinedIds,
  separateFromComposition,
  translateComposition,
  type JoinProposal,
} from "../joined-layout";
import { layoutFromMap } from "../layout-service";
import { getRestaurantTableVisualStatus } from "../table-visual-status";
import type {
  RestaurantMap,
  RestaurantTableMapItem,
  RestaurantTableShape,
  SessionTableLayout,
  TableLayoutEntry,
} from "../types";
import {
  contentBounds,
  fitBoundsToViewport,
  getMapPlaneSize,
  orientMapRect,
  positionFloatingPanel,
  screenToMap,
  shouldRotateMapToFit,
} from "../viewport";
import { MobileTableMapChrome } from "./MobileTableMapChrome";
import { VirtualTableModal } from './VirtualTableModal'
import {
  MobileGroupActionsSheet,
} from "./MobileTableMapSheets";
import { ReservationTableBadge } from "../../reservations/components/ReservationTableBadge";

type Props = {
  canOpen: boolean;
  canQuickSale: boolean;
  cashSessionId: string;
  isBusy: boolean;
  isOnline: boolean;
  map: RestaurantMap;
  mobileLayout: boolean;
  onAreaChange: (areaId: string) => void;
  onLayoutChange: (
    tables: Record<string, TableLayoutEntry>,
    expectedRevision: number,
  ) => Promise<SessionTableLayout>;
  onError: (message: string) => void;
  onMove: (tableId: string) => Promise<void>;
  onSaveQuickSale: (tableId: string) => Promise<void>;
  onCreateVirtual: (input: { areaId: string | null; name: string; capacity: number; shape: RestaurantTableShape }) => Promise<boolean>;
  onDeleteVirtual: (tableId: string) => Promise<boolean>;
  onOpen: (tableIds: string[], guestCount: number) => Promise<void>;
  onOpenOrder: (orderId: string) => void;
  onOpenReservation: (reservationId: string) => void;
  onQuickSale: (areaId?: string) => void;
  selectedAreaId?: string;
  moveOrderId: string | null;
  onCancelMove: () => void;
  quickSaleSaveMode: boolean;
  onCancelQuickSaleSave: () => void;
  openCashPanel?: ReactNode;
};

type DragState = {
  pointerId: number;
  tableId: string;
  start: { x: number; y: number };
  initialTables: RestaurantTableMapItem[];
  currentTables: RestaurantTableMapItem[];
  memberIds: Set<string>;
  moved: boolean;
  proposal: JoinProposal<RestaurantTableMapItem> | null;
};
type Guidelines = { x: number | null; y: number | null };
type GroupMenu = { tableId: string; left: number; top: number };
type AreaSwipeState = { pointerId: number; startX: number; startY: number };
const SNAP_TOLERANCE = 0.7;
const MOBILE_MAP_TOP_INSET = 124;
const MOBILE_MAP_EDGE_INSET = 12;
const FIXED_MAP_PADDING = 16;
const AREA_SWIPE_VISUAL_STYLE = {
  opacity: "var(--area-swipe-opacity, 1)",
  transform: "translate3d(var(--area-swipe-offset-x, 0px), 0, 0)",
  transition: "var(--area-swipe-transition, none)",
} as const;

function elapsed(openedAt: string | null) {
  if (!openedAt) return "";
  const minutes = Math.max(
    0,
    Math.floor((Date.now() - new Date(openedAt).getTime()) / 60000),
  );
  return minutes < 60
    ? `${minutes} min`
    : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

function statusLabel(status: RestaurantTableMapItem["status"]) {
  return status === "free"
    ? "Libre"
    : status === "reserved"
      ? "Reservada"
      : "Ocupada";
}

function withGroupMembership(tables: RestaurantTableMapItem[]) {
  const members = new Map<string, string[]>();
  tables.forEach((table) => {
    if (table.layoutGroupId)
      members.set(table.layoutGroupId, [
        ...(members.get(table.layoutGroupId) ?? []),
        table.id,
      ]);
  });
  return tables.map((table) => ({
    ...table,
    layoutGroupTableIds: table.layoutGroupId
      ? (members.get(table.layoutGroupId) ?? [])
      : [],
  }));
}

export function TableMapView(props: Props) {
  const {
    canOpen,
    canQuickSale,
    isBusy,
    isOnline,
    map,
    mobileLayout,
    moveOrderId,
    onAreaChange,
    onCancelMove,
    onError,
    onCreateVirtual,
    onDeleteVirtual,
    onLayoutChange,
    onMove,
    onSaveQuickSale,
    onOpen,
    onOpenOrder,
    onQuickSale,
    openCashPanel,
    selectedAreaId,
    quickSaleSaveMode,
    onCancelQuickSaleSave,
  } = props;
  const tableSelectionMode = Boolean(moveOrderId || quickSaleSaveMode);
  const [editMode, setEditMode] = useState(false);
  const [selectedTableId, setSelectedTableId] = useState<string | null>(null);
  const [displayTables, setDisplayTables] = useState(map.tables);
  const [pendingIds, setPendingIds] = useState<string[] | null>(null);
  const [guestCount, setGuestCount] = useState("2");
  const parsedGuestCount = Number(guestCount);
  const hasValidGuestCount = Number.isFinite(parsedGuestCount) && parsedGuestCount > 0;
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [joinPreview, setJoinPreview] =
    useState<JoinProposal<RestaurantTableMapItem> | null>(null);
  const [guidelines, setGuidelines] = useState<Guidelines>({
    x: null,
    y: null,
  });
  const [groupMenu, setGroupMenu] = useState<GroupMenu | null>(null);
  const [savingLayout, setSavingLayout] = useState(false);
  const [virtualModalOpen, setVirtualModalOpen] = useState(false);
  const [canvasSize, setCanvasSize] = useState({ width: 0, height: 0 });
  const canvasRef = useRef<HTMLElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const areaSwipeRef = useRef<AreaSwipeState | null>(null);
  const areaSwipeAnimationFrameRef = useRef<number | null>(null);
  const previousLabelSidesRef = useRef(new Map<string, LabelSide>());
  const latestRevisionRef = useRef(map.layoutRevision ?? 0);
  const activeAreaId =
    selectedAreaId && map.areas.some((area) => area.id === selectedAreaId)
      ? selectedAreaId
      : map.areas[0]?.id;
  const activeArea = map.areas.find((area) => area.id === activeAreaId);
  const designWidth = activeArea?.canvasWidth ?? 1200;
  const designHeight = activeArea?.canvasHeight ?? 800;
  const mapInsets = useMemo(
    () => ({
      top: mobileLayout ? MOBILE_MAP_TOP_INSET : 0,
      right: mobileLayout ? MOBILE_MAP_EDGE_INSET : 0,
      bottom: mobileLayout ? MOBILE_MAP_EDGE_INSET : 0,
      left: mobileLayout ? MOBILE_MAP_EDGE_INSET : 0,
    }),
    [mobileLayout],
  );
  const rotatedMap = shouldRotateMapToFit(
    canvasSize.width,
    canvasSize.height,
    designWidth,
    designHeight,
    mapInsets,
  );
  const mapElements = useMemo(
    () => activeArea?.mapElements ?? [],
    [activeArea?.mapElements],
  );
  const planeSize = useMemo(
    () =>
      getMapPlaneSize(
        canvasSize.width,
        canvasSize.height,
        rotatedMap ? designHeight : designWidth,
        rotatedMap ? designWidth : designHeight,
      ),
    [
      canvasSize.height,
      canvasSize.width,
      designHeight,
      designWidth,
      rotatedMap,
    ],
  );
  const tables = useMemo(
    () => displayTables.filter((table) => table.areaId === activeAreaId),
    [activeAreaId, displayTables],
  );
  const fittedItems = useMemo(
    () => [
      ...map.tables.filter((table) => table.areaId === activeAreaId),
      ...mapElements,
    ].map((item) => orientMapRect(item, rotatedMap)),
    [activeAreaId, map.tables, mapElements, rotatedMap],
  );
  const viewport = useMemo(
    () => fitBoundsToViewport(
      contentBounds(fittedItems),
      canvasSize.width,
      canvasSize.height,
      planeSize.width,
      planeSize.height,
      mapInsets,
      FIXED_MAP_PADDING,
    ),
    [canvasSize.height, canvasSize.width, fittedItems, mapInsets, planeSize.height, planeSize.width],
  );
  const layoutGroups = useMemo(() => {
    const groups = new Map<string, RestaurantTableMapItem[]>();
    tables.forEach((table) => {
      if (table.layoutGroupId)
        groups.set(table.layoutGroupId, [
          ...(groups.get(table.layoutGroupId) ?? []),
          table,
        ]);
    });
    return [...groups.entries()].filter(([, members]) => members.length > 1);
  }, [tables]);
  const visualTables = useMemo(
    () =>
      tables.map((table) => ({
        table,
        rect: tableVisualRect(orientMapRect(table, rotatedMap), planeSize, viewport),
      })),
    [planeSize, rotatedMap, tables, viewport],
  );
  const contentModes = useMemo(
    () =>
      new Map(
        visualTables.map(({ table, rect }) => [
          table.id,
          tableContentMode(rect, table.name),
        ]),
      ),
    [visualTables],
  );
  const externalLabels = useMemo(() => {
    const inputs = visualTables
      .filter(({ table }) => contentModes.get(table.id) === "external")
      .map(({ table, rect }) => ({
        id: table.id,
        table: rect,
        label: externalLabelSize(table.name, mobileLayout),
      }));
    const reserved =
      canvasSize.width && canvasSize.height
        ? [
            ...(mobileLayout
              ? [{ x: 0, y: 0, width: canvasSize.width, height: MOBILE_MAP_TOP_INSET }]
              : []),
            ...(groupMenu
              ? [
                  {
                    x: groupMenu.left,
                    y: groupMenu.top,
                    width: Math.min(240, canvasSize.width - 16),
                    height: 220,
                  },
                ]
              : []),
          ]
        : [];
    return placeExternalLabels(
      inputs,
      visualTables.map(({ table, rect }) => ({ id: table.id, rect })),
      canvasSize,
      reserved,
      previousLabelSidesRef.current,
      Boolean(dragRef.current),
    );
  }, [canvasSize, contentModes, groupMenu, mobileLayout, visualTables]);
  const externalLabelTables = useMemo(
    () => new Map(tables.map((table) => [table.id, table])),
    [tables],
  );

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const updateSize = () => {
      const bounds = canvas.getBoundingClientRect();
      setCanvasSize((current) =>
        current.width === bounds.width && current.height === bounds.height
          ? current
          : { width: bounds.width, height: bounds.height },
      );
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    previousLabelSidesRef.current = new Map(
      externalLabels.map((label) => [label.id, label.side]),
    );
  }, [externalLabels]);

  useEffect(() => () => {
    if (areaSwipeAnimationFrameRef.current !== null) {
      cancelAnimationFrame(areaSwipeAnimationFrameRef.current);
    }
  }, []);

  useEffect(() => {
    setSelectedTableId(null);
    setGroupMenu(null);
  }, [activeAreaId]);

  useEffect(() => {
    const revision = map.layoutRevision ?? 0;
    if (!dragRef.current && revision >= latestRevisionRef.current) {
      latestRevisionRef.current = revision;
      setDisplayTables(map.tables);
    }
  }, [map]);

  useEffect(() => {
    const cancel = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (dragRef.current) {
        dragRef.current = null;
        setDisplayTables(map.tables);
        setDropTargetId(null);
        setJoinPreview(null);
        setGuidelines({ x: null, y: null });
      }
      setGroupMenu(null);
    };
    window.addEventListener("keydown", cancel);
    return () => window.removeEventListener("keydown", cancel);
  }, [map.tables]);

  function prepareOpenTable(table: RestaurantTableMapItem) {
    const ids = table.layoutGroupTableIds?.length
      ? table.layoutGroupTableIds
      : [table.id];
    setPendingIds(ids);
    setGuestCount(
      String(Math.max(
        1,
        ids.reduce(
          (total, id) =>
            total +
            (displayTables.find((item) => item.id === id)?.capacity ?? 0),
          0,
        ),
      )),
    );
  }

  function chooseTable(table: RestaurantTableMapItem) {
    if (!isOnline || isBusy || editMode) return;
    if (moveOrderId) {
      if (table.status === "free") void onMove(table.id);
      return;
    }
    if (quickSaleSaveMode) {
      if (table.status === "free") void onSaveQuickSale(table.id);
      return;
    }
    if (table.status === "occupied" && table.orderId)
      onOpenOrder(table.orderId);
    else if (table.status === "free" && canOpen) prepareOpenTable(table);
  }

  function startTableDrag(
    event: ReactPointerEvent<HTMLButtonElement>,
    table: RestaurantTableMapItem,
  ) {
    if (!editMode || savingLayout || !isOnline) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const bounds = canvasRef.current?.getBoundingClientRect();
    if (!bounds) return;
    const dragPlane = getMapPlaneSize(
      bounds.width,
      bounds.height,
      rotatedMap ? (activeArea?.canvasHeight ?? 800) : (activeArea?.canvasWidth ?? 1200),
      rotatedMap ? (activeArea?.canvasWidth ?? 1200) : (activeArea?.canvasHeight ?? 800),
    );
    const memberIds = new Set(getJoinedIds(table, displayTables));
    dragRef.current = {
      pointerId: event.pointerId,
      tableId: table.id,
      start: screenToMap(
        { x: event.clientX, y: event.clientY },
        { left: bounds.left, top: bounds.top, ...dragPlane },
        viewport,
        rotatedMap,
      ),
      initialTables: displayTables,
      currentTables: displayTables,
      memberIds,
      moved: false,
      proposal: null,
    };
    setGroupMenu(null);
  }

  function moveTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current,
      canvas = canvasRef.current;
    if (!drag || !canvas || drag.pointerId !== event.pointerId) return;
    event.preventDefault();
    const bounds = canvas.getBoundingClientRect();
    const dragPlane = getMapPlaneSize(
      bounds.width,
      bounds.height,
      rotatedMap ? (activeArea?.canvasHeight ?? 800) : (activeArea?.canvasWidth ?? 1200),
      rotatedMap ? (activeArea?.canvasWidth ?? 1200) : (activeArea?.canvasHeight ?? 800),
    );
    const current = screenToMap(
      { x: event.clientX, y: event.clientY },
      { left: bounds.left, top: bounds.top, ...dragPlane },
      viewport,
      rotatedMap,
    );
    const dx = current.x - drag.start.x,
      dy = current.y - drag.start.y;
    if (Math.hypot(dx, dy) > 0.25) drag.moved = true;
    const moved = translateComposition(
      drag.initialTables,
      drag.memberIds,
      dx,
      dy,
    );
    const source = moved.find((table) => table.id === drag.tableId);
    const alignment = source
      ? snapTableAlignment(
          source,
          moved.filter(
            (table) =>
              table.areaId === activeAreaId && !drag.memberIds.has(table.id),
          ),
          SNAP_TOLERANCE,
        )
      : null;
    const aligned =
      source && alignment
        ? translateComposition(
            moved,
            drag.memberIds,
            alignment.positionX - source.positionX,
            alignment.positionY - source.positionY,
          )
        : moved;
    const alignedSource = aligned.find((table) => table.id === drag.tableId);
    const areaProposal = findJoinProposal(
      moved.filter((table) => table.areaId === activeAreaId),
      drag.tableId,
      drag.memberIds,
    );
    const proposal = areaProposal
      ? {
          ...areaProposal,
          tables: moved.map(
            (table) =>
              areaProposal.tables.find(
                (candidate) => candidate.id === table.id,
              ) ?? table,
          ),
        }
      : null;
    drag.proposal = proposal;
    drag.currentTables = proposal ? moved : aligned;
    setDropTargetId(proposal?.targetId ?? null);
    setJoinPreview(proposal);
    setGuidelines(
      proposal || !alignment || !alignedSource
        ? { x: null, y: null }
        : {
            x:
              Math.abs(alignedSource.positionX - alignment.positionX) < 0.01
                ? alignment.guidelineX
                : null,
            y:
              Math.abs(alignedSource.positionY - alignment.positionY) < 0.01
                ? alignment.guidelineY
                : null,
          },
    );
    setDisplayTables(proposal ? moved : aligned);
  }

  async function persistTables(nextTables: RestaurantTableMapItem[]) {
    const nextMap = { ...map, tables: nextTables };
    setDisplayTables(nextTables);
    setSavingLayout(true);
    try {
      const saved = await onLayoutChange(
        layoutFromMap(nextMap),
        latestRevisionRef.current,
      );
      latestRevisionRef.current = saved.revision;
      setDisplayTables((current) =>
        withGroupMembership(
          current.map((table) => {
            const entry = saved.tables[table.id];
            return entry
              ? {
                  ...table,
                  positionX: entry.positionX,
                  positionY: entry.positionY,
                  layoutGroupId: entry.groupId,
                }
              : table;
          }),
        ),
      );
    } catch (error) {
      setDisplayTables(map.tables);
      onError(getReadableError(error));
    } finally {
      setSavingLayout(false);
    }
  }

  function finishTableDrag(event: ReactPointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDropTargetId(null);
    setJoinPreview(null);
    setGuidelines({ x: null, y: null });
    if (!drag.moved) {
      const table = displayTables.find((item) => item.id === drag.tableId);
      if (table?.isVirtual) {
        setSelectedTableId(table.id);
        return;
      }
      const canvas = canvasRef.current;
      if (table?.layoutGroupId && canvas) {
        const bounds = canvas.getBoundingClientRect();
        const pointerX = event.clientX - bounds.left;
        const pointerY = event.clientY - bounds.top;
        const menuWidth = Math.min(230, bounds.width - 16);
        const menuHeight = compositionHasOpenOrder(table, displayTables)
          ? 216
          : 146;
        const position = positionFloatingPanel(
          { x: pointerX, y: pointerY },
          bounds,
          { width: menuWidth, height: menuHeight },
        );
        setGroupMenu({
          tableId: table.id,
          left: position.x,
          top: position.y,
        });
      }
      return;
    }
    let nextTables = drag.proposal?.tables ?? drag.currentTables;
    if (drag.proposal) {
      const source = nextTables.find((table) => table.id === drag.tableId),
        target = nextTables.find(
          (table) => table.id === drag.proposal?.targetId,
        );
      if (source && target) {
        if (
          compositionHasOpenOrder(source, nextTables) ||
          compositionHasOpenOrder(target, nextTables)
        ) {
          onError(
            "No se puede modificar una composicion con una comanda abierta.",
          );
          setDisplayTables(map.tables);
          return;
        }
        const memberIds = new Set([
          source.id,
          target.id,
          ...(source.layoutGroupTableIds ?? []),
          ...(target.layoutGroupTableIds ?? []),
        ]);
        const occupiedOrders = new Set(
          nextTables
            .filter((table) => memberIds.has(table.id) && table.orderId)
            .map((table) => table.orderId),
        );
        if (occupiedOrders.size > 1) {
          onError("No se pueden unir mesas con comandas distintas.");
          setDisplayTables(map.tables);
          return;
        }
        const groupId =
          target.layoutGroupId ?? source.layoutGroupId ?? crypto.randomUUID();
        nextTables = withGroupMembership(
          nextTables.map((table) =>
            memberIds.has(table.id)
              ? { ...table, layoutGroupId: groupId }
              : table,
          ),
        );
      }
    }
    void persistTables(nextTables);
  }

  function separate(tableId: string, all: boolean) {
    const selected = displayTables.find((table) => table.id === tableId);
    if (!selected?.layoutGroupId) return;
    if (compositionHasOpenOrder(selected, displayTables)) {
      setGroupMenu(null);
      onError("No se pueden separar mesas con una comanda abierta.");
      return;
    }
    const next = withGroupMembership(
      separateFromComposition(displayTables, tableId, all),
    );
    setGroupMenu(null);
    void persistTables(next);
  }

  async function confirmOpen() {
    if (!pendingIds || !hasValidGuestCount) return;
    await onOpen(pendingIds, parsedGuestCount);
    setPendingIds(null);
  }

  function startAreaSwipe(event: ReactPointerEvent<HTMLElement>) {
    if (editMode || tableSelectionMode || map.areas.length < 2 || areaSwipeRef.current) return;
    if (
      event.target !== event.currentTarget &&
      !(event.target as HTMLElement).classList.contains("map-transform-layer")
    )
      return;
    if (areaSwipeAnimationFrameRef.current !== null) {
      cancelAnimationFrame(areaSwipeAnimationFrameRef.current);
      areaSwipeAnimationFrameRef.current = null;
    }
    updateAreaSwipeVisual(0, 1, false);
    areaSwipeRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function updateAreaSwipeVisual(offsetX: number, opacity: number, animate: boolean) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    canvas.style.setProperty(
      "--area-swipe-transition",
      animate && !reduceMotion
        ? "transform 160ms ease-out, opacity 160ms ease-out"
        : "none",
    );
    canvas.style.setProperty("--area-swipe-offset-x", `${offsetX}px`);
    canvas.style.setProperty("--area-swipe-opacity", String(opacity));
  }

  function moveAreaSwipe(event: ReactPointerEvent<HTMLElement>) {
    const swipe = areaSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    const feedback = getAreaSwipeVisualFeedback(
      event.clientX - swipe.startX,
      event.clientY - swipe.startY,
      canvasSize.width,
    );
    updateAreaSwipeVisual(feedback.offsetX, feedback.opacity, false);
  }

  function finishAreaSwipe(event: ReactPointerEvent<HTMLElement>) {
    const swipe = areaSwipeRef.current;
    if (!swipe || swipe.pointerId !== event.pointerId) return;
    areaSwipeRef.current = null;
    const targetAreaId = getAreaSwipeTarget(
      map.areas.map((area) => area.id),
      activeAreaId,
      event.clientX - swipe.startX,
      event.clientY - swipe.startY,
      canvasSize.width,
    );
    if (!targetAreaId || targetAreaId === activeAreaId) {
      updateAreaSwipeVisual(0, 1, true);
      return;
    }
    setSelectedTableId(null);
    setGroupMenu(null);
    const entryOffset = getAreaSwipeEntryOffset(
      event.clientX - swipe.startX,
      canvasSize.width,
    );
    onAreaChange(targetAreaId);
    updateAreaSwipeVisual(entryOffset, 0.92, false);
    areaSwipeAnimationFrameRef.current = requestAnimationFrame(() => {
      areaSwipeAnimationFrameRef.current = null;
      updateAreaSwipeVisual(0, 1, true);
    });
  }

  function cancelAreaSwipe(event: ReactPointerEvent<HTMLElement>) {
    if (areaSwipeRef.current?.pointerId !== event.pointerId) return;
    areaSwipeRef.current = null;
    updateAreaSwipeVisual(0, 1, true);
  }

  async function confirmDeleteVirtual() {
    if (!selectedTable?.isVirtual) return;
    const deleted = await onDeleteVirtual(selectedTable.id);
    if (deleted) setSelectedTableId(null);
  }

  function toggleEditMode() {
    setEditMode((value) => !value);
    setSelectedTableId(null);
    setGroupMenu(null);
  }

  function openVirtualTableModal() {
    setVirtualModalOpen(true);
  }

  const groupMenuTable = groupMenu
    ? displayTables.find((table) => table.id === groupMenu.tableId)
    : null;
  const groupMenuLocked = groupMenuTable
    ? compositionHasOpenOrder(groupMenuTable, displayTables)
    : false;
  const selectedTable = selectedTableId
    ? displayTables.find((table) => table.id === selectedTableId) ?? null
    : null;
  const pendingReservation =
    pendingIds
      ?.map(
        (id) => map.tables.find((table) => table.id === id)?.nextReservation,
      )
      .find(
        (reservation) =>
          reservation &&
          (reservation.status === "arrived" ||
            new Date(reservation.startsAt).getTime() - Date.now() <=
              60 * 60_000),
      ) ?? null;

  return (
    <main className={`flex min-h-0 flex-1 flex-col ${mobileLayout ? 'gap-0 overflow-hidden p-0' : 'gap-3.5 overflow-y-auto overscroll-contain [-webkit-overflow-scrolling:touch] p-[18px]'}`}>
      {!mobileLayout ? <header className="flex items-center justify-between gap-[18px] [&_h1]:m-0 [&_h1]:text-2xl [&_p]:mb-0 [&_p]:mt-1 [&_p]:text-[var(--muted)]">
        <div>
          <h1>Mapa de mesas</h1>
        </div>
        <nav className="flex gap-2 overflow-x-auto pb-0.5 [&>button]:min-h-[42px] [&>button]:whitespace-nowrap [&>button]:rounded-full [&>button]:border [&>button]:border-[var(--separator)] [&>button]:bg-[var(--surface)] [&>button]:px-[18px] [&>button]:font-extrabold [&>button]:text-[var(--foreground)]" aria-label="Zonas">
          {map.areas.map((area) => (
            <UiButton
              aria-current={area.id === activeAreaId ? "page" : undefined}
              className={area.id === activeAreaId ? "!border-[var(--accent)] !bg-[var(--accent)] !text-[var(--accent-foreground)] shadow-[0_0_0_3px_color-mix(in_srgb,var(--accent)_22%,transparent)]" : ""}
              key={area.id}
              onClick={() => onAreaChange(area.id)}
              type="button"
            >
              {area.name}
            </UiButton>
          ))}
        </nav>
        <div className="flex gap-2.5 max-[760px]:grid max-[760px]:grid-cols-2">
          <UiButton
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45"
            disabled={!isOnline || isBusy || !canOpen || tableSelectionMode}
            onClick={openVirtualTableModal}
            type="button"
          >
            <Plus size={18} /> Mesa virtual
          </UiButton>
          <UiButton
            className={`inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border bg-[var(--surface)] px-4 font-extrabold disabled:opacity-45 ${editMode ? "border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--accent)]" : "border-[var(--separator)] text-[var(--foreground)]"}`}
            disabled={!isOnline || isBusy || tableSelectionMode}
            onClick={toggleEditMode}
            type="button"
          >
            {editMode ? <Check size={18} /> : <Pencil size={18} />}
            {editMode ? "Finalizar edición" : "Editar mesas"}
          </UiButton>
          {canQuickSale ? (
            <UiButton
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45"
              disabled={tableSelectionMode}
              onClick={() => onQuickSale(activeAreaId)}
              type="button"
            >
              <ShoppingBag size={18} /> Venta rápida
            </UiButton>
          ) : null}
        </div>
      </header> : null}
      {!isOnline ? (
        <div className="rounded-[var(--radius)] border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-[11px] font-bold text-[var(--warning)]">
          La gestión de mesas requiere conexión. La venta rápida sigue
          disponible.
        </div>
      ) : null}
      {!canOpen ? (
        <div className="rounded-[var(--radius)] border border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_12%,var(--surface))] px-3.5 py-[11px] font-bold text-[var(--warning)]">
          Abre una caja para poder abrir o cobrar comandas.
        </div>
      ) : null}
      {!canOpen && openCashPanel ? (
        <div className="contents">{openCashPanel}</div>
      ) : null}
      {tableSelectionMode ? (
        <div className="flex items-center gap-2.5 rounded-[var(--radius)] bg-[var(--accent-soft)] px-3.5 py-2.5 font-bold text-[var(--foreground)] max-[760px]:flex-wrap max-[760px]:items-start [&>span]:flex-1 max-[760px]:[&>span]:min-w-[70%] [&>button]:inline-flex [&>button]:items-center [&>button]:gap-1.5 [&>button]:rounded-md [&>button]:border-0 [&>button]:bg-[var(--surface)] [&>button]:px-3 [&>button]:py-2 [&>button]:font-extrabold [&>button]:text-[var(--foreground)]">
          {quickSaleSaveMode ? <Save size={18} /> : <ArrowRightLeft size={18} />}
          <span>{quickSaleSaveMode ? "Selecciona una mesa libre para guardar la comanda." : "Selecciona una mesa libre como destino."}</span>
          <UiButton onClick={quickSaleSaveMode ? onCancelQuickSaleSave : onCancelMove} type="button">
            <X size={16} /> Cancelar
          </UiButton>
        </div>
      ) : null}

      <section
        className={`relative flex-1 touch-none overflow-hidden border border-[var(--separator)] bg-[radial-gradient(var(--separator)_1px,transparent_1px)] bg-[length:22px_22px] bg-[var(--surface-secondary)] ${mobileLayout ? 'min-h-0 rounded-none border-x-0 border-b-0 shadow-none' : 'min-h-[560px] rounded-[var(--radius)] shadow-[var(--shadow)]'}`}
        onPointerDown={startAreaSwipe}
        onPointerMove={(event) => {
          moveAreaSwipe(event);
          moveTableDrag(event);
        }}
        onPointerUp={(event) => {
          finishTableDrag(event);
          finishAreaSwipe(event);
        }}
        onPointerCancel={(event) => {
          finishTableDrag(event);
          cancelAreaSwipe(event);
        }}
        ref={canvasRef}
      >
        {mobileLayout ? (
          <MobileTableMapChrome
            activeAreaId={activeAreaId}
            areas={map.areas}
            canQuickSale={canQuickSale}
            canCreateVirtual={canOpen && isOnline && !isBusy && !tableSelectionMode}
            editDisabled={!isOnline || isBusy || tableSelectionMode}
            editMode={editMode}
            onAreaChange={(areaId) => {
              setSelectedTableId(null);
              onAreaChange(areaId);
            }}
            onEditToggle={toggleEditMode}
            onCreateVirtual={openVirtualTableModal}
            onQuickSale={() => onQuickSale(activeAreaId)}
          />
        ) : null}
        <svg aria-hidden="true" className="pointer-events-none absolute inset-0 z-[1] size-full overflow-hidden [&_line]:stroke-[color-mix(in_srgb,var(--foreground)_52%,transparent)] [&_line]:[stroke-width:1.25] [&_line]:[vector-effect:non-scaling-stroke] [&_circle]:fill-[var(--foreground)] [&_circle]:stroke-[var(--surface)] [&_circle]:[stroke-width:1]" style={AREA_SWIPE_VISUAL_STYLE}>
          {!mobileLayout ? externalLabels.map((label) => {
            const table = externalLabelTables.get(label.id);
            return (
              <g
                className={(() => { const status = table ? getRestaurantTableVisualStatus(table) : "free"; return status === "free" ? "[&_line]:stroke-[var(--success)] [&_circle]:stroke-[var(--success)]" : status === "occupied" ? "[&_line]:stroke-[var(--danger)] [&_circle]:stroke-[var(--danger)]" : "[&_line]:stroke-[var(--warning)] [&_circle]:stroke-[var(--warning)]" })()}
                key={label.id}
              >
                <line
                  x1={label.connector.from.x}
                  x2={label.connector.to.x}
                  y1={label.connector.from.y}
                  y2={label.connector.to.y}
                />
                <circle
                  cx={label.connector.from.x}
                  cy={label.connector.from.y}
                  r="2.5"
                />
              </g>
            );
          }) : null}
        </svg>
        <div
          className="map-transform-layer absolute z-[2]"
          style={{
            ...AREA_SWIPE_VISUAL_STYLE,
            width: planeSize.width * viewport.zoom,
            height: planeSize.height * viewport.zoom,
            left: viewport.panX,
            top: viewport.panY,
          }}
        >
          {mapElements.map((element) => {
            const orientedElement = orientMapRect(element, rotatedMap);
            return (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute z-0 ${element.kind === "wall" ? "rounded-[3px] bg-[repeating-linear-gradient(90deg,#64748b_0_18px,#94a3b8_18px_20px)] shadow-[inset_0_0_0_1px_rgba(15,23,42,.28)]" : element.kind === "column" ? "box-border rounded-full border-[3px] border-[#64748b] bg-[repeating-linear-gradient(45deg,#cbd5e1_0_5px,#94a3b8_5px_7px)]" : "flex items-center justify-center overflow-hidden text-center font-black tracking-[.04em] text-[var(--muted)] [&>span]:truncate"}`}
              key={element.id}
              style={{
                left: `${orientedElement.positionX}%`,
                top: `${orientedElement.positionY}%`,
                width: `${orientedElement.width}%`,
                height: `${orientedElement.height}%`,
              }}
            >
              {element.kind === "text" ? <span>{element.text}</span> : null}
            </div>
            );
          })}
          {guidelines.x !== null ? (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute z-20 bg-[color-mix(in_srgb,var(--accent)_72%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--surface)_55%,transparent)] ${rotatedMap ? 'inset-x-0 h-px -translate-y-px' : 'inset-y-0 w-px -translate-x-px'}`}
              style={rotatedMap ? { top: `${guidelines.x}%` } : { left: `${guidelines.x}%` }}
            />
          ) : null}
          {guidelines.y !== null ? (
            <div
              aria-hidden="true"
              className={`pointer-events-none absolute z-20 bg-[color-mix(in_srgb,var(--accent)_72%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--surface)_55%,transparent)] ${rotatedMap ? 'inset-y-0 w-px -translate-x-px' : 'inset-x-0 h-px -translate-y-px'}`}
              style={rotatedMap ? { left: `${100 - guidelines.y}%` } : { top: `${guidelines.y}%` }}
            />
          ) : null}
          {layoutGroups.map(([groupId, members]) => {
            const bounds = boundsOf(members.map((table) => orientMapRect(table, rotatedMap)));
            return (
              <div
                aria-hidden="true"
                className={`pointer-events-none absolute z-0 rounded-xl border border-[color-mix(in_srgb,var(--foreground)_18%,transparent)] shadow-[0_0_0_6px_color-mix(in_srgb,var(--surface)_55%,transparent)] ${editMode ? "opacity-55" : "opacity-15"}`}
                key={groupId}
                style={{
                  left: `${bounds.left}%`,
                  top: `${bounds.top}%`,
                  width: `${bounds.right - bounds.left}%`,
                  height: `${bounds.bottom - bounds.top}%`,
                }}
              />
            );
          })}
          {joinPreview
            ? joinPreview.tables
                .filter((table) => dragRef.current?.memberIds.has(table.id))
                .map((table) => {
                  const orientedTable = orientMapRect(table, rotatedMap);
                  return (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute z-[4] rounded-[9px] border-2 border-[color-mix(in_srgb,var(--accent)_72%,transparent)] bg-[color-mix(in_srgb,var(--accent)_12%,transparent)]"
                    key={`preview-${table.id}`}
                    style={{
                      left: `${orientedTable.positionX}%`,
                      top: `${orientedTable.positionY}%`,
                      width: `${orientedTable.width}%`,
                      height: `${orientedTable.height}%`,
                    }}
                  />
                  );
                })
            : null}
          {tables.map((table) => {
            const orientedTable = orientMapRect(table, rotatedMap);
            const mode = mobileLayout ? "compact" : contentModes.get(table.id) ?? "full";
            const visualStatus = getRestaurantTableVisualStatus(table);
            const isDropTarget = dropTargetId === table.id || Boolean(table.layoutGroupId && displayTables.find((item) => item.id === dropTargetId)?.layoutGroupId === table.layoutGroupId);
            const isUnavailable = tableSelectionMode && table.status !== "free";
            return (
              <UiButton
                aria-label={`${table.name}, ${statusLabel(table.status)}${table.layoutGroupId ? ", juntada" : ""}`}
                className={`absolute z-[2] flex min-h-0 min-w-0 flex-col items-center justify-center gap-[3px] overflow-visible border-2 p-0 leading-[1.2] text-[var(--foreground)] shadow-[0_8px_18px_rgba(17,24,39,.12)] ${mobileLayout ? "p-1.5" : ""} ${editMode ? "touch-none cursor-grab active:cursor-grabbing" : ""} ${visualStatus === "free" ? "border-[var(--success)] bg-[var(--success-soft)]" : visualStatus === "occupied" ? "border-[var(--danger)] bg-[var(--danger-soft)]" : "border-[var(--warning)] bg-[color-mix(in_srgb,var(--warning)_15%,var(--surface))]"} ${table.shape === "round" ? "rounded-full" : table.shape === "square" ? "rounded-[10px]" : "rounded-[7px]"} ${isDropTarget ? "border-[var(--accent)] outline-[3px] outline-[color-mix(in_srgb,var(--accent)_38%,transparent)] shadow-[0_0_0_5px_color-mix(in_srgb,var(--accent)_10%,transparent)]" : ""} ${mobileLayout && selectedTableId === table.id ? "ring-4 ring-[color-mix(in_srgb,var(--accent)_48%,transparent)] ring-offset-2 ring-offset-[var(--surface-secondary)]" : ""} ${isUnavailable ? "opacity-35" : editMode && joinPreview ? "opacity-70" : ""} ${viewport.zoom < 0.75 ? "gap-px p-1.5" : ""}`}
                disabled={isUnavailable}
                key={table.id}
                onClick={() => chooseTable(table)}
                onPointerDown={(event) => startTableDrag(event, table)}
                style={{
                  left: `${orientedTable.positionX}%`,
                  top: `${orientedTable.positionY}%`,
                  width: `${orientedTable.width}%`,
                  height: `${orientedTable.height}%`,
                }}
                type="button"
              >
                {mode !== "external" ? (
                  <span className={`pointer-events-none absolute inset-0 box-border flex max-w-none flex-col items-center justify-center gap-[3px] overflow-hidden px-2 py-[9px] whitespace-normal ${mode === "compact" || viewport.zoom < 0.75 || mobileLayout ? "p-[5px]" : ""} [&>b]:text-[15px] [&>b]:leading-[1.25] [&>small]:flex [&>small]:max-w-full [&>small]:items-center [&>small]:gap-[3px] [&>small]:text-[11px] [&>small]:leading-[1.25] [&>small]:text-[var(--muted)] ${mobileLayout ? "[&>small]:hidden [&>em]:hidden" : ""} [&>small_svg]:shrink-0 [&>em]:rounded-full [&>em]:bg-[var(--surface)] [&>em]:px-1.5 [&>em]:py-0.5 [&>em]:text-[9px] [&>em]:not-italic [&>em]:font-extrabold` }>
                    <span className={`flex w-full max-w-none flex-col items-center whitespace-normal ${mode === "compact" ? "gap-0" : "gap-px"} [&>strong]:w-full [&>strong]:truncate [&>strong]:font-extrabold [&>strong]:leading-[1.2] ${mobileLayout ? "[&>strong]:text-[11px]" : "[&>strong]:text-[15px]"}`}>
                      <strong title={table.name}>{table.name}</strong>
                      {table.isVirtual && mode === "full" ? <em className="text-[9px] not-italic font-extrabold uppercase tracking-wide text-[var(--accent)]">Temporal</em> : null}
                      {!mobileLayout || table.status !== "free" ? (
                        <span className={`max-w-full truncate font-bold leading-[1.25] ${mobileLayout ? "text-[10px]" : "text-[11px]"} ${mode === "compact" ? "text-[9px]" : ""} ${viewport.zoom < 0.75 ? "text-[10px]" : ""}`}>
                          {statusLabel(table.status)}
                        </span>
                      ) : null}
                    </span>
                    {mode === "full" && table.status === "occupied" ? (
                      <>
                        <b>{formatCurrency(table.totalCents)}</b>
                        <small>
                          <Users aria-hidden="true" size={14} />{" "}
                          {table.guestCount} comensales ·{" "}
                          {elapsed(table.orderOpenedAt)}
                        </small>
                        <small>
                          {table.readyUnits
                            ? `${table.readyUnits} listo${table.readyUnits === 1 ? '' : 's'}`
                            : table.pendingUnits
                              ? `${table.pendingUnits} por servir`
                            : "Todo servido"}
                        </small>
                      </>
                    ) : mode === "full" ? (
                      <small>
                        <Users aria-hidden="true" size={14} /> {table.capacity}{" "}
                        plazas
                      </small>
                    ) : null}
                    {dropTargetId === table.id ? (
                      <em className="absolute inset-x-[7px] bottom-[7px] min-h-[22px] bg-[var(--accent)] px-[7px] py-1 text-[10px] leading-[14px] text-[var(--accent-foreground)]">Soltar para juntar</em>
                    ) : null}
                  </span>
                ) : (
                  <span aria-hidden="true" className={`block size-[9px] rounded-full border-2 border-[color-mix(in_srgb,var(--surface)_75%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--foreground)_35%,transparent)] ${visualStatus === "free" ? "bg-[var(--success)]" : visualStatus === "occupied" ? "bg-[var(--danger)]" : "bg-[var(--warning)]"}` } />
                )}
                {table.nextReservation ? (
                  <ReservationTableBadge
                    compact={mobileLayout}
                    count={table.reservationCount}
                    onClick={() =>
                      props.onOpenReservation(table.nextReservation!.id)
                    }
                    reservation={table.nextReservation}
                  />
                ) : null}
              </UiButton>
            );
          })}
          {!tables.length ? (
            <div className="absolute inset-0 grid place-items-center font-extrabold text-[var(--muted)]">
              No hay mesas activas en esta zona.
            </div>
          ) : null}
        </div>
        {!mobileLayout ? <div aria-hidden="true" className="pointer-events-none absolute inset-0 z-[5] size-full overflow-hidden" style={AREA_SWIPE_VISUAL_STYLE}>
          {externalLabels.map((label) => {
            const table = externalLabelTables.get(label.id);
            if (!table) return null;
            return (
              <div
                className={`pointer-events-none absolute box-border flex flex-col justify-center rounded-lg border border-l-[3px] border-[var(--separator)] bg-[color-mix(in_srgb,var(--surface)_97%,transparent)] leading-[1.2] text-[var(--foreground)] shadow-[0_3px_10px_rgba(0,0,0,.16)] ${mobileLayout ? "min-w-20 max-w-[140px] px-2 py-1 [&>strong]:text-xs [&>span]:text-[9px]" : "min-w-24 max-w-[168px] px-[9px] py-[5px] [&>strong]:text-[13px] [&>span]:text-[10px]"} ${getRestaurantTableVisualStatus(table) === "free" ? "border-l-[var(--success)]" : getRestaurantTableVisualStatus(table) === "occupied" ? "border-l-[var(--danger)]" : "border-l-[var(--warning)]"} [&>strong]:block [&>strong]:truncate [&>strong]:font-extrabold [&>span]:truncate [&>span]:font-bold [&>span]:text-[var(--muted)]`}
                key={label.id}
                style={{
                  left: label.rect.x,
                  top: label.rect.y,
                  width: label.rect.width,
                  height: label.rect.height,
                }}
              >
                <strong title={table.name}>{table.name}</strong>
                <span>{statusLabel(table.status)}</span>
              </div>
            );
          })}
        </div> : null}
        {editMode && groupMenu && !mobileLayout ? (
          <div
            className="absolute right-auto z-30 grid min-w-[220px] gap-[5px] rounded-[10px] border border-[var(--separator)] bg-[var(--surface)] p-2 shadow-[var(--shadow)] max-[760px]:min-w-[min(230px,calc(100%-16px))] [&>strong]:px-2 [&>strong]:py-1.5 [&>strong]:text-[13px] [&>p]:m-0 [&>p]:max-w-[230px] [&>p]:px-2 [&>p]:pb-[7px] [&>p]:pt-1 [&>p]:text-xs [&>p]:leading-[1.35] [&>p]:text-[var(--muted)] [&>button]:flex [&>button]:min-h-10 [&>button]:items-center [&>button]:gap-2 [&>button]:rounded-[7px] [&>button]:border-0 [&>button]:bg-transparent [&>button]:px-[9px] [&>button]:font-bold [&>button]:text-[var(--foreground)] [&>button]:hover:bg-[var(--accent-soft)] [&>button]:hover:outline-2 [&>button]:hover:outline-[var(--accent)] [&>button]:focus-visible:bg-[var(--accent-soft)] [&>button]:focus-visible:outline-2 [&>button]:focus-visible:outline-[var(--accent)] [&>button]:disabled:cursor-not-allowed [&>button]:disabled:opacity-45"
            style={{ left: groupMenu.left, top: groupMenu.top }}
          >
            <strong>{groupMenuTable?.name}</strong>
            {groupMenuLocked ? (
              <p>
                La comanda está abierta. Cobra o cancela la comanda antes de
                separar las mesas.
              </p>
            ) : null}
            <UiButton
              disabled={groupMenuLocked}
              onClick={() => separate(groupMenu.tableId, false)}
              type="button"
            >
              <Unlink size={16} /> Separar esta mesa
            </UiButton>
            <UiButton
              disabled={groupMenuLocked}
              onClick={() => separate(groupMenu.tableId, true)}
              type="button"
            >
              <Unlink size={16} /> Separar todas las mesas
            </UiButton>
          </div>
        ) : null}
      </section>
      {mobileLayout && editMode && groupMenu && groupMenuTable ? (
        <MobileGroupActionsSheet
          locked={groupMenuLocked}
          onClose={() => setGroupMenu(null)}
          onSeparateAll={() => separate(groupMenu.tableId, true)}
          onSeparateOne={() => separate(groupMenu.tableId, false)}
          tableName={groupMenuTable.name}
        />
      ) : null}
      {editMode && selectedTable?.isVirtual ? (
        <AppModal
          containerClassName={mobileLayout ? "!p-0" : "!p-4"}
          dialogClassName={mobileLayout ? "!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0" : ""}
          dismissDisabled={isBusy}
          label="Eliminar mesa temporal"
          maxWidth={448}
          onClose={() => setSelectedTableId(null)}
          placement={mobileLayout ? "bottom" : "center"}
        >
          <section className={`w-full max-w-[440px] bg-[var(--surface)] text-[var(--foreground)] [&_h2]:mb-2 [&_h2]:mt-0 [&_p]:mb-0 [&_p]:mt-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&>div]:mt-[22px] [&>div]:flex [&>div]:justify-end [&>div]:gap-2.5 ${mobileLayout ? "rounded-t-[20px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5" : "rounded-[var(--radius)] border border-[var(--separator)] p-6 shadow-[var(--shadow)]"}`}>
            <h2>Eliminar {selectedTable.name}</h2>
            <p>
              {selectedTable.status === "occupied"
                ? "La comanda sin cobrar se cancelará y la mesa temporal desaparecerá del turno."
                : "La mesa temporal desaparecerá del turno."}
            </p>
            <div>
              <UiButton
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45"
                disabled={isBusy}
                onClick={() => setSelectedTableId(null)}
                type="button"
              >
                Cancelar
              </UiButton>
              <UiButton
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger)] px-4 font-extrabold text-white disabled:opacity-45"
                disabled={isBusy || !isOnline}
                onClick={() => void confirmDeleteVirtual()}
                type="button"
              >
                <Trash2 size={17} /> Eliminar mesa
              </UiButton>
            </div>
          </section>
        </AppModal>
      ) : null}
      {pendingIds ? (
        <AppModal containerClassName={mobileLayout ? "!p-0" : "!p-4"} dialogClassName={mobileLayout ? "!rounded-b-none !rounded-t-[20px] !border-x-0 !border-b-0" : ""} maxWidth={448} dismissDisabled={isBusy} label="Abrir mesa" onClose={() => setPendingIds(null)} placement={mobileLayout ? "bottom" : "center"}>
          <section className={`w-full  max-w-[440px] bg-[var(--surface)] text-[var(--foreground)] [&_h2]:mb-2 [&_h2]:mt-0 [&_p]:mb-[18px] [&_p]:mt-0 [&_p]:leading-6 [&_p]:text-[var(--muted)] [&_label]:grid [&_label]:gap-[7px] [&_label]:font-extrabold [&_input]:min-h-12 [&_input]:rounded-[var(--radius)] [&_input]:border [&_input]:border-[var(--field-border)] [&_input]:bg-[var(--field)] [&_input]:px-3 [&_input]:text-lg [&_input]:text-[var(--field-foreground)] [&>div]:mt-[22px] [&>div]:flex [&>div]:justify-end [&>div]:gap-2.5 ${mobileLayout ? "rounded-t-[20px] px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pt-5" : "rounded-[var(--radius)] border border-[var(--separator)] p-6 shadow-[var(--shadow)]"}`}>
            <h2 className="font-extrabold">
              {pendingIds.length > 1
                ? `Abrir ${pendingIds.length} mesas juntas`
                : map.tables.find((table) => table.id === pendingIds[0])?.name}
            </h2>
            <p className="!text-red-600">
              {pendingReservation
                ? `Esta mesa tiene una reserva a las ${new Intl.DateTimeFormat("es", { hour: "2-digit", minute: "2-digit" }).format(new Date(pendingReservation.startsAt))} para ${pendingReservation.customerName}.`
                : null}
            </p>
            {pendingReservation?.status === "arrived" ? (
              <UiButton
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45"
                onClick={() => {
                  setPendingIds(null);
                  props.onOpenReservation(pendingReservation.id);
                }}
                type="button"
              >
                Sentar reserva
              </UiButton>
            ) : null}
            <label className="!font-normal">
              Número de comensales
              <UiInput
                autoFocus
                min="1"
                onChange={(event) => setGuestCount(event.target.value)}
                type="number"
                value={guestCount}
              />
            </label>
            <div>
              <UiButton
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--surface)] px-4 font-extrabold text-[var(--foreground)] disabled:opacity-45"
                onClick={() => setPendingIds(null)}
                type="button"
              >
                Cancelar
              </UiButton>
              <UiButton
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--accent)] px-4 font-extrabold text-[var(--accent-foreground)] disabled:opacity-45"
                disabled={isBusy || !isOnline || !canOpen || !hasValidGuestCount}
                onClick={() => void confirmOpen()}
                type="button"
              >
                {pendingReservation ? "Abrir igualmente" : "Abrir mesa"}
              </UiButton>
            </div>
          </section>
        </AppModal>
      ) : null}
      {virtualModalOpen ? <VirtualTableModal
        areas={map.areas}
        defaultAreaId={activeAreaId?.startsWith('virtual:') ? undefined : activeAreaId}
        defaultName={`Mesa extra ${map.tables.filter((table) => table.isVirtual).length + 1}`}
        isBusy={isBusy}
        isOnline={isOnline}
        mobileLayout={mobileLayout}
        onClose={() => setVirtualModalOpen(false)}
        onSubmit={onCreateVirtual}
      /> : null}
    </main>
  );
}
