import { AlertTriangle, CheckCircle2, LoaderCircle, Printer, PrinterX } from 'lucide-react'
import { usePrintAgent } from '../hooks/usePrintAgent'

export function PrintAgentStatusBadge({ compact = false }: { compact?: boolean }) {
  const { connectionStatus, isPrintingTicket, selectedPrinterId } = usePrintAgent()
  const state = isPrintingTicket ? 'printing' : !selectedPrinterId ? 'unconfigured' : connectionStatus
  const config = state === 'connected'
    ? { Icon: CheckCircle2, label: 'Impresora conectada', className: 'border-emerald-500/35 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300' }
    : state === 'printing' || state === 'checking'
      ? { Icon: LoaderCircle, label: state === 'printing' ? 'Imprimiendo ticket' : 'Comprobando impresora', className: 'border-sky-500/35 bg-sky-500/10 text-sky-700 dark:text-sky-300' }
      : state === 'unknown' || state === 'unconfigured'
        ? { Icon: Printer, label: 'Impresora sin configurar', className: 'border-[var(--separator)] bg-[var(--surface-secondary)] text-[var(--muted)]' }
        : state === 'disconnected'
          ? { Icon: PrinterX, label: 'Impresora desconectada', className: 'border-red-500/35 bg-red-500/10 text-red-700 dark:text-red-300' }
          : { Icon: AlertTriangle, label: 'Error de impresion', className: 'border-amber-500/35 bg-amber-500/10 text-amber-800 dark:text-amber-200' }
  return <span className={`inline-flex min-h-9 items-center gap-2 rounded-full border px-3 text-xs font-bold ${config.className}`} title={config.label}>
    <config.Icon className={`h-4 w-4 ${state === 'printing' || state === 'checking' ? 'animate-spin' : ''}`} />
    {compact ? <span className="sr-only">{config.label}</span> : config.label}
  </span>
}
