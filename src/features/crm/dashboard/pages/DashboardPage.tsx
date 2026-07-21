import { EmptyList } from '../../shared/components/EmptyList'
import { RefreshCw } from 'lucide-react'
import { TopProductsList } from '../../analytics/pages/StatsPage'
import { formatMoney } from '../../../../lib/format'
import { paymentLabels } from '../../sales/services/salesReportModel'
import { formatCrmDateTime } from '../../shared/formatCrmDateTime'
import { type CSSProperties } from 'react'
import { type Category, type CrmStats, type Product } from '../../../../types'

export type DashboardCrmProps = {
  activeCategories: number
  activeProducts: number
  categories: Category[]
  disabled: boolean
  onRefresh: () => Promise<void>
  products: Product[]
  stats: CrmStats | null
}

export function DashboardCrm({
  activeCategories,
  activeProducts,
  categories,
  disabled,
  onRefresh,
  products,
  stats,
}: DashboardCrmProps) {
  const categoryBars = categories.map((category) => ({
    ...category,
    count: products.filter((product) => product.categoryId === category.id).length,
  }))
  const maxCategoryCount = Math.max(1, ...categoryBars.map((category) => category.count))
  const activeRatio = products.length ? Math.round((activeProducts / products.length) * 100) : 0

  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Resumen del catalogo</span>
          <button aria-label="Actualizar resumen" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="blue" label="Productos activos" value={activeProducts} />
          <KpiCard color="neutral" label="Productos totales" value={products.length} />
          <KpiCard color="neutral" label="Categorias" value={categories.length} />
          <KpiCard color="green" label="Activas" value={activeCategories} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Cajas abiertas</span>
          <button aria-label="Actualizar cajas abiertas" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <OpenCashSessionsList stats={stats} />
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Estado de catalogo</span>
        </div>
        <div className="crm-donut-row !grid !grid-cols-1 !items-center !gap-[18px] !px-[22px] !pt-[18px] !pb-6 md:!grid-cols-[190px_minmax(0,1fr)]">
          <div className="crm-donut" style={{ '--crm-progress': `${activeRatio}%` } as CSSProperties}>
            <span>{activeRatio}%</span>
          </div>
          <div className="crm-stat-list">
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

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Actividad del mes</span>
        </div>
        <div className="crm-mini-metrics">
          <MiniMetric label="Tickets" value={String(stats?.monthTicketCount ?? 0)} />
          <MiniMetric label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <MiniMetric label="Ingresos" value={formatMoney(stats?.monthSalesCents ?? 0)} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos por categoria</span>
        </div>
        <div className="crm-horizontal-bars">
          {categoryBars.map((category) => (
            <div className="crm-bar-row" key={category.id}>
              <span>{category.name}</span>
              <div>
                <i style={{ width: `${Math.max(8, (category.count / maxCategoryCount) * 100)}%` }} />
              </div>
              <strong>{category.count}</strong>
            </div>
          ))}
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>
    </div>
  )
}

function OpenCashSessionsList({ stats }: { stats: CrmStats | null }) {
  const sessions = stats?.openCashSessions ?? []
  const totalOpenSalesCents = sessions.reduce((total, session) => total + session.salesCents, 0)

  if (!stats) {
    return <EmptyList message="Cargando cajas abiertas." />
  }

  if (!sessions.length) {
    return <EmptyList message="No hay cajas abiertas." />
  }

  return (
    <div className="crm-open-cash">
      <div className="crm-open-cash-summary !flex !min-h-[62px] !flex-col !items-start !justify-between !gap-3 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-green-soft)] !px-4 !py-3 md:!flex-row md:!items-center">
        <span>{sessions.length} cajas abiertas</span>
        <strong>{formatMoney(totalOpenSalesCents)}</strong>
      </div>
      <div className="crm-open-cash-list">
        {sessions.map((session) => (
          <div className="crm-open-cash-row !grid !grid-cols-2 !items-center !gap-3.5 !rounded-[var(--crm-radius-md)] !border-0 !bg-[var(--crm-surface-soft)] !px-3.5 !py-[13px] md:!grid-cols-[minmax(0,1fr)_repeat(3,minmax(80px,max-content))] xl:!grid-cols-[minmax(210px,1fr)_minmax(104px,0.32fr)_minmax(78px,0.2fr)_minmax(92px,0.26fr)_minmax(240px,0.8fr)]" key={session.id}>
            <div className="crm-cell-main !col-span-full md:!col-span-1">
              <strong>{session.deviceName}</strong>
              <span>{`${session.venueName} - abierta ${formatCrmDateTime(session.openedAt)}`}</span>
            </div>
            <div className="crm-open-cash-metric">
              <span>Facturado</span>
              <strong>{formatMoney(session.salesCents)}</strong>
            </div>
            <div className="crm-open-cash-metric">
              <span>Tickets</span>
              <strong>{session.ticketCount}</strong>
            </div>
            <div className="crm-open-cash-metric">
              <span>Fondo</span>
              <strong>{formatMoney(session.openingFloatCents)}</strong>
            </div>
            <div className="crm-open-cash-breakdown !col-span-full !flex !min-w-0 !flex-wrap !justify-start !gap-[5px] xl:!col-span-1 xl:!justify-end">
              <span>{`${paymentLabels.cash}: ${formatMoney(session.cashCents)}`}</span>
              <span>{`${paymentLabels.card}: ${formatMoney(session.cardCents)}`}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

const kpiColorClasses = {
  blue: {
    card: '!bg-[var(--crm-blue)]',
    label: '!text-white/85',
    value: '!text-white',
  },
  green: {
    card: '!bg-[var(--crm-green)]',
    label: '!text-white/85',
    value: '!text-white',
  },
  neutral: {
    card: '!bg-[var(--crm-surface-soft)]',
    label: '!text-[var(--crm-text-secondary)]',
    value: '!text-[var(--crm-text)]',
  },
} as const

export function KpiCard({ color, label, value }: { color: keyof typeof kpiColorClasses; label: string; value: number | string }) {
  const colorClasses = kpiColorClasses[color]

  return (
    <div className={`crm-kpi !flex !min-h-[126px] !flex-col !items-start !justify-end !rounded-[18px] !border-0 !p-[22px] !text-left md:!min-h-[150px] ${colorClasses.card}`}>
      <strong className={`!text-[26px] !leading-none !font-bold !tracking-[-0.04em] !tabular-nums ${colorClasses.value}`}>{value}</strong>
      <span className={`!mt-[9px] !text-xs !font-medium ${colorClasses.label}`}>{label}</span>
    </div>
  )
}

export function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="crm-mini-metric !flex !min-h-[52px] !min-w-0 !items-center !justify-between !gap-3 !rounded-[10px] !border-0 !bg-[var(--crm-surface-soft)] !px-[13px] !py-[11px]">
      <span className="!text-xs !font-medium !text-[var(--crm-text-secondary)]">{label}</span>
      <strong className="!text-[15px] !font-semibold !whitespace-nowrap !text-[var(--crm-text)] !tabular-nums">{value}</strong>
    </div>
  )
}
