import { Input as UiInput } from "../../../../components/ui/Input";
import { Button as UiButton } from "../../../../components/ui/Button";
import {
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  Copy,
  Eye,
  EyeOff,
  Plus,
  Save,
  Trash2,
  X,
} from "lucide-react";
import { useMemo, useState, type Dispatch, type SetStateAction } from "react";
import type {
  CatalogAssignment,
  CatalogData,
  CatalogProduct,
} from "../../../catalog/domain/types";
import { formatMoney, parseMoneyToCents } from "../../../../lib/format";
import { CrmModal } from "../../shared/components/CrmModal";
import {
  CrmSelect,
  type CrmSelectFilterOption,
  type CrmSelectOption,
} from "../../shared/components/CrmSelect";
import { Field } from "../../shared/components/Field";
import { catalogAdminService } from "../services/catalogAdminService";
import { getCatalogProductSummaries } from "../services/catalogAdminModel";
import {
  buildNewMenuBatch,
  getMenuCompleteness,
  type NewMenuCourseDraft,
  validateNewMenuDraft,
} from "../services/menuEditorModel";

type Props = {
  catalog: CatalogData;
  defaultTaxRate: number;
  disabled: boolean;
  mutate: (action: () => Promise<unknown>) => Promise<boolean>;
  onClose: () => void;
  product: CatalogProduct | null;
};

const inputClass =
  "h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium text-[var(--crm-text)] outline-none focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)]";
const secondaryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-semibold text-[var(--crm-text-secondary)]";
const primaryButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-blue)] px-3.5 text-[13px] font-semibold text-white";
const dangerButton =
  "inline-flex min-h-10 items-center justify-center gap-2 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-red-soft)] px-3.5 text-[13px] font-semibold text-[var(--crm-red)]";

function newCourse(): NewMenuCourseDraft {
  return {
    id: catalogAdminService.uuid(),
    name: "",
    minSelection: 1,
    maxSelection: 1,
    options: [],
  };
}

function moneyOrNaN(value: string) {
  try {
    return parseMoneyToCents(value);
  } catch {
    return Number.NaN;
  }
}

export function CatalogMenuEditor({
  catalog,
  defaultTaxRate,
  disabled,
  mutate,
  onClose,
  product,
}: Props) {
  const variants = useMemo(
    () =>
      catalog.variants.filter((variant) => variant.productId === product?.id),
    [catalog.variants, product?.id],
  );
  const defaultVariant =
    variants.find((variant) => variant.isDefault) ?? variants[0] ?? null;
  const placement =
    catalog.placements.find(
      (candidate) => candidate.productId === product?.id,
    ) ?? null;
  const [name, setName] = useState(product?.name ?? "");
  const [description, setDescription] = useState(product?.description ?? "");
  const [vatRate, setVatRate] = useState(
    product?.vatRate === null || product?.vatRate === undefined
      ? ""
      : String(product.vatRate),
  );
  const [formatId, setFormatId] = useState(
    defaultVariant?.formatId ??
      catalog.saleFormats.find((format) => format.active)?.id ??
      "",
  );
  const [price, setPrice] = useState(
    defaultVariant
      ? (defaultVariant.priceCents / 100).toFixed(2).replace(".", ",")
      : "0,00",
  );
  const [tabId, setTabId] = useState(
    placement?.tabId ?? catalog.tabs.find((tab) => tab.active)?.id ?? "",
  );
  const [categoryId, setCategoryId] = useState(
    placement?.categoryId ??
      catalog.categories.find((category) => category.active)?.id ??
      "",
  );
  const [draftCourses, setDraftCourses] = useState<NewMenuCourseDraft[]>([
    newCourse(),
  ]);
  const [draftProductByCourse, setDraftProductByCourse] = useState<
    Record<string, string>
  >({});
  const [draftSupplementByCourse, setDraftSupplementByCourse] = useState<
    Record<string, string>
  >({});
  const [newCourseName, setNewCourseName] = useState("");
  const [newCourseProductId, setNewCourseProductId] = useState("");
  const [newCourseSupplement, setNewCourseSupplement] = useState("0,00");
  const [sharedGroupId, setSharedGroupId] = useState("");
  const priceCents = parseMoneyToCents(price);
  const standardProductSummaries = useMemo(
    () =>
      getCatalogProductSummaries(catalog).filter(
        (summary) =>
          summary.product.active && summary.product.type === "standard",
      ),
    [catalog],
  );
  const standardProducts = useMemo(
    () => standardProductSummaries.map((summary) => summary.product),
    [standardProductSummaries],
  );
  const standardProductOptions = useMemo<CrmSelectOption[]>(
    () =>
      standardProductSummaries.map((summary) => {
        const categories = summary.categories.filter(
          (category) => category.active,
        );
        return {
          description:
            categories.map((category) => category.name).join(", ") ||
            "Sin categoría",
          filterValues: categories.length
            ? categories.map((category) => category.id)
            : ["__uncategorized__"],
          label: summary.product.name,
          value: summary.product.id,
        };
      }),
    [standardProductSummaries],
  );
  const standardProductCategoryOptions = useMemo<
    CrmSelectFilterOption[]
  >(() => {
    const usedCategoryIds = new Set(
      standardProductOptions.flatMap((option) => option.filterValues ?? []),
    );
    return [
      { label: "Todas las categorías", value: "" },
      ...catalog.categories
        .filter(
          (category) => category.active && usedCategoryIds.has(category.id),
        )
        .map((category) => ({ label: category.name, value: category.id })),
      ...(usedCategoryIds.has("__uncategorized__")
        ? [{ label: "Sin categoría", value: "__uncategorized__" }]
        : []),
    ];
  }, [catalog.categories, standardProductOptions]);
  const menuAssignments = useMemo(
    () =>
      product
        ? catalog.selectionAssignments
            .filter(
              (assignment) =>
                assignment.productId === product.id &&
                assignment.active &&
                catalog.selectionGroups.some(
                  (group) =>
                    group.id === assignment.groupId &&
                    group.type === "menu_component",
                ),
            )
            .toSorted((left, right) => left.sortOrder - right.sortOrder)
        : [],
    [catalog.selectionAssignments, catalog.selectionGroups, product],
  );
  const completeness = getMenuCompleteness(catalog, product);
  const draftIssues = product
    ? []
    : validateNewMenuDraft({
        name,
        formatId,
        priceCents,
        courses: draftCourses,
      });
  const canPublish = product ? completeness.complete : draftIssues.length === 0;

  async function createAndPublish() {
    if (!canPublish) return;
    const productId = catalogAdminService.uuid();
    const variantId = catalogAdminService.uuid();
    const plan = buildNewMenuBatch({
      catalog,
      productId,
      variantId,
      formatId,
      name,
      description,
      priceCents,
      vatRate: vatRate === "" ? null : Number(vatRate),
      tabId,
      categoryId,
      courses: draftCourses,
      createId: catalogAdminService.uuid,
    });
    const saved = await mutate(() =>
      catalogAdminService.batchWithVariantFormats(
        catalog.venueId,
        plan.batch,
        plan.variantFormats,
      ),
    );
    if (saved) onClose();
  }

  async function saveGeneral() {
    if (
      !product ||
      !defaultVariant ||
      !name.trim() ||
      !Number.isSafeInteger(priceCents)
    )
      return;
    const saved = await mutate(() =>
      catalogAdminService.batchWithVariantFormats(
        catalog.venueId,
        [
          {
            command: "update_product",
            payload: {
              id: product.id,
              type: "menu",
              name: name.trim(),
              description: description.trim() || null,
              vatRate: vatRate === "" ? null : Number(vatRate),
              sortOrder: product.sortOrder,
            },
          },
          {
            command: "update_variant",
            payload: {
              id: defaultVariant.id,
              productId: product.id,
              formatId,
              name:
                catalog.saleFormats.find((format) => format.id === formatId)
                  ?.name ?? defaultVariant.name,
              priceCents,
              active: true,
              isDefault: true,
              sortOrder: defaultVariant.sortOrder,
            },
          },
          ...(placement
            ? [
                {
                  command: "update_placement" as const,
                  payload: {
                    ...placement,
                    tabId,
                    categoryId: categoryId || null,
                  },
                },
              ]
            : tabId
              ? [
                  {
                    command: "create_placement" as const,
                    payload: {
                      id: catalogAdminService.uuid(),
                      productId: product.id,
                      tabId,
                      categoryId: categoryId || null,
                      pinnedVariantId: null,
                      featured: false,
                      active: product.active,
                      sortOrder: catalog.placements.length * 10,
                    },
                  },
                ]
              : []),
        ],
        [{ variantId: defaultVariant.id, formatId }],
      ),
    );
    return saved;
  }

  async function togglePublication() {
    if (!product) return;
    if (!product.active && !completeness.complete) return;
    await mutate(() =>
      catalogAdminService.setProductActive(
        catalog.venueId,
        product.id,
        !product.active,
      ),
    );
  }

  async function addLocalCourse() {
    const supplementCents = moneyOrNaN(newCourseSupplement);
    if (
      !product ||
      !newCourseName.trim() ||
      !newCourseProductId ||
      !Number.isSafeInteger(supplementCents)
    )
      return;
    const groupId = catalogAdminService.uuid();
    const assignmentId = catalogAdminService.uuid();
    const saved = await mutate(() =>
      catalogAdminService.batch(catalog.venueId, [
        {
          command: "save_selection_group",
          payload: {
            id: groupId,
            name: newCourseName.trim(),
            type: "menu_component",
            active: true,
            sortOrder: catalog.selectionGroups.length * 10,
          },
        },
        {
          command: "save_selection_option",
          payload: {
            id: catalogAdminService.uuid(),
            groupId,
            productId: newCourseProductId,
            variantId: null,
            supplementCents,
            defaultQuantity: 0,
            maxQuantity: 1,
            active: true,
            sortOrder: 0,
          },
        },
        {
          command: "save_assignment",
          payload: {
            id: assignmentId,
            domain: "selection",
            productId: product.id,
            groupId,
            displayName: newCourseName.trim(),
            minSelection: 1,
            maxSelection: 1,
            appliesToAllVariants: true,
            variantIds: [],
            active: true,
            sortOrder: menuAssignments.length * 10,
          },
        },
      ]),
    );
    if (saved) {
      setNewCourseName("");
      setNewCourseProductId("");
      setNewCourseSupplement("0,00");
    }
  }

  async function addSharedCourse() {
    if (!product || !sharedGroupId) return;
    const group = catalog.selectionGroups.find(
      (candidate) => candidate.id === sharedGroupId,
    );
    if (!group) return;
    const affected = catalog.selectionAssignments.filter(
      (assignment) => assignment.groupId === group.id && assignment.active,
    ).length;
    if (
      !window.confirm(
        `Este curso ya se usa en ${affected} ${affected === 1 ? "menú" : "menús"}. Los cambios futuros afectarán a todos. ¿Continuar?`,
      )
    )
      return;
    const saved = await mutate(() =>
      catalogAdminService.saveAssignment(catalog.venueId, {
        domain: "selection",
        productId: product.id,
        groupId: group.id,
        displayName: group.name,
        minSelection: 1,
        maxSelection: 1,
        appliesToAllVariants: true,
        variantIds: [],
        active: true,
        sortOrder: menuAssignments.length * 10,
      }),
    );
    if (saved) setSharedGroupId("");
  }

  return (
    <CrmModal
      label={product ? `Editar menú ${product.name}` : "Crear menú"}
      onClose={onClose}
      size="large"
    >
      <div className="flex max-h-[calc(100dvh-48px)] min-h-0 flex-col">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--crm-border-subtle)] px-6 py-5">
          <div>
            <h2 className="text-xl font-bold">
              {product ? product.name : "Nuevo menú"}
            </h2>
            <p className="mt-1 text-sm text-[var(--crm-text-muted)]">
              General → Composición → Revisar y publicar
            </p>
          </div>
          <UiButton
            aria-label="Cerrar"
            className={secondaryButton}
            onClick={onClose}
            type="button"
          >
            <X className="size-4" />
          </UiButton>
        </header>

        <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_300px]">
          <main className="grid content-start gap-6 p-6">
            <section className="grid gap-4">
              <div>
                <h3 className="font-bold">1. Información general</h3>
                <p className="text-sm text-[var(--crm-text-muted)]">
                  El precio y la ubicación se publican inmediatamente al
                  guardar.
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Nombre">
                  <UiInput
                    className={inputClass}
                    onChange={(event) => setName(event.target.value)}
                    value={name}
                  />
                </Field>
                <Field label="Formato">
                  <CrmSelect
                    onChange={setFormatId}
                    options={catalog.saleFormats
                      .filter(
                        (format) => format.active || format.id === formatId,
                      )
                      .map((format) => ({
                        label: format.name,
                        value: format.id,
                      }))}
                    value={formatId}
                  />
                </Field>
                <Field label="Precio base">
                  <UiInput
                    className={inputClass}
                    inputMode="decimal"
                    onChange={(event) => setPrice(event.target.value)}
                    value={price}
                  />
                </Field>
                <Field label={`IVA · vacío hereda ${defaultTaxRate}%`}>
                  <UiInput
                    className={inputClass}
                    inputMode="decimal"
                    onChange={(event) => setVatRate(event.target.value)}
                    value={vatRate}
                  />
                </Field>
                <Field label="Pestaña POS">
                  <CrmSelect
                    onChange={setTabId}
                    options={catalog.tabs
                      .filter((tab) => tab.active)
                      .map((tab) => ({ label: tab.label, value: tab.id }))}
                    value={tabId}
                  />
                </Field>
                <Field label="Categoría POS">
                  <CrmSelect
                    onChange={setCategoryId}
                    options={[
                      { label: "Sin categoría", value: "" },
                      ...catalog.categories
                        .filter((category) => category.active)
                        .map((category) => ({
                          label: category.name,
                          value: category.id,
                        })),
                    ]}
                    value={categoryId}
                  />
                </Field>
              </div>
              <Field label="Descripción">
                <UiInput
                  className={inputClass}
                  onChange={(event) => setDescription(event.target.value)}
                  value={description}
                />
              </Field>
              {product ? (
                <UiButton
                  className={`${primaryButton} w-fit`}
                  disabled={
                    disabled ||
                    !name.trim() ||
                    !Number.isSafeInteger(priceCents)
                  }
                  onClick={() => void saveGeneral()}
                  type="button"
                >
                  <Save className="size-4" /> Guardar información
                </UiButton>
              ) : null}
            </section>

            <section className="grid gap-4 border-t border-[var(--crm-border-subtle)] pt-6">
              <div>
                <h3 className="font-bold">2. Composición</h3>
                <p className="text-sm text-[var(--crm-text-muted)]">
                  Cada curso es local al menú. Reutilizar un grupo es siempre
                  una acción explícita.
                </p>
              </div>
              {!product ? (
                <DraftCourseEditor
                  categoryOptions={standardProductCategoryOptions}
                  courses={draftCourses}
                  disabled={disabled}
                  productByCourse={draftProductByCourse}
                  productOptions={standardProductOptions}
                  products={standardProducts}
                  setCourses={setDraftCourses}
                  setProductByCourse={setDraftProductByCourse}
                  setSupplementByCourse={setDraftSupplementByCourse}
                  supplementByCourse={draftSupplementByCourse}
                />
              ) : (
                <div className="grid gap-3">
                  {menuAssignments.map((assignment, index) => (
                    <ExistingCourseCard
                      assignment={assignment}
                      catalog={catalog}
                      categoryOptions={standardProductCategoryOptions}
                      disabled={disabled}
                      index={index}
                      key={`${assignment.id}:${assignment.updatedAt}`}
                      mutate={mutate}
                      product={product}
                      productOptions={standardProductOptions}
                      total={menuAssignments.length}
                    />
                  ))}
                  {!menuAssignments.length ? (
                    <p className="rounded-xl border border-dashed border-[var(--crm-border)] p-5 text-center text-sm text-[var(--crm-text-muted)]">
                      Este menú todavía no tiene cursos.
                    </p>
                  ) : null}
                  <div className="grid gap-3 rounded-xl bg-[var(--crm-surface-soft)] p-4 sm:grid-cols-[1fr_minmax(220px,1fr)_120px_auto] sm:items-end">
                    <Field label="Nuevo curso local">
                      <UiInput
                        className={inputClass}
                        onChange={(event) =>
                          setNewCourseName(event.target.value)
                        }
                        placeholder="Ej. Primer plato"
                        value={newCourseName}
                      />
                    </Field>
                    <Field label="Primera opción">
                      <CrmSelect
                        emptyMessage="No hay productos en esta categoría."
                        filterOptions={standardProductCategoryOptions}
                        filterPlaceholder="Categorías"
                        onChange={setNewCourseProductId}
                        options={standardProductOptions}
                        placeholder="Selecciona un producto estándar"
                        searchable
                        searchPlaceholder="Buscar producto..."
                        value={newCourseProductId}
                      
                      />
                    </Field>
                    <Field label="Suplemento €">
                      <UiInput
                        aria-label="Suplemento de la primera opción"
                        className={inputClass}
                        inputMode="decimal"
                        onChange={(event) =>
                          setNewCourseSupplement(event.target.value)
                        }
                        value={newCourseSupplement}
                      />
                    </Field>
                    <UiButton
                      className={primaryButton}
                      disabled={
                        disabled ||
                        !newCourseName.trim() ||
                        !newCourseProductId ||
                        !Number.isSafeInteger(moneyOrNaN(newCourseSupplement))
                      }
                      onClick={() => void addLocalCourse()}
                      type="button"
                    >
                      <Plus className="size-4" /> Añadir curso
                    </UiButton>
                  </div>
                  <div className="grid gap-3 rounded-xl border border-[var(--crm-border)] p-4 sm:grid-cols-[1fr_auto] sm:items-end">
                    <Field label="Reutilizar curso de otro menú">
                      <CrmSelect
                        onChange={setSharedGroupId}
                        options={catalog.selectionGroups
                          .filter(
                            (group) =>
                              group.active &&
                              group.type === "menu_component" &&
                              !menuAssignments.some(
                                (assignment) => assignment.groupId === group.id,
                              ) &&
                              catalog.selectionAssignments.some(
                                (assignment) =>
                                  assignment.groupId === group.id &&
                                  assignment.active,
                              ),
                          )
                          .map((group) => ({
                            label: group.name,
                            value: group.id,
                            description: `${catalog.selectionAssignments.filter((assignment) => assignment.groupId === group.id && assignment.active).length} usos`,
                          }))}
                        value={sharedGroupId}
                      />
                    </Field>
                    <UiButton
                      className={secondaryButton}
                      disabled={disabled || !sharedGroupId}
                      onClick={() => void addSharedCourse()}
                      type="button"
                    >
                      <Copy className="size-4" /> Reutilizar curso
                    </UiButton>
                  </div>
                </div>
              )}
            </section>
          </main>

          <aside className="border-t border-[var(--crm-border-subtle)] bg-[var(--crm-surface-soft)] p-6 lg:border-l lg:border-t-0">
            <div className="sticky top-0 grid gap-5">
              <div>
                <h3 className="font-bold">3. Revisar y publicar</h3>
                <p className="mt-1 text-sm text-[var(--crm-text-muted)]">
                  {canPublish
                    ? "El menú está listo."
                    : "Completa los puntos pendientes."}
                </p>
              </div>
              <div className="rounded-xl bg-[var(--crm-surface)] p-4">
                <span className="text-xs font-semibold uppercase text-[var(--crm-text-muted)]">
                  Vista POS
                </span>
                <strong className="mt-3 block text-lg">
                  {name || "Nombre del menú"}
                </strong>
                <span className="mt-1 block text-sm text-[var(--crm-text-muted)]">
                  Menú ·{" "}
                  {product ? completeness.courseCount : draftCourses.length}{" "}
                  elecciones
                </span>
                <strong className="mt-4 block font-mono text-xl">
                  Desde{" "}
                  {Number.isSafeInteger(priceCents)
                    ? formatMoney(priceCents)
                    : "—"}
                </strong>
              </div>
              <div className="rounded-xl bg-[var(--crm-surface)] p-4">
                <span className="text-xs font-semibold uppercase text-[var(--crm-text-muted)]">
                  Ticket detallado
                </span>
                <strong className="mt-3 block">1 × {name || "Menú"}</strong>
                {(product
                  ? menuAssignments.map(
                      (assignment) =>
                        assignment.displayName ||
                        catalog.selectionGroups.find(
                          (group) => group.id === assignment.groupId,
                        )?.name,
                    )
                  : draftCourses.map((course) => course.name)
                )
                  .filter(Boolean)
                  .map((label) => (
                    <span
                      className="mt-1 block border-l-2 border-[var(--crm-border)] pl-2 text-xs text-[var(--crm-text-muted)]"
                      key={label}
                    >
                      {" "}
                      {label} · elección del cliente
                    </span>
                  ))}
              </div>
              <div className="grid gap-2">
                {(product ? completeness.issues : draftIssues).map((issue) => (
                  <p
                    className="rounded-lg bg-[var(--crm-yellow-soft)] p-3 text-sm font-semibold text-[var(--crm-yellow)]"
                    key={issue}
                  >
                    {issue}
                  </p>
                ))}
                {canPublish ? (
                  <p className="flex items-center gap-2 rounded-lg bg-[var(--crm-green-soft)] p-3 text-sm font-semibold text-[var(--crm-green)]">
                    <CheckCircle2 className="size-4" /> Configuración completa
                  </p>
                ) : null}
              </div>
              {product ? (
                <UiButton
                  className={product.active ? dangerButton : primaryButton}
                  disabled={disabled || (!product.active && !canPublish)}
                  onClick={() => void togglePublication()}
                  type="button"
                >
                  {product.active ? (
                    <EyeOff className="size-4" />
                  ) : (
                    <Eye className="size-4" />
                  )}{" "}
                  {product.active ? "Retirar del POS" : "Publicar ahora"}
                </UiButton>
              ) : (
                <UiButton
                  className={primaryButton}
                  disabled={disabled || !canPublish}
                  onClick={() => void createAndPublish()}
                  type="button"
                >
                  <Eye className="size-4" /> Crear y publicar
                </UiButton>
              )}
            </div>
          </aside>
        </div>
      </div>
    </CrmModal>
  );
}

function DraftCourseEditor({
  categoryOptions,
  courses,
  disabled,
  productByCourse,
  productOptions,
  products,
  setCourses,
  setProductByCourse,
  setSupplementByCourse,
  supplementByCourse,
}: {
  categoryOptions: CrmSelectFilterOption[];
  courses: NewMenuCourseDraft[];
  disabled: boolean;
  productByCourse: Record<string, string>;
  productOptions: CrmSelectOption[];
  products: CatalogProduct[];
  setCourses: Dispatch<SetStateAction<NewMenuCourseDraft[]>>;
  setProductByCourse: Dispatch<SetStateAction<Record<string, string>>>;
  setSupplementByCourse: Dispatch<SetStateAction<Record<string, string>>>;
  supplementByCourse: Record<string, string>;
}) {
  return (
    <div className="grid gap-3">
      {courses.map((course, index) => (
        <div
          className="grid gap-3 rounded-xl border border-[var(--crm-border)] p-4"
          key={course.id}
        >
          <div className="flex items-center justify-between gap-3">
            <strong>Curso {index + 1}</strong>
            <UiButton
              aria-label="Eliminar curso"
              className={dangerButton}
              disabled={disabled || courses.length === 1}
              onClick={() =>
                setCourses((current) =>
                  current.filter((candidate) => candidate.id !== course.id),
                )
              }
              type="button"
            >
              <Trash2 className="size-4" />
            </UiButton>
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_90px_90px]">
            <UiInput
              aria-label="Nombre del curso"
              className={inputClass}
              onChange={(event) =>
                setCourses((current) =>
                  current.map((candidate) =>
                    candidate.id === course.id
                      ? { ...candidate, name: event.target.value }
                      : candidate,
                  ),
                )
              }
              placeholder="Ej. Segundo plato"
              value={course.name}
            />
            <UiInput
              aria-label="Mínimo"
              className={inputClass}
              min={1}
              onChange={(event) =>
                setCourses((current) =>
                  current.map((candidate) =>
                    candidate.id === course.id
                      ? {
                          ...candidate,
                          minSelection: Number(event.target.value),
                        }
                      : candidate,
                  ),
                )
              }
              type="number"
              value={course.minSelection}
            />
            <UiInput
              aria-label="Máximo"
              className={inputClass}
              min={course.minSelection}
              onChange={(event) =>
                setCourses((current) =>
                  current.map((candidate) =>
                    candidate.id === course.id
                      ? {
                          ...candidate,
                          maxSelection: Number(event.target.value),
                        }
                      : candidate,
                  ),
                )
              }
              type="number"
              value={course.maxSelection}
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_120px_auto]">
            <CrmSelect
              emptyMessage="No hay productos en esta categoría."
              filterOptions={categoryOptions}
              filterPlaceholder="Categorías"
              onChange={(value) =>
                setProductByCourse((current) => ({
                  ...current,
                  [course.id]: value,
                }))
              }
              options={productOptions.filter(
                (option) =>
                  !course.options.some(
                    (courseOption) => courseOption.productId === option.value,
                  ),
              )}
              placeholder="Añadir producto estándar"
              searchable
              searchPlaceholder="Buscar producto..."
              value={productByCourse[course.id] ?? ""}
            />
            <UiInput
              aria-label="Suplemento de la opción"
              className={inputClass}
              inputMode="decimal"
              onChange={(event) =>
                setSupplementByCourse((current) => ({
                  ...current,
                  [course.id]: event.target.value,
                }))
              }
              placeholder="0,00"
              value={supplementByCourse[course.id] ?? "0,00"}
            />
            <UiButton
              className={secondaryButton}
              disabled={
                disabled ||
                !productByCourse[course.id] ||
                !Number.isSafeInteger(
                  moneyOrNaN(supplementByCourse[course.id] ?? "0,00"),
                )
              }
              onClick={() => {
                const productId = productByCourse[course.id];
                const supplementCents = moneyOrNaN(
                  supplementByCourse[course.id] ?? "0,00",
                );
                if (!productId || !Number.isSafeInteger(supplementCents))
                  return;
                setCourses((current) =>
                  current.map((candidate) =>
                    candidate.id === course.id
                      ? {
                          ...candidate,
                          options: [
                            ...candidate.options,
                            { productId, supplementCents },
                          ],
                        }
                      : candidate,
                  ),
                );
                setProductByCourse((current) => ({
                  ...current,
                  [course.id]: "",
                }));
                setSupplementByCourse((current) => ({
                  ...current,
                  [course.id]: "0,00",
                }));
              }}
              type="button"
            >
              <Plus className="size-4" /> Añadir opción
            </UiButton>
          </div>
          <div className="flex flex-wrap gap-2">
            {course.options.map((option) => (
              <span
                className="inline-flex items-center gap-2 rounded-full bg-[var(--crm-blue-soft)] px-3 py-1.5 text-xs font-semibold text-[var(--crm-blue)]"
                key={option.productId}
              >
                {
                  products.find((product) => product.id === option.productId)
                    ?.name
                }
                {option.supplementCents
                  ? ` · ${option.supplementCents > 0 ? "+" : ""}${formatMoney(option.supplementCents)}`
                  : " · Incluido"}
                <button
                  aria-label="Quitar opción"
                  onClick={() =>
                    setCourses((current) =>
                      current.map((candidate) =>
                        candidate.id === course.id
                          ? {
                              ...candidate,
                              options: candidate.options.filter(
                                (courseOption) =>
                                  courseOption.productId !== option.productId,
                              ),
                            }
                          : candidate,
                      ),
                    )
                  }
                  type="button"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
          </div>
        </div>
      ))}
      <UiButton
        className={`${secondaryButton} w-fit`}
        disabled={disabled}
        onClick={() => setCourses((current) => [...current, newCourse()])}
        type="button"
      >
        <Plus className="size-4" /> Añadir otro curso
      </UiButton>
    </div>
  );
}

function ExistingCourseCard({
  assignment,
  catalog,
  categoryOptions,
  disabled,
  index,
  mutate,
  product,
  productOptions,
  total,
}: {
  assignment: CatalogAssignment;
  catalog: CatalogData;
  categoryOptions: CrmSelectFilterOption[];
  disabled: boolean;
  index: number;
  mutate: Props["mutate"];
  product: CatalogProduct;
  productOptions: CrmSelectOption[];
  total: number;
}) {
  const group = catalog.selectionGroups.find(
    (candidate) => candidate.id === assignment.groupId,
  )!;
  const options = catalog.selectionOptions
    .filter((option) => option.groupId === group.id)
    .toSorted((left, right) => left.sortOrder - right.sortOrder);
  const usageCount = catalog.selectionAssignments.filter(
    (candidate) => candidate.groupId === group.id && candidate.active,
  ).length;
  const [displayName, setDisplayName] = useState(
    assignment.displayName || group.name,
  );
  const [minimum, setMinimum] = useState(assignment.minSelection);
  const [maximum, setMaximum] = useState(assignment.maxSelection);
  const [variantIds, setVariantIds] = useState(
    assignment.appliesToAllVariants ? [] : assignment.variantIds,
  );
  const [optionProductId, setOptionProductId] = useState("");
  const [optionVariantId, setOptionVariantId] = useState("");
  const [supplement, setSupplement] = useState("0,00");
  const productVariants = catalog.variants.filter(
    (variant) => variant.productId === optionProductId && variant.active,
  );
  const menuVariants = catalog.variants.filter(
    (variant) => variant.productId === product.id && variant.active,
  );

  async function saveAssignment() {
    await mutate(() =>
      catalogAdminService.saveAssignment(catalog.venueId, {
        ...assignment,
        domain: "selection",
        displayName: displayName.trim() || group.name,
        minSelection: minimum,
        maxSelection: maximum,
        appliesToAllVariants: variantIds.length === 0,
        variantIds,
      }),
    );
  }
  async function move(direction: -1 | 1) {
    const ordered = catalog.selectionAssignments
      .filter(
        (candidate) =>
          candidate.productId === product.id &&
          candidate.active &&
          catalog.selectionGroups.some(
            (candidateGroup) =>
              candidateGroup.id === candidate.groupId &&
              candidateGroup.type === "menu_component",
          ),
      )
      .toSorted((left, right) => left.sortOrder - right.sortOrder);
    const target = index + direction;
    if (!ordered[target]) return;
    const next = [...ordered];
    [next[index], next[target]] = [next[target], next[index]];
    await mutate(() =>
      catalogAdminService.reorder(catalog.venueId, {
        entity: "selection_assignments",
        items: next.map((candidate, order) => ({
          id: candidate.id,
          sortOrder: order * 10,
        })),
      }),
    );
  }
  async function addOption() {
    if (!optionProductId) return;
    const cents = moneyOrNaN(supplement);
    if (!Number.isSafeInteger(cents)) return;
    const saved = await mutate(() =>
      catalogAdminService.saveSelectionOption(catalog.venueId, {
        groupId: group.id,
        productId: optionProductId,
        variantId: optionVariantId || null,
        supplementCents: cents,
        defaultQuantity: 0,
        maxQuantity: 1,
        active: true,
        sortOrder: options.length * 10,
      }),
    );
    if (saved) {
      setOptionProductId("");
      setOptionVariantId("");
      setSupplement("0,00");
    }
  }
  async function removeCourse() {
    if (!window.confirm(`¿Quitar “${displayName}” de este menú?`)) return;
    await mutate(() =>
      usageCount === 1
        ? catalogAdminService.batch(catalog.venueId, [
            {
              command: "delete_assignment",
              payload: { domain: "selection", id: assignment.id },
            },
            { command: "delete_selection_group", payload: { id: group.id } },
          ])
        : catalogAdminService.deleteAssignment(
            catalog.venueId,
            "selection",
            assignment.id,
          ),
    );
  }
  async function localizeGroup() {
    const newGroupId = catalogAdminService.uuid();
    await mutate(() =>
      catalogAdminService.batch(catalog.venueId, [
        {
          command: "save_selection_group",
          payload: {
            id: newGroupId,
            name: displayName,
            type: "menu_component",
            active: true,
            sortOrder: catalog.selectionGroups.length * 10,
          },
        },
        ...options.map((option) => ({
          command: "save_selection_option" as const,
          payload: {
            ...option,
            id: catalogAdminService.uuid(),
            groupId: newGroupId,
            defaultQuantity: 0,
          },
        })),
        {
          command: "save_assignment",
          payload: {
            ...assignment,
            domain: "selection",
            groupId: newGroupId,
            displayName,
          },
        },
      ]),
    );
  }

  return (
    <article className="grid gap-4 rounded-xl border border-[var(--crm-border)] bg-[var(--crm-surface)] p-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <strong>
            {index + 1}. {displayName}
          </strong>
          <p className="text-xs text-[var(--crm-text-muted)]">
            {options.length} opciones ·{" "}
            {usageCount > 1
              ? `Compartido con ${usageCount} menús`
              : "Local a este menú"}
          </p>
        </div>
        <div className="flex gap-1">
          <UiButton
            aria-label="Subir curso"
            className={secondaryButton}
            disabled={disabled || index === 0}
            onClick={() => void move(-1)}
            type="button"
          >
            <ArrowUp className="size-4" />
          </UiButton>
          <UiButton
            aria-label="Bajar curso"
            className={secondaryButton}
            disabled={disabled || index === total - 1}
            onClick={() => void move(1)}
            type="button"
          >
            <ArrowDown className="size-4" />
          </UiButton>
          <UiButton
            aria-label="Eliminar curso"
            className={dangerButton}
            disabled={disabled || (product.active && total === 1)}
            onClick={() => void removeCourse()}
            title={
              product.active && total === 1
                ? "Retira el menú del POS antes de eliminar su único curso."
                : "Eliminar curso"
            }
            type="button"
          >
            <Trash2 className="size-4" />
          </UiButton>
        </div>
      </header>
      <div className="grid gap-2 sm:grid-cols-[1fr_90px_90px_auto]">
        <UiInput
          aria-label="Nombre visible"
          className={inputClass}
          onChange={(event) => setDisplayName(event.target.value)}
          value={displayName}
        />
        <UiInput
          aria-label="Mínimo"
          className={inputClass}
          min={1}
          onChange={(event) => setMinimum(Number(event.target.value))}
          type="number"
          value={minimum}
        />
        <UiInput
          aria-label="Máximo"
          className={inputClass}
          min={minimum}
          onChange={(event) => setMaximum(Number(event.target.value))}
          type="number"
          value={maximum}
        />
        <UiButton
          className={secondaryButton}
          disabled={
            disabled || !displayName.trim() || minimum < 1 || maximum < minimum
          }
          onClick={() => void saveAssignment()}
          type="button"
        >
          <Save className="size-4" /> Guardar
        </UiButton>
      </div>
      {menuVariants.length > 1 ? (
        <div>
          <span className="text-xs font-semibold text-[var(--crm-text-muted)]">
            Disponible en variantes · ninguna marcada = todas
          </span>
          <div className="mt-2 flex flex-wrap gap-2">
            {menuVariants.map((variant) => (
              <label
                className="flex items-center gap-2 rounded-lg bg-[var(--crm-surface-soft)] px-3 py-2 text-xs font-semibold"
                key={variant.id}
              >
                <input
                  checked={variantIds.includes(variant.id)}
                  onChange={(event) =>
                    setVariantIds((current) =>
                      event.target.checked
                        ? [...current, variant.id]
                        : current.filter((id) => id !== variant.id),
                    )
                  }
                  type="checkbox"
                />
                {variant.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid gap-2">
        {options.map((option) => (
          <ExistingOptionRow
            catalog={catalog}
            categoryOptions={categoryOptions}
            disabled={disabled}
            key={`${option.id}:${option.updatedAt}`}
            mutate={mutate}
            option={option}
            productOptions={productOptions}
          />
        ))}
      </div>
      <div className="grid gap-2 rounded-lg border border-dashed border-[var(--crm-border)] p-3 sm:grid-cols-[minmax(220px,1fr)_minmax(180px,.7fr)_120px_auto]">
        <CrmSelect
          emptyMessage="No hay productos en esta categoría."
          filterOptions={categoryOptions}
          filterPlaceholder="Categorías"
          onChange={(value) => {
            setOptionProductId(value);
            setOptionVariantId("");
          }}
          options={productOptions}
          placeholder="Producto estándar"
          searchable
          searchPlaceholder="Buscar producto..."
          value={optionProductId}
        />
        <CrmSelect
          onChange={setOptionVariantId}
          options={[
            { label: "Variante predeterminada", value: "" },
            ...productVariants.map((variant) => ({
              label: variant.name,
              value: variant.id,
            })),
          ]}
          value={optionVariantId}
        />
        <UiInput
          aria-label="Suplemento"
          className={inputClass}
          inputMode="decimal"
          onChange={(event) => setSupplement(event.target.value)}
          value={supplement}
        />
        <UiButton
          className={secondaryButton}
          disabled={
            disabled ||
            !optionProductId ||
            !Number.isSafeInteger(moneyOrNaN(supplement))
          }
          onClick={() => void addOption()}
          type="button"
        >
          <Plus className="size-4" /> Opción
        </UiButton>
      </div>
      {usageCount > 1 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--crm-yellow-soft)] p-3 text-sm font-semibold text-[var(--crm-yellow)]">
          <span>Los cambios en las opciones afectan a {usageCount} menús.</span>
          <UiButton
            className={secondaryButton}
            disabled={disabled}
            onClick={() => void localizeGroup()}
            type="button"
          >
            <Copy className="size-4" /> Duplicar para este menú
          </UiButton>
        </div>
      ) : null}
    </article>
  );
}

function ExistingOptionRow({
  catalog,
  categoryOptions,
  disabled,
  mutate,
  option,
  productOptions,
}: {
  catalog: CatalogData;
  categoryOptions: CrmSelectFilterOption[];
  disabled: boolean;
  mutate: Props["mutate"];
  option: CatalogData["selectionOptions"][number];
  productOptions: CrmSelectOption[];
}) {
  const [editing, setEditing] = useState(false);
  const [productId, setProductId] = useState(option.productId);
  const [variantId, setVariantId] = useState(option.variantId ?? "");
  const [supplement, setSupplement] = useState(
    (option.supplementCents / 100).toFixed(2).replace(".", ","),
  );
  const [maximum, setMaximum] = useState(option.maxQuantity ?? 1);
  const variants = catalog.variants.filter(
    (variant) => variant.productId === productId && variant.active,
  );
  const product = catalog.products.find(
    (candidate) => candidate.id === option.productId,
  );
  const variant = catalog.variants.find(
    (candidate) => candidate.id === option.variantId,
  );

  async function save() {
    const supplementCents = moneyOrNaN(supplement);
    if (!Number.isSafeInteger(supplementCents) || maximum < 1) return;
    const saved = await mutate(() =>
      catalogAdminService.saveSelectionOption(catalog.venueId, {
        ...option,
        productId,
        variantId: variantId || null,
        supplementCents,
        defaultQuantity: 0,
        maxQuantity: maximum,
      }),
    );
    if (saved) setEditing(false);
  }

  if (!editing)
    return (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-[var(--crm-surface-soft)] px-3 py-2 text-sm">
        <span>
          <strong>{product?.name}</strong>
          {variant ? ` · ${variant.name}` : " · Variante predeterminada"} ·{" "}
          {option.supplementCents
            ? `${option.supplementCents > 0 ? "+" : ""}${formatMoney(option.supplementCents)}`
            : "Incluido"}{" "}
          · máx. {option.maxQuantity ?? "—"} ·{" "}
          {option.active ? "Activa" : "Inactiva"}
        </span>
        <div className="flex gap-1">
          <UiButton
            className={secondaryButton}
            disabled={disabled}
            onClick={() => setEditing(true)}
            type="button"
          >
            Editar
          </UiButton>
          <UiButton
            aria-label="Activar o desactivar opción"
            className={secondaryButton}
            disabled={disabled}
            onClick={() =>
              void mutate(() =>
                catalogAdminService.saveSelectionOption(catalog.venueId, {
                  ...option,
                  defaultQuantity: 0,
                  active: !option.active,
                }),
              )
            }
            type="button"
          >
            {option.active ? (
              <EyeOff className="size-4" />
            ) : (
              <Eye className="size-4" />
            )}
          </UiButton>
          <UiButton
            aria-label="Eliminar opción"
            className={dangerButton}
            disabled={disabled}
            onClick={() =>
              void mutate(() =>
                catalogAdminService.deleteSelectionOption(
                  catalog.venueId,
                  option.id,
                ),
              )
            }
            type="button"
          >
            <Trash2 className="size-4" />
          </UiButton>
        </div>
      </div>
    );

  return (
    <div className="grid gap-2 rounded-lg bg-[var(--crm-surface-soft)] p-3 sm:grid-cols-[1fr_1fr_110px_90px_auto]">
      <CrmSelect
        emptyMessage="No hay productos en esta categoría."
        filterOptions={categoryOptions}
        filterPlaceholder="Categorías"
        onChange={(value) => {
          setProductId(value);
          setVariantId("");
        }}
        options={productOptions}
        searchable
        searchPlaceholder="Buscar producto..."
        value={productId}
      />
      <CrmSelect
        onChange={setVariantId}
        options={[
          { label: "Variante predeterminada", value: "" },
          ...variants.map((candidate) => ({
            label: candidate.name,
            value: candidate.id,
          })),
        ]}
        value={variantId}
      />
      <UiInput
        aria-label="Suplemento"
        className={inputClass}
        onChange={(event) => setSupplement(event.target.value)}
        value={supplement}
      />
      <UiInput
        aria-label="Cantidad máxima"
        className={inputClass}
        min={1}
        onChange={(event) => setMaximum(Number(event.target.value))}
        type="number"
        value={maximum}
      />
      <div className="flex gap-1">
        <UiButton
          className={primaryButton}
          disabled={
            disabled ||
            !productId ||
            !Number.isSafeInteger(moneyOrNaN(supplement)) ||
            maximum < 1
          }
          onClick={() => void save()}
          type="button"
        >
          <Save className="size-4" />
        </UiButton>
        <UiButton
          className={secondaryButton}
          onClick={() => setEditing(false)}
          type="button"
        >
          <X className="size-4" />
        </UiButton>
      </div>
    </div>
  );
}
