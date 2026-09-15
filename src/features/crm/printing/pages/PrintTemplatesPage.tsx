import {
  ArrowDown,
  ArrowUp,
  CopyPlus,
  Plus,
  RotateCcw,
  Settings,
  Save,
  Settings2,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Button, Input, TextArea } from "../../../../components/ui";
import type { TenantContext } from "../../../../types";
import { CrmSelect } from "../../shared/components/CrmSelect";
import type { RunAction } from "../../shared/types";
import {
  PRINT_TEMPLATE_TYPE_LABELS,
  PRINT_TEMPLATE_VARIABLES,
  getMockPrintTemplateContext,
} from "../../../print-templates/catalog.ts";
import { getSafeDefaultPrintTemplate } from "../../../print-templates/defaults.ts";
import { renderPrintTemplateWithFallback } from "../../../print-templates/renderer.ts";
import {
  resolvePrintTemplate,
  restoreDefaultPrintTemplate,
  savePrintTemplate,
} from "../../../print-templates/service.ts";
import {
  PRINT_TEMPLATE_TYPES,
  type PrintTemplateBlock,
  type PrintTemplateDefinition,
  type PrintTemplateType,
} from "../../../print-templates/types.ts";

type Props = {
  context: TenantContext;
  disabled: boolean;
  runAction: RunAction;
  venueId: string;
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
  const scope = useMemo(
    () => ({ tenantId: context.tenantId, venueId }),
    [context.tenantId, venueId],
  );

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
        getMockPrintTemplateContext(type),
        previewLayout,
      ),
    [definition, fallback, type],
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

  const addVariable = (path: string) =>
    setDefinition((current) => ({
      ...current,
      blocks: [
        ...current.blocks,
        { id: newBlockId(), type: "text", value: `{{${path}}}` },
      ],
    }));

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
                Arrástralos con las flechas
              </p>
            </div>
          </div>
          <div className="space-y-2">
            <BlockAddButtons
              disabled={disabled}
              onAdd={(block) =>
                setDefinition((current) => ({
                  ...current,
                  blocks: [...current.blocks, block],
                }))
              }
            />
          </div>
          <div className="mt-5 rounded-xl bg-[var(--crm-blue-soft)] p-3 text-xs leading-relaxed text-[var(--crm-blue)]">
            <strong>Consejo</strong>
            <br />
            Edita cada línea directamente sobre el papel. Usa las variables para
            mostrar datos reales al imprimir.
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
            <BlockList
              blocks={definition.blocks}
              disabled={disabled}
              onChange={(blocks) =>
                setDefinition((current) => ({ ...current, blocks }))
              }
            />
          </div>
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
    </div>
  );
}

function BlockList({
  blocks,
  disabled,
  onChange,
}: {
  blocks: PrintTemplateBlock[];
  disabled: boolean;
  onChange: (blocks: PrintTemplateBlock[]) => void;
}) {
  if (!blocks.length)
    return (
      <p className="rounded-xl bg-[var(--crm-surface-soft)] p-4 text-sm text-[var(--crm-text-muted)]">
        Añade al menos un bloque.
      </p>
    );
  const update = (index: number, block: PrintTemplateBlock) =>
    onChange(
      blocks.map((current, position) => (position === index ? block : current)),
    );
  const move = (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (target < 0 || target >= blocks.length) return;
    const next = [...blocks];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {blocks.map((block, index) => (
        <article
          className="group rounded-lg border border-slate-200 bg-white p-2 shadow-sm"
          key={block.id}
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <span className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[9px] font-black uppercase tracking-wide text-slate-500">
                {blockLabel(block.type)}
              </span>
            </div>
            <div className="flex gap-0.5 opacity-70 group-hover:opacity-100">
              <Button
                aria-label="Subir bloque"
                disabled={disabled || index === 0}
                onClick={() => move(index, -1)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label="Bajar bloque"
                disabled={disabled || index === blocks.length - 1}
                onClick={() => move(index, 1)}
                size="sm"
                type="button"
                variant="tertiary"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </Button>
              <Button
                aria-label="Eliminar bloque"
                disabled={disabled}
                onClick={() =>
                  onChange(blocks.filter((_, position) => position !== index))
                }
                size="sm"
                type="button"
                variant="tertiary"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
          <BlockFields
            block={block}
            disabled={disabled}
            onChange={(next) => update(index, next)}
          />
        </article>
      ))}
    </div>
  );
}

function BlockFields({
  block,
  disabled,
  onChange,
}: {
  block: PrintTemplateBlock;
  disabled: boolean;
  onChange: (block: PrintTemplateBlock) => void;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const conditional = (
    <div className="grid gap-2 border-t border-slate-100 pt-3 sm:grid-cols-2">
      <Input
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...block, when: event.target.value || undefined })
        }
        placeholder="Mostrar si: ruta.variable"
        value={block.when ?? ""}
      />
      <Input
        disabled={disabled}
        onChange={(event) =>
          onChange({ ...block, unless: event.target.value || undefined })
        }
        placeholder="Ocultar si: ruta.variable"
        value={block.unless ?? ""}
      />
    </div>
  );
  const advanced = (
    <div className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
      <button
        className="flex w-full items-center justify-between text-left text-[11px] font-bold text-slate-500"
        onClick={() => setShowAdvanced((value) => !value)}
        type="button"
      >
        <Settings />
      </button>
      {showAdvanced ? (
        <div className="mt-3 space-y-3">
          <StyleFields
            block={
              block as Extract<PrintTemplateBlock, { type: "text" | "row" }>
            }
            disabled={disabled}
            onChange={onChange}
          />
          {conditional}
        </div>
      ) : null}
    </div>
  );
  if (block.type === "text")
    return (
      <div className="flex flex-row justify-between">
        <TextArea
          className="border-0 !p-1 !shadow-none focus:!ring-0"
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...block, value: event.target.value })
          }
          placeholder="Escribe texto o inserta una variable"
          value={block.value}
        />
        {advanced}
      </div>
    );
  if (block.type === "row")
    return (
      <div>
        <div className="grid gap-1 sm:grid-cols-2">
          <Input
            className="border-0 !p-1 !shadow-none focus:!ring-0"
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...block, label: event.target.value })
            }
            placeholder="Etiqueta"
            value={block.label}
          />
          <Input
            className="border-0 !p-1 !shadow-none focus:!ring-0"
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...block, value: event.target.value })
            }
            placeholder="{{variable}}"
            value={block.value}
          />
        </div>
        {advanced}
      </div>
    );
  if (block.type === "separator")
    return (
      <div>
        <div className="text-center text-slate-400">
          {block.character ?? "────────────────"}
        </div>
        <details className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
            Personalizar separador
          </summary>
          <Input
            className="mt-2"
            disabled={disabled}
            maxLength={1}
            onChange={(event) =>
              onChange({ ...block, character: event.target.value || undefined })
            }
            placeholder="Carácter"
            value={block.character ?? ""}
          />
        </details>
      </div>
    );
  if (block.type === "spacer")
    return (
      <div>
        <div
          className="h-3"
          style={{ minHeight: `${Math.min(10, block.lines ?? 1) * 8}px` }}
        />
        <details className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
            Ajustar espacio
          </summary>
          <Input
            className="mt-2"
            disabled={disabled}
            max={10}
            min={1}
            onChange={(event) =>
              onChange({
                ...block,
                lines: Math.max(
                  1,
                  Math.min(10, Number(event.target.value) || 1),
                ),
              })
            }
            type="number"
            value={block.lines ?? 1}
          />
        </details>
      </div>
    );
  if (block.type === "qr")
    return (
      <div>
        <div className="py-2 text-center text-[10px] text-slate-400">
          Código QR fiscal
        </div>
        <details className="mt-2 rounded-lg border border-slate-100 bg-slate-50 p-2">
          <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
            Configurar QR
          </summary>
          <Input
            className="mt-2"
            disabled={disabled}
            onChange={(event) =>
              onChange({ ...block, value: event.target.value })
            }
            placeholder="{{fiscal.verification_url}}"
            value={block.value}
          />
        </details>
      </div>
    );
  return (
    <div className="grid gap-3">
      <details className="rounded-lg border border-slate-100 bg-slate-50 p-2">
        <summary className="cursor-pointer text-[11px] font-bold text-slate-500">
          Configurar repetición
        </summary>
        <Input
          className="mt-2"
          disabled={disabled}
          onChange={(event) =>
            onChange({ ...block, source: event.target.value })
          }
          placeholder="Colección, por ejemplo items"
          value={block.source}
        />
        {conditional}
      </details>
      <div className="rounded-xl bg-[var(--crm-surface-soft)] p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <strong className="text-xs">Bloques repetidos</strong>
          <BlockAddButtons
            compact
            disabled={disabled}
            onAdd={(child) =>
              onChange({ ...block, blocks: [...block.blocks, child] })
            }
          />
        </div>
        <BlockList
          blocks={block.blocks}
          disabled={disabled}
          onChange={(blocks) => onChange({ ...block, blocks })}
        />
      </div>
    </div>
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
    <div className="grid items-center gap-2 sm:grid-cols-[1fr_1fr_auto]">
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
      <label className="flex min-h-9 items-center gap-2 text-xs font-bold">
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
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg border border-[var(--crm-border)] bg-white px-3 py-2 text-xs font-bold text-[var(--crm-text)]">
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
