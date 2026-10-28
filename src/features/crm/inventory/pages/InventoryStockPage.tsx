import { Pencil, Plus, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "../../../../components/ui";
import { formatMoney } from "../../../../lib/format";
import type { TenantContext } from "../../../../types";
import { CrmModal } from "../../shared/components/CrmModal";
import { useCrmModalBusy } from "../../shared/components/CrmModalBusyContext";
import { EmptyList } from "../../shared/components/EmptyList";
import type { RunAction } from "../../shared/types";
import {
  buildInventoryStockTotalChanges,
  formatInventoryQuantity,
  parseInventoryStockQuantity,
} from "../inventoryModel";
import {
  loadInventoryStockPageData,
  saveInventoryItemStock,
  setVenueInventoryEnabled,
} from "../services/inventoryService";
import type { InventorySnapshot } from "../types";
import { StockOverview, StockQuantity, StockStatus, StockTarget } from "../components/StockOverview";
import { InventoryItemHistory } from "../components/InventoryItemHistory";
import { InventoryItemEditor } from "../components/InventoryItemEditor";
import { InventoryItemSummary } from "../components/InventoryItemSummary";
import { buildStockRows, type StockRow } from "../stockControlModel";
import { QuickStockReplenishment } from "../components/QuickStockReplenishment";

type Props = {
  disabled: boolean;
  inventoryEnabled: boolean;
  onInventoryEnabledChange: () => Promise<void>;
  runAction: RunAction;
  selectedVenueId: string;
  tenantContext: TenantContext;
  dayChangeTime: string | null;
  timeZone: string;
};

const emptySnapshot: InventorySnapshot = {
  items: [],
  itemRoutes: [],
  levels: [],
  modifierEffects: [],
  productionRecipeLines: [],
  productionRecipes: [],
  recipeLines: [],
  recipes: [],
  units: [],
  warehouses: [],
};

export function InventoryStockCrm({
  disabled,
  inventoryEnabled,
  onInventoryEnabledChange,
  runAction,
  selectedVenueId,
  tenantContext,
  dayChangeTime,
  timeZone,
}: Props) {
  const modalBusy = useCrmModalBusy(disabled)

  const [snapshot, setSnapshot] = useState<InventorySnapshot>(emptySnapshot);
  const [initialWarehouseId, setInitialWarehouseId] = useState<string>();
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [quickReplenishment, setQuickReplenishment] = useState<StockRow | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const [detailMode, setDetailMode] = useState<'stock' | 'configuration'>('stock');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!selectedVenueId || !inventoryEnabled) {
      setSnapshot(emptySnapshot);
      setLoadState('loading');
      return;
    }
    setLoadState('loading');
    try {
      const next = { ...emptySnapshot, ...(await loadInventoryStockPageData(tenantContext, selectedVenueId)) };
      setSnapshot(next);
      setLoadState('ready');
      return next;
    } catch (cause) {
      setLoadState('error');
      throw cause;
    }
  }, [inventoryEnabled, selectedVenueId, tenantContext]);

  useEffect(() => {
    void runAction(async () => { await refresh(); });
  }, [refresh, runAction]);

  const selectedRows = useMemo(() => buildStockRows(snapshot).filter((row) => row.item.id === selectedId), [snapshot, selectedId]);

  const selected = snapshot.items.find((item) => item.id === selectedId);
  const selectedUnit = snapshot.units.find(
    (unit) => unit.id === selected?.baseUnitId,
  );
  const selectedStockByWarehouse = useMemo(
    () =>
      new Map(
        snapshot.levels
          .filter((level) => level.inventoryItemId === selectedId)
          .map((level) => [level.warehouseId, level.quantity]),
      ),
    [selectedId, snapshot.levels],
  );
  const selectedRoutes = snapshot.itemRoutes
    .filter((route) => route.inventoryItemId === selectedId && route.enabled)
    .toSorted((a, b) => a.priority - b.priority);
  const decimalPlaces = selectedUnit?.decimalPlaces ?? 6;
  const unitLabel = selectedUnit?.symbol ?? selectedUnit?.name ?? "";
  let totalChanges: ReturnType<typeof buildInventoryStockTotalChanges> | null = null;
  try {
    totalChanges = buildInventoryStockTotalChanges(selectedRoutes.map((route) => ({ warehouseId: route.warehouseId, quantity: selectedStockByWarehouse.get(route.warehouseId) ?? 0 })), quantities, decimalPlaces);
  } catch { /* Invalid drafts are explained beside their warehouse input. */ }

  function open(itemId: string, warehouseId?: string) {
    setCreatingItem(false);
    setDetailMode('stock');
    setSelectedId(itemId);
    setInitialWarehouseId(warehouseId);
    setRequestId(crypto.randomUUID());
    setQuantities(
      Object.fromEntries(
        snapshot.warehouses.map((warehouse) => [warehouse.id, String(snapshot.levels.find((level) => level.inventoryItemId === itemId && level.warehouseId === warehouse.id)?.quantity ?? 0)]),
      ),
    );
    setError(null);
  }

  async function itemSaved(itemId: string) {
    // Close the saved draft before refreshing: a failed read must not invite
    // creating the same article again after its write has already committed.
    setCreatingItem(false);
    setSelectedId(null);
    await refresh();
    open(itemId);
  }

  async function reloadTotals() {
    await runAction(async () => {
      const next = await refresh();
      if (!next) return;
      setQuantities(Object.fromEntries(next.warehouses.map((warehouse) => [warehouse.id, String(next.levels.find((level) => level.inventoryItemId === selectedId && level.warehouseId === warehouse.id)?.quantity ?? 0)])));
      setRequestId(crypto.randomUUID());
      setError(null);
    });
  }

  async function save() {
    if (!selected) return;
    try {
      const levels = buildInventoryStockTotalChanges(selectedRoutes.map((route) => ({ warehouseId: route.warehouseId, quantity: selectedStockByWarehouse.get(route.warehouseId) ?? 0 })), quantities, decimalPlaces);
      if (!levels.length) return;
      await runAction(async () => {
        await saveInventoryItemStock(
          tenantContext,
          selectedVenueId,
          selected.id,
          levels,
          { mode: "set", requestId },
        );
        setSelectedId(null);
        await refresh();
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cantidad no válida.");
    }
  }

  return (
    <section className="grid min-w-0 gap-5">
      <header className="flex flex-wrap items-center justify-between gap-4 rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
        <div>
          <h2 className="text-lg font-bold">Artículos y stock</h2>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Artículos físicos, almacenes y existencias en una sola vista.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
        {inventoryEnabled ? <Button disabled={disabled || loadState !== 'ready' || !snapshot.units.some((unit) => unit.active) || !snapshot.warehouses.some((warehouse) => warehouse.active)} onClick={() => { setSelectedId(null); setCreatingItem(true); }} type="button"><Plus className="size-4" /> Nuevo artículo</Button> : null}
        <label className="flex items-center gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] px-4 py-3 text-sm font-semibold">
          <input
            checked={inventoryEnabled}
            disabled={disabled}
            onChange={(event) =>
              void runAction(async () => {
                await setVenueInventoryEnabled(
                  selectedVenueId,
                  event.target.checked,
                );
                await onInventoryEnabledChange();
              })
            }
            type="checkbox"
          />{" "}
          Control de inventario activo
        </label>
        </div>
      </header>

      {inventoryEnabled && loadState === 'ready' && (!snapshot.units.some((unit) => unit.active) || !snapshot.warehouses.some((warehouse) => warehouse.active)) ? <p className="m-0 text-sm text-[var(--crm-text-muted)]">Para crear artículos, configura al menos una unidad física y un almacén activos en Inventario.</p> : null}

      {inventoryEnabled ? (
        loadState === 'ready' ? <StockOverview disabled={disabled} onOpen={open} onRefresh={() => void runAction(async () => { await refresh(); })} onReplenish={setQuickReplenishment} snapshot={snapshot} />
          : <div className="rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] p-6" role="status">{loadState === 'loading' ? 'Cargando inventario…' : <><p>No se pudo consultar el inventario. Las cifras no están disponibles.</p><Button onClick={() => void runAction(async () => { await refresh(); })} type="button" variant="secondary">Volver a intentar</Button></>}</div>
      ) : (
        <div className="rounded-[var(--crm-radius-lg)] bg-[var(--crm-surface)] p-6"><EmptyList message="Activa el control de inventario para gestionar existencias." /></div>
      )}

      {creatingItem ? <CrmModal dismissDisabled={modalBusy} label="Nuevo artículo de inventario" onClose={() => setCreatingItem(false)} size="large">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--crm-border-subtle)] p-5"><h2 className="m-0 text-lg font-bold">Nuevo artículo</h2><Button aria-label="Cerrar" disabled={modalBusy} onClick={() => setCreatingItem(false)} type="button" variant="tertiary"><X className="size-4" /></Button></div>
        <InventoryItemEditor disabled={disabled} item={null} onCancel={() => setCreatingItem(false)} onSaved={itemSaved} runAction={runAction} snapshot={snapshot} venueId={selectedVenueId} />
      </CrmModal> : null}

      {quickReplenishment ? <QuickStockReplenishment context={tenantContext} disabled={disabled} key={quickReplenishment.key} onClose={() => setQuickReplenishment(null)} onSaved={async () => { setQuickReplenishment(null); await refresh(); }} row={quickReplenishment} runAction={runAction} venueId={selectedVenueId} /> : null}

      {selected ? (
        <CrmModal dismissDisabled={modalBusy} size="large"
          label={`Stock de ${selected.name}`}
          onClose={() => setSelectedId(null)}
        >
          <div className="flex items-center justify-between border-b border-[var(--crm-border-subtle)] p-5">
            <div>
              <h2 className="text-lg font-bold">{selected.name}</h2>
              <p className="text-xs text-[var(--crm-text-muted)]">
                Unidad física: {selectedUnit?.name ?? "Sin unidad"}
              </p>
            </div>
            <Button disabled={modalBusy} className="!size-11 !min-h-11 !min-w-11 !shrink-0 !rounded-[12px] !p-0"
              aria-label="Cerrar"
              onClick={() => setSelectedId(null)}
              type="button"
              variant="tertiary"
            >
              <X className="size-4" />
            </Button>
          </div>

          <div aria-label="Secciones de la ficha del artículo" className="flex flex-wrap gap-2 border-b border-[var(--crm-border-subtle)] px-5 py-3" role="group">
            <Button active={detailMode === 'stock'} aria-pressed={detailMode === 'stock'} disabled={modalBusy} onClick={() => setDetailMode('stock')} type="button" variant="tertiary">Stock y movimientos</Button>
            <Button active={detailMode === 'configuration'} aria-pressed={detailMode === 'configuration'} disabled={modalBusy} onClick={() => setDetailMode('configuration')} type="button" variant="tertiary"><Pencil className="size-4" /> Configurar artículo</Button>
          </div>
          {detailMode === 'configuration' ? <InventoryItemEditor disabled={disabled} item={selected} key={selected.id} onCancel={() => setDetailMode('stock')} onSaved={itemSaved} runAction={runAction} snapshot={snapshot} venueId={selectedVenueId} /> : <>
          <InventoryItemSummary context={tenantContext} item={selected} key={`summary:${selected.id}`} unit={selectedUnit} venueId={selectedVenueId} />
          <div className="grid gap-3 p-5 sm:grid-cols-2">
            {selectedRows.map((row) => <article className="grid gap-3 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4" key={row.key}><div className="flex flex-wrap items-center justify-between gap-2"><strong>{row.warehouse?.name ?? 'Sin almacén configurado'}</strong><StockStatus row={row} /></div><StockTarget row={row} /><p className="m-0 text-xs text-[var(--crm-text-muted)]">Valor estimado: {row.valueCents === null ? 'Sin coste conocido' : `≈ ${formatMoney(row.valueCents)}`} · <StockQuantity row={row} /></p></article>)}
          </div>
          <details className="border-t border-[var(--crm-border-subtle)]" open>
            <summary className="min-h-12 cursor-pointer px-5 py-4 text-sm font-bold">Establecer total por almacén</summary>
          <div className="grid gap-4 p-5">
            <p className="m-0 text-xs text-[var(--crm-text-muted)]">Introduce las existencias totales contadas en cada almacén. Solo se guardan los almacenes modificados y se comprueba que su saldo no haya cambiado en otro terminal.</p>

            {selectedRoutes.map((route) => {
              const warehouse = snapshot.warehouses.find(
                (candidate) => candidate.id === route.warehouseId,
              );
              const currentQuantity =
                selectedStockByWarehouse.get(route.warehouseId) ?? 0;
              const draftValue = quantities[route.warehouseId] ?? "";
              let resultingQuantity: number | null = null;
              try {
                resultingQuantity = parseInventoryStockQuantity(draftValue, decimalPlaces);
              } catch {
                resultingQuantity = null;
              }

              return (
                <div
                  className="grid gap-4 rounded-[var(--crm-radius-md)] bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-[minmax(0,1fr)_210px] sm:items-start"
                  key={route.warehouseId}
                >
                  <div>
                    <strong className="block">
                      {route.priority}. {warehouse?.name}
                    </strong>

                    <small className="mt-2 block text-[var(--crm-text-muted)]">
                      Stock actual:{" "}
                      <strong className="font-mono text-[var(--crm-text)]">
                        {formatInventoryQuantity(
                          currentQuantity,
                          decimalPlaces,
                        )}{" "}
                        {unitLabel}
                      </strong>
                    </small>
                  </div>
                  <div className="grid gap-2">
                    <label
                      className="grid gap-1 text-xs font-semibold"
                      htmlFor={`stock-${route.warehouseId}`}
                    >
                      Nuevo stock total
                      <span className="relative block">
                        <Input
                          disabled={modalBusy}
                          id={`stock-${route.warehouseId}`}
                          inputMode="decimal"
                          onChange={(event) => {
                            setRequestId(crypto.randomUUID());
                            setQuantities((current) => ({
                              ...current,
                              [route.warehouseId]: event.target.value,
                            }));
                            setError(null);
                          }}
                          placeholder="0"
                          value={draftValue}
                        />
                      </span>
                    </label>

                    <small
                      className={
                        resultingQuantity === null
                          ? "font-semibold text-[var(--crm-red)]"
                          : "text-[var(--crm-text-muted)]"
                      }
                    >
                      {resultingQuantity === null ? (
                        "Cantidad no válida"
                      ) : (
                        <>
                          Quedará:{" "}
                          <strong className="font-mono text-[var(--crm-text)]">
                            {formatInventoryQuantity(
                              resultingQuantity,
                              decimalPlaces,
                            )}{" "}
                            {unitLabel}
                          </strong>
                        </>
                      )}
                    </small>
                  </div>
                </div>
              );
            })}

            {!selectedRoutes.length ? (
              <EmptyList message="Configura una ruta de almacenes en la ficha del artículo." />
            ) : null}
            {error ? (
              <p className="rounded-[var(--crm-radius-md)] bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">
                {error}
              </p>
            ) : null}
            <Button disabled={modalBusy} onClick={() => void reloadTotals()} size="sm" type="button" variant="tertiary">Actualizar existencias</Button>
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4">
            <Button disabled={modalBusy}
              onClick={() => setSelectedId(null)}
              type="button"
              variant="tertiary"
            >
              Cancelar
            </Button>
            <Button
              disabled={disabled || modalBusy || !totalChanges?.length}
              onClick={() => void save()}
              type="button"
            >
              <Save className="size-4" /> Guardar total
            </Button>
          </div>
          </details>
          <InventoryItemHistory context={tenantContext} dayChangeTime={dayChangeTime} initialWarehouseId={initialWarehouseId} item={selected} key={selected.id} snapshot={snapshot} timeZone={timeZone} venueId={selectedVenueId} />
          </>}
        </CrmModal>
      ) : null}
    </section>
  );
}
