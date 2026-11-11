import { Activity, Cloud, LoaderCircle, RefreshCw, Save, Server, Unlink } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Metric } from '../../../components/ui'
import { appConfirm } from '../../../components/ui/appDialogStore'
import { Input as UiInput } from '../../../components/ui/Input'
import { NativeSelect as UiNativeSelect } from '../../../components/ui/NativeSelect'
import { createPrintAgentClient } from '../api/printAgentClient'
import { getPrintAgentErrorMessage } from '../api/PrintAgentError'
import { usePrintAgentStore } from '../store/usePrintAgentStore'
import type { CashlogyDeviceError, CashlogyDiagnosticLog, PrintAgentProductionStatus, PrintAgentRemoteConfig, PrintAgentRequestLog } from '../types'

const sectionClass = 'rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4'
const fieldClass = 'min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3'

type Diagnostics = { cashlogyErrors: CashlogyDeviceError[]; cashlogyLogs: CashlogyDiagnosticLog[]; requests: PrintAgentRequestLog[] }

/** Ajustes del dashboard del backend de impresión cuando corre integrado en la app nativa. */
export function EmbeddedPrintAgentSettings({ canConfigure }: { canConfigure: boolean }) {
  const baseUrl = usePrintAgentStore((state) => state.baseUrl)
  const token = usePrintAgentStore((state) => state.token)
  const client = useMemo(() => createPrintAgentClient({ baseUrl, token }), [baseUrl, token])
  const [busy, setBusy] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<{ message: string; tone: 'success' | 'danger' } | null>(null)
  const [establishmentName, setEstablishmentName] = useState('')
  const [paperWidth, setPaperWidth] = useState<58 | 80>(80)
  const [cashlogyHost, setCashlogyHost] = useState('')
  const [cashlogyPort, setCashlogyPort] = useState('8092')
  const [production, setProduction] = useState<PrintAgentProductionStatus | null>(null)
  const [productionEndpoint, setProductionEndpoint] = useState('')
  const [pairingCode, setPairingCode] = useState('')
  const [diagnostics, setDiagnostics] = useState<Diagnostics | null>(null)

  async function run(key: string, action: () => Promise<unknown>, message?: string) {
    setBusy(key)
    setFeedback(null)
    try {
      await action()
      if (message) setFeedback({ message, tone: 'success' })
    } catch (error) {
      setFeedback({ message: getPrintAgentErrorMessage(error), tone: 'danger' })
    } finally { setBusy(null) }
  }

  const load = useCallback(async () => {
    const [config, status] = await Promise.all([
      client.getConfig() as Promise<PrintAgentRemoteConfig>,
      client.getProductionStatus(),
    ])
    setEstablishmentName(config.server?.establishmentName ?? '')
    setPaperWidth(config.printer?.paperWidth === 58 ? 58 : 80)
    setCashlogyHost(config.cashlogy?.connector?.host ?? '')
    setCashlogyPort(String(config.cashlogy?.connector?.port ?? 8092))
    setProductionEndpoint(config.cloudProduction?.endpoint ?? '')
    setProduction(status)
  }, [client])

  useEffect(() => {
    if (!token) return
    void load().catch((error: unknown) => setFeedback({ message: getPrintAgentErrorMessage(error), tone: 'danger' }))
  }, [load, token])

  const saveConfig = () => run('config', async () => {
    const port = Number(cashlogyPort)
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('El puerto de Cashlogy no es válido.')
    await client.updateConfig({
      establishmentName: establishmentName.trim(),
      paperWidth,
      ...(cashlogyHost.trim() ? { cashlogyConnector: { host: cashlogyHost.trim(), port } } : {}),
    })
    await load()
  }, 'Ajustes del servidor guardados.')

  const pair = () => run('pair', async () => {
    await client.pairProduction({ code: pairingCode.trim(), ...(productionEndpoint.trim() ? { endpoint: productionEndpoint.trim() } : {}) })
    setPairingCode('')
    await load()
  }, 'Producción cloud vinculada.')

  const unlink = async () => {
    if (!(await appConfirm('¿Desvincular este servidor de la producción cloud? Dejará de recibir comandas remotas.'))) return
    await run('unlink', async () => { await client.unlinkProduction(); await load() }, 'Producción cloud desvinculada.')
  }

  const loadDiagnostics = () => run('diagnostics', async () => {
    const [errors, logs, requests] = await Promise.allSettled([client.getCashlogyErrors(), client.getCashlogyDiagnosticLogs(50), client.getRecentRequests()])
    setDiagnostics({
      cashlogyErrors: errors.status === 'fulfilled' ? errors.value.errors : [],
      cashlogyLogs: logs.status === 'fulfilled' ? logs.value.logs : [],
      requests: requests.status === 'fulfilled' ? requests.value.logs.slice(0, 50) : [],
    })
  })

  const disabled = !canConfigure || !token || busy !== null
  return <div className="grid gap-5">
    <div><p className="text-xs font-black uppercase text-[var(--accent)]">Ajustes · Hardware</p><h2 className="text-2xl font-black">Servidor de impresión integrado</h2><p className="text-sm text-[var(--muted)]">Backend de impresión dentro de esta app: se comunica directamente con las impresoras y con Cashlogy.</p></div>
    {feedback ? <div role="status" className={`rounded-[var(--radius)] border p-3 text-sm font-bold ${feedback.tone === 'danger' ? 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300' : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'}`}>{feedback.message}</div> : null}

    <section className={sectionClass}>
      <div className="flex items-center gap-3"><Server className="h-5 w-5" /><div><h3 className="font-black">Ajustes del servidor</h3><p className="break-all font-mono text-xs text-[var(--muted)]">{baseUrl}</p></div></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="mb-2 block text-sm font-bold">Establecimiento</span><UiInput className={fieldClass} disabled={disabled} maxLength={120} onChange={(event) => setEstablishmentName(event.target.value)} value={establishmentName} /></label>
        <label><span className="mb-2 block text-sm font-bold">Ancho de papel por defecto</span><UiNativeSelect className={fieldClass} disabled={disabled} onChange={(event) => setPaperWidth(event.target.value === '58' ? 58 : 80)} value={paperWidth}><option value={80}>80 mm</option><option value={58}>58 mm</option></UiNativeSelect></label>
        <span className="hidden sm:block" />
        <label><span className="mb-2 block text-sm font-bold">Equipo de CashlogyConnector</span><UiInput className={`${fieldClass} font-mono`} disabled={disabled} maxLength={253} onChange={(event) => setCashlogyHost(event.target.value)} placeholder="192.168.1.50 o cashlogy-pc.local" value={cashlogyHost} /></label>
        <label><span className="mb-2 block text-sm font-bold">Puerto de Cashlogy</span><UiInput className={`${fieldClass} font-mono`} disabled={disabled} inputMode="numeric" onChange={(event) => setCashlogyPort(event.target.value)} value={cashlogyPort} /></label>
      </div>
      <p className="mt-2 text-xs text-[var(--muted)]">En la app, CashlogyConnector sigue ejecutándose en el PC de la máquina: indica aquí su IP o nombre en la red local.</p>
      <Button className="mt-3" disabled={disabled} onClick={() => void saveConfig()} variant="primary">{busy === 'config' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}Guardar</Button>
    </section>

    <section className={sectionClass}>
      <div className="flex items-center gap-3"><Cloud className="h-5 w-5" /><div><h3 className="font-black">Producción cloud (opcional)</h3><p className="text-sm text-[var(--muted)]">Recibe comandas de producción del CRM. Introduce el código generado en el CRM.</p></div></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        <Metric label="Estado" tone={production?.enabled ? 'success' : 'default'} value={production ? (production.enabled ? 'Vinculado' : 'Desactivado') : '-'} />
        <Metric label="Worker" tone={production?.workerState === 'error' ? 'danger' : 'default'} value={production?.workerState ?? '-'} />
        <Metric label="Último error" value={production?.lastError || '-'} />
      </div>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="sm:col-span-2"><span className="mb-2 block text-sm font-bold">URL de la función cloud</span><UiInput className={`${fieldClass} font-mono`} disabled={disabled} onChange={(event) => setProductionEndpoint(event.target.value)} placeholder="https://proyecto.supabase.co/functions/v1/production-agent" value={productionEndpoint} /></label>
        <label><span className="mb-2 block text-sm font-bold">Código de vinculación</span><UiInput autoComplete="off" className={`${fieldClass} font-mono uppercase`} disabled={disabled} maxLength={12} onChange={(event) => setPairingCode(event.target.value)} value={pairingCode} /></label>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button disabled={disabled || pairingCode.trim().length !== 12} onClick={() => void pair()} variant="primary">{busy === 'pair' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Cloud className="h-4 w-4" />}Vincular</Button>
        <Button disabled={disabled || !production?.configured} onClick={() => void unlink()} variant="dangerSoft"><Unlink className="h-4 w-4" />Desvincular</Button>
      </div>
    </section>

    <section className={sectionClass}>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Activity className="h-5 w-5" /><h3 className="font-black">Diagnóstico</h3></div><Button disabled={!token || busy !== null} onClick={() => void loadDiagnostics()} size="sm">{busy === 'diagnostics' ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Actualizar</Button></div>
      {diagnostics ? <div className="mt-3 grid gap-4 text-sm">
        <div><h4 className="font-bold">Errores Cashlogy</h4>{diagnostics.cashlogyErrors.length ? <ul className="mt-1 grid gap-1">{diagnostics.cashlogyErrors.map((error) => <li key={error.code}><span className="font-mono">{error.code}</span> · {error.title || error.mainMessage || error.type}</li>)}</ul> : <p className="text-[var(--muted)]">Sin errores.</p>}</div>
        <div><h4 className="font-bold">Comandos Cashlogy recientes</h4>{diagnostics.cashlogyLogs.length ? <ul className="mt-1 grid gap-1 font-mono text-xs">{diagnostics.cashlogyLogs.map((log) => <li key={log.id}>{new Date(log.createdAt).toLocaleTimeString()} · {log.commandName} · {log.resultCode ?? '-'} · {log.outcome} · {log.durationMs} ms</li>)}</ul> : <p className="text-[var(--muted)]">Sin registros.</p>}</div>
        <div><h4 className="font-bold">Peticiones recientes</h4>{diagnostics.requests.length ? <ul className="mt-1 grid gap-1 font-mono text-xs">{diagnostics.requests.map((log, index) => <li key={`${log.time}-${index}`}>{new Date(log.time).toLocaleTimeString()} · {log.method} {log.url} · {log.statusCode}</li>)}</ul> : <p className="text-[var(--muted)]">Sin peticiones.</p>}</div>
      </div> : <p className="mt-3 text-sm text-[var(--muted)]">Pulsa Actualizar para ver errores, comandos de Cashlogy y peticiones recientes.</p>}
    </section>
  </div>
}
