import { AlertTriangle, X } from 'lucide-react'
import type { PrintAgentError } from '../api/PrintAgentError'

export function PrintErrorAlert({ error, onClose }: { error: PrintAgentError; onClose?: () => void }) {
  return <div className="rounded-[var(--radius)] border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-[var(--foreground)]" role="alert">
    <div className="flex items-start gap-3"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
      <div className="min-w-0 flex-1"><p className="font-black">{error.message}</p>
        {['NETWORK_ERROR', 'TIMEOUT'].includes(error.code) ? <p className="mt-2 leading-6 text-[var(--muted)]">Comprueba la Wi-Fi del local, que el agente este encendido, la direccion, el certificado de confianza, CORS y el puerto 8443.</p> : null}
        <p className="mt-2 font-mono text-xs text-[var(--muted)]">Codigo: {error.code}</p>
      </div>
      {onClose ? <button aria-label="Cerrar error" className="min-h-10 min-w-10" onClick={onClose} type="button"><X className="mx-auto h-4 w-4" /></button> : null}
    </div>
  </div>
}

