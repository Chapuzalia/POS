import { AlertTriangle, Ban, CheckCircle2, Coins, LoaderCircle } from 'lucide-react'
import { useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { cashlogyActiveStatuses, cashlogyCancellableStatuses } from '../cashlogy/cashlogyPolling'
import { useCashlogyStore } from '../cashlogy/useCashlogyStore'
import type { CashlogyLevel, CashlogyTransaction, CashlogyTransactionStatus } from '../types'

const statusLabels: Record<CashlogyTransactionStatus, string> = {
  queued: 'Preparando Cashlogy',
  connecting: 'Conectando con Cashlogy',
  initializing: 'Preparando Cashlogy',
  starting_acceptance: 'Iniciando admisión',
  waiting_for_cash: 'Introduce el efectivo',
  finalizing_acceptance: 'Finalizando admisión',
  dispensing_change: 'Devolviendo cambio',
  processing: 'Procesando resultado',
  completed: 'Cobro completado',
  cancelled: 'Cobro cancelado',
  failed: 'Cobro fallido',
  unknown: 'Resultado desconocido',
  needs_attention: 'Revisión manual necesaria',
}

export function CashlogyPaymentModal({ finalizeDisabled, onFinalizeRecovered }: { finalizeDisabled?: boolean; onFinalizeRecovered: (transaction: CashlogyTransaction) => Promise<void> | void }) {
  const [isFinalizing, setIsFinalizing] = useState(false)
  const state = useCashlogyStore(useShallow((value) => ({
    modalOpen: value.modalOpen,
    intent: value.intent,
    transaction: value.transaction,
    levels: value.levels,
    error: value.error,
    isStarting: value.isStarting,
    isPolling: value.isPolling,
    isCancelling: value.isCancelling,
    cancel: value.cancel,
    recover: value.recover,
    hide: value.hide,
    discardForRetry: value.discardForRetry,
  })))
  const acceptedCents = (state.transaction?.automaticAcceptedCents ?? 0) + (state.transaction?.manualAcceptedCents ?? 0)

  if (!state.modalOpen || !state.intent) return null

  const status = state.transaction?.status
  const active = status ? cashlogyActiveStatuses.has(status) : state.isStarting || state.isPolling
  const critical = status === 'unknown' || status === 'needs_attention'
  const startFailed = !state.transaction && Boolean(state.error) && !state.isStarting && !state.isPolling
  const canCancel = Boolean(status && cashlogyCancellableStatuses.has(status) && !state.isCancelling)

  const finalizeRecovered = async () => {
    if (!state.transaction || isFinalizing) return
    setIsFinalizing(true)
    try {
      await onFinalizeRecovered(state.transaction)
    } finally {
      setIsFinalizing(false)
    }
  }

  return <AppModal dismissDisabled label="Cobro Cashlogy" maxWidth={520} onClose={state.hide}>
    <section className="w-full p-6">
      <div className={`flex items-start gap-3 rounded-[var(--radius)] border p-4 ${critical ? 'border-red-500 bg-red-500/10' : 'border-[var(--separator)] bg-[var(--background)]'}`}>
        {critical ? <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
          : status === 'completed' ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
            : status === 'cancelled' || status === 'failed' || startFailed ? <Ban className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
              : <LoaderCircle className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-[var(--accent)]" />}
        <div>
          <h2 className="text-xl font-black">{state.isCancelling
            ? 'Cancelando cobro…'
            : status
              ? statusLabels[status]
              : startFailed
                ? 'No se pudo iniciar el cobro'
                : state.isStarting
                  ? 'Conectando con Cashlogy…'
                  : 'Recuperando operación'}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">
            {critical
              ? 'No repitas el cobro. Comprueba físicamente la máquina y revisa la operación con el responsable de caja.'
              : startFailed
                ? 'Revisa el mensaje de error antes de volver al pago.'
              : status === 'waiting_for_cash'
                ? 'Introduce billetes y monedas en Cashlogy. Puedes cancelar el cobro o volver al TPV.'
                : state.isStarting
                  ? 'Espera mientras se comprueba la máquina. El cobro ya está bloqueado para evitar duplicados.'
                  : 'Puedes volver al TPV; el cobro seguirá controlado y podrás consultar su estado de nuevo.'}
          </p>
        </div>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <Metric label="Importe solicitado" value={formatMoney(state.intent.amountCents)} />
        <Metric label="Efectivo aceptado" value={formatMoney(acceptedCents)} />
        {state.transaction?.returnedCents !== null && state.transaction?.returnedCents !== undefined
          ? <Metric label="Cambio devuelto" value={formatMoney(state.transaction.returnedCents)} />
          : null}
        {state.transaction?.netPaidCents !== null && state.transaction?.netPaidCents !== undefined
          ? <Metric label="Neto pagado" value={formatMoney(state.transaction.netPaidCents)} />
          : null}
      </div>

      <RecyclerLevels levels={state.levels} />

      {state.error ? <div className="mt-4 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm">
        <p className="font-bold text-red-700 dark:text-red-300">{state.error.message}</p>
        <p className="mt-1 font-mono text-xs text-[var(--muted)]">{state.error.code}{state.error.originalCode ? ` · ${state.error.originalCode}` : ''}</p>
      </div> : null}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {active ? <Button onClick={state.hide} variant="tertiary">Volver al TPV</Button> : null}
        {canCancel ? <Button disabled={state.isCancelling} onClick={() => void state.cancel().catch(() => undefined)} variant="danger">
          {state.isCancelling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          Cancelar cobro
        </Button> : null}
        {status === 'completed' && state.transaction ? <Button disabled={finalizeDisabled || isFinalizing} onClick={() => void finalizeRecovered()} variant="primary">
          {isFinalizing ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
          {isFinalizing ? 'Registrando venta…' : 'Aplicar cobro confirmado'}
        </Button> : null}
        {status === 'cancelled' ? <Button onClick={state.discardForRetry}>Volver al pago</Button> : null}
        {status === 'failed' ? <Button onClick={state.discardForRetry} variant="primary">Iniciar un nuevo intento</Button> : null}
        {startFailed ? <Button onClick={state.discardForRetry} variant="primary">Volver al pago</Button> : null}
        {critical ? <>
          <Button disabled={state.isPolling} onClick={() => void state.recover().catch(() => undefined)} variant="primary">
            {state.isPolling ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
            Consultar estado de nuevo
          </Button>
          <Button onClick={state.hide} variant="tertiary">Cerrar y revisar Cashlogy</Button>
        </> : null}
      </div>
    </section>
  </AppModal>
}

function RecyclerLevels({ levels }: { levels: CashlogyLevel[] }) {
  const relevant = levels.filter((level) => level.state !== 'ok' || level.percentage !== null)
  if (!relevant.length) return null
  return <div className="mt-4 rounded-[var(--radius)] border border-[var(--separator)] p-4"><h3 className="font-black">Niveles</h3><div className="mt-2 flex flex-wrap gap-2">{relevant.map((level) => <span className={`rounded-full px-3 py-1 text-xs font-bold ${level.state === 'ok' ? 'bg-emerald-500/10 text-emerald-700' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`} key={level.index}><Coins className="mr-1 inline h-3.5 w-3.5" />{formatMoney(level.valueCents)} · {level.state}{level.percentage !== null ? ` · ${level.percentage}%` : ''}</span>)}</div></div>
}
