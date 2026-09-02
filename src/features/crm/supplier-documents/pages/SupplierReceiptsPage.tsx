import {
  AlertTriangle,
  ArrowLeft,
  Camera,
  Check,
  CheckCircle2,
  ChevronRight,
  FileText,
  Link2,
  PackagePlus,
  RefreshCw,
  Upload,
  Warehouse,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Button, Chip, Input } from "../../../../components/ui";
import type { TenantContext } from "../../../../types";
import { getReadableError } from "../../../../utils/errors";
import {
  inventoryUnitsCompatible,
  normalizeDocumentText,
  normalizePurchaseToBase,
} from "../../../../../supabase/functions/_shared/supplier-documents/core";
import { CrmModal } from "../../shared/components/CrmModal";
import { CrmSelect } from "../../shared/components/CrmSelect";
import { Field } from "../../shared/components/Field";
import type { InventorySnapshot } from "../../inventory/types";
import {
  confirmSupplierDocument,
  createInventoryItemFromSupplierDocument,
  createMockSupplierDocument,
  loadDeliveryNoteCandidates,
  loadSupplierReceiptWorkspace,
  retrySupplierDocumentProcessing,
  reparseSupplierDocumentLines,
  saveSupplierDocumentLine,
  supplierDocumentMockEnabled,
  supplierDocumentMockFixtures,
  updateSupplierDocumentSupplier,
  uploadSupplierDocument,
} from "../services/supplierDocumentService";
import type {
  SupplierDocumentDetail,
  SupplierDocumentLine,
  SupplierDocumentLineDraft,
  SupplierDocumentLinkCandidate,
  SupplierOption,
  SupplierDocumentType,
} from "../types";
import { PROVISIONAL_SUPPLIER, requiresLineReparseConfirmation, supplierReviewState } from "../supplierReview";
import { OCR_QUALITY_MESSAGE, OCR_QUALITY_TOO_LOW } from "../../../../../supabase/functions/_shared/supplier-documents/ocrQuality";

type Props = {
  disabled: boolean;
  initialDocumentId?: string | null;
  onExit?: () => void;
  selectedVenueId: string;
  tenantContext: TenantContext;
};
type Screen =
  | "capture"
  | "processing"
  | "review"
  | "costs"
  | "confirmed"
  | "duplicate";
type EditorDraft = {
  inventoryItemId: string;
  warehouseId: string;
  quantity: string;
  purchaseUnit: string;
  packageCount: string;
  packageUnitQuantity: string;
  packageUnitId: string;
  unitPrice: string;
  discountAmount: string;
};

const processingMessages = [
  "Leyendo documento…",
  "Detectando proveedor, productos y cantidades…",
];

function parseDecimal(value: string) {
  if (!value.trim()) return null;
  const parsed = Number(value.replace(",", "."));
  return Number.isFinite(parsed) ? parsed : null;
}

function formatQuantity(value: number | null, maximumFractionDigits = 6) {
  if (value === null) return "—";
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits }).format(
    value,
  );
}

function formatCost(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 4,
  }).format(value);
}

function lineDraft(
  line: SupplierDocumentLine,
  referenceCostDecided = line.referenceCostDecided,
): SupplierDocumentLineDraft | null {
  if (
    !line.inventoryItemId ||
    !line.warehouseId ||
    line.quantity === null ||
    line.unitPrice === null ||
    line.baseQuantity === null ||
    line.normalizedUnitCost === null
  )
    return null;
  return {
    inventoryItemId: line.inventoryItemId,
    warehouseId: line.warehouseId,
    quantity: line.quantity,
    purchaseUnit: line.purchaseUnit ?? "",
    packageCount: line.packageCount,
    packageUnitQuantity: line.packageUnitQuantity,
    packageUnitSymbol: line.packageUnitSymbol ?? "",
    unitPrice: line.unitPrice,
    discountAmount: line.discountAmount,
    baseQuantity: line.baseQuantity,
    normalizedUnitCost: line.normalizedUnitCost,
    updateReferenceCost: line.updateReferenceCost,
    referenceCostDecided,
  };
}

function LineStatus({
  status,
}: {
  status: SupplierDocumentLine["matchStatus"];
}) {
  if (status === "recognized")
    return (
      <Chip icon={CheckCircle2} tone="success">
        Reconocido
      </Chip>
    );
  if (status === "probable")
    return (
      <Chip icon={Check} tone="warning">
        Coincidencia probable
      </Chip>
    );
  return (
    <Chip icon={AlertTriangle} tone="danger">
      Necesita revisión
    </Chip>
  );
}

export function SupplierReceiptsCrm({
  disabled,
  initialDocumentId = null,
  onExit,
  selectedVenueId,
  tenantContext,
}: Props) {
  const cameraInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const [screen, setScreen] = useState<Screen>("capture");
  const [documentType, setDocumentType] =
    useState<SupplierDocumentType>("delivery_note");
  const [detail, setDetail] = useState<SupplierDocumentDetail | null>(null);
  const [inventory, setInventory] = useState<InventorySnapshot | null>(null);
  const [supplierOptions, setSupplierOptions] = useState<SupplierOption[]>([]);
  const [showAll, setShowAll] = useState(false);
  const [editingLineId, setEditingLineId] = useState<string | null>(null);
  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [creatingItem, setCreatingItem] = useState(false);
  const [newItem, setNewItem] = useState({
    name: "",
    baseUnitId: "",
    warehouseId: "",
    referenceCost: "",
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [documentDate, setDocumentDate] = useState("");
  const [affectsStock, setAffectsStock] = useState(true);
  const [linkCandidates, setLinkCandidates] = useState<SupplierDocumentLinkCandidate[] | null>(null);
  const [deliveryNoteIds, setDeliveryNoteIds] = useState<string[]>([]);
  const [reparseConfirmation, setReparseConfirmation] = useState(false);
  const supplierReview = detail ? supplierReviewState(detail.document) : null;
  const ocrQualityFailed = detail?.document.extractionMetadata.code === OCR_QUALITY_TOO_LOW;

  const editingLine =
    detail?.lines.find((line) => line.id === editingLineId) ?? null;
  const needsReviewCount =
    detail?.lines.filter((line) => line.matchStatus === "needs_review")
      .length ?? 0;
  const visibleLines = useMemo(() => {
    const lines = detail?.lines ?? [];
    if (showAll || !lines.some((line) => line.matchStatus === "needs_review"))
      return lines;
    return lines.filter((line) => line.matchStatus === "needs_review");
  }, [detail?.lines, showAll]);
  const costChanges = useMemo(() => {
    if (!detail || !inventory) return [];
    return detail.lines.flatMap((line) => {
      const item = inventory.items.find(
        (candidate) => candidate.id === line.inventoryItemId,
      );
      if (
        !item ||
        line.normalizedUnitCost === null ||
        Math.abs((item.referenceCost ?? 0) - line.normalizedUnitCost) <=
          0.000001
      )
        return [];
      return [{ line, item }];
    });
  }, [detail, inventory]);
  const allCostsDecided = costChanges.every(
    ({ line }) => line.referenceCostDecided,
  );
  const isConfirmedDocument = detail?.document.status === "confirmed";

  async function refresh(documentId: string) {
    const workspace = await loadSupplierReceiptWorkspace(
      tenantContext,
      selectedVenueId,
      documentId,
    );
    setDetail({ document: workspace.document, lines: workspace.lines });
    setInventory(workspace.inventory);
    setSupplierOptions(workspace.suppliers);
    setDocumentDate(workspace.document.documentDate ?? "");
    setAffectsStock(workspace.document.affectsStock);
    setShowAll(
      workspace.document.status === "confirmed" ||
        !workspace.lines.some((line) => line.matchStatus === "needs_review"),
    );
    if (workspace.document.status === "confirmed") setScreen("review");
    else if (workspace.document.status === "review") setScreen("review");
    else if (workspace.document.status === "processing") setScreen("processing");
    else if (workspace.document.status === "error") {
      const processingError = workspace.document.extractionMetadata.message;
      setError(
        workspace.document.extractionMetadata.code === OCR_QUALITY_TOO_LOW ? OCR_QUALITY_MESSAGE :
        typeof processingError === "string" && processingError.trim()
          ? processingError
          : "No se pudo procesar el documento.",
      );
      setScreen("processing");
    }
  }

  useEffect(() => {
    if (!initialDocumentId) return;
    void run(async () => refresh(initialDocumentId));
    // The requested document changes only when the parent opens another row.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDocumentId, selectedVenueId]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(getReadableError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleFile(file: File | undefined) {
    if (!file) return;
    setScreen("processing");
    await run(async () => {
      const result = await uploadSupplierDocument(
        selectedVenueId,
        documentType,
        file,
        affectsStock,
      );
      if (result.duplicate) {
        setDetail(null);
        setInventory(null);
        setScreen("duplicate");
        return;
      }
      await refresh(result.documentId);
    });
  }

  async function handleFixture(fixtureId: string) {
    setScreen("processing");
    await run(async () => {
      const result = await createMockSupplierDocument(
        selectedVenueId,
        fixtureId,
        affectsStock,
      );
      await refresh(result.documentId);
    });
  }

  function openEditor(line: SupplierDocumentLine) {
    const inventoryUnits = inventory?.units ?? [];
    const item = inventory?.items.find(
      (candidate) => candidate.id === line.inventoryItemId,
    );
    const baseUnit = inventoryUnits.find(
      (unit) => unit.id === item?.baseUnitId,
    );
    const packageUnit = inventoryUnits.find(
      (unit) =>
        unit.active &&
        normalizeDocumentText(unit.symbol) ===
          normalizeDocumentText(line.packageUnitSymbol ?? "") &&
        (!baseUnit || inventoryUnitsCompatible(unit, baseUnit, inventoryUnits)),
    );
    setEditingLineId(line.id);
    setDraft({
      inventoryItemId: line.inventoryItemId ?? "",
      warehouseId: line.warehouseId ?? "",
      quantity: line.quantity === null ? "" : String(line.quantity),
      purchaseUnit: line.purchaseUnit ?? "",
      packageCount: line.packageCount === null ? "" : String(line.packageCount),
      packageUnitQuantity:
        line.packageUnitQuantity === null
          ? ""
          : String(line.packageUnitQuantity),
      packageUnitId: packageUnit?.id ?? "",
      unitPrice: line.unitPrice === null ? "" : String(line.unitPrice),
      discountAmount: String(line.discountAmount),
    });
    setCreatingItem(false);
    setError(null);
  }

  const editorCalculation = useMemo(() => {
    if (!draft || !editingLine || !inventory) return null;
    const item = inventory.items.find(
      (candidate) => candidate.id === draft.inventoryItemId,
    );
    const baseUnit = inventory.units.find(
      (unit) => unit.id === item?.baseUnitId,
    );
    const quantity = parseDecimal(draft.quantity);
    const unitPrice = parseDecimal(draft.unitPrice);
    const discountAmount = parseDecimal(draft.discountAmount) ?? 0;
    if (
      !item ||
      !baseUnit ||
      quantity === null ||
      unitPrice === null ||
      quantity <= 0 ||
      unitPrice < 0 ||
      discountAmount < 0
    )
      return null;
    const packageCount = parseDecimal(draft.packageCount);
    const packageUnitQuantity = parseDecimal(draft.packageUnitQuantity);
    const hasPackageDetails = packageCount !== null || packageUnitQuantity !== null;
    if (
      hasPackageDetails &&
      (packageCount === null ||
        packageUnitQuantity === null ||
        !draft.packageUnitId)
    )
      return null;
    const normalized = normalizePurchaseToBase({
      purchaseQuantity: quantity,
      purchaseUnit: draft.purchaseUnit,
      packageExpression: editingLine.descriptionRaw,
      description: editingLine.descriptionRaw,
      baseUnit: {
        id: baseUnit.id,
        name: baseUnit.name,
        symbol: baseUnit.symbol,
        contentQuantity: baseUnit.contentQuantity,
        contentUnitId: baseUnit.contentUnitId,
      },
      units: inventory.units.map((unit) => ({
        id: unit.id,
        name: unit.name,
        symbol: unit.symbol,
        contentQuantity: unit.contentQuantity,
        contentUnitId: unit.contentUnitId,
      })),
      packageCount,
      packageUnitQuantity,
      packageUnitId: draft.packageUnitId,
    });
    if (!normalized) return null;
    const netCost = quantity * unitPrice - discountAmount;
    if (netCost < 0) return null;
    return {
      baseQuantity: normalized.baseQuantity,
      normalizedUnitCost:
        Math.round((netCost / normalized.baseQuantity) * 1_000_000) / 1_000_000,
      baseUnit,
    };
  }, [draft, editingLine, inventory]);

  const packageUnitOptions = useMemo(() => {
    if (!inventory) return [];
    const item = inventory.items.find(
      (candidate) => candidate.id === draft?.inventoryItemId,
    );
    const baseUnit = inventory.units.find(
      (unit) => unit.id === item?.baseUnitId,
    );
    return inventory.units
      .filter(
        (unit) =>
          unit.active &&
          (!baseUnit ||
            inventoryUnitsCompatible(unit, baseUnit, inventory.units)),
      )
      .map((unit) => ({
        label: `${unit.name} (${unit.symbol})`,
        value: unit.id,
      }));
  }, [draft?.inventoryItemId, inventory]);

  async function saveEditor() {
    if (
      !detail ||
      !editingLine ||
      !draft ||
      !editorCalculation ||
      !draft.warehouseId
    ) {
      setError(
        "Completa artículo, cantidades, formato, precio y almacén con una conversión segura.",
      );
      return;
    }
    const quantity = parseDecimal(draft.quantity);
    const unitPrice = parseDecimal(draft.unitPrice);
    if (quantity === null || unitPrice === null) return;
    const packageUnit = inventory?.units.find(
      (unit) => unit.id === draft.packageUnitId,
    );
    await run(async () => {
      await saveSupplierDocumentLine(detail.document.id, editingLine.id, {
        inventoryItemId: draft.inventoryItemId,
        warehouseId: draft.warehouseId,
        quantity,
        purchaseUnit: draft.purchaseUnit,
        packageCount: parseDecimal(draft.packageCount),
        packageUnitQuantity: parseDecimal(draft.packageUnitQuantity),
        packageUnitSymbol: packageUnit?.symbol ?? "",
        unitPrice,
        discountAmount: parseDecimal(draft.discountAmount) ?? 0,
        baseQuantity: editorCalculation.baseQuantity,
        normalizedUnitCost: editorCalculation.normalizedUnitCost,
        updateReferenceCost: false,
        referenceCostDecided: false,
      });
      await refresh(detail.document.id);
      setEditingLineId(null);
      setDraft(null);
    });
  }

  async function createItem() {
    if (
      !detail ||
      !editingLine ||
      !newItem.name.trim() ||
      !newItem.baseUnitId ||
      !newItem.warehouseId
    ) {
      setError("Indica nombre, unidad base y almacén.");
      return;
    }
    const referenceCost = newItem.referenceCost.trim()
      ? parseDecimal(newItem.referenceCost)
      : null;
    if (referenceCost !== null && referenceCost < 0)
      return setError("El coste de referencia no puede ser negativo.");
    await run(async () => {
      const itemId = await createInventoryItemFromSupplierDocument({
        documentId: detail.document.id,
        name: newItem.name,
        baseUnitId: newItem.baseUnitId,
        warehouseId: newItem.warehouseId,
        referenceCost,
      });
      const workspace = await loadSupplierReceiptWorkspace(
        tenantContext,
        selectedVenueId,
        detail.document.id,
      );
      setInventory(workspace.inventory);
      setDraft((current) =>
        current
          ? {
              ...current,
              inventoryItemId: itemId,
              warehouseId: newItem.warehouseId,
            }
          : current,
      );
      setCreatingItem(false);
    });
  }

  async function decideCost(line: SupplierDocumentLine, update: boolean) {
    if (!detail) return;
    const next = lineDraft(line, true);
    if (!next)
      return setError(
        `La línea ${line.lineNumber} no tiene datos finales válidos.`,
      );
    await run(async () => {
      await saveSupplierDocumentLine(detail.document.id, line.id, {
        ...next,
        updateReferenceCost: update,
      });
      await refresh(detail.document.id);
      setScreen("costs");
    });
  }

  async function decideAllCosts() {
    if (!detail) return;
    await run(async () => {
      await Promise.all(
        costChanges.map(async ({ line }) => {
          const next = lineDraft(line, true);
          if (!next)
            throw new Error(
              `La línea ${line.lineNumber} no tiene datos finales válidos.`,
            );
          await saveSupplierDocumentLine(detail.document.id, line.id, {
            ...next,
            updateReferenceCost: true,
          });
        }),
      );
      await refresh(detail.document.id);
      setScreen("costs");
    });
  }

  async function confirm() {
    if (
      !detail ||
      !supplierReview?.hasSupplier ||
      !documentDate ||
      (affectsStock && needsReviewCount) ||
      !allCostsDecided
    )
      return;
    await run(async () => {
      await confirmSupplierDocument({
        documentId: detail.document.id,
        documentDate,
        affectsStock,
        deliveryNoteIds,
      });
      await refresh(detail.document.id);
      setScreen("confirmed");
    });
  }

  async function changeSupplier(supplierId: string) {
    if (
      !detail ||
      isConfirmedDocument ||
      supplierId === supplierReview?.selectedValue
    )
      return;
    const provisional = supplierId === PROVISIONAL_SUPPLIER && supplierReview?.detectedName;
    const supplier = supplierOptions.find(
      (candidate) => candidate.id === supplierId,
    );
    if (!supplier && !provisional) return;
    const selectedSupplierId = provisional ? null : supplierId;
    await run(async () => {
      await updateSupplierDocumentSupplier(detail.document.id, selectedSupplierId);
      setDetail((current) =>
        current
          ? {
              ...current,
              document: {
                ...current.document,
                supplierId: selectedSupplierId,
                supplierName: supplier?.name ?? supplierReview?.detectedName ?? null,
                extractionMetadata: {
                  ...current.document.extractionMetadata,
                  supplierSelection: { kind: provisional ? "provisional" : "existing", supplierId: selectedSupplierId, manual: true },
                  linesNeedReparse: (current.document.extractionMetadata.linesSupplierId ?? null) !== selectedSupplierId,
                  supplierResolution: {
                    supplierId: selectedSupplierId,
                    confidence: provisional ? "unresolved" : "high",
                    signals: [],
                    reasons: ["manual_selection"],
                  },
                },
              },
            }
          : current,
      );
    });
  }

  async function updateLinesWithSupplier(allowOverwrite = false) {
    if (!detail || !supplierReview?.canReparseLines || isConfirmedDocument) return;
    if (!allowOverwrite && requiresLineReparseConfirmation(detail.lines, Boolean(editingLineId && draft))) {
      setReparseConfirmation(true);
      return;
    }
    setReparseConfirmation(false);
    await run(async () => {
      await reparseSupplierDocumentLines(detail.document.id, allowOverwrite);
      const workspace = await loadSupplierReceiptWorkspace(tenantContext, selectedVenueId, detail.document.id);
      setDetail({ document: workspace.document, lines: workspace.lines });
      setInventory(workspace.inventory);
      setEditingLineId(null);
      setDraft(null);
      // Keep the user's date/stock choices; only the line review was refreshed.
    });
  }

  if (screen === "capture") {
    return (
      <section className="mx-auto grid w-full max-w-3xl gap-5 pb-8">
        <div className="overflow-hidden rounded-3xl bg-[var(--crm-surface)] shadow-[var(--crm-shadow-card)]">
          <header className="border-b border-[var(--crm-border-subtle)] p-5 sm:p-7">
            <span className="mb-4 grid size-12 place-items-center rounded-2xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]">
              <FileText className="size-6" />
            </span>
            <h2 className="text-2xl font-black">Subir documento</h2>
            <p className="mt-2 max-w-xl text-sm text-[var(--crm-text-muted)]">
              Fotografía o sube una factura o un albarán para extraer sus datos
              y revisarlos antes de confirmar.
            </p>
          </header>
          <div className="grid gap-4 p-5 sm:p-7">
            <div
              className="flex grow gap-2 rounded-2xl bg-[var(--crm-surface-soft)] p-1.5"
              role="group"
              aria-label="Tipo de documento"
            >
              <Button
                active={documentType === "delivery_note"}
                className="!min-h-12 w-full rounded-2xl"
                onClick={() => setDocumentType("delivery_note")}
                type="button"
                variant="tertiary"
              >
                Albarán
              </Button>
              <Button
                active={documentType === "invoice"}
                className="!min-h-12 w-full rounded-2xl"
                onClick={() => setDocumentType("invoice")}
                type="button"
                variant="tertiary"
              >
                Factura
              </Button>
            </div>
            <label className="flex min-h-16 cursor-pointer items-center gap-3 rounded-2xl border border-[var(--crm-border-subtle)] bg-[var(--crm-surface-soft)] px-4 py-3">
              <input
                checked={affectsStock}
                className="size-5 shrink-0 accent-[var(--crm-blue)]"
                onChange={(event) => setAffectsStock(event.target.checked)}
                type="checkbox"
              />
              <span>
                <strong className="block text-sm">Actualizar stock al confirmar</strong>
                <span className="mt-0.5 block text-xs text-[var(--crm-text-muted)]">
                  Desactívalo si solo quieres registrar la compra y el gasto.
                </span>
              </span>
            </label>
            <input
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
              ref={cameraInput}
              type="file"
            />
            <input
              accept="image/jpeg,image/png,image/webp,application/pdf"
              className="hidden"
              onChange={(event) => void handleFile(event.target.files?.[0])}
              ref={uploadInput}
              type="file"
            />
            <Button
              className="!min-h-16 !rounded-2xl !text-base !font-bold"
              disabled={disabled || busy}
              onClick={() => cameraInput.current?.click()}
              type="button"
              variant="primary"
            >
              <Camera className="size-5" /> Hacer foto
            </Button>
            <Button
              className="!min-h-16 !rounded-2xl !text-base !font-bold"
              disabled={disabled || busy}
              onClick={() => uploadInput.current?.click()}
              type="button"
              variant="secondary"
            >
              <Upload className="size-5" /> Subir foto o PDF
            </Button>
          </div>
        </div>
        {supplierDocumentMockEnabled ? (
          <section className="rounded-3xl border border-dashed border-[var(--crm-blue)] bg-[var(--crm-blue-soft)] p-5">
            <div className="mb-4">
              <p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">
                Solo desarrollo · Mock mode
              </p>
              <h3 className="mt-1 text-lg font-bold">
                Probar un escenario completo
              </h3>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {supplierDocumentMockFixtures.map((fixture) => (
                <button
                  className="min-h-20 rounded-2xl bg-[var(--crm-surface)] p-4 text-left shadow-sm transition-transform active:scale-[0.99]"
                  disabled={busy}
                  key={fixture.id}
                  onClick={() => void handleFixture(fixture.id)}
                  type="button"
                >
                  <strong className="block">{fixture.label}</strong>
                  <span className="mt-1 block text-xs text-[var(--crm-text-muted)]">
                    {fixture.description}
                  </span>
                </button>
              ))}
            </div>
          </section>
        ) : null}
        {error ? (
          <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  if (screen === "processing") {
    return (
      <section
        aria-busy={!error}
        className="mx-auto grid min-h-[55dvh] w-full max-w-xl place-items-center rounded-3xl bg-[var(--crm-surface)] p-8 text-center shadow-[var(--crm-shadow-card)]"
        role="status"
      >
        <div>
          <span className="mx-auto grid size-16 place-items-center rounded-3xl bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]">
            {error ? <AlertTriangle className="size-8" /> : <RefreshCw className="size-8 animate-spin" />}
          </span>
          {!error ? processingMessages.map((message, index) => (
            <p
              className={`${index === 0 ? "mt-6 text-xl font-black" : "mt-2 text-sm text-[var(--crm-text-muted)]"}`}
              key={message}
            >
              {message}
            </p>
          )) : <h2 className="mt-6 text-xl font-black">No se pudo leer el documento</h2>}
          {error ? (
            <>
              <p className="mt-6 rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">
                {ocrQualityFailed ? OCR_QUALITY_MESSAGE : error}
              </p>
              <div className="mt-4 flex flex-wrap justify-center gap-2">
                {ocrQualityFailed ? (
                  <Button disabled={busy} onClick={() => {
                    setDetail(null);
                    setError(null);
                    setScreen("capture");
                  }} type="button" variant="primary">
                    Volver a escanear
                  </Button>
                ) : detail?.document.status === "error" ? (
                  <Button
                    disabled={busy}
                    onClick={() => void run(async () => {
                      await retrySupplierDocumentProcessing(detail.document.id);
                      await refresh(detail.document.id);
                    })}
                    type="button"
                    variant="primary"
                  >
                    Reintentar procesamiento
                  </Button>
                ) : null}
                <Button onClick={() => onExit ? onExit() : setScreen("capture")} type="button" variant="secondary">
                  Volver
                </Button>
              </div>
            </>
          ) : null}
          {!error && onExit ? (
            <Button className="mt-6" onClick={onExit} type="button" variant="secondary">
              Volver a facturas
            </Button>
          ) : null}
        </div>
      </section>
    );
  }

  if (screen === "duplicate") {
    return (
      <section
        aria-live="polite"
        className="mx-auto grid min-h-[55dvh] w-full max-w-xl place-items-center rounded-3xl bg-[var(--crm-surface)] p-8 text-center shadow-[var(--crm-shadow-card)]"
        role="status"
      >
        <div>
          <span className="mx-auto grid size-20 place-items-center rounded-full bg-amber-500/15 text-amber-600">
            <AlertTriangle className="size-10" />
          </span>
          <h2 className="mt-6 text-2xl font-black">Documento duplicado</h2>
          <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
            Este archivo coincide con un documento que ya estaba registrado. No
            se ha creado una nueva entrada ni se ha modificado el stock.
          </p>
          <Button
            className="mt-6"
            onClick={() => setScreen("capture")}
            type="button"
            variant="primary"
          >
            Subir otro documento
          </Button>
        </div>
      </section>
    );
  }

  if (!detail || !inventory) return null;

  if (screen === "confirmed") {
    return (
      <section className="mx-auto grid min-h-[55dvh] w-full max-w-xl place-items-center rounded-3xl bg-[var(--crm-surface)] p-8 text-center shadow-[var(--crm-shadow-card)]">
        <div>
          <span className="mx-auto grid size-20 place-items-center rounded-full bg-emerald-500/15 text-emerald-600">
            <CheckCircle2 className="size-10" />
          </span>
          <h2 className="mt-6 text-2xl font-black">Documento confirmado</h2>
          <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
            {detail.document.affectsStock
              ? "La compra y el stock se han actualizado en una única operación."
              : "La compra se ha registrado sin modificar el stock."}
          </p>
          <Button
            className="mt-6"
            onClick={() => {
              setDetail(null);
              setInventory(null);
              if (onExit) onExit();
              else setScreen("capture");
            }}
            type="button"
            variant="primary"
          >
            {onExit ? "Volver a facturas" : "Subir otro documento"}
          </Button>
        </div>
      </section>
    );
  }

  if (screen === "costs") {
    return (
      <section className="mx-auto grid w-full max-w-3xl gap-4 pb-28">
        <header className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
          <Button
            className="!mb-3 !px-2"
            onClick={() => setScreen("review")}
            type="button"
            variant="tertiary"
          >
            <ArrowLeft className="size-4" /> Volver
          </Button>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">
                Antes de confirmar
              </p>
              <h2 className="mt-1 text-2xl font-black">Cambios de coste</h2>
              <p className="mt-2 text-sm text-[var(--crm-text-muted)]">
                El coste real siempre queda en la compra. Tú decides si cambia
                también el coste de referencia.
              </p>
            </div>
            {costChanges.length ? (
              <Button
                disabled={busy}
                onClick={() => void decideAllCosts()}
                type="button"
                variant="secondary"
              >
                Actualizar todos
              </Button>
            ) : null}
          </div>
        </header>
        {costChanges.length ? (
          costChanges.map(({ line, item }) => {
            const unit = inventory.units.find(
              (candidate) => candidate.id === item.baseUnitId,
            );
            const previous = item.referenceCost;
            const change =
              previous && line.normalizedUnitCost !== null
                ? ((line.normalizedUnitCost - previous) / previous) * 100
                : null;
            return (
              <article
                className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"
                key={line.id}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-black">{item.name}</h3>
                    <p className="mt-2 font-mono text-lg">
                      <span className="text-[var(--crm-text-muted)]">
                        {formatCost(previous)}/{unit?.symbol}
                      </span>{" "}
                      <span aria-hidden>→</span>{" "}
                      <strong>
                        {formatCost(line.normalizedUnitCost)}/{unit?.symbol}
                      </strong>
                    </p>
                    {change !== null ? (
                      <p
                        className={`mt-1 text-sm font-bold ${change > 0 ? "text-amber-600" : "text-emerald-600"}`}
                      >
                        {change > 0 ? "+" : ""}
                        {formatQuantity(change, 1)}%
                      </p>
                    ) : null}
                  </div>
                  {line.referenceCostDecided ? (
                    <Chip icon={CheckCircle2} tone="success">
                      Decidido
                    </Chip>
                  ) : (
                    <Chip icon={AlertTriangle} tone="warning">
                      Pendiente
                    </Chip>
                  )}
                </div>
                <div className="mt-5 grid gap-2 sm:grid-cols-2">
                  <Button
                    active={
                      line.referenceCostDecided && !line.updateReferenceCost
                    }
                    disabled={busy}
                    onClick={() => void decideCost(line, false)}
                    type="button"
                    variant="secondary"
                  >
                    Mantener {formatCost(previous)}
                  </Button>
                  <Button
                    active={
                      line.referenceCostDecided && line.updateReferenceCost
                    }
                    disabled={busy}
                    onClick={() => void decideCost(line, true)}
                    type="button"
                    variant="primary"
                  >
                    Actualizar a {formatCost(line.normalizedUnitCost)}
                  </Button>
                </div>
              </article>
            );
          })
        ) : (
          <div className="rounded-3xl bg-[var(--crm-surface)] p-8 text-center shadow-[var(--crm-shadow-card)]">
            <CheckCircle2 className="mx-auto size-10 text-emerald-600" />
            <h3 className="mt-3 text-lg font-black">No hay cambios de coste</h3>
            <p className="mt-1 text-sm text-[var(--crm-text-muted)]">
              Puedes confirmar la entrada.
            </p>
          </div>
        )}
        {error ? (
          <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">
            {error}
          </p>
        ) : null}
        <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--crm-border-subtle)] bg-[var(--crm-surface)]/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur xl:left-[var(--crm-sidebar-width)]">
          <div className="mx-auto max-w-3xl">
            <Button
              className="!min-h-14 !w-full !rounded-2xl !text-base !font-black"
              disabled={disabled || busy || !supplierReview?.hasSupplier || !documentDate || (affectsStock && needsReviewCount > 0) || !allCostsDecided}
              onClick={() => void confirm()}
              type="button"
              variant="primary"
            >
              <CheckCircle2 className="size-5" /> Confirmar documento
            </Button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className={`mx-auto grid w-full max-w-3xl gap-4 ${isConfirmedDocument ? "pb-8" : "pb-28"}`}>
      <header className="rounded-3xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">
              {detail.document.documentType === "invoice"
                ? "Factura"
                : "Albarán"}
            </p>
            {isConfirmedDocument ? (
              <div className="mt-2"><Chip icon={CheckCircle2} tone="success">Confirmado</Chip></div>
            ) : null}
            <div className="mt-3 min-w-64">
              <label className="mb-1.5 block text-xs font-black uppercase tracking-wide text-[var(--crm-text-muted)]">
                Proveedor
              </label>
              <CrmSelect
                ariaLabel="Proveedor del documento"
                disabled={isConfirmedDocument || busy}
                emptyMessage="No hay proveedores existentes."
                onChange={(value) => void changeSupplier(value)}
                options={[...(supplierReview?.detectedName ? [{
                  label: `${supplierReview.detectedName} · Nuevo proveedor`,
                  value: PROVISIONAL_SUPPLIER,
                  description: "Se creará al confirmar si mantienes esta selección.",
                }] : []), ...supplierOptions.map((supplier) => ({
                  label: supplier.name,
                  value: supplier.id,
                  description: supplier.taxId
                    ? `NIF/CIF ${supplier.taxId}`
                    : undefined,
                }))]}
                placeholder="Selecciona un proveedor"
                searchable
                searchPlaceholder="Buscar proveedor..."
                value={supplierReview?.selectedValue ?? ""}
              />
              {supplierReview?.isProvisional ? (
                <p className="mt-2 text-xs text-[var(--crm-text-muted)]">Nuevo proveedor detectado. Se creará únicamente al confirmar.</p>
              ) : null}
              {!isConfirmedDocument && supplierReview?.canReparseLines ? (
                <Button className="mt-3" disabled={busy || disabled} onClick={() => void updateLinesWithSupplier()} type="button" variant="secondary">
                  <RefreshCw className="size-4" /> Actualizar líneas con este proveedor
                </Button>
              ) : null}
            </div>
            <p className="mt-1 text-sm text-[var(--crm-text-muted)]">
              {detail.document.documentNumber ?? "Sin número"}
            </p>
          </div>
          <Button
            aria-label="Cerrar documento"
            onClick={() => {
              setDetail(null);
              if (onExit) onExit();
              else setScreen("capture");
            }}
            type="button"
            variant="tertiary"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="mt-5 grid gap-4 rounded-2xl bg-[var(--crm-surface-soft)] p-4">
          <label className="grid gap-1.5 text-sm font-bold">
            Fecha real del documento
            <Input
              aria-label="Fecha real del documento"
              disabled={isConfirmedDocument}
              onChange={(event) => setDocumentDate(event.target.value)}
              required
              type="date"
              value={documentDate}
            />
          </label>
          <label className={`flex min-h-12 items-center gap-3 rounded-xl bg-[var(--crm-surface)] px-4 py-3 text-sm font-bold ${isConfirmedDocument ? "cursor-default" : "cursor-pointer"}`}>
            <input
              checked={affectsStock}
              className="size-5 accent-[var(--crm-blue)]"
              disabled={isConfirmedDocument}
              onChange={(event) => setAffectsStock(event.target.checked)}
              type="checkbox"
            />
            {isConfirmedDocument
              ? affectsStock ? "Este documento actualizó el stock" : "Este documento no actualizó el stock"
              : "Actualizar stock con este documento"}
          </label>
          <p className="text-xs text-[var(--crm-text-muted)]">
            Confirmar siempre registra la compra. El stock solo cambia si esta opción está activada.
          </p>
          {!isConfirmedDocument && detail.document.documentType === "invoice" ? (
            <div>
              <Button
                className="!px-0"
                disabled={busy}
                onClick={() => void run(async () => setLinkCandidates(await loadDeliveryNoteCandidates(tenantContext, selectedVenueId)))}
                type="button"
                variant="tertiary"
              >
                <Link2 className="size-4" /> Vincular a albaranes existentes
              </Button>
              {linkCandidates ? (
                <div className="mt-2 grid gap-2">
                  {linkCandidates.length ? linkCandidates.map((candidate) => (
                    <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-surface)] p-3 text-sm" key={candidate.id}>
                      <input
                        checked={deliveryNoteIds.includes(candidate.id)}
                        onChange={(event) => setDeliveryNoteIds((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id))}
                        type="checkbox"
                      />
                      <span className="min-w-0 flex-1">
                        <strong className="block truncate">{candidate.supplierName ?? "Sin proveedor"}</strong>
                        <span className="text-xs text-[var(--crm-text-muted)]">{candidate.documentDate} · {candidate.documentNumber ?? "Sin número"} · {formatCost(candidate.total)}</span>
                      </span>
                    </label>
                  )) : <p className="text-xs text-[var(--crm-text-muted)]">No hay albaranes disponibles para vincular.</p>}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="mt-5 grid grid-cols-2 gap-3">
          <div className="rounded-2xl bg-[var(--crm-surface-soft)] p-3">
            <strong className="block text-2xl font-black">
              {detail.lines.length}
            </strong>
            <span className="text-xs text-[var(--crm-text-muted)]">
              productos detectados
            </span>
          </div>
          <div
            className={`${needsReviewCount ? "bg-amber-500/15 text-amber-700 dark:text-amber-200" : "bg-emerald-500/15 text-emerald-700 dark:text-emerald-200"} rounded-2xl p-3`}
          >
            <strong className="block text-2xl font-black">
              {needsReviewCount}
            </strong>
            <span className="text-xs">necesitan revisión</span>
          </div>
        </div>
        <div
          className="mt-4 grid grid-cols-2 gap-2 rounded-2xl bg-[var(--crm-surface-soft)] p-1.5"
          role="group"
          aria-label="Filtro de líneas"
        >
          <Button
            active={!showAll}
            onClick={() => setShowAll(false)}
            type="button"
            variant="tertiary"
          >
            Revisar {needsReviewCount}
          </Button>
          <Button
            active={showAll}
            onClick={() => setShowAll(true)}
            type="button"
            variant="tertiary"
          >
            Ver todos
          </Button>
        </div>
      </header>
      <div className="grid gap-3">
        {visibleLines.map((line) => {
          const item = inventory.items.find(
            (candidate) => candidate.id === line.inventoryItemId,
          );
          const unit = inventory.units.find(
            (candidate) => candidate.id === item?.baseUnitId,
          );
          const warehouse = inventory.warehouses.find(
            (candidate) => candidate.id === line.warehouseId,
          );
          return (
            <button
              className={`w-full rounded-3xl bg-[var(--crm-surface)] p-5 text-left shadow-[var(--crm-shadow-card)] ${isConfirmedDocument ? "cursor-default" : "transition-transform active:scale-[0.995]"}`}
              disabled={isConfirmedDocument}
              key={line.id}
              onClick={() => openEditor(line)}
              type="button"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h3 className="truncate text-base font-black">
                    {line.descriptionRaw}
                  </h3>
                  <p className="mt-1 text-sm text-[var(--crm-text-muted)]">
                    {formatQuantity(line.quantity)}{" "}
                    {line.purchaseUnit ?? "sin unidad"}
                    {line.unitPrice === null
                      ? ""
                      : ` · ${formatCost(line.unitPrice)}/${line.purchaseUnit ?? "ud"}`}
                  </p>
                </div>
                {!isConfirmedDocument ? <ChevronRight className="mt-1 size-5 shrink-0 text-[var(--crm-text-muted)]" /> : null}
              </div>
              {item && line.baseQuantity !== null ? (
                <div className="mt-4 grid gap-2 rounded-2xl bg-[var(--crm-surface-soft)] p-3 sm:grid-cols-2">
                  <div>
                    <span className="text-xs text-[var(--crm-text-muted)]">
                      → {item.name}
                    </span>
                    <strong className="mt-1 block">
                      +{formatQuantity(line.baseQuantity)} {unit?.symbol}
                    </strong>
                  </div>
                  <div className="sm:text-right">
                    <span className="text-xs text-[var(--crm-text-muted)]">
                      {warehouse?.name ?? "Sin almacén"}
                    </span>
                    <strong className="mt-1 block">
                      {formatCost(line.normalizedUnitCost)}/{unit?.symbol}
                    </strong>
                  </div>
                </div>
              ) : null}
              <div className="mt-4">
                <LineStatus status={line.matchStatus} />
              </div>
            </button>
          );
        })}
      </div>
      {error ? (
        <p className="rounded-2xl bg-[var(--crm-red-soft)] p-4 text-sm font-semibold text-[var(--crm-red)]">
          {error}
        </p>
      ) : null}
      {!isConfirmedDocument ? <div className="fixed inset-x-0 bottom-0 z-30 border-t border-[var(--crm-border-subtle)] bg-[var(--crm-surface)]/95 p-3 pb-[max(12px,env(safe-area-inset-bottom))] backdrop-blur xl:left-[var(--crm-sidebar-width)]">
        <div className="mx-auto max-w-3xl">
          <Button
            className="!min-h-14 !w-full !rounded-2xl !text-base !font-black"
            disabled={disabled || busy || !supplierReview?.hasSupplier || !documentDate || (affectsStock && needsReviewCount > 0)}
            onClick={() => setScreen("costs")}
            type="button"
            variant="primary"
          >
            {!supplierReview?.hasSupplier
              ? "Selecciona un proveedor"
              : affectsStock && needsReviewCount
              ? `Resuelve ${needsReviewCount} ${needsReviewCount === 1 ? "línea" : "líneas"}`
              : "Revisar cambios de coste"}
            <ChevronRight className="size-5" />
          </Button>
        </div>
      </div> : null}

      {reparseConfirmation ? (
        <CrmModal label="Actualizar líneas con este proveedor" onClose={() => setReparseConfirmation(false)}>
          <div className="grid gap-4 p-5">
            <h3 className="text-lg font-bold">Recalcular las líneas</h3>
            <p className="text-sm text-[var(--crm-text-muted)]">Hay correcciones manuales. Las líneas detectadas se recalcularán con el proveedor seleccionado y pueden sobrescribir los cambios no confirmados.</p>
            <div className="flex justify-end gap-2">
              <Button disabled={busy} onClick={() => setReparseConfirmation(false)} type="button" variant="tertiary">Cancelar</Button>
              <Button disabled={busy} onClick={() => void updateLinesWithSupplier(true)} type="button" variant="primary">Recalcular líneas</Button>
            </div>
          </div>
        </CrmModal>
      ) : null}
      {editingLine && draft ? (
        <CrmModal
          label={`Revisar ${editingLine.descriptionRaw}`}
          onClose={() => setEditingLineId(null)}
        >
          <div className="flex max-h-[calc(100dvh-24px)] flex-col">
            <header className="flex items-start justify-between gap-3 border-b border-[var(--crm-border-subtle)] p-5">
              <div>
                <p className="text-xs font-black uppercase tracking-widest text-[var(--crm-blue)]">
                  Editar línea
                </p>
                <h2 className="mt-1 text-lg font-black">
                  {editingLine.descriptionRaw}
                </h2>
              </div>
              <Button
                aria-label="Cerrar"
                onClick={() => setEditingLineId(null)}
                type="button"
                variant="tertiary"
              >
                <X className="size-4" />
              </Button>
            </header>
            <div className="grid min-h-0 gap-4 overflow-y-auto p-5">
              {!creatingItem ? (
                <>
                  <Field label="Artículo de inventario">
                    <CrmSelect
                      ariaLabel="Artículo de inventario"
                      onChange={(value) =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                inventoryItemId: value,
                                packageUnitId: "",
                              }
                            : current,
                        )
                      }
                      options={inventory.items
                        .filter((item) => item.active)
                        .map((item) => ({ value: item.id, label: item.name }))}
                      placeholder="Seleccionar existente"
                      searchable
                      value={draft.inventoryItemId}
                    />
                  </Field>
                  <Button
                    onClick={() => {
                      setCreatingItem(true);
                      setNewItem({
                        name: editingLine.descriptionRaw,
                        baseUnitId:
                          inventory.units.find((unit) => unit.active)?.id ?? "",
                        warehouseId:
                          inventory.warehouses.find(
                            (warehouse) => warehouse.active,
                          )?.id ?? "",
                        referenceCost: "",
                      });
                    }}
                    type="button"
                    variant="secondary"
                  >
                    <PackagePlus className="size-4" /> Crear nuevo artículo
                  </Button>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Cantidad">
                      <Input
                        inputMode="decimal"
                        onChange={(event) =>
                          setDraft({ ...draft, quantity: event.target.value })
                        }
                        value={draft.quantity}
                      />
                    </Field>
                    <Field label="Unidad/compra">
                      <Input
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            purchaseUnit: event.target.value,
                          })
                        }
                        placeholder="caja, kg, L…"
                        value={draft.purchaseUnit}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-3 gap-3">
                    <Field label="Unid./caja">
                      <Input
                        inputMode="decimal"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            packageCount: event.target.value,
                          })
                        }
                        placeholder="24"
                        value={draft.packageCount}
                      />
                    </Field>
                    <Field label="Contenido">
                      <Input
                        inputMode="decimal"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            packageUnitQuantity: event.target.value,
                          })
                        }
                        placeholder="33"
                        value={draft.packageUnitQuantity}
                      />
                    </Field>
                    <Field label="Unidad">
                      <CrmSelect
                        ariaLabel="Unidad de contenido"
                        onChange={(packageUnitId) =>
                          setDraft({ ...draft, packageUnitId })
                        }
                        options={packageUnitOptions}
                        placeholder="Selecciona una unidad"
                        searchable
                        value={draft.packageUnitId}
                      />
                    </Field>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Precio unitario">
                      <Input
                        inputMode="decimal"
                        onChange={(event) =>
                          setDraft({ ...draft, unitPrice: event.target.value })
                        }
                        value={draft.unitPrice}
                      />
                    </Field>
                    <Field label="Descuento">
                      <Input
                        inputMode="decimal"
                        onChange={(event) =>
                          setDraft({
                            ...draft,
                            discountAmount: event.target.value,
                          })
                        }
                        value={draft.discountAmount}
                      />
                    </Field>
                  </div>
                  <Field label="Almacén destino">
                    <CrmSelect
                      ariaLabel="Almacén destino"
                      leadingIcon={<Warehouse className="size-4" />}
                      onChange={(value) =>
                        setDraft((current) =>
                          current
                            ? { ...current, warehouseId: value }
                            : current,
                        )
                      }
                      options={inventory.warehouses
                        .filter((warehouse) => warehouse.active)
                        .map((warehouse) => ({
                          value: warehouse.id,
                          label: warehouse.name,
                        }))}
                      placeholder="Seleccionar almacén"
                      value={draft.warehouseId}
                    />
                  </Field>
                  <div
                    className={`${editorCalculation ? "border-emerald-500/40 bg-emerald-500/10" : "border-amber-500/40 bg-amber-500/10"} rounded-2xl border p-4`}
                  >
                    <p className="text-xs font-bold uppercase">
                      Resultado normalizado
                    </p>
                    {editorCalculation ? (
                      <>
                        <strong className="mt-2 block text-xl">
                          +{formatQuantity(editorCalculation.baseQuantity)}{" "}
                          {editorCalculation.baseUnit.symbol}
                        </strong>
                        <span className="mt-1 block text-sm">
                          {formatCost(editorCalculation.normalizedUnitCost)}/
                          {editorCalculation.baseUnit.symbol}
                        </span>
                      </>
                    ) : (
                      <p className="mt-2 text-sm font-semibold">
                        La conversión no es segura. Revisa unidad y formato.
                      </p>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <Button
                    className="!justify-start !px-0"
                    onClick={() => setCreatingItem(false)}
                    type="button"
                    variant="tertiary"
                  >
                    <ArrowLeft className="size-4" /> Seleccionar existente
                  </Button>
                  <Field label="Nombre">
                    <Input
                      onChange={(event) =>
                        setNewItem({ ...newItem, name: event.target.value })
                      }
                      value={newItem.name}
                    />
                  </Field>
                  <Field label="Unidad base">
                    <CrmSelect
                      onChange={(value) =>
                        setNewItem((current) => ({
                          ...current,
                          baseUnitId: value,
                        }))
                      }
                      options={inventory.units
                        .filter((unit) => unit.active)
                        .map((unit) => ({
                          value: unit.id,
                          label: `${unit.name} (${unit.symbol})`,
                        }))}
                      value={newItem.baseUnitId}
                    />
                  </Field>
                  <Field label="Almacén/ruta">
                    <CrmSelect
                      onChange={(value) =>
                        setNewItem((current) => ({
                          ...current,
                          warehouseId: value,
                        }))
                      }
                      options={inventory.warehouses
                        .filter((warehouse) => warehouse.active)
                        .map((warehouse) => ({
                          value: warehouse.id,
                          label: warehouse.name,
                        }))}
                      value={newItem.warehouseId}
                    />
                  </Field>
                  <Field label="Coste referencia inicial (opcional)">
                    <Input
                      inputMode="decimal"
                      onChange={(event) =>
                        setNewItem({
                          ...newItem,
                          referenceCost: event.target.value,
                        })
                      }
                      placeholder="0,00"
                      value={newItem.referenceCost}
                    />
                  </Field>
                  <Button
                    disabled={busy}
                    onClick={() => void createItem()}
                    type="button"
                    variant="primary"
                  >
                    <PackagePlus className="size-4" /> Crear artículo
                  </Button>
                </>
              )}
              {error ? (
                <p className="rounded-2xl bg-[var(--crm-red-soft)] p-3 text-sm font-semibold text-[var(--crm-red)]">
                  {error}
                </p>
              ) : null}
            </div>
            {!creatingItem ? (
              <footer className="grid grid-cols-2 gap-2 border-t border-[var(--crm-border-subtle)] p-4 pb-[max(16px,env(safe-area-inset-bottom))]">
                <Button
                  onClick={() => setEditingLineId(null)}
                  type="button"
                  variant="tertiary"
                >
                  Cancelar
                </Button>
                <Button
                  disabled={busy || !editorCalculation || !draft.warehouseId}
                  onClick={() => void saveEditor()}
                  type="button"
                  variant="primary"
                >
                  <Check className="size-4" /> Guardar línea
                </Button>
              </footer>
            ) : null}
          </div>
        </CrmModal>
      ) : null}
    </section>
  );
}
