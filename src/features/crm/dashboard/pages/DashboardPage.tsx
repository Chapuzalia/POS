import { Checkbox as UiCheckbox } from "../../../../components/ui/Checkbox";
import { Button as UiButton } from "../../../../components/ui/Button";
import { EmptyList } from "../../shared/components/EmptyList";
import { RefreshCw, Coins, CreditCard } from "lucide-react";
import { TopProductsList } from "../../analytics/pages/StatsPage";
import { formatMoney } from "../../../../lib/format";
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
            <div className="!col-span-full grid w-full min-w-0 grid-cols-[minmax(0,1fr)_repeat(2,minmax(72px,max-content))] items-center gap-3.5 xl:!col-span-4">
              <div className="grid min-w-0 gap-[3px] [&_strong]:truncate [&_strong]:text-lg [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_span]:truncate [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)]">
                <strong>{session.venueName}</strong>
                <span>{`${session.deviceName} - abierta ${formatCrmDateTime(session.openedAt)}`}</span>
              </div>
              <div className="grid gap-[3px] [&_span]:text-[11px] [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
                <span>Facturado</span>
                <strong>{formatMoney(session.salesCents)}</strong>
              </div>
              <div className="grid gap-[3px] [&_span]:text-[11px] [&_span]:font-medium [&_span]:text-[var(--crm-text-muted)] [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:tabular-nums [&_strong]:text-[var(--crm-text)]">
                <span>Tickets</span>
                <strong>{session.ticketCount}</strong>
              </div>
            </div>
            <div className="!col-span-full !flex !min-w-0 !flex-wrap justify-center !gap-[5px] xl:!col-span-1 xl:!justify-end">
              <span className="rounded-full flex flex-row gap-1 bg-[var(--crm-green-soft)] px-4 py-1"><Coins />{`${formatMoney(session.cashCents)}`}</span>
              <span className="rounded-full flex flex-row gap-1 bg-[var(--crm-green-soft)] px-4 py-1"><CreditCard />{`${formatMoney(session.cardCents)}`}</span>
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
