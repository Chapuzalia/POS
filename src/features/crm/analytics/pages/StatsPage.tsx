import { RefreshCw } from 'lucide-react'
import { useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Button as UiButton } from '../../../../components/ui/Button'
import { Input as UiInput } from '../../../../components/ui/Input'
import { formatMoney } from '../../../../lib/format'
import { getOperationalDateKey } from '../../../../lib/operationalDay'
import { type CrmStats, type CrmStatsPeriod, type CrmStatsPeriodKind } from '../../../../types'
import { KpiCard } from '../../dashboard/pages/DashboardPage'
import { paymentLabels } from '../../sales/services/salesReportModel'
import { CrmSelect } from '../../shared/components/CrmSelect'
import { HourlySalesChart } from '../components/HourlySalesChart'
import { NormalizedComparisonBadge } from '../components/NormalizedComparisonBadge'
import { SalesBreakdownChart } from '../components/SalesBreakdownChart'
import {
  createCrmStatsPeriod,
  formatCrmStatsPeriod,
  getDefaultCrmStatsPeriod,
  getPreviousCrmStatsPeriod,
  isSameCrmStatsPeriod,
} from '../services/analyticsPeriod'

const periodKindOptions = [
  { label: 'Año', value: 'year' },
  { label: 'Mes', value: 'month' },
  { label: 'Día', value: 'day' },
  { label: 'Período', value: 'period' },
]

const monthOptions = [
  { label: 'Enero', value: '01' },
  { label: 'Febrero', value: '02' },
  { label: 'Marzo', value: '03' },
  { label: 'Abril', value: '04' },
  { label: 'Mayo', value: '05' },
  { label: 'Junio', value: '06' },
  { label: 'Julio', value: '07' },
  { label: 'Agosto', value: '08' },
  { label: 'Septiembre', value: '09' },
  { label: 'Octubre', value: '10' },
  { label: 'Noviembre', value: '11' },
  { label: 'Diciembre', value: '12' },
]

const periodInputClass = 'h-11 min-h-11 w-full rounded-[var(--crm-radius-sm)] border border-transparent bg-[var(--crm-input-bg)] px-3.5 text-[13px] font-medium leading-[1.4] text-[var(--crm-text)] shadow-none outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--crm-blue)] focus:shadow-[0_0_0_3px_var(--crm-blue-soft)] !min-h-10 !min-w-0 !rounded-[10px] !px-3 !text-sm !font-semibold'
const normalizedCountFormatter = new Intl.NumberFormat('es-ES', { maximumFractionDigits: 1 })
const formatComparisonMoney = (value: number) => formatMoney(Math.round(value))
const formatComparisonCount = (value: number) => normalizedCountFormatter.format(value)
const normalizePerOpenDay = (total: number, openDayCount: number) => total / Math.max(1, openDayCount)

function openNativeDatePicker(event: ReactMouseEvent<HTMLInputElement>) {
  event.currentTarget.showPicker?.()
}

export type StatsCrmProps = {
  comparisonStats: CrmStats | null
  dayChangeTime: string | null
  disabled: boolean
  onRefresh: (period: CrmStatsPeriod, comparisonPeriod?: CrmStatsPeriod) => Promise<void>
  stats: CrmStats | null
  timeZone: string
}

function PeriodSelector({
  currentDay,
  disabled,
  idPrefix,
  onChange,
  period,
}: {
  currentDay: string
  disabled: boolean
  idPrefix: string
  onChange: (period: CrmStatsPeriod) => void
  period: CrmStatsPeriod
}) {
  const selectKind = (value: string) => onChange(getDefaultCrmStatsPeriod(value as CrmStatsPeriodKind, currentDay))
  const currentYear = Number(currentDay.slice(0, 4))
  const currentMonth = currentDay.slice(5, 7)
  const selectedYear = period.startDate.slice(0, 4)
  const selectedMonth = period.startDate.slice(5, 7)
  const yearOptions = Array.from({ length: currentYear - 1999 }, (_, index) => {
    const year = String(currentYear - index)
    return { label: year, value: year }
  })
  const selectableMonthOptions = monthOptions.map((option) => ({
    ...option,
    disabled: selectedYear === String(currentYear) && option.value > currentMonth,
  }))
  const selectMonth = (year: string, month: string) => {
    const nextMonth = year === String(currentYear) && month > currentMonth ? currentMonth : month
    onChange(createCrmStatsPeriod('month', `${year}-${nextMonth}`))
  }

  return (
    <div className="!flex !min-w-0 !flex-1 !flex-wrap !items-end !gap-2">
      <div
        className={`!min-w-[132px] !flex-1 sm:!flex-none ${period.kind === 'period' ? '!basis-full sm:!basis-auto' : ''}`}
      >
        <CrmSelect
          ariaLabel="Tipo de período"
          compact
          disabled={disabled}
          onChange={selectKind}
          options={periodKindOptions}
          value={period.kind}
        />
      </div>
      {period.kind === 'year' ? (
        <div className="!min-w-[120px] !flex-1 sm:!flex-none">
          <CrmSelect
          ariaLabel="Año de las estadísticas"
          compact
          disabled={disabled}
          onChange={(value) => onChange(createCrmStatsPeriod('year', value))}
          options={yearOptions}
          value={period.startDate.slice(0, 4)}
          />
        </div>
      ) : null}
      {period.kind === 'month' ? (
        <>
          <div className="!min-w-[140px] !flex-1 sm:!flex-none">
            <CrmSelect
              ariaLabel="Mes de las estadísticas"
              compact
              disabled={disabled}
              onChange={(value) => selectMonth(selectedYear, value)}
              options={selectableMonthOptions}
              value={selectedMonth}
            />
          </div>
          <div className="!min-w-[120px] !flex-1 sm:!flex-none">
            <CrmSelect
              ariaLabel="Año del mes de las estadísticas"
              compact
              disabled={disabled}
              onChange={(value) => selectMonth(value, selectedMonth)}
              options={yearOptions}
              value={selectedYear}
            />
          </div>
        </>
      ) : null}
      {period.kind === 'day' ? (
        <UiInput
          aria-label="Día de las estadísticas"
          className={periodInputClass}
          disabled={disabled}
          id={idPrefix + '-day'}
          max={currentDay}
          onChange={(event) => {
            if (event.target.value) onChange(createCrmStatsPeriod('day', event.target.value))
          }}
          onClick={openNativeDatePicker}
          type="date"
          value={period.startDate}
        />
      ) : null}
      {period.kind === 'period' ? (
        <>
          <label className="!grid !min-w-0 !basis-[calc(50%-0.25rem)] !flex-1 !gap-1 !text-[10px] !font-bold !uppercase !tracking-wide !text-[var(--crm-text-muted)] sm:!min-w-[150px] sm:!basis-auto">
            Desde
            <UiInput
              className={periodInputClass}
              disabled={disabled}
              id={idPrefix + '-start'}
              max={currentDay}
              onChange={(event) => {
                if (!event.target.value) return
                const endDate = event.target.value > period.endDate ? event.target.value : period.endDate
                onChange(createCrmStatsPeriod('period', event.target.value, endDate))
              }}
              onClick={openNativeDatePicker}
              type="date"
              value={period.startDate}
            />
          </label>
          <label className="!grid !min-w-0 !basis-[calc(50%-0.25rem)] !flex-1 !gap-1 !text-[10px] !font-bold !uppercase !tracking-wide !text-[var(--crm-text-muted)] sm:!min-w-[150px] sm:!basis-auto">
            Hasta
            <UiInput
              className={periodInputClass}
              disabled={disabled}
              id={idPrefix + '-end'}
              max={currentDay}
              onChange={(event) => {
                if (!event.target.value) return
                const startDate = event.target.value < period.startDate ? event.target.value : period.startDate
                onChange(createCrmStatsPeriod('period', startDate, event.target.value))
              }}
              onClick={openNativeDatePicker}
              type="date"
              value={period.endDate}
            />
          </label>
        </>
      ) : null}
    </div>
  )
}

function ComparisonValueDetails({
  comparisonLabel,
  comparisonOpenDayCount,
  comparisonTotal,
  currentLabel,
  currentOpenDayCount,
  currentTotal,
  formatValue,
  normalizeByDay,
}: {
  comparisonLabel: string
  comparisonOpenDayCount: number
  comparisonTotal: number
  currentLabel: string
  currentOpenDayCount: number
  currentTotal: number
  formatValue: (value: number) => string
  normalizeByDay: boolean
}) {
  const periods = [
    { dayCount: currentOpenDayCount, label: currentLabel, total: currentTotal },
    { dayCount: comparisonOpenDayCount, label: comparisonLabel, total: comparisonTotal },
  ]

  return (
    <div className="!mt-2 !grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3">
      {periods.map((period) => (
        <div className="!grid !min-w-0 !grid-cols-[minmax(0,1fr)_auto] !items-baseline !gap-x-2 !gap-y-0.5" key={period.label}>
          <span className="!truncate !text-[10px] !font-bold !uppercase !tracking-wide !text-[var(--crm-text-muted)]">{period.label}</span>
          <strong className="!whitespace-nowrap !text-xs !font-bold !tabular-nums !text-[var(--crm-text)]">
            {formatValue(period.total)} {normalizeByDay ? 'total' : 'por ticket'}
          </strong>
          {normalizeByDay ? (
            <span className="!col-span-2 !text-[11px] !font-semibold !tabular-nums !text-[var(--crm-text-secondary)]">
              {formatValue(period.total / Math.max(1, period.dayCount))} por día abierto
            </span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

function ComparativeKpi({
  color,
  comparisonOpenDayCount,
  comparisonLabel,
  comparisonTotal,
  currentLabel,
  currentOpenDayCount,
  currentTotal,
  formatValue,
  label,
  normalizeByDay = true,
  value,
}: {
  color: 'green' | 'blue' | 'neutral'
  comparisonOpenDayCount?: number
  comparisonLabel: string
  comparisonTotal?: number
  currentLabel: string
  currentOpenDayCount: number
  currentTotal: number
  formatValue: (value: number) => string
  label: string
  normalizeByDay?: boolean
  value: number | string
}) {
  return (
    <div>
      <div className="!relative">
        <KpiCard color={color} label={label} value={value} />
        {comparisonTotal !== undefined && comparisonOpenDayCount !== undefined ? (
          <span className="!absolute !top-4 !right-4 !rounded-full !bg-white/90 !p-0.5 !shadow-sm">
            <NormalizedComparisonBadge
              comparisonLabel={comparisonLabel}
              comparisonOpenDayCount={comparisonOpenDayCount}
              comparisonTotal={comparisonTotal}
              currentOpenDayCount={currentOpenDayCount}
              currentTotal={currentTotal}
              normalizeByDay={normalizeByDay}
            />
          </span>
        ) : null}
      </div>
      {comparisonTotal !== undefined && comparisonOpenDayCount !== undefined ? (
        <ComparisonValueDetails
          comparisonLabel={comparisonLabel}
          comparisonOpenDayCount={comparisonOpenDayCount}
          comparisonTotal={comparisonTotal}
          currentLabel={currentLabel}
          currentOpenDayCount={currentOpenDayCount}
          currentTotal={currentTotal}
          formatValue={formatValue}
          normalizeByDay={normalizeByDay}
        />
      ) : null}
    </div>
  )
}

export function StatsCrm({ comparisonStats: loadedComparisonStats, dayChangeTime, disabled, onRefresh, stats: loadedStats, timeZone }: StatsCrmProps) {
  const currentDay = getOperationalDateKey(new Date(), { dayChangeTime, timeZone })
  const [selectedPeriod, setSelectedPeriod] = useState(() => getDefaultCrmStatsPeriod('month', currentDay))
  const [compareEnabled, setCompareEnabled] = useState(false)
  const [comparisonPeriod, setComparisonPeriod] = useState(() => getPreviousCrmStatsPeriod(getDefaultCrmStatsPeriod('month', currentDay)))
  const stats = isSameCrmStatsPeriod(loadedStats?.period, selectedPeriod) ? loadedStats : null
  const comparisonStats = compareEnabled && isSameCrmStatsPeriod(loadedComparisonStats?.period, comparisonPeriod)
    ? loadedComparisonStats
    : null
  const currentLabel = formatCrmStatsPeriod(selectedPeriod)
  const comparisonLabel = formatCrmStatsPeriod(comparisonPeriod)
  const operationalDayStart = dayChangeTime?.slice(0, 5) || '00:00'
  const currentOpenDayCount = stats?.period.openDayCount ?? 0
  const comparisonOpenDayCount = comparisonStats?.period.openDayCount

  const selectPeriod = (nextPeriod: CrmStatsPeriod) => {
    setSelectedPeriod(nextPeriod)
    void onRefresh(nextPeriod, compareEnabled ? comparisonPeriod : undefined)
  }

  const selectComparisonPeriod = (nextPeriod: CrmStatsPeriod) => {
    setComparisonPeriod(nextPeriod)
    void onRefresh(selectedPeriod, nextPeriod)
  }

  const toggleComparison = (checked: boolean) => {
    setCompareEnabled(checked)
    if (!checked) {
      void onRefresh(selectedPeriod)
      return
    }
    const nextComparisonPeriod = getPreviousCrmStatsPeriod(selectedPeriod)
    setComparisonPeriod(nextComparisonPeriod)
    void onRefresh(selectedPeriod, nextComparisonPeriod)
  }

  return (
    <div className="!grid !grid-cols-1 !items-start !gap-4 xl:!grid-cols-[minmax(0,1.12fr)_minmax(0,1fr)] xl:!gap-6">
      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !col-span-full !min-w-0 !overflow-visible !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="!grid !gap-4 !px-[18px] !pt-[18px] !pb-3 md:!px-[22px]">
          <div className="!flex !flex-wrap !items-center !justify-between !gap-3">
            <div>
              <h2 className="!m-0 !text-base !font-bold !text-[var(--crm-text)]">Ventas · {currentLabel}</h2>
              {compareEnabled ? <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Variaciones calculadas por día abierto.</p> : null}
            </div>
            <div className="!flex !items-center !gap-2">
              <label className="!flex !min-h-10 !cursor-pointer !items-center !gap-2 !rounded-[10px] !bg-[var(--crm-input-bg)] !px-3 !text-xs !font-bold !text-[var(--crm-text-secondary)]">
                <input
                  checked={compareEnabled}
                  className="!size-4 !accent-[var(--crm-blue)]"
                  disabled={disabled}
                  onChange={(event) => toggleComparison(event.target.checked)}
                  type="checkbox"
                />
                Comparar
              </label>
              <UiButton
                aria-label="Actualizar estadísticas"
                className="!inline-flex !size-10 !min-h-10 !min-w-10 !shrink-0 !items-center !justify-center !rounded-[10px] !border-0 !bg-transparent !p-0 !text-[var(--crm-text-muted)] !shadow-none"
                disabled={disabled}
                onClick={() => void onRefresh(selectedPeriod, compareEnabled ? comparisonPeriod : undefined)}
                type="button"
              >
                <RefreshCw className="h-4 w-4" />
              </UiButton>
            </div>
          </div>
          <PeriodSelector currentDay={currentDay} disabled={disabled} idPrefix="stats-primary" onChange={selectPeriod} period={selectedPeriod} />
          {compareEnabled ? (
            <div className="!grid !gap-2 !rounded-xl !bg-[var(--crm-surface-soft)] !p-3">
              <span className="!text-xs !font-bold !text-[var(--crm-text-secondary)]">Comparar con…</span>
              <PeriodSelector currentDay={currentDay} disabled={disabled} idPrefix="stats-comparison" onChange={selectComparisonPeriod} period={comparisonPeriod} />
              {stats && comparisonStats ? (
                <div className="!grid !grid-cols-1 !gap-1.5 !border-t !border-[var(--crm-border-subtle)] !pt-2 sm:!grid-cols-2 sm:!gap-3">
                  <span className="!text-[11px] !font-semibold !text-[var(--crm-text-secondary)]"><b className="!text-[var(--crm-text)]">{currentLabel}</b> · {currentOpenDayCount} {currentOpenDayCount === 1 ? 'día abierto' : 'días abiertos'}</span>
                  <span className="!text-[11px] !font-semibold !text-[var(--crm-text-secondary)]"><b className="!text-[var(--crm-text)]">{comparisonLabel}</b> · {comparisonOpenDayCount} {comparisonOpenDayCount === 1 ? 'día abierto' : 'días abiertos'}</span>
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="!grid !grid-cols-1 !gap-3 !px-[18px] !pt-3 !pb-[18px] md:!grid-cols-2 md:!px-[22px] md:!pt-3.5 md:!pb-[22px] lg:!grid-cols-4 lg:!gap-[18px]">
          <ComparativeKpi color="green" comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonOpenDayCount} comparisonTotal={comparisonStats?.monthSalesCents} currentLabel={currentLabel} currentOpenDayCount={currentOpenDayCount} currentTotal={stats?.monthSalesCents ?? 0} formatValue={formatComparisonMoney} label="Ventas" value={formatMoney(stats?.monthSalesCents ?? 0)} />
          <ComparativeKpi color="blue" comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonOpenDayCount} comparisonTotal={comparisonStats?.monthTicketCount} currentLabel={currentLabel} currentOpenDayCount={currentOpenDayCount} currentTotal={stats?.monthTicketCount ?? 0} formatValue={formatComparisonCount} label="Tickets" value={stats?.monthTicketCount ?? 0} />
          <ComparativeKpi color="neutral" comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonOpenDayCount} comparisonTotal={comparisonStats?.averageTicketCents} currentLabel={currentLabel} currentOpenDayCount={currentOpenDayCount} currentTotal={stats?.averageTicketCents ?? 0} formatValue={formatComparisonMoney} label="Ticket medio" normalizeByDay={false} value={formatMoney(stats?.averageTicketCents ?? 0)} />
          <ComparativeKpi color="neutral" comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonOpenDayCount} comparisonTotal={comparisonStats?.discountsCents} currentLabel={currentLabel} currentOpenDayCount={currentOpenDayCount} currentTotal={stats?.discountsCents ?? 0} formatValue={formatComparisonMoney} label="Descuentos hechos" value={formatMoney(stats?.discountsCents ?? 0)} />
        </div>
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !col-span-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="!flex !min-h-[60px] !items-center !justify-between !gap-3 !px-[18px] !pt-[18px] !pb-3 md:!px-[22px]">
          <div>
            <span className="!text-base !font-bold">Actividad por hora</span>
            <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">{compareEnabled ? 'Media por día abierto y hora local' : 'Acumulado del período por hora local'} · día operativo desde las {operationalDayStart}</p>
          </div>
        </div>
        <HourlySalesChart
          comparisonOpenDayCount={comparisonStats?.period.openDayCount}
          comparisonLabel={comparisonLabel}
          comparisonPoints={comparisonStats?.hourlySales}
          currentLabel={currentLabel}
          dayChangeTime={dayChangeTime}
          periodOpenDayCount={stats?.period.openDayCount ?? 0}
          points={stats?.hourlySales ?? []}
        />
      </section>

      <section className="pt-4 min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !col-span-full !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <SalesBreakdownChart comparisonLabel={comparisonLabel} comparisonStats={comparisonStats} stats={stats} />
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="!flex !min-h-[60px] !items-center !justify-between !gap-3 !px-[18px] !pt-[18px] !pb-2 md:!px-[22px]">
          <span className="!text-base !font-bold">Por método de pago</span>
        </div>
        <PaymentBreakdown comparisonLabel={comparisonLabel} comparisonStats={comparisonStats} currentLabel={currentLabel} stats={stats} />
      </section>

      <section className="min-w-0 overflow-hidden rounded-[var(--crm-radius-lg)] border-0 bg-[var(--crm-surface)] text-[var(--crm-text)] shadow-[var(--crm-shadow-card)] !min-w-0 !overflow-hidden !rounded-2xl !border-0 !bg-[var(--crm-surface)] !shadow-[var(--crm-shadow-card)] sm:!rounded-[var(--crm-radius-lg)]">
        <div className="!flex !min-h-[60px] !items-center !justify-between !gap-3 !px-[18px] !pt-[18px] !pb-2 md:!px-[22px]">
          <div>
            <span className="!text-base !font-bold">Productos top</span>
            <p className="!mt-1 !mb-0 !text-xs !font-medium !text-[var(--crm-text-muted)]">Desglosados por mixer y modificadores</p>
          </div>
        </div>
        <TopProductCombinationsList comparisonLabel={comparisonLabel} comparisonStats={comparisonStats} currentLabel={currentLabel} stats={stats} />
      </section>
    </div>
  )
}

export function PaymentBreakdown({ comparisonLabel, comparisonStats, currentLabel, stats }: { comparisonLabel: string; comparisonStats: CrmStats | null; currentLabel: string; stats: CrmStats | null }) {
  const currentByMethod = new Map((stats?.byPayment ?? []).map((payment) => [payment.method, payment]))
  const comparisonByMethod = new Map((comparisonStats?.byPayment ?? []).map((payment) => [payment.method, payment]))
  const methods = [...new Set([...currentByMethod.keys(), ...comparisonByMethod.keys()])]

  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {methods.map((method) => {
        const payment = currentByMethod.get(method) ?? { method, totalCents: 0, count: 0 }
        const comparison = comparisonByMethod.get(method) ?? (comparisonStats ? { method, totalCents: 0, count: 0 } : null)
        return (
          <div className="!flex !min-h-[62px] !min-w-0 !items-center !justify-between !gap-3 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-[13px] !py-[11px]" key={method}>
            <div className="!grid !min-w-0 !gap-1">
              <strong className="!truncate !text-sm !font-semibold">{paymentLabels[method]}</strong>
              <span className="!flex !flex-wrap !items-center !gap-1.5 !text-xs !font-medium !text-[var(--crm-text-secondary)]">
                {payment.count} operaciones
                {comparison && stats && comparisonStats ? (
                  <NormalizedComparisonBadge comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonStats.period.openDayCount} comparisonTotal={comparison.count} currentOpenDayCount={stats.period.openDayCount} currentTotal={payment.count} />
                ) : null}
              </span>
              {comparison && stats && comparisonStats ? (
                <small className="!text-[10px] !font-semibold !text-[var(--crm-text-muted)]">
                  {currentLabel}: {formatComparisonCount(normalizePerOpenDay(payment.count, stats.period.openDayCount))}/día abierto · {comparisonLabel}: {comparison.count} total, {formatComparisonCount(normalizePerOpenDay(comparison.count, comparisonStats.period.openDayCount))}/día abierto
                </small>
              ) : null}
            </div>
            <div className="!grid !justify-items-end !gap-1">
              <b className="!whitespace-nowrap !text-[15px] !font-semibold !tabular-nums">{formatMoney(payment.totalCents)}</b>
              {comparison && stats && comparisonStats ? (
                <NormalizedComparisonBadge comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonStats.period.openDayCount} comparisonTotal={comparison.totalCents} currentOpenDayCount={stats.period.openDayCount} currentTotal={payment.totalCents} />
              ) : null}
              {comparison && stats && comparisonStats ? (
                <small className="!max-w-52 !text-right !text-[10px] !font-semibold !text-[var(--crm-text-muted)]">
                  {currentLabel}: {formatComparisonMoney(normalizePerOpenDay(payment.totalCents, stats.period.openDayCount))}/día abierto<br />
                  {comparisonLabel}: {formatComparisonMoney(comparison.totalCents)} total · {formatComparisonMoney(normalizePerOpenDay(comparison.totalCents, comparisonStats.period.openDayCount))}/día abierto
                </small>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}

export function TopProductsList({ stats }: { stats: CrmStats | null }) {
  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.topProducts ?? []).map((product, index) => (
        <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 rounded-[var(--crm-radius-sm)] bg-[var(--crm-surface-soft)] px-[13px] py-[11px]" key={product.productName}>
          <span className="!grid !size-[30px] !shrink-0 !place-items-center !rounded-[9px] !bg-[var(--crm-blue-soft)] !text-xs !font-semibold !text-[var(--crm-blue)]">{index + 1}</span>
          <div className="!grid !min-w-0 !flex-1 !gap-0.5">
            <strong className="!truncate !text-sm !font-semibold">{product.productName}</strong>
            <small className="!text-xs !text-[var(--crm-text-secondary)]">{product.quantity} uds</small>
          </div>
          <b className="!whitespace-nowrap !text-[15px] !font-semibold !tabular-nums">{formatMoney(product.totalCents)}</b>
        </div>
      ))}
    </div>
  )
}

function TopProductCombinationsList({ comparisonLabel, comparisonStats, currentLabel, stats }: { comparisonLabel: string; comparisonStats: CrmStats | null; currentLabel: string; stats: CrmStats | null }) {
  const comparisonByCombination = new Map((comparisonStats?.topProductCombinations ?? []).map((product) => [
    JSON.stringify([product.productName, product.mixers, product.modifiers]),
    product,
  ]))

  return (
    <div className="grid gap-[9px] px-[22px] pt-3 pb-[22px]">
      {(stats?.topProductCombinations ?? []).map((product, index) => {
        const key = JSON.stringify([product.productName, product.mixers, product.modifiers])
        const comparison = comparisonByCombination.get(key) ?? (comparisonStats ? { ...product, quantity: 0, totalCents: 0 } : null)
        return (
          <div className="!flex !min-h-[62px] !min-w-0 !items-start !justify-between !gap-3 !rounded-[var(--crm-radius-sm)] !bg-[var(--crm-surface-soft)] !px-[13px] !py-[11px]" key={key}>
            <span className="!grid !size-[30px] !shrink-0 !place-items-center !rounded-[9px] !bg-[var(--crm-blue-soft)] !text-xs !font-semibold !text-[var(--crm-blue)]">{index + 1}</span>
            <div className="!grid !min-w-0 !flex-1 !gap-1.5">
              <div className="!grid !min-w-0 !gap-1">
                <strong className="!truncate !text-sm !font-semibold">{product.productName}</strong>
                <span className="!flex !flex-wrap !items-center !gap-1.5 !text-xs !text-[var(--crm-text-secondary)]">
                  {product.quantity.toLocaleString('es-ES')} uds
                  {comparison && stats && comparisonStats ? (
                    <NormalizedComparisonBadge comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonStats.period.openDayCount} comparisonTotal={comparison.quantity} currentOpenDayCount={stats.period.openDayCount} currentTotal={product.quantity} />
                  ) : null}
                </span>
                {comparison && stats && comparisonStats ? (
                  <small className="!text-[10px] !font-semibold !text-[var(--crm-text-muted)]">
                    {currentLabel}: {formatComparisonCount(normalizePerOpenDay(product.quantity, stats.period.openDayCount))}/día abierto · {comparisonLabel}: {formatComparisonCount(comparison.quantity)} total, {formatComparisonCount(normalizePerOpenDay(comparison.quantity, comparisonStats.period.openDayCount))}/día abierto
                  </small>
                ) : null}
              </div>
              {product.mixers.length || product.modifiers.length ? (
                <div className="!flex !min-w-0 !flex-wrap !gap-1">
                  {product.mixers.map((mixer) => <span className="!rounded-full !bg-[var(--crm-blue-soft)] !px-2 !py-1 !text-[10px] !font-semibold !text-[var(--crm-blue)]" key={'mixer:' + mixer}>Mixer: {mixer}</span>)}
                  {product.modifiers.map((modifier) => <span className="!rounded-full !bg-[var(--crm-green-soft)] !px-2 !py-1 !text-[10px] !font-semibold !text-[var(--crm-green)]" key={'modifier:' + modifier}>Modificador: {modifier}</span>)}
                </div>
              ) : <span className="!text-[10px] !font-medium !text-[var(--crm-text-muted)]">Sin mixer ni modificadores</span>}
            </div>
            <div className="!grid !shrink-0 !justify-items-end !gap-1">
              <b className="!whitespace-nowrap !text-[15px] !font-semibold !tabular-nums">{formatMoney(product.totalCents)}</b>
              {comparison && stats && comparisonStats ? (
                <NormalizedComparisonBadge comparisonLabel={comparisonLabel} comparisonOpenDayCount={comparisonStats.period.openDayCount} comparisonTotal={comparison.totalCents} currentOpenDayCount={stats.period.openDayCount} currentTotal={product.totalCents} />
              ) : null}
              {comparison && stats && comparisonStats ? (
                <small className="!max-w-48 !text-right !text-[10px] !font-semibold !text-[var(--crm-text-muted)]">
                  {currentLabel}: {formatComparisonMoney(normalizePerOpenDay(product.totalCents, stats.period.openDayCount))}/día abierto<br />
                  {comparisonLabel}: {formatComparisonMoney(comparison.totalCents)} total · {formatComparisonMoney(normalizePerOpenDay(comparison.totalCents, comparisonStats.period.openDayCount))}/día abierto
                </small>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
  )
}
