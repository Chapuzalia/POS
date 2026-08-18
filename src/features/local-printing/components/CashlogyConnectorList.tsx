import { CheckCircle2, CircleOff, LoaderCircle, Play, RadioTower } from 'lucide-react'
import { Button } from '../../../components/ui'
import type { CashlogyConnector } from '../types'

type ConnectorAction = { connectorId: string; type: 'select' | 'initialize' } | null

export function CashlogyConnectorList(props: {
  action: ConnectorAction
  connectors: CashlogyConnector[]
  disabled?: boolean
  loaded: boolean
  onInitialize: (connectorId: string) => void
  onSelect: (connectorId: string) => void
}) {
  if (!props.loaded) {
    return <div className="rounded-[var(--radius)] border border-dashed border-[var(--separator)] p-6 text-center text-sm font-semibold text-[var(--muted)]">Pulsa «Buscar máquinas» para localizar Cashlogy en la red del agente.</div>
  }

  if (!props.connectors.length) {
    return <div className="rounded-[var(--radius)] border border-amber-500/35 bg-amber-500/10 p-4 text-sm font-semibold text-amber-800 dark:text-amber-200">No se ha encontrado ninguna máquina Cashlogy accesible. Comprueba que esté encendida, conectada a la red y que el módulo Cashlogy esté habilitado en el agente.</div>
  }

  return <div className="grid gap-3">{props.connectors.map((connector) => {
    const action = props.action?.connectorId === connector.id ? props.action.type : null
    const selected = connector.selected === true
    const ready = selected && connector.initialized
    return <article className={`rounded-[var(--radius)] border p-4 ${selected ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--separator)] bg-[var(--background)]'}`} key={connector.id}>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 gap-3">
          <span className={`mt-0.5 grid h-10 w-10 shrink-0 place-items-center rounded-full ${ready ? 'bg-emerald-500/15 text-emerald-600' : 'bg-[var(--surface)] text-[var(--muted)]'}`}>
            {connector.reachable ? <RadioTower className="h-5 w-5" /> : <CircleOff className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <p className="font-black">Cashlogy · {connector.host}:{connector.port}</p>
            <p className="break-all font-mono text-xs text-[var(--muted)]">{connector.id}</p>
            <div className="mt-2 flex flex-wrap gap-2 text-xs font-bold">
              <Status active={connector.reachable} label={connector.reachable ? 'Accesible' : 'No accesible'} />
              <Status active={connector.processRunning === true} label={connector.processRunning === undefined ? 'Proceso sin confirmar' : connector.processRunning ? 'Proceso activo' : 'Proceso detenido'} />
              <Status active={selected} label={selected ? 'Seleccionada' : 'Sin seleccionar'} />
              <Status active={connector.initialized} label={connector.initialized ? 'Inicializada' : 'Sin inicializar'} />
            </div>
            {connector.protocolVersion ? <p className="mt-2 text-xs text-[var(--muted)]">Versión: {connector.protocolVersion}</p> : null}
            {connector.lastError ? <p className="mt-2 text-sm font-semibold text-red-600 dark:text-red-300">{connector.lastError.message || connector.lastError.code}</p> : null}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!selected ? <Button disabled={props.disabled || !connector.reachable || Boolean(props.action)} onClick={() => props.onSelect(connector.id)} size="sm" variant="secondary">
            {action === 'select' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Seleccionar
          </Button> : null}
          {selected && !connector.initialized ? <Button disabled={props.disabled || !connector.reachable || Boolean(props.action)} onClick={() => props.onInitialize(connector.id)} size="sm" variant="primary">
            {action === 'initialize' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}Inicializar
          </Button> : null}
          {ready ? <span className="inline-flex min-h-9 items-center gap-2 rounded-[var(--radius)] bg-emerald-500/15 px-3 text-sm font-black text-emerald-700 dark:text-emerald-300"><CheckCircle2 className="h-4 w-4" />Lista para usar</span> : null}
        </div>
      </div>
    </article>
  })}</div>
}

function Status({ active, label }: { active: boolean; label: string }) {
  return <span className={`rounded-full px-2 py-1 ${active ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300' : 'bg-slate-500/10 text-[var(--muted)]'}`}>{label}</span>
}
