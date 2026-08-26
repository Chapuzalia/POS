import { Input as UiInput } from '../../../../components/ui/Input'
import { Button as UiButton } from '../../../../components/ui/Button'
import { KpiCard } from '../../dashboard/pages/DashboardPage'
import { RefreshCw } from 'lucide-react'
import { useState } from 'react'
import { formatMoney } from '../../../../lib/format'
import { getOperationalDateKey } from '../../../../lib/operationalDay'
import { paymentLabels } from '../../sales/services/salesReportModel'
import { type CrmStats } from '../../../../types'
import { HourlySalesChart } from '../components/HourlySalesChart'
import { SalesBreakdownChart } from '../components/SalesBreakdownChart'

export type StatsCrmProps = {
  dayChangeTime: string | null
  disabled: boolean
  onRefresh: (monthKey: string) => Promise<void>
  stats: CrmStats | null
  timeZone: string
}

export function StatsCrm({ dayChangeTime, disabled, onRefresh, stats: loadedStats, timeZone }: StatsCrmProps) {
  const currentMonthKey = getOperationalDateKey(new Date(), { dayChangeTime, timeZone }).slice(0, 7)
  const [selectedMonthKey, setSelectedMonthKey] = useState(currentMonthKey)
  const stats = loadedStats?.monthKey === selectedMonthKey ? loadedStats : null

  const selectMonth = (monthKey: string) => {
    if (!monthKey || monthKey === selectedMonthKey) return
    setSelectedMonthKey(monthKey)
    void onRefresh(monthKey)
  }

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)] !col-span-full">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !flex-col !items-stretch !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] sm:!flex-row sm:!items-center md:!px-[22px]">
          <span>Ventas del mes</span>
          <div className="!flex !items-center !gap-2">
            <label className="!sr-only" htmlFor="stats-month">Mes de las estadísticas</label>
            <UiInput
              className="h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-[var(--crm-text-muted)] focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] [&:is(textarea)]:h-auto [&:is(textarea)]:min-h-[88px] [&:is(textarea)]:resize-y [&:is(textarea)]:py-[11px] !min-h-10 !w-full !min-w-0 !rounded-[10px] !px-3 !text-sm !font-semibold sm:!w-auto"
              disabled={disabled}
              id="stats-month"
              max={currentMonthKey}
              onChange={(event) => selectMonth(event.target.value)}
              type="month"
              value={selectedMonthKey}
            />
            <UiButton aria-label="Actualizar estadísticas" className="inline-flex size-9 min-h-9 min-w-9 items-center justify-center gap-2 rounded-[9px] border-0 bg-[var(--crm-surface-soft)] p-0 text-[var(--crm-text-secondary)] shadow-none transition-[background-color,color,transform] duration-150 hover:bg-[var(--crm-surface-hover)] hover:text-[var(--crm-text)] !inline-flex !size-10 !min-h-10 !min-w-10 !shrink-0 !items-center !justify-center !gap-[7px] !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[13px] !font-semibold !text-[var(--crm-text-muted)] !shadow-none !transition-[background-color,color,box-shadow,transform] !duration-150" disabled={disabled} onClick={() => void onRefresh(selectedMonthKey)} type="button">
              <RefreshCw className="h-4 w-4" />
            </UiButton>
          </div>
        </div>
        <div className="!grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <KpiCard color="green" label="Ventas" value={formatMoney(stats?.monthSalesCents ?? 0)} />
          <KpiCard color="blue" label="Tickets" value={stats?.monthTicketCount ?? 0} />
          <KpiCard color="neutral" label="Ticket medio" value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <KpiCard color="neutral" label="Descuentos hechos" value={formatMoney(stats?.discountsCents ?? 0)} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !col-span-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-3 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <div>
            <span>Actividad por hora</span>
            <p className="!mt-1 !text-xs !font-medium !text-[var(--crm-text-muted)]">Acumulado del mes por hora local del establecimiento</p>
          </div>
        </div>
        <HourlySalesChart points={stats?.hourlySales ?? []} />
      </section>

      <section className=" pt-4 min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !col-span-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <SalesBreakdownChart stats={stats} />
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <span>Por método de pago</span>
        </div>
        <PaymentBreakdown stats={stats} />
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="flex min-h-11 items-center justify-between gap-2.5 border-b border-[var(--crm-border-subtle)] px-4 py-3 text-[var(--crm-text)] [&_h2]:m-0 [&_p]:m-0 [&_p]:mt-1 [&_p]:text-xs [&_p]:font-medium [&_p]:text-[var(--crm-text-muted)] !flex !min-h-[60px] !items-center !justify-between !gap-3 !border-0 !bg-transparent !px-[18px] !pt-[18px] !pb-2 !text-base !font-bold !text-[var(--crm-text)] md:!px-[22px]">
          <div>
            <span>Productos top</span>
            <p className="!mt-1 !text-xs !font-medium !text-[var(--crm-text-muted)]">Desglosados por mixer y modificadores</p>
          </div>
        </div>
        <TopProductCombinationsList stats={stats} />
      </section>
    </div>
  )
}

export function PaymentBreakdown({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.byPayment ?? []).map((payment) => (
        <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-surface-soft)] px-[13px] py-[11px] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-0.5 [&_span]:text-xs [&_span]:font-medium [&_span]:text-[var(--crm-text-secondary)] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_b]:whitespace-nowrap [&_b]:text-[15px] [&_b]:font-semibold [&_b]:tabular-nums [&_b]:text-[var(--crm-text)]" key={payment.method}>
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
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-surface-soft)] px-[13px] py-[11px] [&>span]:grid [&>span]:size-[30px] [&>span]:shrink-0 [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[var(--crm-blue-soft)] [&>span]:text-xs [&>span]:font-semibold [&>span]:text-[var(--crm-blue)] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-0.5 [&_small]:text-xs [&_small]:font-medium [&_small]:text-[var(--crm-text-secondary)] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_b]:whitespace-nowrap [&_b]:text-[15px] [&_b]:font-semibold [&_b]:tabular-nums [&_b]:text-[var(--crm-text)]" key={product.productName}>
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

function TopProductCombinationsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.topProductCombinations ?? []).map((product, index) => (
        <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] border-0 bg-[var(--crm-surface-soft)] px-[13px] py-[11px] [&>span]:grid [&>span]:size-[30px] [&>span]:shrink-0 [&>span]:place-items-center [&>span]:rounded-[9px] [&>span]:bg-[var(--crm-blue-soft)] [&>span]:text-xs [&>span]:font-semibold [&>span]:text-[var(--crm-blue)] [&>div]:grid [&>div]:min-w-0 [&>div]:gap-0.5 [&_small]:text-xs [&_small]:font-medium [&_small]:text-[var(--crm-text-secondary)] [&_strong]:truncate [&_strong]:text-sm [&_strong]:font-semibold [&_strong]:text-[var(--crm-text)] [&_b]:whitespace-nowrap [&_b]:text-[15px] [&_b]:font-semibold [&_b]:tabular-nums [&_b]:text-[var(--crm-text)] !items-start" key={JSON.stringify([product.productName, product.mixers, product.modifiers])}>
          <span>{index + 1}</span>
          <div className="!grid !min-w-0 !flex-1 !gap-1.5">
            <div className="!grid !min-w-0 !gap-0.5">
              <strong>{product.productName}</strong>
              <small>{product.quantity} uds</small>
            </div>
            {product.mixers.length || product.modifiers.length ? (
              <div className="!flex !min-w-0 !flex-wrap !gap-1">
                {product.mixers.map((mixer) => (
                  <span className="!rounded-full !bg-[var(--crm-blue-soft)] !px-2 !py-1 !text-[10px] !font-semibold !text-[var(--crm-blue)]" key={`mixer:${mixer}`}>
                    Mixer: {mixer}
                  </span>
                ))}
                {product.modifiers.map((modifier) => (
                  <span className="!rounded-full !bg-[var(--crm-green-soft)] !px-2 !py-1 !text-[10px] !font-semibold !text-[var(--crm-green)]" key={`modifier:${modifier}`}>
                    Modificador: {modifier}
                  </span>
                ))}
              </div>
            ) : (
              <span className="!text-[10px] !font-medium !text-[var(--crm-text-muted)]">Sin mixer ni modificadores</span>
            )}
          </div>
          <b>{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}
