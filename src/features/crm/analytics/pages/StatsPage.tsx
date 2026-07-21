import { EmptyList } from '../../shared/components/EmptyList'
import { KpiCard } from '../../dashboard/pages/DashboardPage'
import { RefreshCw } from 'lucide-react'
import { formatMoney } from '../../../../lib/format'
import { paymentLabels } from '../../sales/services/salesReportModel'
import { type CrmStats } from '../../../../types'

export type StatsCrmProps = {
  disabled: boolean
  onRefresh: () => Promise<void>
  stats: CrmStats | null
}

export function StatsCrm({ disabled, onRefresh, stats }: StatsCrmProps) {
  return (
    <div className="crm-dashboard-grid !grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] crm-panel-span !col-span-full">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Ventas del mes</span>
          <button aria-label="Actualizar estadisticas" className="crm-icon-button !inline-flex !size-10 !min-h-10 !min-w-10 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh()} type="button">
            <RefreshCw className="h-4 w-4" />
          </button>
        </div>
        <div className="crm-kpi-strip !grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Ventas" value={formatMoney(stats?.monthSalesCents ?? 0)} />
          <KpiCard color="blue" label="Tickets" value={stats?.monthTicketCount ?? 0} />
          <KpiCard color="neutral" label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <KpiCard color="neutral" label="Descuentos hechos" value={formatMoney(stats?.discountsCents ?? 0)} />
        </div>
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Por metodo de pago</span>
        </div>
        <PaymentBreakdown stats={stats} />
      </section>

      <section className="crm-panel !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Productos top</span>
        </div>
        <TopProductsList stats={stats} />
      </section>

      <section className="crm-panel !col-span-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="crm-panel-header !flex !min-h-[60px] !items-center !justify-between !gap-3 !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold md:!px-[22px]">
          <div><span>Descuentos</span><p className="!mt-1 !text-xs !font-medium !text-[var(--crm-text-muted)]">{stats?.discountedTicketCount ?? 0} tickets con descuento</p></div>
        </div>
        <div className="!overflow-x-auto !px-[18px] !pb-[18px] md:!px-[22px] md:!pb-[22px]">
          <div className="!grid !min-w-[760px] !grid-cols-[minmax(220px,1fr)_120px_150px_150px_110px] !gap-3 !border-b !border-[var(--crm-border-subtle)] !py-3 !text-[11px] !font-semibold !uppercase !text-[var(--crm-text-muted)]">
            <span>Descuento</span><span>Aplicaciones</span><span>Total descontado</span><span>Ventas asociadas</span><span>% tickets</span>
          </div>
          {(stats?.discountApplications ?? []).map((discount) => (
            <div className="!grid !min-h-14 !min-w-[760px] !grid-cols-[minmax(220px,1fr)_120px_150px_150px_110px] !items-center !gap-3 !border-b !border-[var(--crm-border-subtle)] !text-[13px]" key={discount.id}>
              <strong>{discount.name}</strong>
              <span>{discount.applications}</span>
              <span className="!font-mono">{formatMoney(discount.discountedCents)}</span>
              <span className="!font-mono">{formatMoney(discount.netSalesCents)}</span>
              <span>{discount.ticketPercentage} %</span>
            </div>
          ))}
          {!stats?.discountApplications.length ? <EmptyList message="No hay descuentos en el periodo actual." /> : null}
        </div>
      </section>
    </div>
  )
}

export function PaymentBreakdown({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-payment-list">
      {(stats?.byPayment ?? []).map((payment) => (
        <div className="crm-payment-row" key={payment.method}>
          <div>
            <strong>{paymentLabels[payment.method]}</strong>
            <span>{payment.count} operaciones</span>
          </div>
          <b>{formatMoney(payment.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

export function TopProductsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="crm-top-list">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="crm-top-row" key={product.productName}>
          <span>{index + 1}</span>
          <div>
            <strong>{product.productName}</strong>
            <small>{product.quantity} uds</small>
          </div>
          <b>{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}
