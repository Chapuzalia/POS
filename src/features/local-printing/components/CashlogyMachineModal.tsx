import {
  ArrowDownToLine,
  Coins,
  HandCoins,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  Vault,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { AppModal, Button, Metric } from '../../../components/ui'
import { formatMoney } from '../../../lib/format'
import { createPrintAgentClient } from '../api/printAgentClient'
import { toCashlogyError } from '../cashlogy/cashlogyError'
import {
  cashlogyDangerousManagementActions,
  cashlogyManagementPresets,
  type CashlogyManagementAction,
} from '../cashlogy/cashlogyManagement'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { CashlogyDenomination, CashlogyDenominations, CashlogyTotal } from '../types'

type Props = {
  canWithdraw: boolean
  onClose: () => void
}

const actions = [
  {
    id: 'refill' as const,
    title: 'Rellenar',
    description: 'Abre Cashlogy en modo reposición para introducir el efectivo que haga falta.',
    button: 'Abrir reposición',
    icon: ArrowDownToLine,
  },
  {
    id: 'give_change' as const,
    title: 'Dar cambio',
    description: 'Abre Cashlogy para indicar el importe y elegir las denominaciones que quieres devolver.',
    button: 'Abrir cambio',
    icon: HandCoins,
  },
  {
    id: 'withdraw' as const,
    title: 'Vaciado',
    description: 'Abre la retirada de efectivo para indicar cuánto quieres sacar de la máquina.',
    button: 'Abrir retirada',
    icon: Vault,
  },
]

export function CashlogyMachineModal({ canWithdraw, onClose }: Props) {
  const agent = usePrintAgentStore(useShallow((state) => ({
    baseUrl: state.baseUrl,
    token: state.token,
    health: state.cashlogyHealth,
  })))
  const client = useMemo(
    () => createPrintAgentClient({ baseUrl: agent.baseUrl, token: agent.token }),
    [agent.baseUrl, agent.token],
  )
  const [total, setTotal] = useState<CashlogyTotal | null>(null)
  const [denominations, setDenominations] = useState<CashlogyDenominations | null>(null)
  const [loadingInventory, setLoadingInventory] = useState(true)
  const [activeAction, setActiveAction] = useState<CashlogyManagementAction | null>(null)
  const [confirmAction, setConfirmAction] = useState<CashlogyManagementAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const connected = agent.health?.connector?.connected === true
  const ready = agent.health?.ok === true && agent.health.sessionState === 'ready'
  const hasActiveSale = Boolean(agent.health?.activeTransaction)
  const busy = activeAction !== null

  const loadInventory = useCallback(async (signal?: AbortSignal) => {
    setLoadingInventory(true)
    setError(null)
    try {
      const [nextTotal, nextDenominations] = await Promise.all([
        client.getCashlogyTotal(signal),
        client.getCashlogyDenominations(signal),
      ])
      setTotal(nextTotal)
      setDenominations(nextDenominations)
    } catch (loadError) {
      if (signal?.aborted) return
      setError(toCashlogyError(loadError).message)
    } finally {
      if (!signal?.aborted) setLoadingInventory(false)
    }
  }, [client])

  useEffect(() => {
    const controller = new AbortController()
    void loadInventory(controller.signal)
    return () => controller.abort()
  }, [loadInventory])

  async function runAction(action: CashlogyManagementAction) {
    if (!ready || hasActiveSale || busy) return
    if (action === 'withdraw' && !canWithdraw) return
    setConfirmAction(null)
    setActiveAction(action)
    setError(null)
    setNotice(null)
    try {
      await client.openCashlogyBackoffice(
        cashlogyManagementPresets[action],
        cashlogyDangerousManagementActions.has(action),
      )
      setNotice(action === 'refill'
        ? 'Reposición finalizada. Se han actualizado las cantidades.'
        : action === 'give_change'
          ? 'Operación de cambio finalizada. Se han actualizado las cantidades.'
          : 'Retirada finalizada. Se han actualizado las cantidades.')
      await loadInventory()
    } catch (actionError) {
      setError(toCashlogyError(actionError).message)
    } finally {
      setActiveAction(null)
    }
  }

  function requestAction(action: CashlogyManagementAction) {
    if (cashlogyDangerousManagementActions.has(action)) {
      setConfirmAction(action)
      setNotice(null)
      setError(null)
      return
    }
    void runAction(action)
  }

  return (
    <AppModal dismissDisabled={busy} label="Máquina de efectivo" maxWidth={960} onClose={onClose}>
      <section className="flex max-h-[calc(100dvh-2rem)] min-w-0 flex-col overflow-hidden">
        <header className="flex items-start justify-between gap-4 border-b border-[var(--separator)] p-5">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-black">Máquina de efectivo</h2>
              <span className={`rounded-full px-2.5 py-1 text-xs font-bold ${ready ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-amber-500/15 text-amber-700 dark:text-amber-300'}`}>
                {ready ? 'Preparada' : connected ? 'Ocupada' : 'Desconectada'}
              </span>
            </div>
            <p className="mt-1 text-sm text-[var(--muted)]">
              {agent.health?.device?.model || 'Cashlogy'}
              {agent.health?.device?.serialNumber ? ` · ${agent.health.device.serialNumber}` : ''}
            </p>
          </div>
          <Button aria-label="Cerrar" disabled={busy} onClick={onClose} size="sm" type="button" variant="tertiary">
            <X className="h-4 w-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
          {!ready ? (
            <div className="mb-4 flex gap-3 rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-800 dark:text-amber-200">
              <ShieldAlert className="h-5 w-5 shrink-0" />
              <p>{hasActiveSale ? 'Hay un cobro Cashlogy en curso. Termínalo antes de gestionar la máquina.' : 'La máquina está conectada, pero todavía no está disponible para nuevas operaciones.'}</p>
            </div>
          ) : null}

          <div className="grid gap-3 md:grid-cols-3">
            {actions.map((action) => {
              const Icon = action.icon
              const running = activeAction === action.id
              const forbidden = action.id === 'withdraw' && !canWithdraw
              return (
                <article className="flex min-w-0 flex-col rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4" key={action.id}>
                  <div className="flex items-center gap-3">
                    <span className="rounded-[var(--radius)] bg-[var(--accent-soft)] p-2 text-[var(--accent)]"><Icon className="h-5 w-5" /></span>
                    <h3 className="font-black">{action.title}</h3>
                  </div>
                  <p className="mt-3 min-h-16 text-sm text-[var(--muted)]">{action.description}</p>
                  {forbidden ? <p className="mb-2 text-xs font-semibold text-amber-700 dark:text-amber-300">Requiere permiso para gestionar caja.</p> : null}
                  <Button
                    disabled={!ready || hasActiveSale || busy || forbidden}
                    fullWidth
                    onClick={() => requestAction(action.id)}
                    type="button"
                    variant={action.id === 'withdraw' ? 'danger' : 'secondary'}
                  >
                    {running ? <LoaderCircle className="h-4 w-4 animate-spin" /> : null}
                    {running ? 'Cashlogy abierto…' : action.button}
                  </Button>
                </article>
              )
            })}
          </div>

          {confirmAction === 'withdraw' ? (
            <div className="mt-4 rounded-[var(--radius)] border border-red-500/40 bg-red-500/10 p-4">
              <div className="flex gap-3">
                <ShieldAlert className="h-5 w-5 shrink-0 text-red-600" />
                <div>
                  <h3 className="font-black text-red-700 dark:text-red-300">Confirmar apertura de retirada</h3>
                  <p className="mt-1 text-sm text-[var(--muted)]">Cashlogy abrirá la pantalla donde podrás indicar el importe. Comprueba la retirada física antes de cerrarla.</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                <Button onClick={() => setConfirmAction(null)} type="button" variant="tertiary">Cancelar</Button>
                <Button onClick={() => void runAction('withdraw')} type="button" variant="danger">Continuar a Cashlogy</Button>
              </div>
            </div>
          ) : null}

          {error ? <p className="mt-4 rounded-[var(--radius)] border border-[var(--danger)] bg-[var(--danger-soft)] p-3 text-sm font-semibold text-[var(--danger)]" role="alert">{error}</p> : null}
          {notice ? <p className="mt-4 rounded-[var(--radius)] border border-emerald-500/40 bg-emerald-500/10 p-3 text-sm font-semibold text-emerald-700 dark:text-emerald-300">{notice}</p> : null}

          <section aria-labelledby="cashlogy-accounting-title" className="mt-5 rounded-[var(--radius)] border border-[var(--separator)]">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--separator)] p-4">
              <div>
                <h3 className="font-black" id="cashlogy-accounting-title">Cantidades de efectivo</h3>
                <p className="mt-0.5 text-xs text-[var(--muted)]">Recaudación almacenada y cambio disponible en el reciclador.</p>
              </div>
              <Button disabled={loadingInventory || busy || !ready} onClick={() => void loadInventory()} size="sm" type="button" variant="tertiary">
                <RefreshCw className={`h-4 w-4 ${loadingInventory ? 'animate-spin' : ''}`} />
                Actualizar
              </Button>
            </div>

            <div className="grid gap-3 p-4 sm:grid-cols-3">
              <Metric label="Cajón de recaudación" value={loadingInventory && !total ? '…' : formatMoney(total?.stackerTotalCents ?? 0)} />
              <Metric label="Reciclador · cambio disponible" value={loadingInventory && !total ? '…' : formatMoney(total?.recyclerTotalCents ?? 0)} />
              <Metric label="Total en la máquina" value={loadingInventory && !total ? '…' : formatMoney(total?.totalCents ?? 0)} />
            </div>

            <DenominationTable denominations={denominations} loading={loadingInventory} />
          </section>
        </div>
      </section>
    </AppModal>
  )
}

function DenominationTable({ denominations, loading }: { denominations: CashlogyDenominations | null; loading: boolean }) {
  const rows = useMemo(() => [
    ...(denominations?.notes ?? []).map((item) => ({ ...item, kind: 'Billete' })),
    ...(denominations?.coins ?? []).map((item) => ({ ...item, kind: 'Moneda' })),
  ].sort((left, right) => right.valueCents - left.valueCents), [denominations])

  if (loading && rows.length === 0) return <div className="flex items-center justify-center gap-2 border-t border-[var(--separator)] p-8 text-sm text-[var(--muted)]"><LoaderCircle className="h-4 w-4 animate-spin" /> Consultando Cashlogy…</div>
  if (rows.length === 0) return <div className="border-t border-[var(--separator)] p-6 text-center text-sm text-[var(--muted)]">Cashlogy no ha devuelto un desglose por denominación.</div>

  return (
    <div className="overflow-x-auto border-t border-[var(--separator)]">
      <table className="w-full min-w-[620px] text-sm">
        <thead className="bg-[var(--background)] text-left text-xs uppercase tracking-wide text-[var(--muted)]">
          <tr>
            <th className="px-4 py-3">Tipo</th>
            <th className="px-4 py-3 text-right">Valor</th>
            <th className="px-4 py-3 text-right"><span className="inline-flex items-center gap-1"><Coins className="h-3.5 w-3.5" /> Reciclador</span></th>
            <th className="px-4 py-3 text-right">Disponible</th>
            <th className="px-4 py-3 text-right">Recaudación</th>
            <th className="px-4 py-3 text-right">Importe</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-[var(--separator)]">
          {rows.map((row) => <DenominationRow key={`${row.kind}-${row.valueCents}`} row={row} />)}
        </tbody>
      </table>
    </div>
  )
}

function DenominationRow({ row }: { row: CashlogyDenomination & { kind: string } }) {
  return (
    <tr>
      <td className="px-4 py-3 text-[var(--muted)]">{row.kind}</td>
      <td className="px-4 py-3 text-right font-mono font-bold">{formatMoney(row.valueCents)}</td>
      <td className="px-4 py-3 text-right font-mono">{row.recyclerCount}</td>
      <td className="px-4 py-3 text-right font-mono">{formatMoney(row.valueCents * row.recyclerCount)}</td>
      <td className="px-4 py-3 text-right font-mono">{row.stackerCount}</td>
      <td className="px-4 py-3 text-right font-mono">{formatMoney(row.valueCents * row.stackerCount)}</td>
    </tr>
  )
}
