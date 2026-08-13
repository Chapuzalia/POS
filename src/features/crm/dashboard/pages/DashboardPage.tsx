import { Checkbox as UiCheckbox } from "../../../../components/ui/Checkbox";
import { Button as UiButton } from "../../../../components/ui/Button";
import { EmptyList } from "../../shared/components/EmptyList";
import { RefreshCw } from "lucide-react";
import { TopProductsList } from "../../analytics/pages/StatsPage";
import { formatMoney } from "../../../../lib/format";
import { paymentLabels } from "../../sales/services/salesReportModel";
import { formatCrmDateTime } from "../../shared/formatCrmDateTime";
import { type CSSProperties, useState } from "react";
import type { CrmStats } from "../../../../types";
import type {
  CatalogCategory,
  CatalogPlacement,
  CatalogProduct,
} from "../../../catalog/domain/types.ts";

export type DashboardCrmProps = {
  activeCategories: number;
  activeProducts: number;
  categories: CatalogCategory[];
  disabled: boolean;
  onRefresh: () => Promise<void>;
  placements: CatalogPlacement[];
  products: CatalogProduct[];
  selectedVenueId: string;
  stats: CrmStats | null;
};

export function DashboardCrm({
  activeCategories,
  activeProducts,
  categories,
  disabled,
  onRefresh,
  placements,
  products,
  selectedVenueId,
  stats,
}: DashboardCrmProps) {
  const [showAllOpenCashSessions, setShowAllOpenCashSessions] = useState(true);
  const categoryBars = categories.map((category) => ({
    ...category,
    count: new Set(
      placements
        .filter((placement) => placement.categoryId === category.id)
        .map((placement) => placement.productId),
    ).size,
  }));
  const maxCategoryCount = Math.max(
    1,
    ...categoryBars.map((category) => category.count),
  );
  const activeRatio = products.length
    ? Math.round((activeProducts / products.length) * 100)
    : 0;

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] !col-span-full">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !flex-col !items-stretch !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] sm:!flex-row sm:!items-center md:!px-[22px]">
          <span>Cajas abiertas</span>
          <div className="!flex !items-center !justify-between !gap-2 sm:!justify-end">
            <UiCheckbox
              checked={showAllOpenCashSessions}
              className="rounded-[10px] bg-(--crm-surface-soft) p-3 text-xs font-semibold text-(--crm-text-secondary)"
              onChange={setShowAllOpenCashSessions}
            >
              Todas las cajas del negocio
            </UiCheckbox>
            <UiButton
              aria-label="Actualizar cajas abiertas"
              className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
              disabled={disabled}
              onClick={() => void onRefresh()}
              type="button"
            >
              <RefreshCw className="h-4 w-4" />
            </UiButton>
          </div>
        </div>
        <OpenCashSessionsList
          selectedVenueId={selectedVenueId}
          showAll={showAllOpenCashSessions}
          stats={stats}
        />
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] !col-span-full">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Resumen del catálogo</span>
          <UiButton
            aria-label="Actualizar resumen"
            className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150"
            disabled={disabled}
            onClick={() => void onRefresh()}
            type="button"
          >
            <RefreshCw className="h-4 w-4" />
          </UiButton>
        </div>
        <div className="!grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard
            color="blue"
            label="Productos activos"
            value={activeProducts}
          />
          <KpiCard
            color="neutral"
            label="Productos totales"
            value={products.length}
          />
          <KpiCard
            color="neutral"
            label="Categorias"
            value={categories.length}
          />
          <KpiCard color="green" label="Activas" value={activeCategories} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Estado del catálogo</span>
        </div>
        <div className="!grid !grid-cols-1 !items-center !gap-[18px] !px-[22px] !pt-[18px] !pb-6 md:!grid-cols-[190px_minmax(0,1fr)]">
          <div
            className="relative grid aspect-square w-[138px] place-items-center justify-self-center rounded-full bg-[conic-gradient(var(--crm-blue)_var(--crm-progress),var(--crm-surface-soft)_0)] after:absolute after:inset-[15px] after:rounded-[inherit] after:bg-[var(--crm-surface)] after:content-[''] [&_span]:relative [&_span]:z-[1] [&_span]:grid [&_span]:place-items-center [&_span]:bg-transparent [&_span]:text-[22px] [&_span]:font-bold [&_span]:tabular-nums [&_span]:text-[var(--crm-text)]"
            style={{ "--crm-progress": `${activeRatio}%` } as CSSProperties}
          >
            <span>{activeRatio}%</span>
          </div>
          <div className="grid gap-[9px] p-0 [&>div]:flex [&>div]:min-h-[52px] [&>div]:min-w-0 [&>div]:items-center [&>div]:justify-between [&>div]:gap-3 [&>div]:rounded-[var(--crm-radius-sm)] [&>div]:border-0 [&>div]:bg-[var(--crm-surface-soft)] [&>div]:px-[13px] [&>div]:py-[11px] [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-secondary)] [&_strong]:whitespace-nowrap [&_strong]:text-[15px] [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
            <div>
              <span>Activos</span>
              <strong>{activeProducts}</strong>
            </div>
            <div>
              <span>Ocultos</span>
              <strong>{products.length - activeProducts}</strong>
            </div>
            <div>
              <span>Ventas mes</span>
              <strong>{formatMoney(stats?.monthSalesCents ?? 0)}</strong>
            </div>
          </div>
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Actividad del mes</span>
        </div>
        <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
          <MiniMetric
            label="Tickets"
            value={String(stats?.monthTicketCount ?? 0)}
          />
          <MiniMetric
            label="Ticket medio"
            value={formatMoney(stats?.averageTicketCents ?? 0)}
          />
          <MiniMetric
            label="Ingresos"
            value={formatMoney(stats?.monthSalesCents ?? 0)}
          />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos por categoría</span>
        </div>
        <div className="grid gap-[9px] px-[22px] pt-3.5 pb-[22px]">
          {categoryBars.map((category) => (
            <div
              className="grid grid-cols-[120px_minmax(0,1fr)_36px] items-center gap-2.5 text-xs font-medium text-[var(--crm-text-secondary)] [&>div]:h-[7px] [&>div]:overflow-hidden [&>div]:rounded-full [&>div]:bg-[var(--crm-surface-soft)] [&_i]:block [&_i]:h-full [&_i]:rounded-[inherit] [&_i]:bg-[var(--crm-blue)]"
              key={category.id}
            >
              <span>{category.name}</span>
              <div>
                <i
                  style={{
                    width: `${Math.max(8, (category.count / maxCategoryCount) * 100)}%`,
                  }}
                />
              </div>
              <strong>{category.count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  );
}

function OpenCashSessionsList({
  selectedVenueId,
  showAll,
  stats,
}: {
  selectedVenueId: string;
  showAll: boolean;
  stats: CrmStats | null;
}) {
  const sessions = (stats?.openCashSessions ?? []).filter(
    (session) => showAll || session.venueId === selectedVenueId,
  );
  const totalOpenSalesCents = sessions.reduce(
    (total, session) => total + session.salesCents,
    0,
  );

  if (!stats) {
    return <EmptyList message="Cargando cajas abiertas." />;
  }

  if (!sessions.length) {
    return (
      <EmptyList
        message={
          showAll
            ? "No hay cajas abiertas."
            : "No hay cajas abiertas en el local seleccionado."
        }
      />
    );
  }

  return (
    <div className="grid gap-3 px-[22px] pt-3 pb-[22px]">
      <div className="!flex !min-h-[62px] !flex-col !items-start !justify-between !gap-3 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-green-soft)] !px-4 !py-3 md:!flex-row md:!items-center">
        <span>
          {sessions.length === 1
            ? "1 caja abierta"
            : `${sessions.length} cajas abiertas`}
        </span>
        <strong>{formatMoney(totalOpenSalesCents)}</strong>
      </div>
      <div className="grid gap-2">
        {sessions.map((session) => (
          <div
            className="!grid !grid-cols-2 !items-center !gap-3.5 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !py-[13px] md:!grid-cols-[minmax(0,1fr)_repeat(3,minmax(80px,max-content))] xl:!grid-cols-[minmax(210px,1fr)_minmax(104px,0.32fr)_minmax(78px,0.2fr)_minmax(92px,0.26fr)_minmax(240px,0.8fr)]"
            key={session.id}
          >
            <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] !col-span-full md:!col-span-1">
              <strong>{session.deviceName}</strong>
              <span>{`${session.venueName} - abierta ${formatCrmDateTime(session.openedAt)}`}</span>
            </div>
            <div className="grid gap-[3px] [&_span]:text-[11px] [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
              <span>Facturado</span>
              <strong>{formatMoney(session.salesCents)}</strong>
            </div>
            <div className="grid gap-[3px] [&_span]:text-[11px] [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
              <span>Tickets</span>
              <strong>{session.ticketCount}</strong>
            </div>
            <div className="grid gap-[3px] [&_span]:text-[11px] [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
              <span>Fondo</span>
              <strong>{formatMoney(session.openingFloatCents)}</strong>
            </div>
            <div className="!col-span-full !flex !min-w-0 !flex-wrap !justify-start !gap-[5px] xl:!col-span-1 xl:!justify-end">
              <span>{`${paymentLabels.cash}: ${formatMoney(session.cashCents)}`}</span>
              <span>{`${paymentLabels.card}: ${formatMoney(session.cardCents)}`}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const kpiColorClasses = {
  blue: {
    card: "!bg-[var(--crm-blue)]",
    label: "!text-white/85",
    value: "!text-white",
  },
  green: {
    card: "!bg-[var(--crm-green)]",
    label: "!text-white/85",
    value: "!text-white",
  },
  neutral: {
    card: "!bg-[var(--crm-surface-soft)]",
    label: "!text-[var(--crm-text-secondary)]",
    value: "!text-[var(--crm-text)]",
  },
} as const;

export function KpiCard({
  color,
  label,
  value,
}: {
  color: keyof typeof kpiColorClasses;
  label: string;
  value: number | string;
}) {
  const colorClasses = kpiColorClasses[color];

  return (
    <div
      className={`!flex !min-h-[126px] !flex-col !items-start !justify-end !rounded-[18px] !border-0 !p-[22px] !text-left md:!min-h-[150px] ${colorClasses.card}`}
    >
      <strong
        className={`!text-[26px] !leading-none !font-bold !tracking-[-0.04em] !tabular-nums ${colorClasses.value}`}
      >
        {value}
      </strong>
      <span className={`!mt-[9px] !text-xs !font-medium ${colorClasses.label}`}>
        {label}
      </span>
    </div>
  );
}

export function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-surface-soft)] p-2.5 [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-secondary)] [&_strong]:whitespace-nowrap [&_strong]:text-[15px] [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] !flex !min-h-[52px] !min-w-0 !items-center !justify-between !gap-3 !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !py-[11px]">
      <span className="!text-xs !font-medium !text-[var(--crm-text-secondary)]">
        {label}
      </span>
      <strong className="!text-[15px] !font-semibold !whitespace-nowrap !text-[var(--crm-text)] !tabular-nums">
        {value}
      </strong>
    </div>
  );
}
