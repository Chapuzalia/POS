import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ChevronRight,
  CopyPlus,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  Trash2,
  X,
} from "lucide-react";
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
import { getSafeDefaultPrintTemplate } from "../../../print-templates/defaults.ts";
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
  const scope = useMemo(
    () => ({ tenantId: context.tenantId, venueId }),
    [context.tenantId, venueId],
  );
  const mockContext = useMemo(() => getMockPrintTemplateContext(type), [type]);

  useEffect(() => {
    let active = true;
    void runAction(async () => {
      const resolved = await resolvePrintTemplate(scope, type);
      if (!active) return;
      setDefinition(structuredClone(resolved.definition));
      setIsCustom(resolved.isCustom);
    });
    return () => {
      active = false;
    };
  }, [runAction, scope, type]);

  const fallback = useMemo(() => getSafeDefaultPrintTemplate(type), [type]);
  const preview = useMemo(
    () =>
      renderPrintTemplateWithFallback(
        definition,
        fallback,
        mockContext,
        previewLayout,
      ),
    [definition, fallback, mockContext],
  );

  const persist = () =>
    runAction(async () => {
      await savePrintTemplate(scope, type, definition);
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

  const moveEditingBlock = (offset: -1 | 1) => {
    if (!editing) return;
    const resolved = readBlockAtPath(editing.path, definition.blocks);
    if (!resolved) return;
    const target = resolved.index + offset;
    if (target < 0 || target >= resolved.siblings.length) return;
    setDefinition((current) => ({
      ...current,
      blocks: moveBlockAtPath(editing.path, offset, current.blocks).blocks,
    }));
    setEditing({
      ...editing,
      path: [...editing.path.slice(0, -1), target],
    });
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
              Edita bloques lógicos; el TPV resuelve datos fiscales y de negocio
              antes de aplicar el diseño. No se admiten scripts ni comandos
              ESC/POS.
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
            disabled={disabled}
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

      {editing && edited ? (
        <BlockModal
          block={edited.block}
          canGoBack={editing.path.length > 1}
          canMoveDown={edited.index < edited.siblings.length - 1}
          canMoveUp={edited.index > 0}
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
          onMoveDown={() => moveEditingBlock(1)}
          onMoveUp={() => moveEditingBlock(-1)}
          onOpenChild={(childPath, childContext) =>
            setEditing({ path: childPath, context: childContext })
          }
          path={editing.path}
        />
      ) : null}
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
  onOpen,
  paper = true,
}: {
  basePath: BlockPath;
  blocks: PrintTemplateBlock[];
  context: PrintTemplateContext;
  disabled: boolean;
  emptyMessage: string;
  layout: PrinterLayout;
  onOpen: (path: BlockPath, childContext?: PrintTemplateContext) => void;
  paper?: boolean;
}) {
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
            className={
              paper
                ? "group flex w-full cursor-pointer items-start gap-1.5 py-0.5 pr-1 pl-0.5 text-left transition-colors hover:bg-amber-300 disabled:cursor-default disabled:opacity-60 disabled:hover:bg-transparent"
                : "group flex w-full cursor-pointer items-center gap-2 px-2.5 py-1.5 text-left transition-colors hover:bg-[var(--crm-surface-hover)] disabled:cursor-default disabled:opacity-60"
            }
            disabled={disabled}
            key={block.id}
            onClick={() => onOpen(path)}
            type="button"
          >
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
  canMoveDown,
  canMoveUp,
  context,
  disabled,
  label,
  layout,
  onAddChild,
  onBack,
  onChange,
  onClose,
  onDelete,
  onMoveDown,
  onMoveUp,
  onOpenChild,
  path,
}: {
  block: PrintTemplateBlock;
  canGoBack: boolean;
  canMoveDown: boolean;
  canMoveUp: boolean;
  context: PrintTemplateContext;
  disabled: boolean;
  label: string;
  layout: PrinterLayout;
  onAddChild: (block: PrintTemplateBlock) => void;
  onBack: () => void;
  onChange: (block: PrintTemplateBlock) => void;
  onClose: () => void;
  onDelete: () => void;
  onMoveDown: () => void;
  onMoveUp: () => void;
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
      dialogClassName="!border-[var(--crm-border)] !bg-[var(--crm-surface)] !text-[var(--crm-text)]"
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
            className="ml-auto rounded-lg p-1.5 text-[var(--crm-text-muted)] transition-colors hover:bg-[var(--crm-surface-soft)]"
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
          <Button
            aria-label="Subir bloque"
            disabled={disabled || !canMoveUp}
            onClick={onMoveUp}
            size="sm"
            variant="secondary"
          >
            <ArrowUp className="h-3.5 w-3.5" /> Subir
          </Button>
          <Button
            aria-label="Bajar bloque"
            disabled={disabled || !canMoveDown}
            onClick={onMoveDown}
            size="sm"
            variant="secondary"
          >
            <ArrowDown className="h-3.5 w-3.5" /> Bajar
          </Button>
          <span className="ml-auto hidden text-[11px] text-[var(--crm-text-muted)] sm:block">
            Reordena el bloque en el ticket con estas flechas.
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

function moveBlockAtPath(
  path: BlockPath,
  offset: -1 | 1,
  blocks: PrintTemplateBlock[],
): { blocks: PrintTemplateBlock[]; moved: boolean } {
  const resolved = readBlockAtPath(path, blocks);
  if (!resolved) return { blocks, moved: false };
  const target = resolved.index + offset;
  if (target < 0 || target >= resolved.siblings.length)
    return { blocks, moved: false };
  const next = swap(resolved.siblings, resolved.index, target);
  if (resolved.parent) {
    const parent = resolved.parent;
    if (parent.type !== "repeat") return { blocks, moved: false };
    return {
      blocks: updateBlockAtPath(
        path.slice(0, -1),
        { ...parent, blocks: next },
        blocks,
      ),
      moved: true,
    };
  }
  return { blocks: next, moved: true };
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

function swap<T>(items: T[], from: number, to: number): T[] {
  const next = [...items];
  [next[from], next[to]] = [next[to], next[from]];
  return next;
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