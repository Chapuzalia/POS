import { Clipboard, ExternalLink, LoaderCircle, Network, Printer, RefreshCw, RotateCcw, Server, Settings2, TestTube2, WalletCards } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Button, Metric } from '../../../components/ui'
import { usePrintAgent } from '../hooks/usePrintAgent'
import { CertificateHelpDialog } from './CertificateHelpDialog'
import { PrintAgentSetupWizard } from './PrintAgentSetupWizard'
import { PrintAgentStatusBadge } from './PrintAgentStatusBadge'
import { PrintErrorAlert } from './PrintErrorAlert'
import { PrintJobsTable } from './PrintJobsTable'
import { PrinterList } from './PrinterList'

export function PrintAgentSettings({ canConfigure, canOpenDrawer }: { canConfigure: boolean; canOpenDrawer: boolean }) {
  const agent = usePrintAgent()
  const [wizardOpen, setWizardOpen] = useState(false)
  const [certificateHelpOpen, setCertificateHelpOpen] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)
  const { connectionStatus, hasToken, loadJobs, loadPrinters, loadServerInfo } = agent

  useEffect(() => {
    if (connectionStatus === 'connected' && hasToken) {
      void Promise.allSettled([loadServerInfo(), loadPrinters(), loadJobs()])
    }
  }, [connectionStatus, hasToken, loadJobs, loadPrinters, loadServerInfo])

  async function run(action: () => Promise<unknown>, message: string) {
    setFeedback(null)
    try { await action(); setFeedback(message) } catch { /* el store muestra el error seguro */ }
  }

  async function copyDiagnostics() {
    await navigator.clipboard.writeText(JSON.stringify(agent.getDiagnosticReport(), null, 2))
    setFeedback('Informe tecnico copiado sin token ni contenido de tickets.')
  }

  const busy = agent.isCheckingConnection || agent.isDiscovering || agent.isSelectingPrinter || agent.isTestingPrinter || agent.isOpeningCashDrawer
  return <div className="grid gap-5">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="text-xs font-black uppercase text-[var(--accent)]">Ajustes · Hardware</p><h2 className="text-2xl font-black">Impresion local</h2><p className="text-sm text-[var(--muted)]">Agente HTTPS de esta terminal.</p></div><PrintAgentStatusBadge /></div>
    {agent.lastError ? <PrintErrorAlert error={agent.lastError} onClose={agent.clearError} /> : null}
    {feedback ? <div className="rounded-[var(--radius)] border border-emerald-500/35 bg-emerald-500/10 p-3 text-sm font-bold text-emerald-700 dark:text-emerald-300">{feedback}</div> : null}

    <section className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Server className="h-5 w-5" /><div><h3 className="font-black">Servidor de impresion</h3><p className="break-all font-mono text-xs text-[var(--muted)]">{agent.baseUrl}</p></div></div><div className="flex flex-wrap gap-2"><Button disabled={busy} onClick={() => void run(agent.checkConnection, 'Servidor de impresion conectado.')} size="sm"><RefreshCw className={`h-4 w-4 ${agent.isCheckingConnection ? 'animate-spin' : ''}`} />Probar conexion</Button><Button disabled={!canConfigure} onClick={() => setWizardOpen(true)} size="sm" variant="primary"><Settings2 className="h-4 w-4" />{agent.hasToken ? 'Cambiar servidor' : 'Configurar'}</Button></div></div>
      <div className="mt-4 grid gap-3 sm:grid-cols-3"><Metric label="Hostname" value={String(agent.serverInfo?.hostname || '-')} /><Metric label="IP del agente" value={String(agent.serverInfo?.ip || '-')} /><Metric label="Version" value={String(agent.serverInfo?.version || '-')} /><Metric label="Sistema" value={String(agent.serverInfo?.operatingSystem || agent.serverInfo?.platform || '-')} /><Metric label="HTTPS" value={agent.serverInfo?.https === false ? 'No' : 'Si / navegador'} /><Metric label="Respuesta" value={agent.lastResponseTimeMs === null ? '-' : `${agent.lastResponseTimeMs} ms`} /></div>
      <div className="mt-3 flex flex-wrap gap-2"><Button onClick={() => setCertificateHelpOpen(true)} size="sm"><ExternalLink className="h-4 w-4" />Ayuda certificado</Button><Button onClick={() => void copyDiagnostics()} size="sm"><Clipboard className="h-4 w-4" />Copiar diagnostico</Button></div>
    </section>

    <section className={'rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4'}>
      <h3 className={'font-black'}>Ticket automatico</h3>
      <label className={'mt-3 flex min-h-12 items-center gap-3 rounded-[var(--radius)] border border-[var(--separator)] px-3'}>
        <input checked={agent.preferences.alwaysPrintTicket} disabled={!canConfigure} onChange={(event) => agent.updatePreferences({ alwaysPrintTicket: event.target.checked })} type={'checkbox'} />
        <span>
          <strong className={'block'}>Imprimir ticket siempre</strong>
          <small className={'text-[var(--muted)]'}>Si se desactiva, los cobros en efectivo solo abriran el cajon.</small>
        </span>
      </label>
    </section>

    <section className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-3"><Printer className="h-5 w-5" /><div><h3 className="font-black">Impresoras</h3><p className="text-sm text-[var(--muted)]">Descubrimiento gestionado por el agente local.</p></div></div><div className="flex gap-2"><Button disabled={busy} onClick={() => void run(agent.loadPrinters, 'Lista de impresoras actualizada.')} size="sm"><RefreshCw className={`h-4 w-4 ${agent.isLoadingPrinters ? 'animate-spin' : ''}`} />Actualizar</Button><Button disabled={busy || !canConfigure} onClick={() => void run(agent.discoverPrinters, 'Descubrimiento completado.')} size="sm" variant="primary"><Network className={`h-4 w-4 ${agent.isDiscovering ? 'animate-pulse' : ''}`} />Descubrir</Button></div></div>
      {agent.discoveryProgress ? <p className="my-3 font-mono text-xs text-[var(--muted)]">Progreso: {agent.discoveryProgress.scanned ?? '-'} / {agent.discoveryProgress.total ?? '-'} · {agent.discoveryProgress.found ?? agent.printers.length} encontradas</p> : null}
      <div className="mt-4"><PrinterList disabled={busy || !canConfigure} onSelect={(id) => void run(() => agent.selectPrinter(id), 'Impresora seleccionada.')} onTest={(id) => void run(() => agent.testPrinter(id), 'Ticket de prueba enviado.')} printers={agent.printers} selectedPrinterId={agent.selectedPrinterId} /></div>
      <div className="mt-4 flex flex-wrap gap-2"><Button disabled={busy || !agent.selectedPrinterId} onClick={() => void run(agent.testPrinter, 'Ticket de prueba enviado.')}><TestTube2 className={`h-4 w-4 ${agent.isTestingPrinter ? 'animate-spin' : ''}`} />Imprimir prueba</Button><Button disabled={busy || !canOpenDrawer || !agent.selectedPrinterId} onClick={() => { if (window.confirm('¿Quieres abrir el cajon manualmente?')) void run(() => agent.openCashDrawer(), 'Cajon abierto.') }}><WalletCards className={`h-4 w-4 ${agent.isOpeningCashDrawer ? 'animate-pulse' : ''}`} />Abrir cajon</Button></div>
    </section>

    <section className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"><h3 className="font-black">Preferencias</h3><div className="mt-3 grid gap-3 sm:grid-cols-2"><label className="flex min-h-12 items-center gap-3 rounded-[var(--radius)] border border-[var(--separator)] px-3"><input checked={agent.preferences.autoOpenCashDrawer} disabled={!canConfigure} onChange={(event) => agent.updatePreferences({ autoOpenCashDrawer: event.target.checked })} type="checkbox" /><span className="font-semibold">Abrir cajon automaticamente con efectivo</span></label><label className="flex min-h-12 items-center gap-3 rounded-[var(--radius)] border border-[var(--separator)] px-3"><input checked={agent.preferences.cut} disabled={!canConfigure} onChange={(event) => agent.updatePreferences({ cut: event.target.checked })} type="checkbox" /><span className="font-semibold">Cortar papel</span></label><label className="sm:col-span-2"><span className="mb-2 block text-sm font-bold">Pie del ticket</span><input className="min-h-12 w-full rounded-[var(--radius)] border border-[var(--field-border)] bg-[var(--field)] px-3" disabled={!canConfigure} maxLength={500} onChange={(event) => agent.updatePreferences({ footer: event.target.value })} value={agent.preferences.footer} /></label></div></section>

    <section className="rounded-[var(--radius)] border border-[var(--separator)] bg-[var(--background)] p-4"><div className="flex items-center justify-between gap-3"><h3 className="font-black">Trabajos recientes</h3><Button disabled={agent.isLoadingJobs} onClick={() => void run(agent.loadJobs, 'Trabajos actualizados.')} size="sm">{agent.isLoadingJobs ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}Ver trabajos</Button></div><div className="mt-3"><PrintJobsTable jobs={agent.jobs} /></div></section>

    {canConfigure ? <Button onClick={() => { if (window.confirm('¿Borrar URL, token e impresora de esta terminal?')) { agent.resetConfiguration(); setFeedback('Configuracion local borrada.') } }} variant="danger"><RotateCcw className="h-4 w-4" />Borrar configuracion</Button> : null}
    {wizardOpen ? <PrintAgentSetupWizard canOpenDrawer={canOpenDrawer} onClose={() => setWizardOpen(false)} /> : null}
    {certificateHelpOpen ? <CertificateHelpDialog baseUrl={agent.baseUrl} onClose={() => setCertificateHelpOpen(false)} /> : null}
  </div>
}
