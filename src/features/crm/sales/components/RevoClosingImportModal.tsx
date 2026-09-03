import { useId, useRef, useState } from 'react'
import { Upload, X } from 'lucide-react'
import { Button } from '../../../../components/ui/Button'
import { Select } from '../../../../components/ui/Select'
import { formatMoney } from '../../../../lib/format'
import { formatRevoDate, parseRevoClosingsCsv, REVO_CLOSING_MAX_BYTES, type RevoClosingImport } from '../../../../lib/revoCashClosings.ts'
import type { CrmVenue } from '../../../../types'
import { getReadableError } from '../../../../utils/errors'
import { CrmModal } from '../../shared/components/CrmModal'
import { importRevoCashClosings } from '../services/revoCashClosingService'

export function RevoClosingImportModal({ venues, disabled, onClose, onImported }: {
  venues: CrmVenue[]
  disabled: boolean
  onClose: () => void
  onImported: (venueId: string) => Promise<void>
}) {
  const fileId = useId()
  const [venueId, setVenueId] = useState('')
  const [fileName, setFileName] = useState('')
  const [preview, setPreview] = useState<RevoClosingImport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [reading, setReading] = useState(false)
  const [importing, setImporting] = useState(false)
  const importPending = useRef(false)
  const [result, setResult] = useState<{ inserted: number; skipped: number; venueName: string } | null>(null)
  const venue = venues.find((item) => item.id === venueId)
  const busy = reading || importing

  async function readFile(file: File | undefined) {
    setPreview(null); setError(null); setResult(null); setFileName(file?.name ?? '')
    if (!file) return
    setReading(true)
    try {
      if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('Selecciona el archivo .csv fiscal exportado desde REVO.')
      if (file.size > REVO_CLOSING_MAX_BYTES) throw new Error('El archivo supera los 10 MB.')
      setPreview(parseRevoClosingsCsv(await file.text()))
    } catch (cause) { setError(getReadableError(cause)) }
    finally { setReading(false) }
  }

  async function importFile() {
    if (!preview || !venue || disabled || importPending.current || result) return
    importPending.current = true
    setImporting(true); setError(null)
    try {
      const imported = await importRevoCashClosings(venue.id, fileName, preview.days)
      setResult({ ...imported, venueName: venue.name })
      await onImported(venue.id)
    } catch (cause) { setError(getReadableError(cause)) }
    finally { importPending.current = false; setImporting(false) }
  }

  return (
    <CrmModal label="Importar cierres desde REVO" onClose={() => { if (!busy) onClose() }} size="large">
      <section className="!flex !max-h-[85dvh] !flex-col">
        <header className="!flex !items-center !justify-between !gap-4 !border-b !border-[var(--crm-border-subtle)] !p-5">
          <div>
            <h2 className="!text-lg !font-bold">Importar cierres desde REVO</h2>
            <p className="!mt-1 !text-sm !text-[var(--crm-text-muted)]">Selecciona el local y revisa el historial antes de guardarlo.</p>
          </div>
          <Button aria-label="Cerrar importación" disabled={busy} onClick={onClose} variant="tertiary"><X className="!size-5" /></Button>
        </header>
        <div className="!grid !auto-rows-max !gap-5 !overflow-y-auto !p-5">
          <div className="!grid !gap-4 sm:!grid-cols-2">
            <div className="!grid !content-start !gap-2 !text-sm !font-semibold">
              <span>Local de destino</span>
              <Select ariaLabel="Local de destino" disabled={busy || disabled || Boolean(result)} onChange={setVenueId}
                options={venues.map((item) => ({ value: item.id, label: item.name }))} value={venueId} />
              {!venues.length ? <p className="!text-xs !text-[var(--crm-text-muted)]">No hay locales disponibles.</p> : null}
            </div>
            <div className="!grid !content-start !gap-2 !text-sm !font-semibold">
              <label htmlFor={fileId}>Archivo fiscal de REVO (.csv)</label>
              <input accept=".csv,text/csv" className="!w-full !rounded-lg !border !border-[var(--crm-border-subtle)] !p-2 !text-sm"
                disabled={busy || disabled || Boolean(result)} id={fileId} onChange={(event) => void readFile(event.target.files?.[0])} type="file" />
            </div>
          </div>
          {reading ? <p role="status">Leyendo archivo…</p> : null}
          {error ? <p className="!rounded-xl !bg-[var(--crm-red-soft)] !p-3 !text-sm !text-[var(--crm-red)]" role="alert">{error}</p> : null}
          {preview ? <>
            <div className="!grid !gap-3 sm:!grid-cols-3">
              <PreviewValue label={`${preview.rowCount} filas del archivo`} value={`${preview.days.length} cierres diarios`} />
              <PreviewValue label="Total REVO" value={formatMoney(preview.totalCents)} />
              <PreviewValue label="Propinas declaradas" value={formatMoney(preview.tipCents)} />
            </div>
            <div className="!space-y-2 !text-sm !text-[var(--crm-text-secondary)]">
              <p>{formatRevoDate(preview.days[0].date)} — {formatRevoDate(preview.days[preview.days.length - 1].date)}{venue ? ` · Destino: ${venue.name}` : ''}</p>
              <p>Las filas del mismo día se suman por forma de pago. Se conserva el total de REVO y se muestran las propinas por separado, sin volver a sumarlas al total.</p>
              <p>Los días ya importados con los mismos importes se omiten. Si un día tiene importes distintos, se cancela toda la importación para que puedas revisar el archivo.</p>
              <p>Este archivo no contiene arqueos, fondos, horas de cierre ni número de tickets.</p>
            </div>
            <div className="!h-64 !min-h-48 !overflow-auto !rounded-xl !border !border-[var(--crm-border-subtle)]">
              <table aria-label="Vista previa de cierres REVO" className="!w-full !text-right !text-sm">
                <thead className="!sticky !top-0 !bg-[var(--crm-surface-soft)]"><tr>
                  <th className="!p-3 !text-left">Fecha</th><th className="!p-3">Efectivo</th><th className="!p-3">Tarjeta</th><th className="!p-3">Total</th><th className="!p-3">Propinas</th>
                </tr></thead>
                <tbody>{preview.days.slice(0, 100).map((day) => <tr className="!border-t !border-[var(--crm-border-subtle)]" key={day.date}>
                  <td className="!whitespace-nowrap !p-3 !text-left">{formatRevoDate(day.date)}</td>
                  <td className="!p-3">{formatMoney(day.cashCents)}</td><td className="!p-3">{formatMoney(day.cardCents)}</td>
                  <td className="!p-3 !font-semibold">{formatMoney(day.cashCents + day.cardCents)}</td>
                  <td className="!p-3">{formatMoney(day.cashTipCents + day.cardTipCents)}</td>
                </tr>)}</tbody>
              </table>
            </div>
            {preview.days.length > 100 ? <p className="!text-xs !text-[var(--crm-text-muted)]">Vista previa de los primeros 100 días. Se procesarán los {preview.days.length} días del archivo.</p> : null}
          </> : null}
          {result ? <p className="!rounded-xl !bg-[var(--crm-green-soft)] !p-4 !text-sm !text-[var(--crm-green)]" role="status">
            Importación completada en {result.venueName}: {result.inserted} cierres añadidos y {result.skipped} ya existentes.
            {' '}Puedes consultarlos en los informes Z de ese local.
          </p> : null}
        </div>
        <footer className="!flex !justify-end !gap-3 !border-t !border-[var(--crm-border-subtle)] !p-5">
          <Button disabled={busy} onClick={onClose} variant="secondary">{result ? 'Cerrar' : 'Cancelar'}</Button>
          {!result ? <Button disabled={disabled || busy || !preview || !venue} onClick={() => void importFile()} variant="primary">
            <Upload className="!size-4" />{importing ? 'Importando…' : `Importar${preview ? ` ${preview.days.length} cierres` : ''}`}
          </Button> : null}
        </footer>
      </section>
    </CrmModal>
  )
}

function PreviewValue({ label, value }: { label: string; value: string }) {
  return <div className="!rounded-xl !bg-[var(--crm-surface-soft)] !p-4">
    <p className="!text-xs !text-[var(--crm-text-muted)]">{label}</p><strong className="!mt-1 !block !text-lg">{value}</strong>
  </div>
}
