import { AlertTriangle, Ban, CheckCircle2, LoaderCircle } from 'lucide-react'
import { Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import type { CashlogyError } from '../cashlogy/cashlogyError'
import type { CashlogyCashManagementOperation, CashlogyCashManagementStatus, CashlogyCashManagementType } from '../types'

const statusLabels: Record<CashlogyCashManagementStatus, string> = {
  starting: 'Preparando Cashlogy',
  accepting: 'Introduce efectivo',
  finalizing_acceptance: 'Finalizando entrada',
  awaiting_dispense: 'Selecciona las denominaciones',
  dispensing: 'Entregando efectivo',
  processing: 'Procesando resultado',
  completed: 'Operación completada',
  cancelled: 'Operación cancelada',
  failed: 'Operación fallida',
  unknown: 'Resultado desconocido',
  needs_attention: 'Revisión manual necesaria',
}

const typeLabels: Record<CashlogyCashManagementType, string> = {
  refill: 'Rellenar Cashlogy',
  give_change: 'Dar cambio',
  withdraw: 'Retirar efectivo',
  empty: 'Vaciar Cashlogy',
  remove_stacker: 'Retirar stacker',
}

export function CashlogyOperationStatus({
  error,
  isCancelling,
  isPending,
  operation,
  type,
}: {
  error: CashlogyError | null
  isCancelling?: boolean
  isPending: boolean
  operation: CashlogyCashManagementOperation | null
  type: CashlogyCashManagementType
}) {
  const critical = operation?.status === 'unknown' || operation?.status === 'needs_attention' || (!operation && Boolean(error))
  const completed = operation?.status === 'completed'
  const stopped = operation?.status === 'cancelled' || operation?.status === 'failed'
  const title = isCancelling ? 'Cancelando operación…' : operation ? statusLabels[operation.status] : isPending ? 'Iniciando operación…' : 'Recuperando operación'

  return <div className="grid gap-4">
    <div className={`flex items-start gap-3 rounded-[var(--radius)] border p-4 ${critical ? 'border-red-500/50 bg-red-500/10' : 'border-[var(--separator)] bg-[var(--background)]'}`}>
      {critical ? <AlertTriangle className="mt-0.5 h-6 w-6 shrink-0 text-red-600" />
        : completed ? <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-emerald-600" />
          : stopped ? <Ban className="mt-0.5 h-6 w-6 shrink-0 text-amber-600" />
            : <LoaderCircle className="mt-0.5 h-6 w-6 shrink-0 animate-spin text-[var(--accent)]" />}
      <div className="min-w-0">
        <p className="text-xs font-black uppercase text-[var(--accent)]">{typeLabels[type]}</p>
        <h3 className="text-xl font-black">{title}</h3>
        <p className="mt-1 text-sm text-[var(--muted)]">
          {isCancelling
            ? 'Espera a que Cashlogy confirme la cancelación antes de iniciar otra operación.'
            : critical
            ? 'No repitas la operación. Comprueba físicamente el efectivo y consulta de nuevo con el mismo requestId.'
            : type === 'remove_stacker' && !completed
              ? 'Retira el stacker de Cashlogy y vuelve a colocarlo para continuar.'
              : operation?.status === 'accepting'
                ? 'Cashlogy está contando el efectivo introducido.'
                : 'Puedes volver al TPV; la operación seguirá controlada y podrás abrirla de nuevo para consultar su estado.'}
        </p>
      </div>
    </div>

    {operation ? <div className="grid gap-3 sm:grid-cols-3">
      {operation.acceptedCents !== null ? <Metric label="Efectivo introducido" value={formatMoney(operation.acceptedCents)} /> : null}
      {operation.requestedAmountCents !== null ? <Metric label="Importe solicitado" value={formatMoney(operation.requestedAmountCents)} /> : null}
      {operation.dispensedCents !== null ? <Metric label="Importe entregado" value={formatMoney(operation.dispensedCents)} /> : null}
    </div> : null}

    {operation?.type === 'empty' && operation.stackerCollectionRequired ? <p className="rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-3 text-sm font-semibold">Cashlogy confirma que también debe retirarse el efectivo enviado al stacker.</p> : null}

    {error ? <div className="rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-3 text-sm" role="alert">
      <p className="font-bold text-red-700 dark:text-red-300">{error.message}</p>
      <p className="mt-1 font-mono text-xs text-[var(--muted)]">{error.code}{error.originalCode ? ` · ${error.originalCode}` : ''}</p>
    </div> : null}
  </div>
}
