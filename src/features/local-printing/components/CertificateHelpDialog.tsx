import { ExternalLink, X } from 'lucide-react'
import { Button } from '../../../components/ui'
import { closeOnModalBackdrop } from '../../../components/modals/modalBackdrop'

export function CertificateHelpDialog({ baseUrl, onClose }: { baseUrl: string; onClose: () => void }) {
  return <div className="fixed inset-0 z-[70] flex items-end justify-center bg-black/60 sm:items-center sm:p-4" onClick={(event) => closeOnModalBackdrop(event, onClose)}>
    <section aria-modal="true" className="max-h-[100svh] w-full overflow-y-auto rounded-t-[var(--radius)] bg-[var(--surface)] p-5 text-[var(--foreground)] sm:max-w-xl sm:rounded-[var(--radius)]" role="dialog">
      <div className="flex justify-between gap-3"><div><h2 className="text-xl font-black">Certificado y red local</h2><p className="text-sm text-[var(--muted)]">Safari no permite ignorar errores TLS desde JavaScript.</p></div><Button onClick={onClose} size="sm" variant="tertiary"><X className="h-4 w-4" /></Button></div>
      <ol className="mt-5 grid list-decimal gap-3 pl-5 text-sm leading-6">
        <li>Abre <strong className="break-all">{baseUrl}/health</strong> directamente en Safari.</li>
        <li>Si aparece un error de confianza, instala el certificado raiz proporcionado por el agente.</li>
        <li>Ve a Ajustes &gt; General &gt; Informacion &gt; Ajustes de confianza de certificados.</li>
        <li>Activa la confianza completa, regresa al TPV y vuelve a probar.</li>
      </ol>
      <a className="mt-5 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-[var(--radius)] bg-[var(--accent)] px-4 font-bold text-[var(--accent-foreground)]" href={`${baseUrl}/health`} rel="noreferrer" target="_blank"><ExternalLink className="h-4 w-4" />Abrir agente en una nueva pestana</a>
    </section>
  </div>
}
