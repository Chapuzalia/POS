import { Input as UiInput } from "../../../../components/ui/Input";
import { Checkbox as UiCheckbox } from "../../../../components/ui/Checkbox";
import { Button as UiButton } from "../../../../components/ui/Button";
import { CrmModal } from "../../shared/components/CrmModal";
import { CrmSelect } from "../../shared/components/CrmSelect";
import { EmptyList } from "../../shared/components/EmptyList";
import { Field } from "../../shared/components/Field";
import { LockKeyhole, Pencil, Plus, Save, Search, Sparkles, X } from "lucide-react";
import {
  centsToInput,
  formatMoney,
  parseMoneyToCents,
} from "../../../../lib/format";
import {
  createDiscount,
  loadCrmDiscounts,
  loadDiscountTargetOptions,
  loadManualDiscountSettings,
  normalizeDiscountTargets,
  setDiscountActive,
  saveManualDiscountSettings,
  updateDiscount,
  type DiscountTargetProductOption,
} from "../services/discountService";
import {
  discountRoundingOptions,
  formatDiscountRounding,
  validateDiscountRule,
} from "../../../../lib/discounts";
import {
  type Discount,
  type DiscountCalculationType,
  type DiscountCreateInput,
  type DiscountFixedApplication,
  type DiscountRoundingIncrementCents,
  type DiscountRuleKind,
  type DiscountScope,
  type DiscountTarget,
  type TenantContext,
} from "../../../../types";
import { type RunAction } from "../../shared/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  filterDiscountTargetOptions,
  getDiscountTargetCategoryOptions,
  getDiscountTargetVariantOptions,
} from "../discountTargetFilters";

export type DiscountsCrmProps = {
  disabled: boolean;
  onCatalogChanged: () => Promise<void>;
  runAction: RunAction;
  selectedVenueId: string;
  tenantContext: TenantContext;
};

const inputClass =
  "!h-11 !w-full !rounded-[10px] !border !border-transparent !bg-[var(--crm-input-bg)] !px-3.5 !text-[13px] !font-medium !text-[var(--crm-text)] !shadow-none !outline-none focus:!border-[var(--crm-blue)]";
const weekdays = [
  { label: "L", value: 1 },
  { label: "M", value: 2 },
  { label: "X", value: 3 },
  { label: "J", value: 4 },
  { label: "V", value: 5 },
  { label: "S", value: 6 },
  { label: "D", value: 7 },
];

function ruleSchedule(discount: Discount) {
  if (discount.ruleKind !== "promotion") return "Sin calendario";
  const days = weekdays
    .filter((day) => discount.activeWeekdays.includes(day.value))
    .map((day) => day.label)
    .join(" ");
  return `${days} · ${discount.startsAt ?? "--:--"}–${discount.endsAt ?? "--:--"}`;
}

export function DiscountsCrm({
  disabled,
  onCatalogChanged,
  runAction,
  selectedVenueId,
  tenantContext,
}: DiscountsCrmProps) {
  const [discounts, setDiscounts] = useState<Discount[]>([]);
  const [targetOptions, setTargetOptions] = useState<
    DiscountTargetProductOption[]
  >([]);
  const [editor, setEditor] = useState<Discount | "new" | null>(null);
  const [manualEnabled, setManualEnabled] = useState(false);
  const [manualRequiresPin, setManualRequiresPin] = useState(false);
  const [manualPin, setManualPin] = useState("");
  const [manualPinConfigured, setManualPinConfigured] = useState(false);

  const refresh = useCallback(async () => {
    if (!selectedVenueId) {
      setDiscounts([]);
      setTargetOptions([]);
      setManualEnabled(false);
      setManualRequiresPin(false);
      setManualPin("");
      setManualPinConfigured(false);
      return;
    }
    const [nextDiscounts, nextManualSettings, nextTargetOptions] =
      await Promise.all([
        loadCrmDiscounts(tenantContext, selectedVenueId),
        loadManualDiscountSettings(tenantContext, selectedVenueId),
        loadDiscountTargetOptions(tenantContext, selectedVenueId),
      ]);
    setDiscounts(nextDiscounts);
    setManualEnabled(nextManualSettings.enabled);
    setManualRequiresPin(nextManualSettings.requiresPin);
    setManualPin("");
    setManualPinConfigured(nextManualSettings.requiresPin);
    setTargetOptions(nextTargetOptions);
  }, [selectedVenueId, tenantContext]);

  useEffect(() => {
    setEditor(null);
    void runAction(refresh);
  }, [refresh, runAction]);

  async function toggleManual() {
    await runAction(async () => {
      const normalizedPin = manualPin.trim();
      if (manualRequiresPin && !manualPinConfigured && !normalizedPin) {
        throw new Error("Configura un PIN de entre 4 y 8 dígitos.");
      }
      await saveManualDiscountSettings(tenantContext, selectedVenueId, {
        enabled: !manualEnabled,
        requiresPin: manualRequiresPin,
        pin: normalizedPin || null,
      });
      setManualEnabled(!manualEnabled);
      setManualPin("");
      setManualPinConfigured(manualRequiresPin);
      await onCatalogChanged();
    });
  }

  async function saveManualSecurity() {
    await runAction(async () => {
      const normalizedPin = manualPin.trim();
      if (manualRequiresPin && !manualPinConfigured && !normalizedPin) {
        throw new Error("Configura un PIN de entre 4 y 8 dígitos.");
      }
      await saveManualDiscountSettings(tenantContext, selectedVenueId, {
        enabled: manualEnabled,
        requiresPin: manualRequiresPin,
        pin: normalizedPin || null,
      });
      setManualPin("");
      setManualPinConfigured(manualRequiresPin);
      await onCatalogChanged();
    });
  }

  async function toggleDiscount(discount: Discount) {
    await runAction(async () => {
      await setDiscountActive(tenantContext, discount.id, !discount.isActive);
      await refresh();
      await onCatalogChanged();
    });
  }

  return (
    <div className="grid grid-cols-1 items-start gap-4 xl:gap-6">
      <section className="min-w-0 overflow-hidden rounded-2xl bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)]">
        <div className="flex flex-col items-stretch justify-between gap-4 border-b border-[var(--crm-border-subtle)] px-[18px] py-5 md:flex-row md:items-center md:px-[22px]">
          <div>
            <h2 className="m-0 text-[17px] font-bold tracking-[-0.02em]">
              Descuentos y promociones
            </h2>
            <p className="mb-0 mt-1 text-xs font-medium text-[var(--crm-text-muted)]">
              {discounts.length} reglas configuradas
            </p>
          </div>
          <UiButton
            className="min-h-10 rounded-[10px] border-0 bg-[var(--crm-blue)] px-4 text-[13px] font-semibold text-white"
            disabled={disabled || !selectedVenueId}
            onClick={() => setEditor("new")}
            type="button"
          >
            <Plus className="mr-2 inline size-4" /> Añadir regla
          </UiButton>
        </div>

        <div className="grid gap-2 p-[18px] md:p-[22px]">
          {discounts.map((discount) => (
            <article
              className="grid gap-3 rounded-[12px] bg-[var(--crm-surface-soft)] px-4 py-3 text-[13px] md:grid-cols-[minmax(0,1fr)_minmax(170px,auto)_auto] md:items-center"
              key={discount.id}
            >
              <div className="flex min-w-0 items-center gap-3">
                <span
                  className="size-3 shrink-0 rounded-full border border-black/10"
                  style={{
                    backgroundColor: discount.color ?? "var(--crm-blue)",
                  }}
                />
                <div className="grid min-w-0 gap-1">
                  <strong className="truncate text-sm">{discount.name}</strong>
                  <span className="text-xs font-medium text-[var(--crm-text-muted)]">
                    {discount.ruleKind === "promotion"
                      ? "Promoción"
                      : "Descuento"}{" "}
                    · {discount.scope === "general" ? "General" : "Específico"}{" "}
                    · {ruleSchedule(discount)}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <strong className="font-mono">
                  {discount.type === "percentage"
                    ? `${discount.value} %`
                    : formatMoney(discount.value)}
                </strong>
                {discount.type === "fixed" ? (
                  <span className="rounded-full bg-[var(--crm-input-bg)] px-2.5 py-1 text-[11px] font-semibold">
                    {discount.fixedApplication === "line"
                      ? "Por producto"
                      : "Por ticket"}
                  </span>
                ) : null}
                {discount.autoApply ? (
                  <span className="rounded-full bg-[var(--crm-blue-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--crm-blue)]">
                    Automática
                  </span>
                ) : null}
                {discount.requiresPin ? (
                  <span className="inline-flex items-center gap-1 rounded-full bg-[var(--crm-input-bg)] px-2.5 py-1 text-[11px] font-semibold">
                    <LockKeyhole className="size-3" /> PIN
                  </span>
                ) : null}
                <span
                  className={
                    discount.isActive
                      ? "rounded-full bg-[var(--crm-green-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--crm-green)]"
                      : "rounded-full bg-[var(--crm-input-bg)] px-2.5 py-1 text-[11px] font-semibold text-[var(--crm-text-muted)]"
                  }
                >
                  {discount.isActive ? "Activo" : "Inactivo"}
                </span>
              </div>
              <div className="flex justify-end gap-2">
                <UiButton
                  className="min-h-9 rounded-[9px] border-0 bg-[var(--crm-surface)] px-3 text-xs font-semibold"
                  disabled={disabled}
                  onClick={() => setEditor(discount)}
                  type="button"
                >
                  <Pencil className="mr-1 inline size-3.5" />
                  Editar
                </UiButton>
                <UiButton
                  className="min-h-9 rounded-[9px] border-0 bg-[var(--crm-surface)] px-3 text-xs font-semibold"
                  disabled={disabled}
                  onClick={() => void toggleDiscount(discount)}
                  type="button"
                >
                  {discount.isActive ? "Desactivar" : "Activar"}
                </UiButton>
              </div>
            </article>
          ))}
          {!discounts.length ? (
            <EmptyList message="No hay descuentos ni promociones configurados para este local." />
          ) : null}
        </div>
      </section>

      <section className="grid gap-5 rounded-2xl bg-[var(--crm-surface)] p-[18px] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] md:p-[22px]">
        <div className="flex flex-col items-start justify-between gap-4 sm:flex-row sm:items-center">
          <div>
            <h2 className="text-base font-bold">
              Permitir descuento manual libre
            </h2>
            <p className="mt-1 text-xs text-[var(--crm-text-muted)]">
              Puede protegerse con un PIN común para este local.
            </p>
          </div>
          <UiButton
            aria-pressed={manualEnabled}
            className={
              manualEnabled
                ? "min-h-10 rounded-[10px] border-0 bg-[var(--crm-green-soft)] px-4 text-[13px] font-semibold text-[var(--crm-green)]"
                : "min-h-10 rounded-[10px] border-0 bg-[var(--crm-input-bg)] px-4 text-[13px] font-semibold"
            }
            disabled={disabled || !selectedVenueId}
            onClick={() => void toggleManual()}
            type="button"
          >
            {manualEnabled ? "Activado" : "Desactivado"}
          </UiButton>
        </div>
        <div className="grid gap-3 border-t border-[var(--crm-border-subtle)] pt-4 sm:grid-cols-[minmax(0,1fr)_minmax(220px,320px)_auto] sm:items-end">
          <UiCheckbox
            checked={manualRequiresPin}
            disabled={disabled || !selectedVenueId}
            onChange={setManualRequiresPin}
          >
            Solicitar PIN al aplicarlo
          </UiCheckbox>
          {manualRequiresPin ? (
            <label className="grid gap-1.5 text-xs font-semibold text-[var(--crm-text-muted)]">
              <span>
                {manualPinConfigured ? "Nuevo PIN (opcional)" : "PIN"}
              </span>
              <UiInput
                className={inputClass}
                inputMode="numeric"
                maxLength={8}
                onChange={(event) =>
                  setManualPin(
                    event.target.value.replace(/\D/g, "").slice(0, 8),
                  )
                }
                placeholder={
                  manualPinConfigured ? "Conservar PIN actual" : "4 a 8 dígitos"
                }
                type="password"
                value={manualPin}
              />
            </label>
          ) : (
            <div />
          )}
          <UiButton
            className="min-h-11 rounded-[10px] border-0 bg-[var(--crm-blue)] px-4 text-[13px] font-semibold text-white"
            disabled={disabled || !selectedVenueId}
            onClick={() => void saveManualSecurity()}
            type="button"
          >
            <Save className="mr-2 inline size-4" />
            Guardar seguridad
          </UiButton>
        </div>
      </section>

      {editor ? (
        <DiscountEditor
          disabled={disabled}
          discount={editor === "new" ? null : editor}
          key={editor === "new" ? "new" : editor.id}
          onClose={() => setEditor(null)}
          onSaved={async () => {
            await refresh();
            await onCatalogChanged();
            setEditor(null);
          }}
          runAction={runAction}
          selectedVenueId={selectedVenueId}
          targetOptions={targetOptions}
          tenantContext={tenantContext}
        />
      ) : null}
    </div>
  );
}

export function DiscountEditor({
  disabled,
  discount,
  onClose,
  onSaved,
  runAction,
  selectedVenueId,
  targetOptions,
  tenantContext,
}: {
  disabled: boolean;
  discount: Discount | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
  runAction: RunAction;
  selectedVenueId: string;
  targetOptions: DiscountTargetProductOption[];
  tenantContext: TenantContext;
}) {
  const [name, setName] = useState(discount?.name ?? "");
  const [ruleKind, setRuleKind] = useState<DiscountRuleKind>(
    discount?.ruleKind ?? "discount",
  );
  const [type, setType] = useState<DiscountCalculationType>(
    discount?.type ?? "percentage",
  );
  const [fixedApplication, setFixedApplication] =
    useState<DiscountFixedApplication>(
      discount?.fixedApplication ?? "ticket",
    );
  const [value, setValue] = useState(
    discount
      ? discount.type === "fixed"
        ? centsToInput(discount.value)
        : String(discount.value)
      : "",
  );
  const [roundingIncrementCents, setRoundingIncrementCents] =
    useState<DiscountRoundingIncrementCents | null>(
      discount?.roundingIncrementCents ?? null,
    );
  const [color, setColor] = useState(discount?.color ?? "#2563eb");
  const [isActive, setIsActive] = useState(discount?.isActive ?? true);
  const [scope, setScope] = useState<DiscountScope>(
    discount?.scope ?? "general",
  );
  const [targets, setTargets] = useState<DiscountTarget[]>(
    discount?.targets ?? [],
  );
  const [requiresPin, setRequiresPin] = useState(
    discount?.requiresPin ?? false,
  );
  const [pin, setPin] = useState("");
  const [activeWeekdays, setActiveWeekdays] = useState<number[]>(
    discount?.activeWeekdays ?? [1, 2, 3, 4, 5, 6, 7],
  );
  const [startsAt, setStartsAt] = useState(discount?.startsAt ?? "09:00");
  const [endsAt, setEndsAt] = useState(discount?.endsAt ?? "14:00");
  const [autoApply, setAutoApply] = useState(discount?.autoApply ?? false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [targetQuery, setTargetQuery] = useState("");
  const [targetCategoryId, setTargetCategoryId] = useState("all");
  const [targetVariantName, setTargetVariantName] = useState("all");

  const targetCategoryOptions = useMemo(
    () => getDiscountTargetCategoryOptions(targetOptions),
    [targetOptions],
  );

  const targetVariantOptions = useMemo(
    () => getDiscountTargetVariantOptions(targetOptions),
    [targetOptions],
  );

  const filteredTargetOptions = useMemo(
    () => filterDiscountTargetOptions(targetOptions, {
      categoryId: targetCategoryId,
      query: targetQuery,
      variantName: targetVariantName,
    }),
    [targetCategoryId, targetOptions, targetQuery, targetVariantName],
  );

  function toggleProduct(productId: string, checked: boolean) {
    setTargets((current) =>
      normalizeDiscountTargets([
        ...current.filter((target) => target.productId !== productId),
        ...(checked ? [{ productId, variantId: null }] : []),
      ]),
    );
  }

  function toggleVariant(
    productId: string,
    variantId: string,
    checked: boolean,
  ) {
    setTargets((current) =>
      normalizeDiscountTargets([
        ...current.filter(
          (target) =>
            !(
              target.productId === productId &&
              (target.variantId === null || target.variantId === variantId)
            ),
        ),
        ...(checked ? [{ productId, variantId }] : []),
      ]),
    );
  }

  async function save() {
    const parsedValue =
      type === "fixed"
        ? parseMoneyToCents(value)
        : Number(value.replace(",", "."));
    const input: DiscountCreateInput = {
      venueId: selectedVenueId,
      name: name.trim(),
      type,
      value: parsedValue,
      fixedApplication: type === "fixed" ? fixedApplication : "ticket",
      roundingIncrementCents,
      color: color || null,
      isActive,
      ruleKind,
      scope,
      targets: scope === "specific" ? normalizeDiscountTargets(targets) : [],
      requiresPin: ruleKind === "promotion" && autoApply ? false : requiresPin,
      pin: requiresPin && pin ? pin : null,
      activeWeekdays: ruleKind === "promotion" ? activeWeekdays : [],
      startsAt: ruleKind === "promotion" ? startsAt : null,
      endsAt: ruleKind === "promotion" ? endsAt : null,
      autoApply: ruleKind === "promotion" && autoApply,
    };
    try {
      validateDiscountRule(input);
      if (input.requiresPin && !discount && !input.pin)
        throw new Error("Configura un PIN de entre 4 y 8 dígitos.");
    } catch (error) {
      setValidationError(
        error instanceof Error
          ? error.message
          : "Revisa los datos de la regla.",
      );
      return;
    }
    await runAction(async () => {
      if (discount) await updateDiscount(tenantContext, discount.id, input);
      else await createDiscount(tenantContext, input);
      await onSaved();
    });
  }

  return (
    <CrmModal
      label={discount ? "Editar regla" : "Añadir regla"}
      onClose={onClose}
    >
      <div className="flex h-full min-h-0 flex-col">
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[var(--crm-border-subtle)] px-[18px] py-5 text-[var(--crm-text)] md:px-[22px]">
          <div>
            <span className="text-[15px] font-bold">
              {discount ? "Editar descuento o promoción" : "Nueva regla"}
            </span>
            <small className="mt-1 block text-xs text-[var(--crm-text-muted)]">
              Una regla activa por ticket
            </small>
          </div>
          <UiButton
            aria-label="Cerrar"
            className="size-10 rounded-[10px] border-0 bg-[var(--crm-surface-soft)] p-0"
            onClick={onClose}
            type="button"
          >
            <X className="mx-auto size-4" />
          </UiButton>
        </div>
        <form
          className="grid min-h-0 flex-1 content-start gap-3.5 overflow-y-auto px-[22px] py-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
        <Field label="Nombre">
          <UiInput
            autoFocus
            className={inputClass}
            onChange={(event) => setName(event.target.value)}
            value={name}
          />
        </Field>
        <Field label="Tipo de regla">
          <CrmSelect
            onChange={(next) => {
              setRuleKind(next as DiscountRuleKind);
              if (next === "discount") setAutoApply(false);
            }}
            options={[
              { label: "Descuento", value: "discount" },
              { label: "Promoción", value: "promotion" },
            ]}
            value={ruleKind}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Cálculo">
            <CrmSelect
              onChange={(next) => {
                const nextType = next as DiscountCalculationType;
                setType(nextType);
                if (nextType === "percentage") setFixedApplication("ticket");
                setValue("");
              }}
              options={[
                { label: "Porcentaje", value: "percentage" },
                { label: "Importe fijo", value: "fixed" },
              ]}
              value={type}
            />
          </Field>
          <Field label={type === "percentage" ? "Porcentaje" : "Importe"}>
            <UiInput
              className={inputClass}
              inputMode="decimal"
              onChange={(event) => {
                setValue(event.target.value);
                setValidationError(null);
              }}
              value={value}
            />
          </Field>
        </div>
        {type === "fixed" ? (
          <Field label="Aplicación del importe">
            <CrmSelect
              onChange={(next) =>
                setFixedApplication(next as DiscountFixedApplication)
              }
              options={[
                { label: "Por ticket", value: "ticket" },
                { label: "Por producto", value: "line" },
              ]}
              value={fixedApplication}
            />
            <small className="mt-1.5 block text-xs text-[var(--crm-text-muted)]">
              {fixedApplication === "line"
                ? "Se descuenta una vez en cada línea que cumpla el ámbito."
                : "Se descuenta una sola vez sobre el conjunto aplicable del ticket."}
            </small>
          </Field>
        ) : null}
        <Field label="Ámbito">
          <CrmSelect
            onChange={(next) => setScope(next as DiscountScope)}
            options={[
              { label: "General", value: "general" },
              { label: "Productos específicos", value: "specific" },
            ]}
            value={scope}
          />
        </Field>

        {scope === "specific" ? (
          <Field label="Productos y variantes">
            <div className="overflow-hidden rounded-[10px] bg-[var(--crm-input-bg)]">
              <div className="grid grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)_minmax(0,1fr)] gap-1.5 border-b border-[var(--crm-border-subtle)] p-2">
                <div className="relative min-w-0">
                  <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 z-10 size-3.5 -translate-y-1/2 text-[var(--crm-text-muted)]" />
                  <UiInput
                    aria-label="Buscar productos o variantes"
                    className="!h-9 !rounded-[9px] !border !border-[var(--crm-input-border)] !bg-[var(--crm-surface)] !p-0 !pl-8 !pr-2 !text-xs"
                    onChange={(event) => setTargetQuery(event.target.value)}
                    placeholder="Buscar"
                    type="search"
                    value={targetQuery}
                  />
                </div>
                <CrmSelect
                  ariaLabel="Filtrar por categoría"
                  compact
                  onChange={setTargetCategoryId}
                  options={targetCategoryOptions}
                  value={targetCategoryId}
                />
                <CrmSelect
                  ariaLabel="Filtrar por variante"
                  compact
                  onChange={setTargetVariantName}
                  options={targetVariantOptions}
                  value={targetVariantName}
                />
              </div>
              <div className="grid max-h-64 gap-2 overflow-y-auto p-3">
                {filteredTargetOptions.map((product) => {
                  const wholeProduct = targets.some(
                    (target) =>
                      target.productId === product.id &&
                      target.variantId === null,
                  );
                  return (
                    <div className="grid gap-1" key={product.id}>
                      <UiCheckbox
                        checked={wholeProduct}
                        onChange={(checked) => toggleProduct(product.id, checked)}
                      >
                        {product.name} (todas las variantes)
                      </UiCheckbox>
                      {!wholeProduct ? (
                        <div className="ml-6 grid gap-1">
                          {product.variants.map((variant) => (
                            <UiCheckbox
                              checked={targets.some(
                                (target) =>
                                  target.productId === product.id &&
                                  target.variantId === variant.id,
                              )}
                              key={variant.id}
                              onChange={(checked) =>
                                toggleVariant(product.id, variant.id, checked)
                              }
                            >
                              {variant.name}
                            </UiCheckbox>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {!targetOptions.length ? (
                  <p className="text-xs text-[var(--crm-text-muted)]">
                    No hay productos activos en este local.
                  </p>
                ) : !filteredTargetOptions.length ? (
                  <p className="py-3 text-center text-xs text-[var(--crm-text-muted)]">
                    No hay productos que coincidan con los filtros.
                  </p>
                ) : null}
              </div>
            </div>
          </Field>
        ) : null}

        {ruleKind === "promotion" ? (
          <div className="grid gap-3 rounded-[12px] bg-[var(--crm-surface-soft)] p-4">
            <div className="flex items-center gap-2 font-semibold">
              <Sparkles className="size-4 text-[var(--crm-blue)]" />{" "}
              Programación
            </div>
            <p className="-mt-1 text-xs text-[var(--crm-text-muted)]">
              Utilizando horario operativo del local
            </p>
            <Field label="Días activos">
              <div className="grid grid-cols-7 gap-1 w-full">
                {weekdays.map((day) => (
                  <UiButton
                    aria-label={`Día ${day.label}`}
                    aria-pressed={activeWeekdays.includes(day.value)}
                    className={
                      activeWeekdays.includes(day.value)
                        ? "w-full min-h-10 rounded-[9px] border-0 bg-[var(--crm-blue)] px-0 text-white"
                        : "w-full min-h-10 rounded-[9px] border-0 bg-[var(--crm-input-bg)] px-0"
                    }
                    key={day.value}
                    onClick={() =>
                      setActiveWeekdays((current) =>
                        current.includes(day.value)
                          ? current.filter((value) => value !== day.value)
                          : [...current, day.value].sort(),
                      )
                    }
                    type="button"
                  >
                    {day.label}
                  </UiButton>
                ))}
              </div>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Hora de inicio">
                <UiInput
                  className={inputClass}
                  onChange={(event) => setStartsAt(event.target.value)}
                  type="time"
                  value={startsAt}
                />
              </Field>
              <Field label="Hora de fin">
                <UiInput
                  className={inputClass}
                  onChange={(event) => setEndsAt(event.target.value)}
                  type="time"
                  value={endsAt}
                />
              </Field>
            </div>
            <UiCheckbox
              checked={autoApply}
              onChange={(checked) => {
                setAutoApply(checked);
                if (checked) {
                  setRequiresPin(false);
                  setPin("");
                }
              }}
            >
              Aplicar automáticamente
            </UiCheckbox>
            {autoApply ? (
              <p className="text-xs text-[var(--crm-text-muted)]">
                Las promociones automáticas no pueden solicitar un PIN.
              </p>
            ) : null}
          </div>
        ) : null}

        <UiCheckbox
          checked={requiresPin}
          disabled={ruleKind === "promotion" && autoApply}
          onChange={(checked) => {
            setRequiresPin(checked);
            if (!checked) setPin("");
          }}
        >
          Requiere PIN
        </UiCheckbox>
        {requiresPin ? (
          <Field
            label={
              discount?.requiresPin
                ? "Nuevo PIN (vacío conserva el actual)"
                : "PIN"
            }
          >
            <UiInput
              autoComplete="new-password"
              className={inputClass}
              inputMode="numeric"
              maxLength={8}
              onChange={(event) =>
                setPin(event.target.value.replace(/\D/g, "").slice(0, 8))
              }
              type="password"
              value={pin}
            />
          </Field>
        ) : null}

        <Field label="Redondeo del total">
          <CrmSelect
            onChange={(next) =>
              setRoundingIncrementCents(
                next ? (Number(next) as DiscountRoundingIncrementCents) : null,
              )
            }
            options={discountRoundingOptions.map((option) => ({
              label: option.label,
              value: String(option.value ?? ""),
            }))}
            value={String(roundingIncrementCents ?? "")}
          />
          <small className="mt-1.5 block text-xs text-[var(--crm-text-muted)]">
            {formatDiscountRounding(roundingIncrementCents)}
          </small>
        </Field>
        <Field label="Color">
          <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_44px] items-center gap-2 rounded-[10px] bg-[var(--crm-surface-soft)] px-2.5">
            <span className="truncate text-[11px]">{color.toUpperCase()}</span>
            <UiInput
              aria-label="Color de la regla"
              className="h-6 w-9 border-0 bg-transparent p-0"
              onChange={(event) => setColor(event.target.value)}
              type="color"
              value={color}
            />
          </div>
        </Field>
        <UiCheckbox
          checked={isActive}
          className="min-h-11 rounded-[10px] bg-[var(--crm-input-bg)] px-3.5 text-sm font-semibold"
          onChange={setIsActive}
        >
          Activo
        </UiCheckbox>
        {validationError ? (
          <p className="text-sm font-semibold text-[var(--crm-red)]">
            {validationError}
          </p>
        ) : null}
        <UiButton
          className="min-h-10 rounded-[10px] border-0 bg-[var(--crm-blue)] px-4 font-semibold text-white"
          disabled={disabled}
          type="submit"
        >
          <Save className="mr-2 inline size-4" />
          Guardar
        </UiButton>
        </form>
      </div>
    </CrmModal>
  );
}
