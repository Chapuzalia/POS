import { Download } from 'lucide-react'
import { useState } from 'react'
import { Button } from '../../../components/ui/Button'
import { getReadableError } from '../../../utils/errors'
import { downloadTenantExport } from './tenantExportService'

export function TenantDataExport({ tenantId }: { tenantId: string }) {
  const [exporting, setExporting] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  async function exportData() {
    if (exporting) return
    setExporting(true)
    setError('')
    setProgress('Preparando exportación…')
    try {
      await downloadTenantExport(tenantId, setProgress)
      setProgress('Exportación preparada para descargar. Comprueba el manifiesto y guarda el ZIP en un lugar seguro.')
    } catch (cause) {
      setProgress('')
      setError(getReadableError(cause, { operation: 'crm.tenant-export' }, 'No se ha podido completar la exportación. Inténtalo de nuevo o contacta con Alteil.'))
    } finally {
      setExporting(false)
    }
  }
  return <section aria-label="Exportación completa" className="grid gap-4 rounded-2xl bg-[var(--crm-surface)] p-6 shadow-[var(--crm-shadow-card)] max-[700px]:p-4">
    <div>
      <h2 className="m-0 text-lg font-bold">Exportación completa de datos</h2>
      <p className="m-0 mt-1 text-sm text-[var(--crm-text-muted)]">Descarga los datos de todos tus locales, con documentos e imágenes, en un ZIP con datos estructurados y un manifiesto de integridad. Incluye datos personales: guárdalo y compártelo de forma segura.</p>
      <p className="mt-2 text-sm text-[var(--crm-text-muted)]">Se mantienen las relaciones y los históricos. Las ventas pueden continuar: la lectura se realiza por páginas y puede recoger cambios durante la descarga. Sincroniza primero los datos pendientes de todos los TPV y concilia la extracción final antes de cambiar de sistema.</p>
      <a className="inline-flex min-h-11 items-center text-sm text-[var(--crm-blue)] underline" href="/legal/portabilidad.html" target="_blank" rel="noreferrer">Ver datos incluidos, formatos y limitaciones</a>
    </div>
    <Button className="!min-h-11 !w-fit !gap-2" disabled={exporting} onClick={() => void exportData()} type="button" variant="primary"><Download aria-hidden="true" className="size-4" />{exporting ? 'Exportando…' : 'Exportar todos mis datos'}</Button>
    {progress ? <p role="status" aria-live="polite" className="m-0 text-sm text-[var(--crm-text-muted)]">{progress}</p> : null}
    {error ? <p role="alert" className="m-0 text-sm text-[var(--crm-red)]">{error}</p> : null}
  </section>
}
