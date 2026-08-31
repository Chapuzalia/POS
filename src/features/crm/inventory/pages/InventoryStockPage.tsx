import { ChevronRight, Package, Pencil, Plus, Save, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Input } from "../../../../components/ui";
import { DataTable } from "../../../../components/ui/DataTable";
import type { TenantContext } from "../../../../types";
import { CrmModal } from "../../shared/components/CrmModal";
import { EmptyList } from "../../shared/components/EmptyList";
import type { RunAction } from "../../shared/types";
import {
  addInventoryStockQuantity,
  formatInventoryQuantity,
  parseInventoryQuantity,
  parseInventoryStockQuantity,
} from "../inventoryModel";
import {
  loadInventorySnapshot,
  saveInventoryItemStock,
  setVenueInventoryEnabled,
} from "../services/inventoryService";
import type { InventorySnapshot } from "../types";

type Props = {
  disabled: boolean;
  inventoryEnabled: boolean;
  onInventoryEnabledChange: () => Promise<void>;
  runAction: RunAction;
  selectedVenueId: string;
  tenantContext: TenantContext;
};

type StockEditMode = "add" | "set";

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
}: Props) {
  const [snapshot, setSnapshot] = useState<InventorySnapshot>(emptySnapshot);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stockEditMode, setStockEditMode] = useState<StockEditMode>("add");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!selectedVenueId || !inventoryEnabled)
      return setSnapshot(emptySnapshot);
    setSnapshot(await loadInventorySnapshot(tenantContext, selectedVenueId));
  }, [inventoryEnabled, selectedVenueId, tenantContext]);

  useEffect(() => {
    void runAction(refresh);
  }, [refresh, runAction]);

  const rows = useMemo(
    () =>
      snapshot.items
        .map((item) => {
          const unit = snapshot.units.find(
            (candidate) => candidate.id === item.baseUnitId,
          );
          const levels = snapshot.levels.filter(
            (level) => level.inventoryItemId === item.id && level.enabled,
          );
          const primaryRoute = snapshot.itemRoutes
            .filter(
              (route) => route.inventoryItemId === item.id && route.enabled,
            )
            .toSorted((a, b) => a.priority - b.priority)[0];
          return {
            item,
            unit,
            total: levels.reduce((sum, level) => sum + level.quantity, 0),
            warehouse: snapshot.warehouses.find(
              (warehouse) => warehouse.id === primaryRoute?.warehouseId,
            ),
            isPreparation: snapshot.productionRecipes.some(
              (recipe) => recipe.inventoryItemId === item.id && recipe.active,
            ),
          };
        })
        .toSorted((a, b) => a.item.name.localeCompare(b.item.name, "es")),
    [snapshot],
  );

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
  const hasAddition =
    stockEditMode === "set" ||
    Object.values(quantities).some(
      (value) => value.trim() !== "" && Number(value.replace(",", ".")) !== 0,
    );

  function open(itemId: string) {
    setSelectedId(itemId);
    setStockEditMode("add");
    setQuantities(
      Object.fromEntries(
        snapshot.warehouses.map((warehouse) => [warehouse.id, ""]),
      ),
    );
    setError(null);
  }

  function changeStockEditMode(nextMode: StockEditMode) {
    if (nextMode === stockEditMode) return;
    setStockEditMode(nextMode);
    setQuantities(
      Object.fromEntries(
        snapshot.warehouses.map((warehouse) => [
          warehouse.id,
          nextMode === "add"
            ? ""
            : String(selectedStockByWarehouse.get(warehouse.id) ?? 0),
        ]),
      ),
    );
    setError(null);
  }

  function addQuickQuantity(warehouseId: string, amount: number) {
    setQuantities((current) => {
      const value = current[warehouseId]?.trim() || "0";
      let currentAddition = 0;
      try {
        currentAddition = parseInventoryQuantity(value, decimalPlaces);
      } catch {
        // A preset replaces an invalid draft so the user can recover in one tap.
      }
      return {
        ...current,
        [warehouseId]: String(
          addInventoryStockQuantity(
            currentAddition,
            String(amount),
            decimalPlaces,
          ),
        ),
      };
    });
    setError(null);
  }

  async function save() {
    if (!selected) return;
    try {
      const levels = snapshot.warehouses.map((warehouse) => ({
        warehouseId: warehouse.id,
        enabled: selectedRoutes.some(
          (route) => route.warehouseId === warehouse.id,
        ),
        quantity:
          stockEditMode === "add"
            ? addInventoryStockQuantity(
                selectedStockByWarehouse.get(warehouse.id) ?? 0,
                quantities[warehouse.id]?.trim() || "0",
                decimalPlaces,
              )
            : parseInventoryStockQuantity(
                quantities[warehouse.id] ?? "0",
                decimalPlaces,
              ),
      }));
      await runAction(async () => {
        await saveInventoryItemStock(
          tenantContext,
          selectedVenueId,
          selected.id,
          levels,
        );
        await refresh();
        setSelectedId(null);
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Cantidad no válida.");
    }
  }

  return (
    <section className="overflow-hidden rounded-2xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--crm-border-subtle)] p-5">
        <div>
          <h2 className="text-lg font-bold">Stock físico</h2>
          <p className="text-sm text-[var(--crm-text-muted)]">
            Existencias por artículo y almacén. El stock negativo está
            permitido.
          </p>
        </div>
        <label className="flex items-center gap-3 rounded-xl bg-[var(--crm-surface-soft)] px-4 py-3 text-sm font-semibold">
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
      </header>

      {inventoryEnabled ? (
        <>
          {rows.length ? (
            <DataTable
              aria-label="Stock por artículo"
              className="!w-full !min-w-[720px] !border-collapse"
              filterPlaceholder="Buscar artículo físico…"
              filterValue={query}
              onFilterChange={setQuery}
            >
              <thead>
                <tr className="!border-b !border-[var(--crm-border-subtle)] !text-left !text-xs !font-bold !uppercase !text-[var(--crm-text-muted)]">
                  <th className="!min-w-[220px] !px-5 !py-3">Artículo</th>
                  <th className="!w-[140px] !px-3 !py-3">Disponible</th>
                  <th className="!min-w-[170px] !px-3 !py-3">Ruta principal</th>
                  <th className="!w-[130px] !px-3 !py-3">Tipo</th>
                  <th
                    aria-label="Acciones"
                    className="!w-[64px] !px-3 !py-3"
                    data-sortable="false"
                  />
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    className="!border-b !border-[var(--crm-border-subtle)] hover:!bg-[var(--crm-surface-hover)] last:!border-0"
                    key={row.item.id}
                  >
                    <td className="!px-5 !py-3">
                      <span className="flex items-center gap-3">
                        <span className="grid size-9 place-items-center rounded-xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]">
                          <Package className="size-4" />
                        </span>
                        <span>
                          <strong className="block">{row.item.name}</strong>
                          <small className="text-[var(--crm-text-muted)]">
                            {row.item.active ? "Activo" : "Inactivo"}
                          </small>
                        </span>
                      </span>
                    </td>
                    <td
                      className="!whitespace-nowrap !px-3 !py-3"
                      data-sort-value={row.total}
                    >
                      <strong className="font-mono">
                        {formatInventoryQuantity(
                          row.total,
                          row.unit?.decimalPlaces ?? 6,
                        )}{" "}
                        {row.unit?.symbol}
                      </strong>
                    </td>
                    <td className="!px-3 !py-3">
                      {row.warehouse?.name ?? "Sin ruta"}
                    </td>
                    <td className="!px-3 !py-3">
                      {row.isPreparation ? "Elaboración" : "Artículo"}
                    </td>
                    <td className="!px-3 !py-3">
                      <Button
                        aria-label={`Editar stock de ${row.item.name}`}
                        disabled={disabled}
                        onClick={() => open(row.item.id)}
                        size="sm"
                        type="button"
                        variant="tertiary"
                      >
                        <ChevronRight className="size-4" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </DataTable>
          ) : (
            <div className="p-5">
              <EmptyList message="No hay artículos de inventario. Créelos desde Inventario → Artículos." />
            </div>
          )}
        </>
      ) : (
        <div className="p-6">
          <EmptyList message="Activa el control de inventario para gestionar existencias." />
        </div>
      )}

      {selected ? (
        <CrmModal
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
            <Button
              aria-label="Cerrar"
              onClick={() => setSelectedId(null)}
              type="button"
              variant="tertiary"
            >
              <X className="size-4" />
            </Button>
          </div>

          <div className="grid gap-4 p-5">
            <div className="grid gap-2">
              <div
                aria-label="Modo de actualización del stock"
                className="flex justify-between gap-1 rounded-xl bg-[var(--crm-surface-soft)] p-1"
                role="group"
              >
                <Button
                  active={stockEditMode === "add"}
                  className="!flex-1 !rounded-r-none !rounded-l-xl"
                  onClick={() => changeStockEditMode("add")}
                  type="button"
                  variant="tertiary"
                >
                  <Plus className="size-4" /> Añadir stock
                </Button>
                <Button
                  active={stockEditMode === "set"}
                  className="!flex-1 !rounded-l-none !rounded-r-xl"
                  onClick={() => changeStockEditMode("set")}
                  type="button"
                  variant="tertiary"
                >
                  <Pencil className="size-4" /> Establecer total
                </Button>
              </div>
            </div>

            {selectedRoutes.map((route) => {
              const warehouse = snapshot.warehouses.find(
                (candidate) => candidate.id === route.warehouseId,
              );
              const currentQuantity =
                selectedStockByWarehouse.get(route.warehouseId) ?? 0;
              const draftValue = quantities[route.warehouseId] ?? "";
              let resultingQuantity: number | null = null;
              try {
                resultingQuantity =
                  stockEditMode === "add"
                    ? addInventoryStockQuantity(
                        currentQuantity,
                        draftValue.trim() || "0",
                        decimalPlaces,
                      )
                    : parseInventoryStockQuantity(draftValue, decimalPlaces);
              } catch {
                resultingQuantity = null;
              }

              return (
                <div
                  className="grid gap-4 rounded-xl bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-[minmax(0,1fr)_210px] sm:items-start"
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
                      {stockEditMode === "add"
                        ? "Cantidad recibida"
                        : "Nuevo stock total"}
                      <span className="relative block">
                        {stockEditMode === "add" ? (
                          <span
                            aria-hidden
                            className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-lg font-bold text-[var(--crm-blue)]"
                          >
                            +
                          </span>
                        ) : null}
                        <Input
                          className={
                            stockEditMode === "add" ? "!pl-8" : undefined
                          }
                          id={`stock-${route.warehouseId}`}
                          inputMode="decimal"
                          onChange={(event) => {
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

                    {stockEditMode === "add" ? (
                      <div
                        aria-label={`Cantidades rápidas para ${warehouse?.name ?? "almacén"}`}
                        className="grid grid-cols-3 gap-2"
                        role="group"
                      >
                        {[1, 5, 10].map((amount) => (
                          <Button
                            className="!min-h-9 !px-2 !text-xs"
                            disabled={disabled}
                            key={amount}
                            onClick={() =>
                              addQuickQuantity(route.warehouseId, amount)
                            }
                            type="button"
                            variant="tertiary"
                          >
                            +{amount} {unitLabel}
                          </Button>
                        ))}
                      </div>
                    ) : null}

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
              <p className="rounded-xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">
                {error}
              </p>
            ) : null}
          </div>

          <div className="flex justify-end gap-2 border-t border-[var(--crm-border-subtle)] p-4">
            <Button
              onClick={() => setSelectedId(null)}
              type="button"
              variant="tertiary"
            >
              Cancelar
            </Button>
            <Button
              disabled={disabled || !selectedRoutes.length || !hasAddition}
              onClick={() => void save()}
              type="button"
            >
              {stockEditMode === "add" ? (
                <Plus className="size-4" />
              ) : (
                <Save className="size-4" />
              )}
              {stockEditMode === "add" ? "Añadir stock" : "Guardar total"}
            </Button>
          </div>
        </CrmModal>
      ) : null}
    </section>
  );
}
