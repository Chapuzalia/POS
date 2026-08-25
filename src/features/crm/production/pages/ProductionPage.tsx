import { Copy, Link2, Pencil, Plus, Printer, RefreshCw, Save, Trash2, Unplug, X } from 'lucide-react'
import { type FormEvent, useCallback, useEffect, useState } from 'react'
import { Button, Input } from '../../../../components/ui'
import type { CatalogData } from '../../../catalog/domain/types'
import type { TenantContext } from '../../../../types'
import type { RunAction } from '../../shared/types'
import { CrmSelect } from '../../shared/components/CrmSelect'
import {
  createAgentPairingCode,
  createKdsDevice,
  deleteKdsDevice,
  deleteProductionDestination,
  loadProductionAdmin,
  reprintDispatch,
  saveProductionDestination,
  saveProductionRoute,
  setVenueProductionEnabled,
  unlinkAgent,
  updateKdsDevice,
  type ProductionAdminState,
  type ProductionDestination,
  type ProductionKdsDevice,
} from '../services/productionAdminService'

type Props = { catalog: CatalogData | null; context: TenantContext; disabled: boolean; runAction: RunAction; venueId: string }
const emptyState: ProductionAdminState = { venueEnabled: false, destinations: [], categoryRoutes: [], productRoutes: [], agent: null, printers: [], dispatches: [], kdsDevices: [] }

export function ProductionCrm({ catalog, context, disabled, runAction, venueId }: Props) {
  const [state, setState] = useState(emptyState)
  const [destinationName, setDestinationName] = useState('Cocina')
  const [destinationKds, setDestinationKds] = useState(true)
  const [destinationPrinter, setDestinationPrinter] = useState('')
  const [categoryId, setCategoryId] = useState('')
  const [productId, setProductId] = useState('')
  const [routeDestinationId, setRouteDestinationId] = useState('')
  const [kdsName, setKdsName] = useState('KDS Cocina')
  const [kdsDestinationId, setKdsDestinationId] = useState('')
  const [credentials, setCredentials] = useState<{ email: string; password: string } | null>(null)
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string } | null>(null)

  const refresh = useCallback(async () => setState(await loadProductionAdmin(context, venueId)), [context, venueId])
  useEffect(() => { void runAction(refresh) }, [refresh, runAction])
  useEffect(() => {
    const first = state.destinations.find((destination) => destination.isActive)?.id ?? ''
    if (!routeDestinationId) setRouteDestinationId(first)
    if (!kdsDestinationId) setKdsDestinationId(state.destinations.find((destination) => destination.isActive && destination.kdsEnabled)?.id ?? '')
  }, [kdsDestinationId, routeDestinationId, state.destinations])

  const mutate = (action: () => Promise<unknown>) => runAction(async () => { await action(); await refresh() })
  const createDestination = (event: FormEvent) => {
    event.preventDefault()
    const destination: ProductionDestination = { id: crypto.randomUUID(), name: destinationName, isActive: true, sortOrder: state.destinations.length, kdsEnabled: destinationKds, printerId: destinationPrinter || null }
    void mutate(async () => { await saveProductionDestination(context, venueId, destination); setDestinationName(''); setDestinationPrinter('') })
  }
  const updateDestination = (destination: ProductionDestination, patch: Partial<ProductionDestination>) => mutate(() => saveProductionDestination(context, venueId, { ...destination, ...patch }))

  return <div className="space-y-5">
    <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="text-lg font-black">Producción del local</h2><p className="text-sm text-[var(--crm-text-muted)]">La feature del plan y este interruptor deben estar activos. Al apagarlo, el TPV anterior sigue funcionando sin cambios.</p></div><div className="flex gap-2"><Button disabled={disabled} onClick={() => void runAction(refresh)} size="md" type="button" variant="secondary"><RefreshCw className="h-4 w-4" /> Actualizar</Button><Button disabled={disabled} onClick={() => void mutate(() => setVenueProductionEnabled(venueId, !state.venueEnabled))} size="md" type="button" variant={state.venueEnabled ? 'primary' : 'secondary'}>{state.venueEnabled ? 'Producción activa' : 'Activar producción'}</Button></div></div>
    </section>

    {state.venueEnabled ? <>
      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="text-lg font-black">Destinos y salidas</h2><p className="mb-4 text-sm text-[var(--crm-text-muted)]">Cada destino activo necesita KDS, impresora o ambos.</p>
        <form className="mb-4 grid gap-2 md:grid-cols-[1fr_auto_1fr_auto]" onSubmit={createDestination}><Input onChange={(event) => setDestinationName(event.target.value)} placeholder="Nombre del destino" required value={destinationName} /><label className="flex items-center gap-2 px-2 text-sm font-bold"><input checked={destinationKds} onChange={(event) => setDestinationKds(event.target.checked)} type="checkbox" /> KDS</label><CrmSelect onChange={setDestinationPrinter} options={[{ label: 'Sin impresora', value: '' }, ...state.printers.map((printer) => ({ label: `${printer.displayName}${printer.available ? '' : ' (no disponible)'}`, value: printer.printerId }))]} value={destinationPrinter} /><Button disabled={disabled || (!destinationKds && !destinationPrinter)} size="md" type="submit" variant="primary"><Plus className="h-4 w-4" /> Crear</Button></form>
        <div className="space-y-2">{state.destinations.map((destination) => <article className="grid items-center gap-2 rounded-xl border border-[var(--crm-border)] p-3 md:grid-cols-[1fr_auto_1fr_auto]" key={destination.id}><Input onBlur={(event) => { if (event.target.value.trim() && event.target.value !== destination.name) void updateDestination(destination, { name: event.target.value }) }} defaultValue={destination.name} /><label className="flex items-center gap-2 text-sm font-bold"><input checked={destination.kdsEnabled} disabled={disabled || (destination.isActive && !destination.printerId && destination.kdsEnabled)} onChange={(event) => void updateDestination(destination, { kdsEnabled: event.target.checked })} type="checkbox" /> KDS</label><CrmSelect disabled={disabled} onChange={(value) => void updateDestination(destination, { printerId: value || null })} options={[{ label: 'Sin impresora', value: '' }, ...state.printers.map((printer) => ({ label: printer.displayName, value: printer.printerId }))]} value={destination.printerId ?? ''} /><div className="flex gap-1"><Button disabled={disabled || (!destination.kdsEnabled && !destination.printerId && !destination.isActive)} onClick={() => void updateDestination(destination, { isActive: !destination.isActive })} size="sm" type="button" variant="secondary">{destination.isActive ? 'Desactivar' : 'Activar'}</Button><Button disabled={disabled || destination.isActive} onClick={() => void mutate(() => deleteProductionDestination(context, destination.id))} size="sm" type="button" variant="tertiary"><Trash2 className="h-4 w-4" /></Button></div></article>)}</div>
      </section>

      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="text-lg font-black">Routing</h2><p className="mb-4 text-sm text-[var(--crm-text-muted)]">La ruta específica de producto prevalece sobre la categoría.</p>
        <div className="grid gap-4 lg:grid-cols-2">
          <RouteEditor disabled={disabled} destinations={state.destinations} items={(catalog?.categories ?? []).filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))} label="Categorías" onSave={(source, destination) => void mutate(() => saveProductionRoute(context, venueId, 'category', source, destination))} routes={state.categoryRoutes} selectedDestination={routeDestinationId} selectedSource={categoryId} setDestination={setRouteDestinationId} setSource={setCategoryId} />
          <RouteEditor disabled={disabled} destinations={state.destinations} items={(catalog?.products ?? []).filter((item) => item.active).map((item) => ({ id: item.id, name: item.name }))} label="Excepciones por producto" onSave={(source, destination) => void mutate(() => saveProductionRoute(context, venueId, 'product', source, destination))} routes={state.productRoutes} selectedDestination={routeDestinationId} selectedSource={productId} setDestination={setRouteDestinationId} setSource={setProductId} />
        </div>
      </section>

      <section className="grid gap-5 lg:grid-cols-2"><div className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="text-lg font-black">Dispositivos KDS</h2><p className="mb-4 text-sm text-[var(--crm-text-muted)]">Cuentas reales, cada una ligada a un único destino y sin permisos de caja.</p><div className="space-y-2"><Input onChange={(event) => setKdsName(event.target.value)} value={kdsName} /><CrmSelect onChange={setKdsDestinationId} options={state.destinations.filter((destination) => destination.isActive && destination.kdsEnabled).map((destination) => ({ label: destination.name, value: destination.id }))} placeholder="Selecciona destino KDS" value={kdsDestinationId} /><Button disabled={disabled || !kdsDestinationId || !kdsName.trim()} fullWidth onClick={() => void runAction(async () => { setCredentials(await createKdsDevice(context, venueId, kdsDestinationId, kdsName)); await refresh() })} size="md" type="button" variant="primary"><Plus className="h-4 w-4" /> Crear KDS</Button>{credentials ? <div className="rounded-xl border border-[var(--crm-border)] p-3 text-sm"><strong>Credenciales (se muestran una vez)</strong><p className="font-mono">{credentials.email}</p><p className="font-mono">{credentials.password}</p><Button onClick={() => void navigator.clipboard.writeText(`${credentials.email}\n${credentials.password}`)} size="sm" type="button" variant="secondary"><Copy className="h-4 w-4" /> Copiar</Button></div> : null}{state.kdsDevices.map((device) => <KdsDeviceRow destinationName={state.destinations.find((destination) => destination.id === device.destinationId)?.name ?? 'Destino eliminado'} device={device} disabled={disabled} key={device.id} onDelete={() => mutate(() => deleteKdsDevice(context, device.id))} onSave={(name, password) => mutate(() => updateKdsDevice(context, device.id, name, password || undefined))} />)}</div></div>

        <div className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="text-lg font-black">Print Agent del local</h2><p className="mb-3 text-sm text-[var(--crm-text-muted)]">Un agente por local. El secreto solo se entrega al agente al consumir el código.</p>{state.agent ? <div className="mb-3 rounded-xl border border-[var(--crm-border)] p-3 text-sm"><p><strong>{state.agent.isActive ? 'Vinculado' : 'Desvinculado'}</strong> · {state.agent.workerState}</p><p>Versión {state.agent.version ?? 'desconocida'} · {state.agent.productionCapability ? 'compatible' : 'sin worker'}</p><p>Última señal: {state.agent.lastSeenAt ? new Date(state.agent.lastSeenAt).toLocaleString() : 'nunca'}</p></div> : null}<div className="flex flex-wrap gap-2"><Button disabled={disabled} onClick={() => void runAction(async () => setPairing(await createAgentPairingCode(venueId)))} size="md" type="button" variant="primary"><Link2 className="h-4 w-4" /> Generar código</Button>{state.agent?.isActive ? <Button disabled={disabled} onClick={() => void mutate(() => unlinkAgent(venueId))} size="md" type="button" variant="secondary"><Unplug className="h-4 w-4" /> Desvincular</Button> : null}</div>{pairing ? <div className="mt-3 rounded-xl border-2 border-[var(--crm-accent)] p-3 text-center"><p className="font-mono text-3xl font-black tracking-widest">{pairing.code}</p><p className="text-xs">Caduca {new Date(pairing.expiresAt).toLocaleTimeString()}</p></div> : null}</div>
      </section>

      <section className="rounded-2xl bg-[var(--crm-surface)] p-5 shadow-[var(--crm-shadow-card)]"><h2 className="text-lg font-black">Últimas impresiones</h2><div className="mt-3 space-y-2">{state.dispatches.map((dispatch) => <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--crm-border)] p-3 text-sm" key={dispatch.id}><div><strong>{dispatch.status.toUpperCase()}</strong> · {dispatch.printerId}<p className="text-[var(--crm-text-muted)]">{new Date(dispatch.createdAt).toLocaleString()} {dispatch.errorMessage ? `· ${dispatch.errorMessage}` : ''}</p></div><div className="flex gap-2"><Button disabled={disabled || !state.agent?.isActive} onClick={() => void mutate(() => reprintDispatch(dispatch.id))} size="sm" type="button" variant="secondary"><Printer className="h-4 w-4" /> Reimprimir</Button><Button disabled={disabled || !state.agent?.isActive || state.printers.length < 2} onClick={() => { const printerId = window.prompt(`Printer ID de destino:\n${state.printers.map((printer) => `${printer.printerId} — ${printer.displayName}`).join('\n')}`, dispatch.printerId); if (printerId) void mutate(() => reprintDispatch(dispatch.id, printerId)) }} size="sm" type="button" variant="tertiary">Reasignar</Button></div></div>)}</div></section>
    </> : null}
  </div>
}

function KdsDeviceRow(props: { destinationName: string; device: ProductionKdsDevice; disabled: boolean; onDelete: () => Promise<void>; onSave: (name: string, password: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false)
  const [name, setName] = useState(props.device.name)
  const [password, setPassword] = useState('')

  const cancel = () => {
    setEditing(false)
    setName(props.device.name)
    setPassword('')
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    await props.onSave(name.trim(), password)
    setEditing(false)
    setPassword('')
  }

  return <article className="rounded-xl border border-[var(--crm-border)] p-3 text-sm">
    <div className="flex items-center justify-between gap-3">
      <span className="min-w-0 truncate"><strong>{props.device.name}</strong> · {props.destinationName}</span>
      <div className="flex shrink-0 gap-1">
        <Button aria-label={`Editar ${props.device.name}`} disabled={props.disabled} onClick={() => setEditing(true)} size="sm" type="button" variant="tertiary"><Pencil className="h-4 w-4" /></Button>
        <Button aria-label={`Eliminar ${props.device.name}`} disabled={props.disabled} onClick={() => void props.onDelete()} size="sm" type="button" variant="tertiary"><Trash2 className="h-4 w-4" /></Button>
      </div>
    </div>
    {editing ? <form className="mt-3 grid gap-2 border-t border-[var(--crm-border)] pt-3 sm:grid-cols-2" onSubmit={(event) => void submit(event)}>
      <Input aria-label="Nombre del KDS" disabled={props.disabled} maxLength={80} onChange={(event) => setName(event.target.value)} placeholder="Nombre del KDS" required value={name} />
      <Input aria-label="Nueva contraseña" autoComplete="new-password" disabled={props.disabled} maxLength={6} minLength={6} onChange={(event) => setPassword(event.target.value)} placeholder="Nueva contraseña (6 caracteres)" type="password" value={password} />
      <p className="text-xs text-[var(--crm-text-muted)] sm:col-span-2">Deja la contraseña vacía para conservar la actual.</p>
      <div className="flex justify-end gap-2 sm:col-span-2">
        <Button disabled={props.disabled} onClick={cancel} size="sm" type="button" variant="secondary"><X className="h-4 w-4" /> Cancelar</Button>
        <Button disabled={props.disabled || !name.trim() || (password.length > 0 && password.length !== 6)} size="sm" type="submit" variant="primary"><Save className="h-4 w-4" /> Guardar</Button>
      </div>
    </form> : null}
  </article>
}

function RouteEditor(props: { disabled: boolean; destinations: ProductionDestination[]; items: Array<{ id: string; name: string }>; label: string; onSave: (source: string, destination: string | null) => void; routes: Array<{ sourceId: string; destinationId: string }>; selectedDestination: string; selectedSource: string; setDestination: (value: string) => void; setSource: (value: string) => void }) {
  const names = new Map(props.items.map((item) => [item.id, item.name]))
  const destinations = new Map(props.destinations.map((item) => [item.id, item.name]))
  return <div><h3 className="font-black">{props.label}</h3><div className="mt-2 flex gap-2"><CrmSelect className="min-w-0 flex-1" onChange={props.setSource} options={props.items.map((item) => ({ label: item.name, value: item.id }))} placeholder="Selecciona…" searchable value={props.selectedSource} /><CrmSelect className="min-w-0 flex-1" onChange={props.setDestination} options={[{ label: 'Sin ruta', value: '' }, ...props.destinations.filter((item) => item.isActive).map((item) => ({ label: item.name, value: item.id }))]} value={props.selectedDestination} /><Button disabled={props.disabled || !props.selectedSource} onClick={() => props.onSave(props.selectedSource, props.selectedDestination || null)} size="md" type="button" variant="primary"><Save className="h-4 w-4" /></Button></div><div className="mt-2 space-y-1">{props.routes.map((route) => <div className="flex justify-between rounded-lg bg-[var(--crm-surface-muted)] px-3 py-2 text-sm" key={route.sourceId}><span>{names.get(route.sourceId) ?? route.sourceId} → {destinations.get(route.destinationId) ?? 'Destino eliminado'}</span><button className="font-bold text-[var(--danger)]" disabled={props.disabled} onClick={() => props.onSave(route.sourceId, null)} type="button">Quitar</button></div>)}</div></div>
}
