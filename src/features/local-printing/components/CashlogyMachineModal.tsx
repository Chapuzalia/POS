import {
  ArrowDownToLine,
  Coins,
  HandCoins,
  Layers,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Trash2,
  Vault,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { createPrintAgentClient } from '../api/printAgentClient'
import {
  denominationTotalCents,
  getDispensableDenominations,
  selectedDenominations,
  suggestCashlogyDenominations,
} from '../cashlogy/cashlogyManagement'
import { cashlogyManagementActiveStatuses } from '../cashlogy/cashlogyPolling'
import { useCashlogyManagementStore, type CashlogyManagementState } from '../cashlogy/useCashlogyManagementStore'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type {
  CashlogyAccounting,
  CashlogyDenomination,
  CashlogyDeviceError,
  CashlogyLevel,
} from '../types'
import { CashlogyDenominationSelector } from './CashlogyDenominationSelector'
import { CashlogyOperationStatus } from './CashlogyOperationStatus'

type Props = {
  canManage: boolean
  onClose: () => void
}

type View = 'overview' | 'withdraw' | 'confirm_empty' | 'confirm_stacker'

const actions = [
  { id: 'refill', title: 'Rellenar', description: 'Introduce efectivo y deja que Cashlogy determine el importe final.', icon: ArrowDownToLine },
  { id: 'give_change', title: 'Dar cambio', description: 'Introduce efectivo y elige exactamente cómo quieres recibirlo.', icon: HandCoins },
  { id: 'withdraw', title: 'Retirar efectivo', description: 'Selecciona unidades disponibles por denominación.', icon: Vault },
  { id: 'empty', title: 'Vaciar Cashlogy', description: 'Retira el efectivo gestionado mediante el vaciado específico.', icon: Trash2 },
  { id: 'remove_stacker', title: 'Retirar stacker', description: 'Sigue la intervención física indicada por Cashlogy.', icon: Layers },
] as const

export function CashlogyMachineModal({ canManage, onClose }: Props) {
  const baseUrl = usePrintAgentStore((state) => state.baseUrl)
  const token = usePrintAgentStore((state) => state.token)
  const health = usePrintAgentStore((state) => state.cashlogyHealth)
  const checkHealth = usePrintAgentStore((state) => state.checkCashlogyHealth)
  const management = useCashlogyManagementStore(useShallow((state) => ({
    intent: state.intent,
    operation: state.operation,
    error: state.error,
    isStarting: state.isStarting,
    isPolling: state.isPolling,
    isMutating: state.isMutating,
    open: state.open,
    hide: state.hide,
    startRefill: state.startRefill,
    startGiveChange: state.startGiveChange,
    withdraw: state.withdraw,
    empty: state.empty,
    collectStacker: state.collectStacker,
    finalizeRefill: state.finalizeRefill,
    finalizeGiveChangeAdmission: state.finalizeGiveChangeAdmission,
    dispenseGiveChange: state.dispenseGiveChange,
    recover: state.recover,
    clearResolved: state.clearResolved,
  })))
  const openManagement = management.open
  const managementOperation = management.operation
  const managementRequestId = management.intent?.requestId
  const client = useMemo(
    () => createPrintAgentClient({ baseUrl, token }),
    [baseUrl, token],
  )
  const [accounting, setAccounting] = useState<CashlogyAccounting | null>(null)
  const [deviceErrors, setDeviceErrors] = useState<CashlogyDeviceError[]>([])
  const [loadingDashboard, setLoadingDashboard] = useState(false)
  const [dashboardError, setDashboardError] = useState<string | null>(null)
  const [view, setView] = useState<View>('overview')
  const [quantities, setQuantities] = useState<Record<number, number>>({})

  const operationActive = Boolean(management.operation && cashlogyManagementActiveStatuses.has(management.operation.status))
  const operationBusy = management.isStarting || management.isMutating || operationActive
  const ready = health?.enabled === true && health.ok === true && health.sessionState === 'ready'
  const denominationOptions = useMemo(() => {
    const live = getDispensableDenominations(accounting)
    return live.length ? live : management.intent?.denominationOptions ?? []
  }, [accounting, management.intent?.denominationOptions])
  const chosenDenominations = useMemo(() => selectedDenominations(quantities), [quantities])
  const selectedTotalCents = useMemo(() => denominationTotalCents(chosenDenominations), [chosenDenominations])

  const loadDashboard = useCallback(async () => {
    setLoadingDashboard(true)
    setDashboardError(null)
    try {
      const nextHealth = await checkHealth()
      if (!(nextHealth.enabled && nextHealth.ok && nextHealth.sessionState === 'ready')) return
      const current = useCashlogyManagementStore.getState()
      const active = current.isStarting || current.isMutating
        || Boolean(current.operation && cashlogyManagementActiveStatuses.has(current.operation.status))
      if (active) return
      const [nextAccounting, errors] = await Promise.all([
        client.getCashlogyAccounting(),
        client.getCashlogyErrors(),
      ])
      setAccounting(nextAccounting)
      setDeviceErrors(errors.errors)
    } catch (error) {
      setDashboardError(error instanceof Error ? error.message : 'No se ha podido consultar Cashlogy.')
    } finally {
      setLoadingDashboard(false)
    }
  }, [checkHealth, client])

  useEffect(() => {
    openManagement()
    void loadDashboard()
  }, [loadDashboard, openManagement])

  useEffect(() => {
    setQuantities({})
  }, [managementRequestId])

  useEffect(() => {
    if (managementOperation && !cashlogyManagementActiveStatuses.has(managementOperation.status)) void loadDashboard()
  }, [loadDashboard, managementOperation])

  function closeModal() {
    management.hide()
    onClose()
  }

  function run(action: () => Promise<unknown>) {
    void action().catch(() => undefined)
  }

  function resetToOverview() {
    setQuantities({})
    setView('overview')
  }

  function closeResolvedOperation() {
    management.clearResolved()
    resetToOverview()
  }

  const changeDenominationQuantity = useCallback((valueCents: number, quantity: number) => {
    setQuantities((current) => ({ ...current, [valueCents]: quantity }))
  }, [])

  const title = management.intent ? 'Operación Cashlogy' : view === 'withdraw'
    ? 'Retirar efectivo'
    : view === 'confirm_empty'
      ? 'Vaciar Cashlogy'
      : view === 'confirm_stacker' ? 'Retirar stacker' : 'Máquina de efectivo'

  return <AppModal label={title} maxWidth={980} onClose={closeModal}>
    <section className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-2xl font-black">{title}</h2>
            <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${ready ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
              {ready ? 'Preparada' : health?.connector?.connected ? 'Ocupada o no preparada' : 'Desconectada'}
            </span>
          </div>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {health?.device?.model || 'Cashlogy'}
            {health?.device?.serialNumber ? ` · ${health.device.serialNumber}` : ''}
          </p>
        </div>
        <Button aria-label="Cerrar" onClick={closeModal} size="sm" type="button" variant="tertiary"><X className="h-4 w-4" /></Button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
        {management.intent ? <OperationView
          accounting={accounting}
          chosenDenominations={chosenDenominations}
          denominationOptions={denominationOptions}
          management={management}
          onCloseReviewed={closeModal}
          onCloseResolved={closeResolvedOperation}
          onQuantitiesChange={changeDenominationQuantity}
          quantities={quantities}
          selectedTotalCents={selectedTotalCents}
        /> : <>
          {!canManage ? <Notice tone="warning">Estas operaciones requieren permiso para gestionar caja.</Notice> : null}
          {!ready ? <Notice tone="warning">{health?.activeTransaction
            ? 'Hay un cobro Cashlogy en curso. Termínalo antes de gestionar la máquina.'
            : health?.activeCashManagementOperation
              ? 'Cashlogy informa de otra operación de efectivo activa.'
              : 'Cashlogy no está preparada para iniciar movimientos de efectivo.'}</Notice> : null}
          {ready && !loadingDashboard && denominationOptions.length === 0 ? <Notice tone="warning">
            Cashlogy no ha devuelto denominaciones dispensables. «Dar cambio» permanecerá deshabilitado para evitar iniciar una operación que no pueda completarse.
          </Notice> : null}

          {view === 'overview' ? <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {actions.map((action) => {
              const Icon = action.icon
              return <article className="flex min-w-0 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4" key={action.id}>
                <span className="w-fit rounded-[var(--radius)] bg-[var(--accent-soft)] p-2 text-[var(--accent)]"><Icon className="h-5 w-5" /></span>
                <h3 className="mt-3 font-black">{action.title}</h3>
                <p className="mt-1 min-h-16 flex-1 text-sm text-[var(--muted)]">{action.description}</p>
                <Button
                  disabled={!canManage || !ready || operationBusy || loadingDashboard || (action.id === 'give_change' && denominationOptions.length === 0)}
                  fullWidth
                  onClick={() => {
                    if (action.id === 'refill') run(management.startRefill)
                    else if (action.id === 'give_change') run(() => management.startGiveChange(denominationOptions))
                    else if (action.id === 'withdraw') setView('withdraw')
                    else if (action.id === 'empty') setView('confirm_empty')
                    else setView('confirm_stacker')
                  }}
                  type="button"
                  variant={action.id === 'empty' ? 'dangerSoft' : 'secondary'}
                >{action.title}</Button>
              </article>
            })}
          </div> : null}

          {view === 'withdraw' ? <section className="grid gap-4">
            <p className="text-sm text-[var(--muted)]">Selecciona unidades del reciclador. Nunca se solicitarán más unidades que las indicadas como disponibles.</p>
            <CashlogyDenominationSelector
              disabled={operationBusy}
              onChange={changeDenominationQuantity}
              options={denominationOptions}
              quantities={quantities}
            />
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={operationBusy} onClick={resetToOverview} variant="tertiary">Cancelar</Button>
              <Button disabled={operationBusy || chosenDenominations.length === 0} onClick={() => run(() => management.withdraw(chosenDenominations))} variant="danger">Retirar {formatMoney(selectedTotalCents)}</Button>
            </div>
          </section> : null}

          {view === 'confirm_empty' ? <Confirmation
            confirmLabel="Vaciar Cashlogy"
            description="Esta operación retirará el efectivo gestionado por Cashlogy. Parte del efectivo puede entregarse físicamente y parte puede quedar en el stacker."
            disabled={operationBusy}
            onCancel={resetToOverview}
            onConfirm={() => run(management.empty)}
          /> : null}

          {view === 'confirm_stacker' ? <Confirmation
            confirmLabel="Iniciar retirada de stacker"
            description="La petición puede permanecer abierta mientras retiras el stacker y vuelves a colocarlo. No cierres esta pantalla durante la intervención."
            disabled={operationBusy}
            onCancel={resetToOverview}
            onConfirm={() => run(management.collectStacker)}
          /> : null}

          {management.error ? <Notice tone="danger">{management.error.message}</Notice> : null}
          {dashboardError ? <Notice tone="danger">{dashboardError}</Notice> : null}

          <AccountingPanel
            accounting={accounting}
            deviceErrors={deviceErrors}
            disabled={operationBusy || !ready}
            loading={loadingDashboard}
            onRefresh={() => void loadDashboard()}
          />
        </>}
      </div>
    </section>
  </AppModal>
}

type OperationViewProps = {
  accounting: CashlogyAccounting | null
  chosenDenominations: ReturnType<typeof selectedDenominations>
  denominationOptions: ReturnType<typeof getDispensableDenominations>
  management: Pick<CashlogyManagementState,
    | 'intent' | 'operation' | 'error' | 'isStarting' | 'isPolling' | 'isMutating'
    | 'finalizeRefill' | 'finalizeGiveChangeAdmission' | 'dispenseGiveChange' | 'recover'>
  onCloseReviewed: () => void
  onCloseResolved: () => void
  onQuantitiesChange: (valueCents: number, quantity: number) => void
  quantities: Record<number, number>
  selectedTotalCents: number
}

function OperationView(props: OperationViewProps) {
  const { denominationOptions, management, onQuantitiesChange, quantities } = props
  const operation = management.operation
  const type = management.intent!.type
  const active = Boolean(operation && cashlogyManagementActiveStatuses.has(operation.status))
  const critical = operation?.status === 'unknown' || operation?.status === 'needs_attention' || (!operation && Boolean(management.error))
  const busy = management.isStarting || management.isMutating
  const acceptedCents = operation?.acceptedCents ?? 0

  useEffect(() => {
    if (operation?.type !== 'give_change' || operation.status !== 'awaiting_dispense' || acceptedCents <= 0) return
    if (Object.values(quantities).some((quantity) => quantity > 0)) return
    const suggestion = suggestCashlogyDenominations(denominationOptions, acceptedCents)
    for (const denomination of suggestion) {
      onQuantitiesChange(denomination.valueCents, denomination.quantity)
    }
  }, [acceptedCents, denominationOptions, onQuantitiesChange, operation?.id, operation?.status, operation?.type, quantities])

  return <section className="grid gap-5">
    <CashlogyOperationStatus error={management.error} isPending={busy || management.isPolling} operation={operation} type={type} />

    {type === 'refill' && operation?.status === 'accepting' ? <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={props.onCloseReviewed} variant="tertiary">Volver al TPV</Button>
      <Button disabled={busy} onClick={() => void management.finalizeRefill().catch(() => undefined)} size="lg" variant="primary">
        {management.isMutating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} Detener y finalizar reposición
      </Button>
    </div> : null}

    {type === 'give_change' && operation?.status === 'accepting' ? <div className="flex flex-wrap justify-end gap-2">
      <Button onClick={props.onCloseReviewed} variant="tertiary">Volver al TPV</Button>
      <Button disabled={busy || acceptedCents <= 0} onClick={() => void management.finalizeGiveChangeAdmission().catch(() => undefined)} size="lg" variant="primary">
        {management.isMutating ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null} Cerrar entrada y elegir cambio
      </Button>
    </div> : null}

    {type === 'give_change' && operation?.status === 'awaiting_dispense' ? <div className="grid gap-4">
      <div>
        <h3 className="text-lg font-black">¿Cómo quieres recibir {formatMoney(acceptedCents)}?</h3>
        <p className="text-sm text-[var(--muted)]">La selección debe sumar exactamente el efectivo admitido.</p>
      </div>
      <CashlogyDenominationSelector
        disabled={busy}
        onChange={props.onQuantitiesChange}
        options={props.denominationOptions}
        quantities={props.quantities}
        targetCents={acceptedCents}
      />
      <Button
        disabled={busy || props.chosenDenominations.length === 0 || props.selectedTotalCents !== acceptedCents}
        fullWidth
        onClick={() => void management.dispenseGiveChange(props.chosenDenominations).catch(() => undefined)}
        size="lg"
        variant="primary"
      >Entregar cambio</Button>
      <Button onClick={props.onCloseReviewed} variant="tertiary">Volver al TPV</Button>
    </div> : null}

    {active && !critical && !['accepting', 'awaiting_dispense'].includes(operation?.status ?? '') ? <div className="flex justify-end">
      <Button onClick={props.onCloseReviewed} variant="tertiary">Volver al TPV</Button>
    </div> : null}

    {critical ? <div className="flex flex-wrap justify-end gap-2">
      <Button disabled={management.isPolling || management.isMutating} onClick={() => void management.recover().catch(() => undefined)} variant="primary">
        {management.isPolling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Consultar estado de nuevo
      </Button>
      <Button onClick={props.onCloseReviewed} variant="tertiary">Cerrar y revisar Cashlogy</Button>
    </div> : null}

    {operation && !active && !critical ? <div className="flex justify-end">
      <Button onClick={props.onCloseResolved} variant="primary">Cerrar operación y actualizar</Button>
    </div> : null}

    {!operation && !critical ? <p className="text-center text-sm text-[var(--muted)]">Esperando la identificación de la operación por el backend…</p> : null}
    {props.accounting && active ? <p className="text-center text-xs text-[var(--muted)]">La contabilidad se actualizará al terminar la operación.</p> : null}
  </section>
}

function Confirmation({ confirmLabel, description, disabled, onCancel, onConfirm }: {
  confirmLabel: string
  description: string
  disabled: boolean
  onCancel: () => void
  onConfirm: () => void
}) {
  return <section className="rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-5">
    <div className="flex gap-3"><ShieldAlert className="h-6 w-6 shrink-0 text-red-600" /><div><h3 className="text-lg font-black">Confirmación necesaria</h3><p className="mt-1 text-sm text-[var(--muted)]">{description}</p></div></div>
    <div className="mt-5 flex flex-wrap justify-end gap-2"><Button disabled={disabled} onClick={onCancel} variant="tertiary">Cancelar</Button><Button disabled={disabled} onClick={onConfirm} variant="danger">{confirmLabel}</Button></div>
  </section>
}

function Notice({ children, tone }: { children: React.ReactNode; tone: 'warning' | 'danger' }) {
  return <div className={`mb-4 flex gap-3 rounded-[var(--radius)] border p-4 text-sm ${tone === 'danger' ? 'border-red-500/40 bg-red-500/10 text-red-800 dark:text-red-200' : 'border-amber-500/40 bg-amber-500/10 text-amber-800 dark:text-amber-200'}`}>
    <ShieldAlert className="h-5 w-5 shrink-0" /><p>{children}</p>
  </div>
}

function AccountingPanel({ accounting, deviceErrors, disabled, loading, onRefresh }: {
  accounting: CashlogyAccounting | null
  deviceErrors: CashlogyDeviceError[]
  disabled: boolean
  loading: boolean
  onRefresh: () => void
}) {
  return <section aria-labelledby="cashlogy-accounting-title" className="mt-5 rounded-[var(--radius)] border border-[var(--separator)]">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--separator)] p-4">
      <div><h3 className="font-black" id="cashlogy-accounting-title">Efectivo y estado</h3><p className="mt-0.5 text-xs text-[var(--muted)]">Contabilidad confirmada por Cashlogy.</p></div>
      <Button disabled={disabled || loading} onClick={onRefresh} size="sm" variant="tertiary"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</Button>
    </div>
    <div className="grid gap-3 p-4 sm:grid-cols-3">
      <Metric label="Reciclador · disponible" value={loading && !accounting ? '…' : formatMoney(accounting?.total.recyclerTotalCents ?? 0)} />
      <Metric label="Stacker · recaudación" value={loading && !accounting ? '…' : formatMoney(accounting?.total.stackerTotalCents ?? 0)} />
      <Metric label="Total en Cashlogy" value={loading && !accounting ? '…' : formatMoney(accounting?.total.totalCents ?? 0)} />
    </div>
    <DenominationTable denominations={accounting?.denominations ?? null} loading={loading} />
    {accounting?.levels.levels.length ? <LevelList levels={accounting.levels.levels} /> : null}
    {deviceErrors.length ? <div className="border-t border-[var(--separator)] p-4"><h4 className="font-black">Avisos de Cashlogy</h4><div className="mt-2 grid gap-2">{deviceErrors.map((error) => <div className="rounded-[var(--radius)] border border-amber-500/30 bg-amber-500/10 p-3 text-sm" key={`${error.code}-${error.mainMessage}`}><p className="font-bold">{error.title || error.mainMessage || error.code}</p>{error.additionalMessage ? <p className="mt-1 text-[var(--muted)]">{error.additionalMessage}</p> : null}{error.requiresTechnicalIntervention ? <p className="mt-1 font-semibold">Requiere intervención técnica.</p> : null}</div>)}</div></div> : null}
  </section>
}

function DenominationTable({ denominations, loading }: { denominations: CashlogyAccounting['denominations'] | null; loading: boolean }) {
  const rows = [
    ...(denominations?.notes ?? []).map((item) => ({ ...item, kind: 'Billete' })),
    ...(denominations?.coins ?? []).map((item) => ({ ...item, kind: 'Moneda' })),
  ].sort((left, right) => right.valueCents - left.valueCents)
  if (loading && rows.length === 0) return <div className="flex items-center justify-center gap-2 border-t border-[var(--separator)] p-8 text-sm text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" />Consultando Cashlogy…</div>
  if (rows.length === 0) return <div className="border-t border-[var(--separator)] p-6 text-center text-sm text-[var(--muted)]">Sin desglose por denominación.</div>
  return <div className="overflow-x-auto border-t border-[var(--separator)]"><table className="w-full min-w-[600px] text-sm"><thead className="bg-[var(--background)] text-left text-xs uppercase text-[var(--muted)]"><tr><th className="px-4 py-3">Tipo</th><th className="px-4 py-3 text-right">Valor</th><th className="px-4 py-3 text-right">Reciclador</th><th className="px-4 py-3 text-right">Stacker</th><th className="px-4 py-3 text-right">Total</th></tr></thead><tbody className="divide-y divide-[var(--separator)]">{rows.map((row) => <DenominationRow key={`${row.kind}-${row.valueCents}`} row={row} />)}</tbody></table></div>
}

function DenominationRow({ row }: { row: CashlogyDenomination & { kind: string } }) {
  return <tr><td className="px-4 py-3 text-[var(--muted)]">{row.kind}</td><td className="px-4 py-3 text-right font-mono font-bold">{formatMoney(row.valueCents)}</td><td className="px-4 py-3 text-right font-mono">{row.recyclerCount}</td><td className="px-4 py-3 text-right font-mono">{row.stackerCount}</td><td className="px-4 py-3 text-right font-mono">{formatMoney(row.valueCents * (row.recyclerCount + row.stackerCount))}</td></tr>
}

function LevelList({ levels }: { levels: CashlogyLevel[] }) {
  const relevant = levels.filter((level) => level.state !== 'ok' || level.percentage !== null)
  if (!relevant.length) return null
  return <div className="border-t border-[var(--separator)] p-4"><h4 className="font-black">Niveles</h4><div className="mt-2 flex flex-wrap gap-2">{relevant.map((level) => <span className={`rounded-full px-3 py-1 text-xs font-bold ${level.state === 'ok' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`} key={level.index}><Coins className="mr-1 inline h-3.5 w-3.5" />{formatMoney(level.valueCents)} · {level.state}{level.percentage !== null ? ` · ${level.percentage}%` : ''}</span>)}</div></div>
}
