import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CopyPlus,
  GripVertical,
  Lock,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppModal, Button, Input, TextArea } from "../../../../components/ui";
import type { PrinterLayout } from "../../../local-printing/types.ts";
import type { TenantContext } from "../../../../types";
import { CrmSelect } from "../../shared/components/CrmSelect";
import type { RunAction } from "../../shared/types";
import {
  PRINT_TEMPLATE_TYPE_LABELS,
  PRINT_TEMPLATE_VARIABLES,
  getMockPrintTemplateContext,
} from "../../../print-templates/catalog.ts";
import {
  getSafeDefaultPrintTemplate,
  SALE_MANDATORY_GROUPS,
  SALE_TEMPLATE_SLOTS,
  type SaleTemplateSlot,
} from "../../../print-templates/defaults.ts";
import {
  extractSafeSaleCustomization,
  isRegulatedSaleTemplateType,
} from "../../../print-templates/saleTemplateGuard.ts";
import {
  renderPrintTemplate,
  renderPrintTemplateWithFallback,
} from "../../../print-templates/renderer.ts";
import {
  resolvePrintTemplate,
  restoreDefaultPrintTemplate,
  savePrintTemplate,
} from "../../../print-templates/service.ts";
import {
  PRINT_TEMPLATE_TYPES,
  type PrintTemplateBlock,
  type PrintTemplateContext,
  type PrintTemplateDefinition,
  type PrintTemplateType,
  type RenderedTemplateElement,
} from "../../../print-templates/types.ts";

type Props = {
  context: TenantContext;
  disabled: boolean;
  runAction: RunAction;
  venueId: string;
};

type BlockPath = number[];
type EditingTarget = { path: BlockPath; context: PrintTemplateContext };

type ResolvedBlock = {
  block: PrintTemplateBlock;
  parent: PrintTemplateBlock | null;
  siblings: PrintTemplateBlock[];
  index: number;
};

const previewLayout = {
  columns: 48 as const,
  paperWidth: 80 as const,
  characterSet: "CP858",
};

type PersonalizationTextBlock = Extract<PrintTemplateBlock, { type: "text" }>;

type PersonalizationEntry = {
  block: PersonalizationTextBlock;
  index: number;
};

type MandatoryGroup = {
  id: string;
  label: string;
  blockIds: readonly string[];
};

const mandatorySaleGroups: readonly MandatoryGroup[] = [
  { id: "fiscal", label: "Verificación fiscal", blockIds: SALE_MANDATORY_GROUPS.fiscal },
  { id: "issuer", label: "Emisor", blockIds: SALE_MANDATORY_GROUPS.issuer },
  { id: "document", label: "Identificación del documento fiscal", blockIds: SALE_MANDATORY_GROUPS.document },
  { id: "rectification_customer", label: "Rectificación y cliente (cuando aplique)", blockIds: ["rectified-document", "rectified-invoice", "rectified-date", "cash-register", "employee", "customer-gap", "customer-title", "customer-separator", "customer-name", "customer-tax-id", "customer-address", "customer-postal-code", "customer-city", "customer-province", "customer-country"] },
  { id: "items", label: "Productos", blockIds: SALE_MANDATORY_GROUPS.items },
  { id: "totals", label: "Impuestos y totales", blockIds: SALE_MANDATORY_GROUPS.totals },
  { id: "footer", label: "Pago y pie fiscal", blockIds: ["payment-gap", "payment-title", "payment-separator", "payment", "fiscal-footer-gap", "fiscal-footer", "footer-gap", "footer"] },
];

const slotLabels: Record<SaleTemplateSlot, string> = {
  top: "Antes de la verificación fiscal",
  after_issuer: "Después del emisor",
  after_document: "Después de la identificación fiscal",
  before_items: "Antes de productos",
  after_items: "Después de productos",
  after_totals: "Después de impuestos y totales",
  bottom: "Al final del ticket",
};

/**
 * Same literal rule enforced by the print-template service guard: any template
 * braces mark a block as structural, so it is never editable as personalization.
 */
const templateBracesPattern = /\{\{|\}\}/u;

function hasTemplateBraces(value: string) {
  return templateBracesPattern.test(value);
}

/** Personalization is literal text only, and never part of the regulated structure. */
function isPersonalizationText(
  block: PrintTemplateBlock,
  regulatedBlockIds: ReadonlySet<string>,
): block is PersonalizationTextBlock {
  return (
    block.type === "text" &&
    !block.when &&
    !block.unless &&
    !hasTemplateBraces(block.value) &&
    !regulatedBlockIds.has(block.id)
  );
}

function selectPersonalizationEntries(
  blocks: PrintTemplateBlock[],
  regulatedBlockIds: ReadonlySet<string>,
): PersonalizationEntry[] {
  return blocks.reduce<PersonalizationEntry[]>((entries, block, index) => {
    if (isPersonalizationText(block, regulatedBlockIds)) {
      entries.push({ block, index });
    }
    return entries;
  }, []);
}

/** Mirrors the service guard so a text the service would drop is never saved silently. */
function getPersonalizationSlot(id: string): SaleTemplateSlot {
  const match = /^custom-text:([a-z_]+):\d+$/u.exec(id);
  return match && SALE_TEMPLATE_SLOTS.includes(match[1] as SaleTemplateSlot)
    ? (match[1] as SaleTemplateSlot)
    : "bottom";
}

function assembleSaleBlocks(
  structural: PrintTemplateBlock[],
  personalizations: PersonalizationEntry[],
): PrintTemplateBlock[] {
  const bySlot = new Map<SaleTemplateSlot, PrintTemplateBlock[]>();
  SALE_TEMPLATE_SLOTS.forEach((slot) => bySlot.set(slot, []));
  personalizations.forEach(({ block }) => bySlot.get(getPersonalizationSlot(block.id))?.push(block));
  const anchors: Record<SaleTemplateSlot, string | undefined> = {
    top: "fiscal-top-gap",
    after_issuer: "venue-address",
    after_document: "ticket-date",
    before_items: "customer-country",
    after_items: "items",
    after_totals: "totals",
    bottom: undefined,
  };
  const result: PrintTemplateBlock[] = [];
  for (const block of structural) {
    result.push(block);
    for (const slot of SALE_TEMPLATE_SLOTS) {
      if (anchors[slot] === block.id) result.push(...(bySlot.get(slot) ?? []));
    }
  }
  result.push(...(bySlot.get("bottom") ?? []));
  return result;
}

function findBlockedPersonalizationId(
  personalizations: PersonalizationEntry[],
  regulatedDefinition: PrintTemplateDefinition,
): string | null {
  const candidates = personalizations.filter(
    ({ block }) => block.value.trim().length > 0,
  );
  if (!candidates.length) return null;
  const accepted = extractSafeSaleCustomization(
    { version: 1, blocks: candidates.map(({ block }) => block) },
    regulatedDefinition,
  );
  const acceptedBlocks = Object.values(accepted).flat();
  if (acceptedBlocks.length === candidates.length) return null;
  const acceptedIds = new Set(acceptedBlocks.map((block) => block.id));
  const blocked = candidates.find(({ block }) => !acceptedIds.has(block.id));
  return blocked?.block.id ?? null;
}

/** Personalization-only definition; the service layer merges the regulated structure. */
function toPersonalizationDefinition(
  blocks: PrintTemplateBlock[],
  regulatedBlockIds: ReadonlySet<string>,
): PrintTemplateDefinition {
  const entries = selectPersonalizationEntries(blocks, regulatedBlockIds)
    .map(({ block }) => block)
    .filter((block) => block.value.trim().length > 0);
  return {
    version: 1,
    blocks: entries.length
      ? entries
      : [{ id: newBlockId(), type: "text", value: "" }],
  };
}

function updatePersonalizationTextAt(
  blocks: PrintTemplateBlock[],
  index: number,
  value: string,
): PrintTemplateBlock[] {
  return blocks.map((block, position) =>
    position === index && block.type === "text" ? { ...block, value } : block,
  );
}

function removePersonalizationAt(
  blocks: PrintTemplateBlock[],
  index: number,
): PrintTemplateBlock[] {
  return blocks.filter((_, position) => position !== index);
}

function movePersonalization(
  blocks: PrintTemplateBlock[],
  from: number,
  to: number,
  regulatedBlockIds: ReadonlySet<string>,
): PrintTemplateBlock[] {
  const positions = blocks.flatMap((block, index) =>
    isPersonalizationText(block, regulatedBlockIds) ? [index] : [],
  );
  if (from === to || from < 0 || to < 0) return blocks;
  if (from >= positions.length || to >= positions.length) return blocks;
  const group = positions.map((position) => blocks[position]);
  const [moved] = group.splice(from, 1);
  group.splice(to, 0, moved);
  const next = [...blocks];
  positions.forEach((position, offset) => {
    next[position] = group[offset];
  });
  return next;
}

export function PrintTemplatesCrm({
  context,
  disabled,
  runAction,
  venueId,
}: Props) {
  const [type, setType] = useState<PrintTemplateType>("simplified_invoice");
  const [definition, setDefinition] = useState<PrintTemplateDefinition>(() =>
    getSafeDefaultPrintTemplate(type),
  );
  const [isCustom, setIsCustom] = useState(false);
  const [editing, setEditing] = useState<EditingTarget | null>(null);
  const [variableNotice, setVariableNotice] = useState(false);
  const scope = useMemo(
    () => ({ tenantId: context.tenantId, venueId }),
    [context.tenantId, venueId],
  );
  const mockContext = useMemo(() => getMockPrintTemplateContext(type), [type]);
  const isSale = isRegulatedSaleTemplateType(type);

  useEffect(() => {
    let active = true;
    void runAction(async () => {
      const resolved = await resolvePrintTemplate(scope, type);
      if (!active) return;
      setDefinition(structuredClone(resolved.definition));
      setIsCustom(resolved.isCustom);
      setVariableNotice(false);
    });
    return () => {
      active = false;
    };
  }, [runAction, scope, type]);

  const fallback = useMemo(() => getSafeDefaultPrintTemplate(type), [type]);
  const regulatedBlockIds = useMemo(
    () => new Set(fallback.blocks.map((block) => block.id)),
    [fallback],
  );
  const personalizations = useMemo(
    () => selectPersonalizationEntries(definition.blocks, regulatedBlockIds),
    [definition.blocks, regulatedBlockIds],
  );
  const assembledSaleDefinition = useMemo<PrintTemplateDefinition>(
    () => ({ version: 1, blocks: assembleSaleBlocks(fallback.blocks, personalizations) }),
    [fallback.blocks, personalizations],
  );
  const preview = useMemo(
    () =>
      renderPrintTemplateWithFallback(
        isSale ? assembledSaleDefinition : definition,
        fallback,
        mockContext,
        previewLayout,
      ),
    [assembledSaleDefinition, definition, fallback, isSale, mockContext],
  );
  const blockedPersonalizationId = useMemo(
    () =>
      isSale
        ? findBlockedPersonalizationId(personalizations, fallback)
        : null,
    [isSale, personalizations, fallback],
  );

  const persist = () =>
    runAction(async () => {
      if (isSale && blockedPersonalizationId) return;
      await savePrintTemplate(
        scope,
        type,
        isSale
          ? toPersonalizationDefinition(definition.blocks, regulatedBlockIds)
          : definition,
      );
      setIsCustom(true);
    });

  const restore = () =>
    runAction(async () => {
      const resolved = await restoreDefaultPrintTemplate(scope, type);
      setDefinition(structuredClone(resolved.definition));
      setIsCustom(false);
    });

  const addBlock = (block: PrintTemplateBlock) =>
    setDefinition((current) => ({
      ...current,
      blocks: [...current.blocks, block],
    }));

  const addVariable = (path: string) =>
    addBlock({
      id: newBlockId(),
      type: "text",
      value: `{{${path}}}`,
    });

  const addPersonalizationText = (slot: SaleTemplateSlot = "bottom") =>
    setDefinition((current) => ({
      ...current,
      blocks: [...current.blocks, { ...newBlock("text"), id: `custom-text:${slot}:${Date.now()}` }],
    }));

  const updatePersonalizationText = (index: number, value: string) => {
    if (hasTemplateBraces(value)) {
      setVariableNotice(true);
      return;
    }
    setVariableNotice(false);
    setDefinition((current) => ({
      ...current,
      blocks: updatePersonalizationTextAt(current.blocks, index, value),
    }));
  };

  const removePersonalizationText = (index: number) =>
    setDefinition((current) => ({
      ...current,
      blocks: removePersonalizationAt(current.blocks, index),
    }));

  const movePersonalizationText = (from: number, to: number) =>
    setDefinition((current) => ({
      ...current,
      blocks: movePersonalization(
        current.blocks,
        from,
        to,
        regulatedBlockIds,
      ),
    }));

  const movePersonalizationSlot = (index: number, slot: SaleTemplateSlot) =>
    setDefinition((current) => ({
      ...current,
      blocks: current.blocks.map((block, position) =>
        position === personalizations[index]?.index && block.type === "text"
          ? { ...block, id: `custom-text:${slot}:${index + 1}` }
          : block,
      ),
    }));

  const edited = useMemo(
    () =>
      editing ? readBlockAtPath(editing.path, definition.blocks) ?? null : null,
    [editing, definition.blocks],
  );

  const updateEditingBlock = (next: PrintTemplateBlock) => {
    if (!editing) return;
    setDefinition((current) => ({
      ...current,
      blocks: updateBlockAtPath(editing.path, next, current.blocks),
    }));
  };

  const deleteEditingBlock = () => {
    if (!editing) return;
    setDefinition((current) => ({
      ...current,
      blocks: removeBlockAtPath(editing.path, current.blocks),
    }));
    setEditing(null);
  };

  const addChildToEditing = (child: PrintTemplateBlock) => {
    if (!editing) return;
    setDefinition((current) => ({
      ...current,
      blocks: appendBlockAtPath(editing.path, child, current.blocks),
    }));
  };

  return (
    <div className="space-y-5">
      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-black">Plantillas de impresión</h2>
            <p className="mt-1 max-w-3xl text-sm text-[var(--crm-text-muted)]">
              {isSale
                ? "La aplicación fija la estructura fiscal obligatoria en grupos protegidos. Solo puedes insertar textos comerciales literales entre esos grupos; no se admiten variables, condiciones, códigos QR ni bloques estructurales."
                : "Edita bloques lógicos; el TPV resuelve datos fiscales y de negocio antes de aplicar el diseño. No se admiten scripts ni comandos ESC/POS."}
            </p>
          </div>
          <span
            className={`rounded-full px-3 py-1 text-xs font-bold ${isCustom ? "bg-[var(--crm-blue-soft)] text-[var(--crm-blue)]" : "bg-[var(--crm-surface-soft)] text-[var(--crm-text-muted)]"}`}
          >
            {isCustom ? "Personalizada" : "Predeterminada"}
          </span>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-[minmax(260px,1fr)_auto_auto]">
          <CrmSelect
            onChange={(value) => setType(value as PrintTemplateType)}
            options={PRINT_TEMPLATE_TYPES.map((value) => ({
              label: PRINT_TEMPLATE_TYPE_LABELS[value],
              value,
            }))}
            value={type}
          />
          <Button
            disabled={disabled || blockedPersonalizationId !== null}
            onClick={() => void persist()}
            type="button"
            variant="primary"
          >
            <Save className="h-4 w-4" /> Guardar
          </Button>
          <Button
            disabled={disabled || !isCustom}
            onClick={() => void restore()}
            type="button"
            variant="secondary"
          >
            <RotateCcw className="h-4 w-4" /> Restaurar predeterminada
          </Button>
        </div>
      </section>

      {isSale ? (
        <SaleTemplateSections
          blockedId={blockedPersonalizationId}
          context={mockContext}
          disabled={disabled}
          layout={previewLayout}
          onAdd={addPersonalizationText}
          onChangeText={updatePersonalizationText}
          onMove={movePersonalizationText}
          onMoveSlot={movePersonalizationSlot}
          onRemove={removePersonalizationText}
          personalizations={personalizations}
           regulatedDefinition={assembledSaleDefinition}

          variableNotice={variableNotice}
        />
      ) : (
      <div className="grid items-start gap-5 xl:grid-cols-[220px_minmax(360px,1fr)_300px]">
        <section className="rounded-2xl bg-[var(--crm-surface)] p-4 shadow-[var(--crm-shadow-card)] xl:sticky xl:top-0">
          <div className="mb-4 flex items-center gap-2">
            <Settings2 className="h-4 w-4 text-[var(--crm-blue)]" />
            <div>
              <h3 className="text-sm font-black">Elementos</h3>
              <p className="text-[11px] text-[var(--crm-text-muted)]">
                Se añaden al final del ticket
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <BlockAddButtons disabled={disabled} onAdd={addBlock} />
          </div>
          <div className="mt-5 rounded-xl bg-[var(--crm-blue-soft)] p-3 text-xs leading-relaxed text-[var(--crm-blue)]">
            <strong>Consejo</strong>
            <br />
            Pulsa sobre cualquier línea del ticket para editar su contenido,
            estilo u orden.
          </div>
        </section>

        <section className="min-w-0 rounded-2xl bg-[var(--crm-surface-soft)] p-4 shadow-[var(--crm-shadow-card)] sm:p-6">
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="font-black">Editor del ticket</h3>
              <p className="text-xs text-[var(--crm-text-muted)]">
                Vista previa editable · 80 mm
              </p>
            </div>
            <span className="rounded-full bg-white px-3 py-1 text-[11px] font-bold text-[var(--crm-text-muted)] shadow-sm">
              {definition.blocks.length} elementos
            </span>
          </div>
          <div className="mx-auto max-w-[430px] bg-white px-5 py-7 font-mono text-[12px] leading-[1.45] text-black shadow-[0_12px_35px_rgba(15,23,42,.14)] sm:px-7">
            <BlockRows
              basePath={[]}
              blocks={definition.blocks}
              context={mockContext}
              disabled={disabled}
              emptyMessage="Añade al menos un bloque."
              layout={previewLayout}
          onMove={(from, to) =>
            setDefinition((current) => ({
              ...current,
              blocks: reorderBlockAtPath(from, to, current.blocks),
            }))
          }
          onOpen={(path) => setEditing({ path, context: mockContext })}
          paper
            />
          </div>
          <p className="mt-3 text-center text-[11px] text-[var(--crm-text-muted)]">
            Toca cualquier línea para abrir su configuración.
          </p>
        </section>

        <div className="grid gap-5 xl:sticky xl:top-0">
          <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
            <h3 className="font-black">Variables disponibles</h3>
            <p className="mb-3 text-xs text-[var(--crm-text-muted)]">
              Haz clic para añadir una línea al ticket.
            </p>
            <div className="max-h-[520px] space-y-4 overflow-auto pr-1">
              {PRINT_TEMPLATE_VARIABLES[type].map((group) => (
                <div key={group.label}>
                  <h4 className="mb-1 text-xs font-black text-[var(--crm-text-muted)] uppercase">
                    {group.label}
                  </h4>
                  <div className="flex flex-wrap gap-1.5">
                    {group.variables.map((variable) => (
                      <button
                        className="rounded-lg bg-[var(--crm-surface-soft)] px-2 py-1 font-mono text-[11px] text-[var(--crm-text)] hover:bg-[var(--crm-blue-soft)]"
                        disabled={disabled}
                        key={`${group.label}-${variable.path}`}
                        onClick={() => addVariable(variable.path)}
                        title={variable.label}
                        type="button"
                      >{`{{${variable.path}}}`}</button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
            <h3 className="font-black">Resultado real</h3>
            <p className="mb-3 text-xs text-[var(--crm-text-muted)]">
              La previsualización usa datos de ejemplo.
            </p>
            <div className="rounded-xl bg-white p-3 font-mono text-[10px] leading-[1.4] text-black">
              {preview.elements.map((element, index) =>
                element.type === "qr" ? (
                  <div className="break-all text-center" key={`${index}-qr`}>
                    [QR] {element.data}
                  </div>
                ) : (
                  <div
                    key={`${index}-text`}
                    style={{
                      fontWeight: element.bold ? 800 : 500,
                      textAlign: element.align ?? "left",
                      whiteSpace: "pre-wrap",
                    }}
                  >
                    {element.value || "\u00a0"}
                  </div>
                ),
              )}
            </div>
          </section>
        </div>
      </div>
      )}

      {!isSale && editing && edited ? (
        <BlockModal
          block={edited.block}
          canGoBack={editing.path.length > 1}
          context={editing.context}
          disabled={disabled}
          label={blockLabel(edited.block.type)}
          layout={previewLayout}
          onAddChild={addChildToEditing}
          onBack={() =>
            setEditing({ ...editing, path: editing.path.slice(0, -1) })
          }
          onChange={updateEditingBlock}
          onClose={() => setEditing(null)}
          onDelete={deleteEditingBlock}
          onOpenChild={(childPath, childContext) =>
            setEditing({ path: childPath, context: childContext })
          }
          path={editing.path}
        />
      ) : null}
    </div>
  );
}

function ReceiptQr({ data, size = 150 }: { data: string; size?: number }) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    void QRCode.toDataURL(data, {
      errorCorrectionLevel: "M",
      margin: 1,
      width: size,
    }).then((nextDataUrl) => {
      if (!cancelled) setDataUrl(nextDataUrl);
    }).catch(() => {
      if (!cancelled) setDataUrl(null);
    });
    return () => {
      cancelled = true;
    };
  }, [data, size]);

  return (
    <div className="my-2 flex justify-center" style={{ minHeight: size }}>
      {dataUrl ? (
        <img
          alt="Código QR de verificación fiscal"
          className="block max-w-full"
          height={size}
          src={dataUrl}
          style={{ imageRendering: "pixelated" }}
          width={size}
        />
      ) : (
        <div aria-label="Generando código QR" className="bg-slate-100" style={{ height: size, width: size }} />
      )}
    </div>
  );
}

function AssembledSalePreview({
  definition,
  context,
  layout,
  qrSize = 150,
}: { definition: PrintTemplateDefinition; context: PrintTemplateContext; layout: PrinterLayout; qrSize?: number }) {
  const elements = renderPrintTemplate(definition, context, layout).elements;
  return elements.map((element, index) => {
    if (element.type === "qr") {
      return <ReceiptQr data={element.data} key={`qr-${index}-${element.data}`} size={qrSize} />;
    }
    const align = element.align ?? "left";
    return (
      <div
        className="whitespace-pre"
        key={`text-${index}-${element.value}`}
        style={{
          fontSize: element.size === "large" ? "1.25em" : undefined,
          fontWeight: element.bold ? 700 : 400,
          minHeight: element.value ? undefined : "1.45em",
          textAlign: align,
          whiteSpace: "pre",
        }}
      >
        {element.value || " "}
      </div>
    );
  });
}

function SaleTemplateSections({
  blockedId,
  context,
  disabled,
  layout,
  onAdd,
  onChangeText,
  onMove,
  onMoveSlot,
  onRemove,
  personalizations,
  regulatedDefinition,
  variableNotice,
}: {
  blockedId: string | null;
  context: PrintTemplateContext;
  disabled: boolean;
  layout: PrinterLayout;
  onAdd: (slot?: SaleTemplateSlot) => void;
  onChangeText: (index: number, value: string) => void;
  onMove: (from: number, to: number) => void;
  onMoveSlot: (index: number, slot: SaleTemplateSlot) => void;
  onRemove: (index: number) => void;
  personalizations: PersonalizationEntry[];
  regulatedDefinition: PrintTemplateDefinition;
  variableNotice: boolean;
}) {
  return (
    <div className="grid items-start gap-5 xl:grid-cols-[minmax(320px,1fr)_minmax(320px,1fr)]">
      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Lock className="h-4 w-4 text-[var(--crm-blue)]" />
            <h3 className="font-black">Estructura fiscal obligatoria</h3>
          </div>
          <span className="rounded-full bg-[var(--crm-surface-soft)] px-3 py-1 text-[11px] font-bold text-[var(--crm-text-muted)]">
              {mandatorySaleGroups.length} grupos fijos
          </span>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--crm-text-muted)]">
          La aplicación fija el contenido y el orden de estos bloques fiscales.
          No se pueden editar, añadir, reordenar ni eliminar.
        </p>
        <ul className="mt-3 space-y-2 text-xs leading-relaxed text-[var(--crm-text)]">
          <li className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
            <strong>RD 1619/2012, arts. 6 y 7</strong>: contenido mínimo de la
            factura simplificada (identificación del emisor, número y fecha de
            expedición, descripción de la operación, base imponible, cuota de IVA
            e importe total).
          </li>
          <li className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
            <strong>Orden HAC/1177/2024, arts. 20 y 21</strong>: huella y
            encadenamiento del registro de facturación, y código QR de
            verificación con NIF, serie/número, fecha e importe.
          </li>
        </ul>
        <div className="mt-3 space-y-2">
          {mandatorySaleGroups.map((group) => {
            const blocks = regulatedDefinition.blocks.filter((block) => group.blockIds.includes(block.id));
            const elements = renderPrintTemplate({ version: 1, blocks }, context, layout).elements;
             if (!elements.some((element) => element.type === "qr" || element.value.trim())) return null;
             return <div className="rounded-xl bg-[var(--crm-surface-soft)] p-3" key={group.id}><strong>{group.label}</strong><div className="mt-1 font-mono"><AssembledSalePreview definition={{ version: 1, blocks }} context={context} layout={layout} qrSize={96} /></div></div>;

          })}
        </div>
        <div className="mt-4">
          <p className="mb-2 text-[11px] font-black text-[var(--crm-text-muted)] uppercase">
            Vista previa regulada (datos de ejemplo)
          </p>
          <div className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
            <div className="mx-auto min-h-[420px] w-full max-w-[360px] overflow-x-auto bg-white px-5 py-7 font-mono text-[10px] leading-[1.45] text-black shadow-[0_2px_12px_rgba(0,0,0,0.14)]">
              <AssembledSalePreview definition={regulatedDefinition} context={context} layout={layout} />
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
        <div className="flex items-center gap-2">
          <Settings2 className="h-4 w-4 text-[var(--crm-blue)]" />
          <h3 className="font-black">Personalización</h3>
        </div>
        <p className="mt-2 text-xs leading-relaxed text-[var(--crm-text-muted)]">
          Solo textos comerciales literales, que puedes insertar entre grupos,
           sin variables, condiciones, códigos QR ni bloques estructurales. Logo/imagen:
           requiere actualización compatible del agente de impresión.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {SALE_TEMPLATE_SLOTS.map((slot) => <Button disabled={disabled} key={slot} onClick={() => onAdd(slot)} size="sm" type="button" variant="secondary"><Plus className="h-3.5 w-3.5" /> {slotLabels[slot]}</Button>)}
        </div>
        {personalizations.length ? (
          <ul className="mt-3 space-y-2">
            {personalizations.map(({ block, index }, position) => {
              return (
                <li
                  className="rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3"
                  key={block.id}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="text-[11px] font-black text-[var(--crm-text-muted)] uppercase">
                      Texto comercial {position + 1}
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        aria-label="Subir texto"
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-hover)] disabled:opacity-30"
                        disabled={disabled || position === 0}
                        onClick={() => onMove(position, position - 1)}
                        type="button"
                      >
                        <ChevronUp className="h-4 w-4" />
                      </button>
                      <button
                        aria-label="Bajar texto"
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-hover)] disabled:opacity-30"
                        disabled={
                          disabled || position === personalizations.length - 1
                        }
                        onClick={() => onMove(position, position + 1)}
                        type="button"
                      >
                        <ChevronDown className="h-4 w-4" />
                      </button>
                      <button
                        aria-label="Eliminar texto"
                        className="flex h-10 w-10 items-center justify-center rounded-lg text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-hover)] disabled:opacity-30"
                        disabled={disabled}
                        onClick={() => onRemove(index)}
                        type="button"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                  <div className="mb-2">
                    <p className="mb-1 text-[11px] font-black text-[var(--crm-text-muted)] uppercase">
                      Posición en el ticket
                    </p>
                    <CrmSelect
                      ariaLabel={`Posición del texto comercial ${position + 1}`}
                      compact
                      disabled={disabled}
                      onChange={(value) =>
                        onMoveSlot(position, value as SaleTemplateSlot)
                      }
                      options={SALE_TEMPLATE_SLOTS.map((slot) => ({
                        label: slotLabels[slot],
                        value: slot,
                      }))}
                      value={getPersonalizationSlot(block.id)}
                    />
                  </div>
                  <TextArea
                    className="!min-h-20 !w-full !rounded-[10px] !border !border-[var(--crm-input-border)] !bg-[var(--crm-input-bg)] !px-3.5 !py-3 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none placeholder:!text-[var(--crm-text-muted)] focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)]"
                    disabled={disabled}
                    maxLength={240}
                    onChange={(event) => onChangeText(index, event.target.value)}
                    placeholder="Texto comercial, por ejemplo: ¡Gracias por su compra!"
                    value={block.value}
                  />
                  {block.id === blockedId ? (
                    <p className="mt-1.5 text-[11px] font-bold text-red-600">
                      Este texto no se guardará tal cual: debe ser literal, no
                      vacío, sin variables, distinto de los textos de la
                      estructura obligatoria y sin la leyenda VERI*FACTU.
                    </p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-3 rounded-xl bg-[var(--crm-surface-soft)] p-3 text-xs text-[var(--crm-text-muted)]">
            Sin textos de personalización. Solo se imprimirá la estructura fiscal
            obligatoria.
          </p>
        )}
        {variableNotice ? (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700">
            Las variables {"{{...}}"} no están permitidas en facturas: este texto
            debe ser literal.
          </p>
        ) : null}
        {blockedId ? (
          <p className="mt-3 rounded-xl bg-red-50 p-3 text-xs font-bold text-red-700">
            Corrige o elimina el texto marcado para poder guardar.
          </p>
        ) : null}
        <Button
          className="mt-3"
          disabled={disabled}
          fullWidth
          onClick={() => onAdd("bottom")}
          type="button"
          variant="secondary"
        >
          <Plus className="h-4 w-4" /> Añadir texto
        </Button>
        <p className="mt-3 text-[11px] leading-relaxed text-[var(--crm-text-muted)]">
          Al guardar, la aplicación combina estos textos con la estructura fiscal
          obligatoria.
        </p>
      </section>
    </div>
  );
}

function BlockRows({
  basePath,
  blocks,
  context,
  disabled,
  emptyMessage,
  layout,
  onMove,
  onOpen,
  paper = true,
}: {
  basePath: BlockPath;
  blocks: PrintTemplateBlock[];
  context: PrintTemplateContext;
  disabled: boolean;
  emptyMessage: string;
  layout: PrinterLayout;
  onMove?: (from: BlockPath, to: BlockPath) => void;
  onOpen: (path: BlockPath, childContext?: PrintTemplateContext) => void;
  paper?: boolean;
}) {
  const [draggingPath, setDraggingPath] = useState<BlockPath | null>(null);
  if (!blocks.length)
    return (
      <p className="rounded-xl bg-[var(--crm-surface-soft)] p-3 text-xs text-[var(--crm-text-muted)]">
        {emptyMessage}
      </p>
    );
  return (
    <div className={paper ? "space-y-0" : "divide-y divide-slate-100"}>
      {blocks.map((block, index) => {
        const path = [...basePath, index];
        return (
          <button
            className={`${
              paper
                ? "group flex w-full cursor-pointer items-start gap-1.5 py-0.5 pr-1 pl-0.5 text-left transition-colors hover:bg-amber-300 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                : "group flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--crm-surface-hover)] disabled:cursor-default disabled:opacity-60"
            } ${pathKey(draggingPath) === pathKey(path) ? "opacity-40" : ""}`}
            disabled={disabled}
            draggable={!disabled}
            key={block.id}
            onClick={() => onOpen(path)}
            onDragEnd={() => setDraggingPath(null)}
            onDragOver={(event) => {
              if (draggingPath && pathKey(draggingPath) !== pathKey(path))
                event.preventDefault();
            }}
            onDragStart={(event) => {
              setDraggingPath(path);
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/plain", pathKey(path));
            }}
            onDrop={(event) => {
              event.preventDefault();
              const source = parsePath(event.dataTransfer.getData("text/plain"));
              if (source && onMove) onMove(source, path);
              setDraggingPath(null);
            }}
            type="button"
          >
            <span
              aria-hidden="true"
              className="mt-0.5 shrink-0 cursor-grab text-[var(--crm-text-muted)] opacity-40 transition-opacity group-hover:opacity-100 active:cursor-grabbing"
            >
              <GripVertical className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 font-mono text-[12px] leading-[1.45]">
              <RowPreview block={block} context={context} layout={layout} />
            </span>
            <span
              className={
                paper
                  ? "shrink-0 text-[var(--crm-text-muted)] opacity-0 transition-opacity group-hover:opacity-100"
                  : "shrink-0 rounded bg-[var(--crm-input-bg)] px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-[var(--crm-text-muted)] uppercase"
              }
            >
              {paper ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                blockLabel(block.type)
              )}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function RowPreview({
  block,
  context,
  layout,
}: {
  block: PrintTemplateBlock;
  context: PrintTemplateContext;
  layout: PrinterLayout;
}) {
  if (block.type === "spacer") {
    const lines = Math.min(block.lines ?? 1, 8);
    return (
      <div>
        {Array.from({ length: lines }, (_, index) => (
          <div className="min-h-[1.45em]" key={`spacer-${index}`}>
            &nbsp;
          </div>
        ))}
      </div>
    );
  }
  const elements = renderBlockPreview(block, context, layout);
  const hasContent = elements.some(
    (element) => element.type === "qr" || element.value.trim() !== "",
  );
  if (!hasContent)
    return (
      <p className="text-[11px] text-[var(--crm-text-muted)] italic">
        Bloque sin contenido visible en la vista previa
      </p>
    );
  return (
    <div>
      {elements.map((element, index) =>
        element.type === "qr" ? (
          <div className="break-all text-center" key={`${block.id}-qr`}>
            [QR] {element.data}
          </div>
        ) : (
          <div
            className="min-h-[1.45em]"
            key={`${block.id}-${index}`}
            style={{
              fontWeight: element.bold ? 800 : 500,
              textAlign: element.align ?? "left",
              whiteSpace: "pre-wrap",
            }}
          >
            {element.value || "\u00a0"}
          </div>
        ),
      )}
    </div>
  );
}

function BlockModal({
  block,
  canGoBack,
  context,
  disabled,
  label,
  layout,
  onAddChild,
  onBack,
  onChange,
  onClose,
  onDelete,
  onOpenChild,
  path,
}: {
  block: PrintTemplateBlock;
  canGoBack: boolean;
  context: PrintTemplateContext;
  disabled: boolean;
  label: string;
  layout: PrinterLayout;
  onAddChild: (block: PrintTemplateBlock) => void;
  onBack: () => void;
  onChange: (block: PrintTemplateBlock) => void;
  onClose: () => void;
  onDelete: () => void;
  onOpenChild: (path: BlockPath, childContext: PrintTemplateContext) => void;
  path: BlockPath;
}) {
  const isStyled = block.type === "text" || block.type === "row";
  const childContext = useMemo(
    () =>
      block.type === "repeat" ? sampleScope(block.source, context) : context,
    [block, context],
  );

  return (
    <AppModal
      containerClassName="!p-0 sm:!p-4"
      theme="crm"
      label={`Configurar: ${label}`}
      maxWidth={640}
      onClose={onClose}
    >
      <div className="flex max-h-[85dvh] w-full flex-col">
        <header className="flex items-center gap-2.5 border-b border-[var(--crm-border-subtle)] px-5 py-3.5">
          {canGoBack ? (
            <button
              aria-label="Volver al bloque padre"
              className="rounded-lg p-1.5 text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-soft)]"
              onClick={onBack}
              type="button"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
          ) : null}
          <span className="rounded-full bg-[var(--crm-blue-soft)] px-2.5 py-1 text-[11px] font-black text-[var(--crm-blue)]">
            {label}
          </span>
          <h2 className="truncate text-sm font-black">
            Configurar {label.toLowerCase()}
          </h2>
          <button
            aria-label="Cerrar"
            className="ml-auto p-1.5 text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-soft)] !size-11 !min-h-11 !min-w-11 !shrink-0 !rounded-[12px] !p-0"
            onClick={onClose}
            type="button"
          >
            <X className="h-4 w-4" />
          </button>
        </header>

        <div className="grid gap-5 overflow-y-auto px-5 py-5">
          <div className="rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)] p-3 shadow-inner">
            <p className="mb-2 text-[11px] font-black text-[var(--crm-text-muted)] uppercase">
              Vista previa de la línea
            </p>
            <div className="font-mono text-[12px] leading-[1.45] text-[var(--crm-text)]">
              <RowPreview block={block} context={context} layout={layout} />
            </div>
          </div>

          {block.type === "text" ? (
            <Field label="Texto o variable">
              <TextArea
                className="!min-h-20 !w-full !rounded-[10px] !border !border-[var(--crm-input-border)] !bg-[var(--crm-input-bg)] !px-3.5 !py-3 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none placeholder:!text-[var(--crm-text-muted)] focus:!border-[var(--crm-blue)] focus:!shadow-[0_0_0_3px_var(--crm-blue-soft)]"
                disabled={disabled}
                onChange={(event) =>
                  onChange({ ...block, value: event.target.value })
                }
                placeholder="Escribe texto o inserta una variable, por ejemplo {{venue.name}}"
                value={block.value}
              />
            </Field>
          ) : null}
          {block.type === "row" ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Etiqueta">
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...block, label: event.target.value })
                  }
                  placeholder="Etiqueta"
                  value={block.label}
                />
              </Field>
              <Field label="Valor">
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...block, value: event.target.value })
                  }
                  placeholder="{{variable}}"
                  value={block.value}
                />
              </Field>
            </div>
          ) : null}
          {block.type === "separator" ? (
            <Field
              hint="Déjalo vacío para usar el separador por defecto."
              label="Carácter del separador"
            >
              <Input
                disabled={disabled}
                onChange={(event) =>
                  onChange({
                    ...block,
                    character: event.target.value || undefined,
                  })
                }
                placeholder="────────────────"
                value={block.character ?? ""}
              />
            </Field>
          ) : null}
          {block.type === "spacer" ? (
            <Field hint="Espacio vertical entre bloques." label="Líneas en blanco">
              <Input
                disabled={disabled}
                max={10}
                min={1}
                onChange={(event) =>
                  onChange({
                    ...block,
                    lines: clampNumber(event.target.value, 1, 10, 1),
                  })
                }
                type="number"
                value={String(block.lines ?? 1)}
              />
            </Field>
          ) : null}
          {block.type === "qr" ? (
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_120px]">
              <Field label="Contenido del código QR">
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...block, value: event.target.value })
                  }
                  placeholder="{{fiscal.verification_url}}"
                  value={block.value}
                />
              </Field>
              <Field label="Tamaño (mm)">
                <Input
                  disabled={disabled}
                  max={12}
                  min={1}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      qrSize: clampNumber(event.target.value, 1, 12, 6),
                    })
                  }
                  type="number"
                  value={String(block.qrSize ?? 6)}
                />
              </Field>
            </div>
          ) : null}
          {block.type === "repeat" ? (
            <>
              <Field
                hint="Variable de tipo colección, por ejemplo items o payment.rows."
                label="Colección"
              >
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...block, source: event.target.value })
                  }
                  placeholder="items"
                  value={block.source}
                />
              </Field>
              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-black text-[var(--crm-text-muted)]">
                    Bloques repetidos
                  </span>
                  <BlockAddButtons
                    compact
                    disabled={disabled}
                    onAdd={onAddChild}
                  />
                </div>
                <div className="rounded-xl border border-[var(--crm-border-subtle)] bg-[var(--crm-input-bg)]">
                  <BlockRows
                    basePath={path}
                    blocks={block.blocks}
                    context={childContext}
                    disabled={disabled}
                    emptyMessage="Sin bloques repetidos todavía."
                    layout={layout}
                    onOpen={(childPath, childScope) =>
                      onOpenChild(childPath, childScope ?? childContext)
                    }
                    paper={false}
                  />
                </div>
              </div>
            </>
          ) : null}

          {isStyled ? (
            <section className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
              <h3 className="mb-2 text-xs font-black text-[var(--crm-text-muted)] uppercase">
                Estilo
              </h3>
              <StyleFields
                block={
                  block as Extract<PrintTemplateBlock, { type: "text" | "row" }>
                }
                disabled={disabled}
                onChange={onChange}
              />
            </section>
          ) : null}

          <section className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
            <h3 className="mb-2 text-xs font-black text-[var(--crm-text-muted)] uppercase">
              Condiciones
            </h3>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Mostrar si (variable)">
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({ ...block, when: event.target.value || undefined })
                  }
                  placeholder="ruta.variable"
                  value={block.when ?? ""}
                />
              </Field>
              <Field label="Ocultar si (variable)">
                <Input
                  disabled={disabled}
                  onChange={(event) =>
                    onChange({
                      ...block,
                      unless: event.target.value || undefined,
                    })
                  }
                  placeholder="ruta.variable"
                  value={block.unless ?? ""}
                />
              </Field>
            </div>
          </section>
        </div>

        <footer className="flex flex-wrap items-center gap-2 border-t border-[var(--crm-border-subtle)] px-5 py-3">
          <span className="text-[11px] text-[var(--crm-text-muted)]">
            Arrastra las filas desde el asa del ticket para reordenarlas.
          </span>
          <span className="ml-auto hidden text-[11px] text-[var(--crm-text-muted)] sm:block">
            El orden se guarda al pulsar Guardar.
          </span>
          <Button
            aria-label="Eliminar bloque"
            disabled={disabled}
            onClick={onDelete}
            size="sm"
            variant="danger"
          >
            <Trash2 className="h-3.5 w-3.5" /> Eliminar
          </Button>
        </footer>
      </div>
    </AppModal>
  );
}

function Field({
  children,
  hint,
  label,
}: {
  children: ReactNode;
  hint?: string;
  label: string;
}) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-xs font-bold text-[var(--crm-text-muted)]">
        {label}
      </span>
      {children}
      {hint ? (
        <span className="mt-1.5 block text-[11px] text-[var(--crm-text-muted)]">
          {hint}
        </span>
      ) : null}
    </label>
  );
}

function StyleFields({
  block,
  disabled,
  onChange,
}: {
  block: Extract<PrintTemplateBlock, { type: "text" | "row" }>;
  disabled: boolean;
  onChange: (block: PrintTemplateBlock) => void;
}) {
  return (
    <div className="grid items-end gap-2 sm:grid-cols-[1fr_1fr_auto]">
      <CrmSelect
        compact
        disabled={disabled}
        onChange={(align) =>
          onChange({ ...block, align: align as "left" | "center" | "right" })
        }
        options={[
          { label: "Izquierda", value: "left" },
          { label: "Centro", value: "center" },
          { label: "Derecha", value: "right" },
        ]}
        value={block.align ?? "left"}
      />
      <CrmSelect
        compact
        disabled={disabled}
        onChange={(size) =>
          onChange({ ...block, size: size as "normal" | "large" })
        }
        options={[
          { label: "Normal", value: "normal" },
          { label: "Grande", value: "large" },
        ]}
        value={block.size ?? "normal"}
      />
      <label className="flex min-h-9 items-center gap-2 pb-0 text-xs font-bold">
        <input
          checked={block.bold ?? false}
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...block, bold: event.target.checked })
          }
          type="checkbox"
        />{" "}
        Negrita
      </label>
    </div>
  );
}

function BlockAddButtons({
  compact = false,
  disabled,
  onAdd,
}: {
  compact?: boolean;
  disabled: boolean;
  onAdd: (block: PrintTemplateBlock) => void;
}) {
  const types: PrintTemplateBlock["type"][] = compact
    ? ["text", "row", "separator", "spacer", "repeat"]
    : ["text", "row", "separator", "spacer", "repeat", "qr"];
  return (
    <details className="group">
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-[var(--crm-border)] bg-[var(--crm-input-bg)] px-3 py-2 text-xs font-bold text-[var(--crm-text)] hover:bg-[var(--crm-surface-hover)]">
        Añadir elemento{" "}
        <Plus className="h-4 w-4 text-[var(--crm-blue)] transition-transform group-open:rotate-45" />
      </summary>
      <div className="mt-2 grid gap-1.5">
        {types.map((type) => (
          <Button
            disabled={disabled}
            key={type}
            onClick={() => onAdd(newBlock(type))}
            size="sm"
            type="button"
            variant="secondary"
          >
            {type === "repeat" ? (
              <CopyPlus className="h-3.5 w-3.5" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}{" "}
            {blockLabel(type)}
          </Button>
        ))}
      </div>
    </details>
  );
}

function renderBlockPreview(
  block: PrintTemplateBlock,
  context: PrintTemplateContext,
  layout: PrinterLayout,
): RenderedTemplateElement[] {
  try {
    return renderPrintTemplate(
      { version: 1, blocks: [block] },
      context,
      layout,
    ).elements;
  } catch {
    return [];
  }
}

function readBlockAtPath(
  path: BlockPath,
  blocks: PrintTemplateBlock[],
): ResolvedBlock | null {
  let siblings = blocks;
  let parent: PrintTemplateBlock | null = null;
  for (let depth = 0; depth < path.length; depth += 1) {
    const block = siblings[path[depth]];
    if (!block) return null;
    if (depth === path.length - 1)
      return { block, parent, siblings, index: path[depth] };
    if (block.type !== "repeat") return null;
    parent = block;
    siblings = block.blocks;
  }
  return null;
}

function updateBlockAtPath(
  path: BlockPath,
  next: PrintTemplateBlock,
  blocks: PrintTemplateBlock[],
): PrintTemplateBlock[] {
  if (!path.length) return blocks;
  return blocks.map((block, index) => {
    if (index !== path[0]) return block;
    if (path.length === 1) return next;
    if (block.type !== "repeat") return block;
    return {
      ...block,
      blocks: updateBlockAtPath(path.slice(1), next, block.blocks),
    };
  });
}

function removeBlockAtPath(
  path: BlockPath,
  blocks: PrintTemplateBlock[],
): PrintTemplateBlock[] {
  const resolved = readBlockAtPath(path, blocks);
  if (!resolved) return blocks;
  if (resolved.parent) {
    const parent = resolved.parent;
    if (parent.type !== "repeat") return blocks;
    return updateBlockAtPath(
      path.slice(0, -1),
      {
        ...parent,
        blocks: parent.blocks.filter(
          (_, index) => index !== resolved.index,
        ),
      },
      blocks,
    );
  }
  return blocks.filter((_, index) => index !== resolved.index);
}

function appendBlockAtPath(
  path: BlockPath,
  block: PrintTemplateBlock,
  blocks: PrintTemplateBlock[],
): PrintTemplateBlock[] {
  const resolved = readBlockAtPath(path, blocks);
  if (!resolved) return blocks;
  if (resolved.block.type !== "repeat") return blocks;
  const parent = resolved.block;
  return updateBlockAtPath(
    path,
    { ...parent, blocks: [...parent.blocks, block] },
    blocks,
  );
}

function pathKey(path: BlockPath | null) {
  return path?.join(".") ?? "";
}

function parsePath(value: string): BlockPath | null {
  if (!value) return null;
  const path = value.split(".").map(Number);
  return path.every(Number.isInteger) ? path : null;
}

function reorderBlockAtPath(
  from: BlockPath,
  to: BlockPath,
  blocks: PrintTemplateBlock[],
): PrintTemplateBlock[] {
  if (from.length !== to.length || from.slice(0, -1).some((value, index) => value !== to[index]))
    return blocks;
  const sourceIndex = from[from.length - 1];
  const targetIndex = to[to.length - 1];
  if (sourceIndex === targetIndex) return blocks;
  const resolved = readBlockAtPath(from, blocks);
  if (!resolved) return blocks;
  const reordered = [...resolved.siblings];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  if (!resolved.parent) return reordered;
  if (resolved.parent.type !== "repeat") return blocks;
  return updateBlockAtPath(from.slice(0, -1), { ...resolved.parent, blocks: reordered }, blocks);
}

function sampleScope(
  source: string,
  context: PrintTemplateContext,
): PrintTemplateContext {
  const resolved = resolveContextPath(source, context);
  if (
    !Array.isArray(resolved) ||
    !resolved.length ||
    typeof resolved[0] !== "object" ||
    resolved[0] === null
  )
    return context;
  return { ...context, ...flattenSample(resolved[0]) };
}

function flattenSample(item: Record<string, unknown>): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(item)) {
    flat[key] =
      Array.isArray(value) &&
      value.length > 0 &&
      typeof value[0] === "object" &&
      value[0] !== null
        ? [flattenSample(value[0] as Record<string, unknown>)]
        : value;
  }
  return flat;
}

function resolveContextPath(
  path: string,
  context: PrintTemplateContext,
): unknown {
  if (!/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*$/.test(path)) return undefined;
  if (path.split(".").some((segment) => ["__proto__", "prototype", "constructor"].includes(segment)))
    return undefined;
  let current: unknown = context;
  for (const segment of path.split(".")) {
    if (!current || typeof current !== "object" || Array.isArray(current))
      return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

function newBlock(type: PrintTemplateBlock["type"]): PrintTemplateBlock {
  const id = newBlockId();
  if (type === "text") return { id, type, value: "Nueva línea" };
  if (type === "row")
    return { id, type, label: "Etiqueta", value: "{{ticket.number}}" };
  if (type === "separator") return { id, type };
  if (type === "spacer") return { id, type, lines: 1 };
  if (type === "qr")
    return { id, type, value: "{{fiscal.verification_url}}", qrSize: 6 };
  return {
    id,
    type,
    source: "items",
    blocks: [{ id: newBlockId(), type: "text", value: "{{name}}" }],
  };
}

function newBlockId() {
  return `block-${crypto.randomUUID()}`;
}
function blockLabel(type: PrintTemplateBlock["type"]) {
  return (
    {
      text: "Texto",
      row: "Fila",
      separator: "Separador",
      spacer: "Blanco",
      repeat: "Repetición",
      qr: "QR",
    } as const
  )[type];
}

function clampNumber(
  value: string,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
